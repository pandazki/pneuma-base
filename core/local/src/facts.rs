//! Facts: append only, one new file per append, in day directories (the old layout, one
//! directory per scene, is still read).
//!
//! A reader's cursor follows arrival, not names. A file can arrive late anywhere: synced in
//! from another machine into an older day, or into the old layout. What a file is "after" is when
//! it arrived in its directory on this machine (macOS keeps the time each entry was added; else
//! the change time). A directory's change time moves whenever an entry arrives, so a read lists
//! only the directories that changed since the cursor, and then only the files that arrived since:
//! its cost follows what is new, not what is there.
//!
//! The cursor holds a floor (every file that arrived before it has been given), the names of the
//! files given that arrived at or after it (a few: those of the last `WINDOW`, at most
//! `WIN_MAX`), and, part way through a long read, the position reached. One read gives the files
//! that arrived since the floor, oldest name first, so a library copied whole is read in the
//! order its writers wrote it.

use std::cmp::Ordering;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use pneuma_base_storage::{
    Ctx, Fact, FactsAppendAnswer, FactsAppendRequest, FactsSinceAnswer, FactsSinceRequest, Failure,
    RecordPlace, Time,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sys::{self, DirStream, Stat};
use crate::{LocalFolder, fnv64, io_failure};

/// A file that arrived this close before a read began may not yet have been visible to it, and
/// clocks step back a little: such files are named in the cursor rather than put under its floor.
const WINDOW_NS: i64 = 10_000_000_000;
/// The most files the cursor names; past it the floor rises over the oldest.
const WIN_MAX: usize = 32;
/// A directory's change time and the arrival time of an entry added to it are taken a moment
/// apart in the same call.
const SLACK_NS: i64 = 1_000_000_000;

/// This process's name in the files it writes; random, so writers on synced machines differ.
fn writer() -> &'static str {
    static WRITER: OnceLock<String> = OnceLock::new();
    WRITER.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_i128(Time::now().nanos());
        format!("{:012x}", hasher.finish() & 0xffff_ffff_ffff)
    })
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Where a facts file sits: the old layout (a scene directory) sorts before the dated one.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct Key {
    /// 0: old layout; 1: a day.
    l: u8,
    d: String,
    f: String,
}

impl Key {
    fn order(&self, line: u64) -> String {
        match self.l {
            0 => format!("old/{}/{}#{line}", self.d, self.f),
            _ => format!("{}/{}#{line}", self.d, self.f),
        }
    }

    fn id(&self) -> String {
        format!(
            "{:016x}",
            fnv64(format!("{}/{}", self.d, self.f).as_bytes())
        )
    }
}

/// How far into the current pass a read got.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Mark {
    k: Key,
    line: u64,
    byte: u64,
    whole: bool,
}

/// A pass over the files that arrived in `[floor, hi)`, part way through.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pass {
    hi: i64,
    at: Mark,
}

/// The cursor, serialized as the opaque string the kernel keeps.
#[derive(Serialize, Deserialize, Debug)]
struct Cursor {
    v: u32,
    /// The inode of `facts/` when the cursor was made; a cursor made on another folder no longer
    /// fits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fi: Option<u64>,
    /// Every file that arrived before this moment (ns) has been given; absent: none has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    floor: Option<i64>,
    /// The files given that arrived at or after the floor: their key's id and arrival.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    win: Vec<(String, i64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pass: Option<Pass>,
}

/// A facts file found by a read.
struct Arrived {
    key: Key,
    at: i64,
    path: PathBuf,
}

struct Collected {
    facts: Vec<Fact>,
    limit: usize,
}

struct Progress {
    line: u64,
    byte: u64,
    whole: bool,
}

fn refused() -> Failure {
    Failure::refused(None)
}

impl LocalFolder {
    fn facts_dir(&self, place: &RecordPlace) -> PathBuf {
        self.record_area().join(place.as_str()).join("facts")
    }

