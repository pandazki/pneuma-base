//! Rows: a cache the record place's owner derives from its facts, one SQLite file per record
//! place in the cache area. The saved cursor and the rows change in one transaction.

use std::collections::{BTreeMap, HashMap};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use pneuma_base_storage::{
    After, CursorExpect, Failure, LookItem, LookRows, Reason, RecordPlace, Row, RowChange,
    RowsGetAnswer, RowsGetRequest, RowsPage, RowsPutRequest, RowsUnderRequest, RowsWhereAnswer,
    RowsWhereRequest, StoredRow, request::MAX_FIELDS,
};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::{LocalFolder, io_failure, sys};

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS rows (
        tbl TEXT NOT NULL, key TEXT NOT NULL, fields TEXT, value TEXT NOT NULL,
        PRIMARY KEY (tbl, key)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fields (
        tbl TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, key TEXT NOT NULL,
        PRIMARY KEY (tbl, name, value, key)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS table_fields (
        tbl TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (tbl, name)) WITHOUT ROWID;
    PRAGMA user_version = 1;
";

pub(crate) fn sql_failure(error: rusqlite::Error) -> Failure {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Failure::new(Reason::Busy),
        // The file was removed under an open connection by `rows.reset`; trying again opens
        // the new one.
        Some(ErrorCode::ReadOnly) => Failure::new(Reason::Busy),
        Some(code) => Failure::unreadable(format!("SQLITE_{code:?}")),
        None => Failure::unreadable(format!("{error:?}")),
    }
}

/// Makes the database whole under a private name, then links it into place, which never
/// replaces a file. Two processes setting up one file at once can deadlock in SQLite (switching
/// to WAL needs the lock the other holds), so no file is ever set up in place.
pub(crate) fn create_db(path: &Path, schema: &str) -> Result<(), Failure> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io_failure(&e))?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("rows");
    let temp = path.with_file_name(format!(
        ".{name}.{}.{}.new",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let built = Connection::open(&temp).and_then(|conn| {
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })?;
        conn.execute_batch(schema)?;
        conn.close().map_err(|(_, error)| error)
    });
    let linked = built
        .map_err(sql_failure)
        .and_then(|()| match std::fs::hard_link(&temp, path) {
            Ok(()) => Ok(()),
            // Another process linked its own first; it is as good as ours.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(io_failure(&e)),
        });
    for suffix in ["", "-wal", "-shm"] {
        let mut file = temp.clone().into_os_string();
        file.push(suffix);
        let _ = std::fs::remove_file(file);
    }
    linked
}

fn row_from(key: String, fields: Option<String>, value: String) -> StoredRow {
    let fields = fields
        .and_then(|text| serde_json::from_str::<BTreeMap<String, String>>(&text).ok())
        .unwrap_or_default();
    let value = RawValue::from_string(value)
        .unwrap_or_else(|_| RawValue::from_string("null".to_owned()).expect("null is JSON"));
    StoredRow { key, fields, value }
}

/// Which file a connection was opened on: its inode and birth (or, where there is none, change)
/// time. A file removed and made again at the same path is another file.
type FileId = (u64, i128);

fn file_id(path: &Path) -> Option<FileId> {
    sys::stat_path(path)
        .ok()
        .map(|s| (s.inode, s.btime_ns.unwrap_or(s.ctime_ns)))
}

type Pool = Mutex<HashMap<PathBuf, Vec<(FileId, Connection)>>>;

/// Connections a `serve` process opened, kept for its next requests: opening one costs more than
/// most requests do. One is used again only while the file at its path is the one it was opened on.
fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(Pool::default)
}

/// A connection taken from the pool, or newly opened, that goes back to it when dropped.
pub(crate) struct Pooled {
    path: PathBuf,
    id: FileId,
    conn: Option<Connection>,
}

impl Deref for Pooled {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("held until dropped")
    }
}

impl DerefMut for Pooled {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("held until dropped")
    }
}

