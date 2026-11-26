//! The change log: what a live listener heard, kept in the cache area so that `changed` from any
//! process can be answered without replaying the system's journal. One SQLite file, written only
//! by the listener holding the lock file beside it. A place is kept once, with the newest event
//! that named it, so the log is bounded by places, not by events. Never synced, safe to delete.
//!
//! The log covers the events after `floor` up to `head`, both event ids of the origin it names
//! (the volume's event database, the library folder's device and inode). A reader trusts it only
//! while its listener is live: the lock is held (the system drops it when the process dies, however
//! it dies), `live` says the listener has caught up with the system's history, and its heartbeat
//! is recent (a listener that hangs stops beating).

use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pneuma_base_storage::{Failure, Place};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::rows::{create_db, sql_failure};
use crate::{io_failure, sys};

/// The most places the log keeps. Past it the oldest go, and readers whose cursor is older than
/// what went are answered `cannot_say`.
pub const BOUND: usize = 10_000;
/// How often a listener writes its heartbeat.
pub const BEAT: Duration = Duration::from_secs(1);
/// A heartbeat older than this is a listener that stopped.
const STALE_MS: i64 = 3_000;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS heard (place TEXT PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS heard_by_id ON heard (id);
    PRAGMA user_version = 1;
";

/// Where the log and its lock are.
pub struct Files {
    db: PathBuf,
    lock: PathBuf,
}

impl Files {
    pub fn of(cache_area: &Path) -> Files {
        let dir = cache_area.join("changes");
        Files {
            db: dir.join("log.sqlite"),
            lock: dir.join("listener.lock"),
        }
    }
}

/// What the log can say about the events after a cursor.
pub enum Heard {
    /// No live listener: nobody holds the lock, it has not caught up yet, or its heartbeat is old.
    NoListener,
    /// A live listener whose log starts after the cursor, or keeps another origin's events.
    Behind { floor: u64 },
    /// The places named after the cursor, in event order, up to `next`, the cursor to keep.
    Places {
        places: Vec<Place>,
        next: u64,
        more: bool,
    },
}

/// The meta row's values, as the writer keeps them.
#[derive(Default)]
struct Meta {
    origin: String,
    floor: u64,
    head: u64,
    beat: i64,
    live: bool,
}

fn read_meta(conn: &Connection) -> rusqlite::Result<Meta> {
    let mut meta = Meta::default();
    let mut statement = conn.prepare_cached("SELECT k, v FROM meta")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let (k, v): (String, String) = (row.get(0)?, row.get(1)?);
        match k.as_str() {
            "origin" => meta.origin = v,
            "floor" => meta.floor = v.parse().unwrap_or(u64::MAX),
            "head" => meta.head = v.parse().unwrap_or(0),
            "beat" => meta.beat = v.parse().unwrap_or(0),
            "live" => meta.live = v == "1",
            _ => {}
        }
    }
    Ok(meta)
}

/// Whether some process holds the lock: a shared lock taken without waiting fails.
fn held(lock: &Path) -> bool {
    let Ok(file) = File::open(lock) else {
        return false;
    };
    // SAFETY: flock on a descriptor this function owns; closing it drops any lock taken.
    let taken = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0;
    !taken
}

/// What the log says about the events of `origin` after `after`, at most `limit` places.
pub fn read(files: &Files, origin: &str, after: u64, limit: usize, now_ms: i64) -> Heard {
    if !held(&files.lock) {
        return Heard::NoListener;
    }
    let read = || -> rusqlite::Result<Heard> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&files.db, flags)?;
        conn.busy_timeout(Duration::from_millis(200))?;
        let tx = conn.unchecked_transaction()?;
        let meta = read_meta(&tx)?;
        if !meta.live || now_ms - meta.beat > STALE_MS {
            return Ok(Heard::NoListener);
        }
        if meta.origin != origin || after < meta.floor {
            return Ok(Heard::Behind { floor: meta.floor });
        }
        let mut statement = tx.prepare_cached(
            "SELECT place, id FROM heard WHERE id > ?1 AND id <= ?2 ORDER BY id, place LIMIT ?3",
        )?;
        let mut rows: Vec<(String, u64)> = statement
            .query_map(
                params![after as i64, meta.head as i64, (limit + 1) as i64],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let places = |rows: Vec<(String, u64)>| {
            rows.iter()
                .filter_map(|(place, _)| Place::parse(place))
                .collect()
        };
        if rows.len() <= limit {
            return Ok(Heard::Places {
                places: places(rows),
                next: after.max(meta.head),
                more: false,
            });
        }
        // Cut where the event id changes, so the next read resumes after a whole event.
        let boundary = rows[limit].1;
        let keep = rows.iter().take_while(|(_, id)| *id < boundary).count();
        rows.truncate(if keep == 0 { limit + 1 } else { keep });
        let next = rows.last().map_or(after, |(_, id)| *id);
        Ok(Heard::Places {
            places: places(rows),
            next,
            more: true,
        })
    };
    // A log being made, replaced or deleted under the reader says nothing.
    read().unwrap_or(Heard::NoListener)
}

/// Takes the listener's lock without waiting; `None` when another process holds it.
pub fn take_lock(files: &Files) -> Result<Option<File>, Failure> {
    if let Some(dir) = files.lock.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io_failure(&e))?;
    }
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&files.lock)
        .map_err(|e| io_failure(&e))?;
    // SAFETY: flock on a descriptor `file` owns; the lock lasts as long as it is open.
    let taken = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    Ok(taken.then_some(file))
}