    pub fn append_facts(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure> {
        if req.facts.is_empty() {
            return Ok(FactsAppendAnswer { orders: Vec::new() });
        }
        let mut text = Vec::new();
        for fact in &req.facts {
            serde_json::to_writer(&mut text, fact).map_err(|_| Failure::bad_request())?;
            text.push(b'\n');
        }
        let now = Time::now();
        let day = now.day();
        let dir = self.facts_dir(&req.place).join(&day);
        fs::create_dir_all(&dir).map_err(|e| io_failure(&e))?;
        loop {
            let seq = SEQ.fetch_add(1, AtomicOrdering::Relaxed);
            let name = format!("{}-{}-{seq:06}.jsonl", now.stamp(), writer());
            // A whole file appears at its final name or nothing does: write a hidden temporary
            // name, then link it, which never replaces an existing file.
            let temp = dir.join(format!(".{name}.tmp"));
            let written = File::create_new(&temp).and_then(|mut file| {
                file.write_all(&text)?;
                file.sync_data()
            });
            if let Err(error) = written {
                let _ = fs::remove_file(&temp);
                return Err(io_failure(&error));
            }
            let linked = fs::hard_link(&temp, dir.join(&name));
            let _ = fs::remove_file(&temp);
            match linked {
                Ok(()) => {
                    let orders = (1..=req.facts.len())
                        .map(|line| format!("{day}/{name}#{line}"))
                        .collect();
                    return Ok(FactsAppendAnswer { orders });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_failure(&error)),
            }
        }
    }

    pub fn facts_after(
        &self,
        req: &FactsSinceRequest,
        ctx: &Ctx,
    ) -> Result<FactsSinceAnswer, Failure> {
        let facts_dir = self.facts_dir(&req.place);
        let cursor = match &req.cursor {
            None => Cursor {
                v: 2,
                fi: None,
                floor: None,
                win: Vec::new(),
                pass: None,
            },
            Some(text) => match serde_json::from_str::<Cursor>(text) {
                Ok(cursor) if cursor.v == 2 => cursor,
                // A cursor of the earlier layout no longer fits: the reader starts again.
                Ok(_) => return Err(refused()),
                Err(_) => return Err(Failure::bad_request()),
            },
        };
        let facts_stat = stat_dir(&facts_dir)?;
        if let Some(inode) = cursor.fi
            && facts_stat.map(|stat| stat.inode) != Some(inode)
        {
            return Err(refused());
        }
        let fi = facts_stat.map(|stat| stat.inode);
        if req.limit == 0 {
            return end_of_facts(&facts_dir, fi);
        }
        // Taken before any listing: a file that arrives after it belongs to the next pass.
        let hi = cursor
            .pass
            .as_ref()
            .map_or_else(|| Time::now().nanos() as i64, |pass| pass.hi);
        let mut arrived = Vec::new();
        let mut named = 0;
        let mut blind = false;
        // Listed now, though a floor raised to this read would let it be skipped.
        let mut stale = false;
        for dir in subdirs(&facts_dir)? {
            ctx.check()?;
            if cursor
                .floor
                .is_some_and(|floor| dir.changed < floor - SLACK_NS)
            {
                continue;
            }
            stale |= dir.changed < hi - WINDOW_NS - SLACK_NS;
            let Some(files) = files_of(&dir)? else {
                blind = true;
                continue;
            };
            for file in files {
                let id = file.key.id();
                if cursor.win.iter().any(|(known, _)| *known == id) {
                    named += 1;
                } else if cursor.floor.is_none_or(|floor| file.at >= floor) && file.at < hi {
                    arrived.push(file);
                }
            }
        }
        // A file the cursor names is gone: the facts were rewritten under it. (A directory that
        // cannot be read hides its files without removing them.)
        if named < cursor.win.len() && !blind {
            return Err(refused());
        }
        arrived.sort_by(|a, b| a.key.cmp(&b.key));
        // Nothing new: the same cursor, unless it makes every read list directories long settled
        // (after many arrived at once, as when a whole library is synced in); then it moves up.
        if arrived.is_empty()
            && cursor.pass.is_none()
            && !stale
            && let Some(text) = &req.cursor
        {
            return Ok(FactsSinceAnswer {
                facts: Vec::new(),
                cursor: text.clone(),
                more: false,
            });
        }
        let mut collected = Collected {
            facts: Vec::new(),
            limit: req.limit,
        };
        let resume = cursor.pass.as_ref().map(|pass| &pass.at);
        for file in &arrived {
            let (line, byte) = match resume.map(|at| file.key.cmp(&at.k)) {
                Some(Ordering::Less) => continue,
                Some(Ordering::Equal) => match resume {
                    Some(at) if !at.whole => (at.line, at.byte),
                    _ => continue,
                },
                _ => (0, 0),
            };
            let read = read_facts(&file.path, line, byte, &mut collected, |n| {
                file.key.order(n)
            })?;
            if !read.whole {
                let pass = Pass {
                    hi,
                    at: Mark {
                        k: file.key.clone(),
                        line: read.line,
                        byte: read.byte,
                        whole: false,
                    },
                };
                let cursor = Cursor {
                    pass: Some(pass),
                    fi,
                    ..cursor
                };
                return Ok(FactsSinceAnswer {
                    facts: collected.facts,
                    cursor: encode(&cursor),
                    more: true,
                });
            }
        }
        // The pass is complete: everything that arrived before `hi` has been given.
        let floor = cursor
            .floor
            .map_or(hi - WINDOW_NS, |f| f.max(hi - WINDOW_NS));
        let given = cursor
            .win
            .iter()
            .cloned()
            .chain(arrived.iter().map(|f| (f.key.id(), f.at)));
        let (floor, win) = window(floor, given);
        Ok(FactsSinceAnswer {
            facts: collected.facts,
            cursor: encode(&Cursor {
                v: 2,
                fi,
                floor: Some(floor),
                win,
                pass: None,
            }),
            more: false,
        })
    }
}

/// The files to name above `floor`, newest first kept; past `WIN_MAX` the floor rises.
fn window(floor: i64, given: impl Iterator<Item = (String, i64)>) -> (i64, Vec<(String, i64)>) {
    let mut win: Vec<(String, i64)> = given.filter(|(_, at)| *at >= floor).collect();
    win.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    win.dedup_by(|a, b| a.0 == b.0);
    let mut floor = floor;
    if win.len() > WIN_MAX {
        floor = win[WIN_MAX - 1].1;
        win.retain(|(_, at)| *at >= floor);
    }
    win.sort();
    (floor, win)
}

fn encode(cursor: &Cursor) -> String {
    serde_json::to_string(cursor).unwrap_or_default()
}

/// `limit` 0: a cursor after the newest fact, reading no facts. The floor sits one window below
/// the newest arrival, so the cursor depends only on what is there: the same text while nothing
/// arrives.
fn end_of_facts(facts_dir: &Path, fi: Option<u64>) -> Result<FactsSinceAnswer, Failure> {
    let mut dirs = subdirs(facts_dir)?;
    dirs.sort_by_key(|d| std::cmp::Reverse(d.changed));
    let mut newest: Option<i64> = None;
    let mut seen = Vec::new();
    for dir in &dirs {
        if newest.is_some_and(|n| dir.changed < n - WINDOW_NS - SLACK_NS) {
            break;
        }
        for file in files_of(dir)?.unwrap_or_default() {
            newest = Some(newest.map_or(file.at, |n| n.max(file.at)));
            seen.push((file.key.id(), file.at));
        }
    }
    let (floor, win) = match newest {
        Some(newest) => {
            let (floor, win) = window(newest + 1 - WINDOW_NS, seen.into_iter());
            (Some(floor), win)
        }
        None => (None, Vec::new()),
    };
    Ok(FactsSinceAnswer {
        facts: Vec::new(),
        cursor: encode(&Cursor {
            v: 2,
            fi,
            floor,
            win,
            pass: None,
        }),
        more: false,
    })
}

/// A directory of `facts/`: a day, or a scene of the old layout.
struct Subdir {
    path: PathBuf,
    name: String,
    layout: u8,
    changed: i64,
}

fn subdirs(facts_dir: &Path) -> Result<Vec<Subdir>, Failure> {
    let mut dirs = Vec::new();
    for name in list_dirs(facts_dir)? {
        let path = facts_dir.join(&name);
        let Some(stat) = stat_dir(&path)? else {
            continue;
        };
        dirs.push(Subdir {
            layout: u8::from(is_day(&name)),
            changed: stat.ctime_ns as i64,
            path,
            name,
        });
    }
    Ok(dirs)
}

/// When a file arrived in its directory: macOS keeps the moment each entry was added, which no
/// later change to the file moves; a sync service that dates it back still leaves its birth time.
fn arrival(dir: std::os::fd::RawFd, name: &std::ffi::CStr, stat: &Stat) -> i64 {
    match sys::added_at(dir, name) {
        Some(added) => added.max(stat.btime_ns.unwrap_or(added)) as i64,
        None => stat.ctime_ns as i64,
    }
}

/// The facts files of a directory, with when each arrived; `None` when it cannot be read, so
/// holds nothing that can be given.
fn files_of(dir: &Subdir) -> Result<Option<Vec<Arrived>>, Failure> {
    let fd = match sys::open_root(&dir.path) {
        Ok(fd) => fd,
        Err(libc::ENOENT | libc::ENOTDIR) => return Ok(Some(Vec::new())),
        Err(libc::EACCES | libc::EPERM) => return Ok(None),
        Err(errno) => return Err(Failure::unreadable(sys::errno_name(errno))),
    };
    let mut names = Vec::new();
    let mut stream = DirStream::open(&fd).map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
    while let Some(entry) = stream.next_entry() {
        let (name, _) = entry.map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
        if let Ok(name) = std::str::from_utf8(name)
            && !name.starts_with('.')
            && name.ends_with(".jsonl")
        {
            names.push(name.to_owned());
        }
    }
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let c_name = sys::c_name(name.as_bytes());
        let stat = match sys::stat_at(fd.as_raw_fd(), &c_name) {
            Ok(stat) if stat.kind == pneuma_base_storage::Kind::File => stat,
            _ => continue,
        };
        files.push(Arrived {
            at: arrival(fd.as_raw_fd(), &c_name, &stat),
            path: dir.path.join(&name),
            key: Key {
                l: dir.layout,
                d: dir.name.clone(),
                f: name,
            },
        });
    }
    Ok(Some(files))
}