impl Drop for Pooled {
    fn drop(&mut self) {
        if let (Some(conn), Ok(mut pool)) = (self.conn.take(), pool().lock()) {
            pool.entry(std::mem::take(&mut self.path))
                .or_default()
                .push((self.id, conn));
        }
    }
}

/// A pooled connection to the file at `path` when it is still `id`; the stale ones go.
fn pooled(path: &Path, id: FileId) -> Option<Pooled> {
    let mut pool = pool().lock().ok()?;
    let kept = pool.get_mut(path)?;
    kept.retain(|(at, _)| *at == id);
    let (_, conn) = kept.pop()?;
    Some(Pooled {
        path: path.to_owned(),
        id,
        conn: Some(conn),
    })
}

impl LocalFolder {
    fn rows_file(&self, place: &RecordPlace) -> PathBuf {
        self.cache_area()
            .join("rows")
            .join(format!("{}.sqlite", place.as_str()))
    }

    /// The place's database; `None` when reading and there is none yet.
    fn rows_db(&self, place: &RecordPlace, create: bool) -> Result<Option<Pooled>, Failure> {
        let path = self.rows_file(place);
        let id = match file_id(&path) {
            Some(id) => id,
            None if !create => return Ok(None),
            None => {
                create_db(&path, SCHEMA)?;
                file_id(&path).ok_or_else(|| Failure::new(Reason::Busy))?
            }
        };
        if let Some(conn) = pooled(&path, id) {
            return Ok(Some(conn));
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&path, flags).map_err(sql_failure)?;
        conn.busy_timeout(Duration::from_secs(10))
            .map_err(sql_failure)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_failure)?;
        if version == 0 {
            return Ok(None);
        }
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_failure)?;
        Ok(Some(Pooled {
            path,
            id,
            conn: Some(conn),
        }))
    }

    pub fn put_rows(&self, req: &RowsPutRequest) -> Result<(), Failure> {
        self.ensure_record_area()?;
        let Some(mut conn) = self.rows_db(&req.place, true)? else {
            return Err(Failure::new(Reason::Busy));
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_failure)?;
        let saved: Option<String> = tx
            .query_row("SELECT v FROM meta WHERE k = 'cursor'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql_failure)?;
        if let CursorExpect::Cursor(expected) = &req.expect
            && *expected != saved
        {
            return Err(Failure::refused(Some(
                saved.map_or(Value::Null, Value::String),
            )));
        }
        for (table, changes) in &req.tables {
            for change in changes {
                let old_fields: Option<Option<String>> = tx
                    .prepare_cached("SELECT fields FROM rows WHERE tbl = ?1 AND key = ?2")
                    .and_then(|mut s| {
                        s.query_row(params![table, change.key()], |r| r.get(0))
                            .optional()
                    })
                    .map_err(sql_failure)?;
                if let Some(Some(text)) = old_fields {
                    let old: BTreeMap<String, String> =
                        serde_json::from_str(&text).unwrap_or_default();
                    let mut delete = tx
                        .prepare_cached(
                            "DELETE FROM fields WHERE tbl = ?1 AND name = ?2 AND value = ?3 AND key = ?4",
                        )
                        .map_err(sql_failure)?;
                    for (name, value) in &old {
                        delete
                            .execute(params![table, name, value, change.key()])
                            .map_err(sql_failure)?;
                    }
                }
                match change {
                    RowChange::Delete(key) => {
                        tx.prepare_cached("DELETE FROM rows WHERE tbl = ?1 AND key = ?2")
                            .and_then(|mut s| s.execute(params![table, key]))
                            .map_err(sql_failure)?;
                    }
                    RowChange::Put(row) => put_row(&tx, table, row)?,
                }
            }
            let names: i64 = tx
                .query_row(
                    "SELECT count(*) FROM table_fields WHERE tbl = ?1",
                    [table],
                    |r| r.get(0),
                )
                .map_err(sql_failure)?;
            if names > MAX_FIELDS as i64 {
                return Err(Failure::bad_request());
            }
        }
        if let Some(cursor) = &req.cursor {
            tx.execute(
                "INSERT OR REPLACE INTO meta (k, v) VALUES ('cursor', ?1)",
                [cursor],
            )
            .map_err(sql_failure)?;
        }
        tx.commit().map_err(sql_failure)
    }

    pub fn get_rows(&self, req: &RowsGetRequest) -> Result<RowsGetAnswer, Failure> {
        let Some(mut conn) = self.rows_db(&req.place, false)? else {
            return Ok(RowsGetAnswer {
                rows: Vec::new(),
                cursor: None,
            });
        };
        // One read transaction, so the rows and the cursor come from the same commit.
        let tx = conn.transaction().map_err(sql_failure)?;
        let cursor = tx
            .query_row("SELECT v FROM meta WHERE k = 'cursor'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql_failure)?;
        let mut rows = Vec::new();
        {
            let mut select = tx
                .prepare_cached("SELECT fields, value FROM rows WHERE tbl = ?1 AND key = ?2")
                .map_err(sql_failure)?;
            for key in &req.keys {
                let found = select
                    .query_row(params![req.table, key], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(sql_failure)?;
                if let Some((fields, value)) = found {
                    rows.push(row_from(key.clone(), fields, value));
                }
            }
        }
        Ok(RowsGetAnswer { rows, cursor })
    }

    pub fn rows_with_prefix(&self, req: &RowsUnderRequest) -> Result<RowsPage, Failure> {
        let Some(conn) = self.rows_db(&req.place, false)? else {
            return Ok(RowsPage {
                rows: Vec::new(),
                more: None,
            });
        };
        let (sql, from) = match &req.after {
            Some(after) if *after >= req.prefix => (
                "SELECT key, fields, value FROM rows WHERE tbl = ?1 AND key > ?2 ORDER BY key LIMIT ?3",
                after.as_str(),
            ),
            _ => (
                "SELECT key, fields, value FROM rows WHERE tbl = ?1 AND key >= ?2 ORDER BY key LIMIT ?3",
                req.prefix.as_str(),
            ),
        };
        let mut select = conn.prepare_cached(sql).map_err(sql_failure)?;
        let found = select
            .query_map(params![req.table, from, req.limit as i64 + 1], |r| {
                Ok(row_from(r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(sql_failure)?;
        let mut rows = Vec::new();
        for row in found {
            let row = row.map_err(sql_failure)?;
            if !row.key.starts_with(&req.prefix) {
                break;
            }
            rows.push(row);
        }
        Ok(page(rows, req.limit))
    }

    pub fn rows_with_field(&self, req: &RowsWhereRequest) -> Result<RowsWhereAnswer, Failure> {
        let Some(conn) = self.rows_db(&req.place, false)? else {
            return Ok(match req.count {
                Some(_) => RowsWhereAnswer::Count {
                    count: 0,
                    exceeded: false,
                },
                None => RowsWhereAnswer::Page(RowsPage {
                    rows: Vec::new(),
                    more: None,
                }),
            });
        };
        if let Some(cap) = req.count {
            let n: i64 = conn
                .query_row(
                    "SELECT count(*) FROM (SELECT 1 FROM fields
                     WHERE tbl = ?1 AND name = ?2 AND value = ?3 LIMIT ?4)",
                    params![req.table, req.field, req.value, cap as i64 + 1],
                    |r| r.get(0),
                )
                .map_err(sql_failure)?;
            let n = n as u64;
            return Ok(RowsWhereAnswer::Count {
                count: n.min(cap),
                exceeded: n > cap,
            });
        }
        let select = "SELECT r.key, r.fields, r.value FROM fields f
             JOIN rows r ON r.tbl = f.tbl AND r.key = f.key
             WHERE f.tbl = ?1 AND f.name = ?2 AND f.value = ?3";
        let sql = match req.after {
            Some(_) => format!("{select} AND f.key > ?4 ORDER BY f.key LIMIT ?5"),
            None => format!("{select} AND f.key >= ?4 ORDER BY f.key LIMIT ?5"),
        };
        let after = req.after.as_deref().unwrap_or("");
        let mut statement = conn.prepare_cached(&sql).map_err(sql_failure)?;
        let rows = statement
            .query_map(
                params![req.table, req.field, req.value, after, req.limit as i64 + 1],
                |r| Ok(row_from(r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql_failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_failure)?;
        Ok(RowsWhereAnswer::Page(page(rows, req.limit)))
    }

    /// What a look expects, read from a table: a page of rows after `after` in key order, each
    /// row's key the place and its field `field` the expectation, absent when the row has none.
    pub fn expectations(&self, rows: &LookRows) -> Result<(Vec<LookItem>, Option<After>), Failure> {
        let Some(conn) = self.rows_db(&rows.place, false)? else {
            return Ok((Vec::new(), None));
        };
        let (sql, from) = match &rows.after {
            Some(after) => (
                "SELECT key, fields FROM rows WHERE tbl = ?1 AND key > ?2 ORDER BY key LIMIT ?3",
                after.as_str(),
            ),
            None => (
                "SELECT key, fields FROM rows WHERE tbl = ?1 AND key >= ?2 ORDER BY key LIMIT ?3",
                "",
            ),
        };
        let mut select = conn.prepare_cached(sql).map_err(sql_failure)?;
        let found = select
            .query_map(params![rows.table, from, rows.limit as i64 + 1], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(sql_failure)?;
        let mut items = Vec::new();
        let mut last = None;
        for row in found {
            let (key, fields) = row.map_err(sql_failure)?;
            if items.len() == rows.limit {
                return Ok((items, last.map(|after| After { after })));
            }
            let fields = fields
                .and_then(|text| serde_json::from_str::<BTreeMap<String, String>>(&text).ok())
                .unwrap_or_default();
            items.push(LookItem::new(
                &key,
                fields.get(&rows.field).map(String::as_str),
            ));
            last = Some(key);
        }
        Ok((items, None))
    }

    /// Drops the rows and the cursor in constant time by removing the place's database file.
    pub fn reset_rows(&self, place: &RecordPlace) -> Result<(), Failure> {
        let path = self.rows_file(place);
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.clone().into_os_string();
            file.push(suffix);
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_failure(&e)),
            }
        }
        Ok(())
    }
}

fn put_row(tx: &rusqlite::Transaction, table: &str, row: &Row) -> Result<(), Failure> {
    let fields = (!row.fields.is_empty())
        .then(|| serde_json::to_string(&row.fields))
        .transpose()
        .map_err(|_| Failure::bad_request())?;
    let value = serde_json::to_string(&row.value).map_err(|_| Failure::bad_request())?;
    tx.prepare_cached(
        "INSERT OR REPLACE INTO rows (tbl, key, fields, value) VALUES (?1, ?2, ?3, ?4)",
    )
    .and_then(|mut s| s.execute(params![table, row.key, fields, value]))
    .map_err(sql_failure)?;
    let mut name_insert = tx
        .prepare_cached("INSERT OR IGNORE INTO table_fields (tbl, name) VALUES (?1, ?2)")
        .map_err(sql_failure)?;
    let mut field_insert = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO fields (tbl, name, value, key) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(sql_failure)?;
    for (name, value) in &row.fields {
        name_insert
            .execute(params![table, name])
            .map_err(sql_failure)?;
        field_insert
            .execute(params![table, name, value, row.key])
            .map_err(sql_failure)?;
    }
    Ok(())
}

fn page(mut rows: Vec<StoredRow>, limit: usize) -> RowsPage {
    let more = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|row| After {
            after: row.key.clone(),
        })
    } else {
        None
    };
    RowsPage { rows, more }
}