/// The one writer of the log, holding its lock.
pub struct Writer {
    conn: Connection,
    meta: Meta,
    count: usize,
    lock: File,
    inodes: (u64, u64),
}

impl Writer {
    /// Opens the log under `lock`. A log of the same origin is carried on from its head; any other
    /// is started afresh at `start`. Answers the writer and the event id to listen after.
    pub fn open(
        files: &Files,
        lock: File,
        origin: &str,
        start: u64,
    ) -> Result<(Writer, u64), Failure> {
        if !files.db.exists() {
            create_db(&files.db, SCHEMA)?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&files.db, flags).map_err(sql_failure)?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(sql_failure)?;
        conn.pragma_update(None, "synchronous", "OFF")
            .map_err(sql_failure)?;
        let mut meta = read_meta(&conn).map_err(sql_failure)?;
        let carried = meta.origin == origin && meta.floor <= meta.head;
        if !carried {
            conn.execute("DELETE FROM heard", []).map_err(sql_failure)?;
            meta = Meta {
                origin: origin.to_owned(),
                floor: start,
                head: start,
                ..Meta::default()
            };
        }
        meta.live = false;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM heard", [], |row| row.get(0))
            .map_err(sql_failure)?;
        let inodes = (inode(&files.db), lock_inode(&lock));
        let writer = Writer {
            conn,
            meta,
            count: count as usize,
            lock,
            inodes,
        };
        writer.save_meta().map_err(sql_failure)?;
        let since = writer.meta.head;
        Ok((writer, since))
    }

    fn save_meta(&self) -> rusqlite::Result<()> {
        let m = &self.meta;
        let mut statement = self
            .conn
            .prepare_cached("INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)")?;
        for (k, v) in [
            ("origin", m.origin.clone()),
            ("floor", m.floor.to_string()),
            ("head", m.head.to_string()),
            ("beat", m.beat.to_string()),
            ("live", if m.live { "1" } else { "0" }.to_owned()),
        ] {
            statement.execute(params![k, v])?;
        }
        Ok(())
    }

    /// Keeps what was heard: each place with its newest event id. Readers see it once a heartbeat
    /// moves the head past it.
    pub fn record(&mut self, heard: &[(String, u64)]) -> Result<(), Failure> {
        if heard.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction().map_err(sql_failure)?;
        {
            let mut insert = tx
                .prepare_cached("INSERT OR IGNORE INTO heard (place, id) VALUES (?1, ?2)")
                .map_err(sql_failure)?;
            let mut update = tx
                .prepare_cached("UPDATE heard SET id = ?2 WHERE place = ?1 AND id < ?2")
                .map_err(sql_failure)?;
            for (place, id) in heard {
                if insert
                    .execute(params![place, *id as i64])
                    .map_err(sql_failure)?
                    == 1
                {
                    self.count += 1;
                } else {
                    update
                        .execute(params![place, *id as i64])
                        .map_err(sql_failure)?;
                }
            }
        }
        if self.count > BOUND {
            let over = self.count - BOUND * 9 / 10;
            let last: Option<i64> = tx
                .query_row(
                    "SELECT MAX(id) FROM (SELECT id FROM heard ORDER BY id LIMIT ?1)",
                    params![over as i64],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_failure)?
                .flatten();
            if let Some(last) = last {
                let gone = tx
                    .execute("DELETE FROM heard WHERE id <= ?1", params![last])
                    .map_err(sql_failure)?;
                self.count -= gone;
                self.meta.floor = self.meta.floor.max(last as u64);
            }
        }
        self.meta.head = self.meta.head.max(self.meta.floor);
        self.save_meta().map_err(sql_failure)?;
        tx.commit().map_err(sql_failure)
    }

    /// Events up to `at` may have been lost: the log starts again after it.
    pub fn lost(&mut self, at: u64) -> Result<(), Failure> {
        let tx = self.conn.unchecked_transaction().map_err(sql_failure)?;
        self.meta.floor = self.meta.floor.max(at);
        self.meta.head = self.meta.head.max(self.meta.floor);
        let gone = tx
            .execute(
                "DELETE FROM heard WHERE id <= ?1",
                params![self.meta.floor as i64],
            )
            .map_err(sql_failure)?;
        self.count -= gone;
        self.save_meta().map_err(sql_failure)?;
        tx.commit().map_err(sql_failure)
    }

    pub fn head(&self) -> u64 {
        self.meta.head
    }

    /// The heartbeat: every event up to `upto` has been delivered and kept, the listener is
    /// caught up, and it is alive at `now_ms`.
    pub fn beat(&mut self, upto: u64, now_ms: i64) -> Result<(), Failure> {
        self.meta.head = self.meta.head.max(upto);
        self.meta.beat = now_ms;
        self.meta.live = true;
        self.save_meta().map_err(sql_failure)
    }

    /// Whether the cache area was deleted or replaced under the writer: its log or lock file is
    /// not the one it holds any more.
    pub fn replaced(&self, files: &Files) -> bool {
        (inode(&files.db), inode(&files.lock)) != self.inodes
    }

    /// Stops listening: readers fall back at once.
    pub fn stop(mut self) {
        self.meta.live = false;
        let _ = self.save_meta();
        drop(self.lock);
    }
}

fn inode(path: &Path) -> u64 {
    sys::stat_path(path).map_or(0, |s| s.inode)
}

fn lock_inode(lock: &File) -> u64 {
    sys::stat_fd(lock.as_raw_fd()).map_or(0, |s| s.inode)
}