/// Gives the facts of one file from a position on, until the limit; stops before the first
/// fact that does not fit, so `whole: false` means at least one more fact follows.
fn read_facts(
    path: &Path,
    line: u64,
    byte: u64,
    collected: &mut Collected,
    order: impl Fn(u64) -> String,
) -> Result<Progress, Failure> {
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => refused(),
        _ => io_failure(&e),
    })?;
    let mut reader = BufReader::with_capacity(1 << 16, file);
    if byte > 0 {
        reader
            .seek(SeekFrom::Start(byte))
            .map_err(|e| io_failure(&e))?;
    }
    let (mut line, mut byte) = (line, byte);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| io_failure(&e))?;
        if read == 0 {
            return Ok(Progress {
                line,
                byte,
                whole: true,
            });
        }
        if let Ok(Value::Object(fact)) = serde_json::from_slice::<Value>(&buffer) {
            if collected.facts.len() >= collected.limit {
                return Ok(Progress {
                    line,
                    byte,
                    whole: false,
                });
            }
            collected.facts.push(Fact {
                order: order(line + 1),
                fact: Value::Object(fact),
            });
        }
        line += 1;
        byte += read as u64;
    }
}

fn stat_dir(path: &Path) -> Result<Option<Stat>, Failure> {
    match sys::stat_path(path) {
        Ok(stat) => Ok(Some(stat)),
        Err(libc::ENOENT | libc::ENOTDIR) => Ok(None),
        Err(errno) => Err(Failure::unreadable(sys::errno_name(errno))),
    }
}

fn is_day(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Visible names in a directory, sorted, keeping directories or files; none when it is missing.
fn names_in(dir: &Path, dirs: bool) -> Result<Vec<String>, Failure> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
            return Ok(Vec::new());
        }
        Err(e) => return Err(io_failure(&e)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| io_failure(&e))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) == dirs {
            names.push(name);
        }
    }
    names.sort_unstable();
    Ok(names)
}

fn list_dirs(dir: &Path) -> Result<Vec<String>, Failure> {
    names_in(dir, true)
}
