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
use std::io::{Read, Seek, SeekFrom, Write};
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
/// How many threads read a page's files, and how many neighbouring files each takes at a time.
/// Opening a file is most of reading a small one; on an Apple-silicon Mac more than four threads
/// opening files in the same folders wait on each other.
const READERS: usize = 4;
const READ_RUN: usize = 64;
/// A facts file no longer than this from where a page starts in it is read in one call.
const WHOLE_READ: u64 = 1 << 20;
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
    /// The newest files the pass gave so far, as `window` keeps them: all its end needs to name
    /// above the new floor, so no page lists what earlier pages gave.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    top: Vec<(String, i64)>,
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
    /// Its directory, open: a file is opened by its name in it, not by its whole path.
    dir: std::sync::Arc<std::os::fd::OwnedFd>,
    name: std::ffi::CString,
    /// Its size as listed: a facts file is written whole once, so one read of that much reads it.
    size: u64,
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
                crate::sys::fsync(&file)
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
        let resume = cursor.pass.as_ref().map(|pass| &pass.at);
        // Directories in the order of the keys of their files, so a page lists only from where
        // the pass got to, and only until it is full: its cost follows the page.
        let mut dirs = subdirs(&facts_dir)?;
        dirs.retain(|dir| {
            cursor
                .floor
                .is_none_or(|floor| dir.changed >= floor - SLACK_NS)
        });
        dirs.sort_by(|a, b| (a.layout, &a.name).cmp(&(b.layout, &b.name)));
        // Listed now, though a floor raised to this read would let it be skipped.
        let stale = dirs
            .iter()
            .any(|dir| dir.changed < hi - WINDOW_NS - SLACK_NS);
        let files = match req.cursor {
            None => Some(count_files(&dirs)?),
            Some(_) => None,
        };
        // The files the cursor names are looked for on a pass's first page, in every directory
        // they can be in; the pages after it only read on.
        let find_named = resume.is_none() && !cursor.win.is_empty();
        let mut named = 0;
        let mut blind = false;
        let mut arrived_any = false;
        // The files to read, in key order from where the pass got to: no more than the page has
        // room for facts, since each file holds at least one.
        let mut todo: Vec<(Arrived, u64, u64)> = Vec::new();
        let mut cut = false;
        for dir in &dirs {
            ctx.check()?;
            let room = todo.len() < req.limit;
            let reading = room
                && resume.is_none_or(|at| (dir.layout, dir.name.as_str()) >= (at.k.l, &*at.k.d));
            cut |= !room;
            if !reading && !find_named {
                continue;
            }
            let Some(files) = files_of(dir)? else {
                blind = true;
                continue;
            };
            let mut arrived = Vec::new();
            for file in files {
                let id = file.key.id();
                if cursor.win.iter().any(|(known, _)| *known == id) {
                    named += 1;
                } else if cursor.floor.is_none_or(|floor| file.at >= floor) && file.at < hi {
                    arrived.push(file);
                }
            }
            if !reading {
                continue;
            }
            arrived_any |= !arrived.is_empty();
            arrived.sort_by(|a, b| a.key.cmp(&b.key));
            for file in arrived {
                let (line, byte) = match resume.map(|at| file.key.cmp(&at.k)) {
                    Some(Ordering::Less) => continue,
                    Some(Ordering::Equal) => match resume {
                        Some(at) if !at.whole => (at.line, at.byte),
                        _ => continue,
                    },
                    _ => (0, 0),
                };
                if todo.len() == req.limit {
                    cut = true;
                    break;
                }
                todo.push((file, line, byte));
            }
        }
        let mut given = Vec::new();
        let mut stopped = None;
        let mut last_whole = None;
        let mut collected = Vec::new();
        'files: for ((file, ..), read) in todo.iter().zip(read_files(&todo, req.limit + 1)) {
            let read = read?;
            for (line, byte, fact) in read.facts {
                if collected.len() == req.limit {
                    stopped = Some(Mark {
                        k: file.key.clone(),
                        line,
                        byte,
                        whole: false,
                    });
                    break 'files;
                }
                collected.push(Fact {
                    order: file.key.order(line + 1),
                    fact: Value::Object(fact),
                });
            }
            given.push((file.key.id(), file.at));
            last_whole = Some(Mark {
                k: file.key.clone(),
                line: read.end.0,
                byte: read.end.1,
                whole: true,
            });
        }
        // Listing stopped with the page full of files: the next page goes on after the last one read.
        if stopped.is_none() && cut {
            stopped = last_whole;
        }
        // A file the cursor names is gone: the facts were rewritten under it. (A directory that
        // cannot be read hides its files without removing them.)
        if find_named && named < cursor.win.len() && !blind {
            return Err(refused());
        }
        // Nothing new: the same cursor, unless it makes every read list directories long settled
        // (after many arrived at once, as when a whole library is synced in); then it moves up.
        if !arrived_any
            && resume.is_none()
            && !stale
            && let Some(text) = &req.cursor
        {
            return Ok(FactsSinceAnswer {
                facts: Vec::new(),
                cursor: text.clone(),
                more: false,
                files,
            });
        }
        let earlier = cursor
            .pass
            .as_ref()
            .map(|pass| pass.top.clone())
            .unwrap_or_default();
        if let Some(at) = stopped {
            let (_, top) = window(hi - WINDOW_NS, earlier.into_iter().chain(given));
            let cursor = Cursor {
                pass: Some(Pass { hi, at, top }),
                fi,
                ..cursor
            };
            return Ok(FactsSinceAnswer {
                facts: collected,
                cursor: encode(&cursor),
                more: true,
                files,
            });
        }
        // The pass is complete: everything that arrived before `hi` has been given.
        let floor = cursor
            .floor
            .map_or(hi - WINDOW_NS, |f| f.max(hi - WINDOW_NS));
        let given = cursor.win.iter().cloned().chain(earlier).chain(given);
        let (floor, win) = window(floor, given);
        Ok(FactsSinceAnswer {
            facts: collected,
            cursor: encode(&Cursor {
                v: 2,
                fi,
                floor: Some(floor),
                win,
                pass: None,
            }),
            more: false,
            files,
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
        files: None,
    })
}

/// How many facts files the directories hold, by their names: no file is opened or stat'ed.
fn count_files(dirs: &[Subdir]) -> Result<u64, Failure> {
    let mut n = 0;
    for dir in dirs {
        let fd = match sys::open_root(&dir.path) {
            Ok(fd) => fd,
            Err(libc::ENOENT | libc::ENOTDIR | libc::EACCES | libc::EPERM) => continue,
            Err(errno) => return Err(Failure::unreadable(sys::errno_name(errno))),
        };
        let mut stream =
            DirStream::open(&fd).map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
        while let Some(entry) = stream.next_entry() {
            let (name, kind) = entry.map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
            if kind != sys::EntryType::Dir && !name.starts_with(b".") && name.ends_with(b".jsonl") {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// A directory of facts files: a day, a scene of the old layout, or `facts/` itself (the flat old layout, named `""`).
struct Subdir {
    path: PathBuf,
    name: String,
    layout: u8,
    changed: i64,
}

fn subdirs(facts_dir: &Path) -> Result<Vec<Subdir>, Failure> {
    let mut dirs = Vec::new();
    // The flat old layout: facts files right in `facts/`, as plugins wrote them before storage did.
    if let Some(stat) = stat_dir(facts_dir)? {
        dirs.push(Subdir {
            layout: 0,
            changed: stat.ctime_ns as i64,
            path: facts_dir.to_path_buf(),
            name: String::new(),
        });
    }
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
    let unreadable = |e| Failure::unreadable(sys::errno_name(e));
    let is_facts = |name: &str| !name.starts_with('.') && name.ends_with(".jsonl");
    // (name, arrival, size) of each regular file.
    let mut found = Vec::new();
    match sys::listed(fd.as_raw_fd()) {
        Some(entries) => {
            for e in entries.map_err(unreadable)? {
                if let Ok(name) = String::from_utf8(e.name)
                    && e.file
                    && is_facts(&name)
                {
                    let at = match e.added_ns {
                        Some(added) => added.max(e.btime_ns.unwrap_or(added)),
                        None => e.ctime_ns,
                    };
                    found.push((name, at as i64, e.size));
                }
            }
        }
        None => {
            let mut names = Vec::new();
            let mut stream = DirStream::open(&fd).map_err(unreadable)?;
            while let Some(entry) = stream.next_entry() {
                let (name, _) = entry.map_err(unreadable)?;
                if let Ok(name) = std::str::from_utf8(name)
                    && is_facts(name)
                {
                    names.push(name.to_owned());
                }
            }
            for name in names {
                let c_name = sys::c_name(name.as_bytes());
                if let Ok(stat) = sys::stat_at(fd.as_raw_fd(), &c_name)
                    && stat.kind == pneuma_base_storage::Kind::File
                {
                    let at = arrival(fd.as_raw_fd(), &c_name, &stat);
                    found.push((name, at, stat.size));
                }
            }
        }
    }
    let fd = std::sync::Arc::new(fd);
    Ok(Some(
        found
            .into_iter()
            .map(|(name, at, size)| Arrived {
                at,
                size,
                dir: fd.clone(),
                name: sys::c_name(name.as_bytes()),
                key: Key {
                    l: dir.layout,
                    d: dir.name.clone(),
                    f: name,
                },
            })
            .collect(),
    ))
}

/// The facts of one file from a position on, at most as many as asked: each with its line and the
/// byte it starts at, and where the file ends when they all fit.
struct FileFacts {
    facts: Vec<(u64, u64, serde_json::Map<String, Value>)>,
    end: (u64, u64),
}

fn facts_in(file: &Arrived, line: u64, byte: u64, most: usize) -> Result<FileFacts, Failure> {
    let file_size = file.size;
    let mut file =
        sys::open_file_at(file.dir.as_raw_fd(), &file.name).map_err(|errno| match errno {
            libc::ENOENT => refused(),
            _ => Failure::unreadable(sys::errno_name(errno)),
        })?;
    if byte > 0 {
        file.seek(SeekFrom::Start(byte))
            .map_err(|e| io_failure(&e))?;
    }
    // A long file (one of the old layout) is read a line at a time, only as far as the page needs.
    if file_size.saturating_sub(byte) > WHOLE_READ {
        let mut reader = std::io::BufReader::with_capacity(1 << 16, file);
        let mut facts = Lines::new(line, byte, most);
        let mut one = Vec::new();
        while !facts.full() {
            one.clear();
            if std::io::BufRead::read_until(&mut reader, b'\n', &mut one)
                .map_err(|e| io_failure(&e))?
                == 0
            {
                break;
            }
            facts.take(&one);
        }
        return Ok(facts.done());
    }
    // One read of the size listed, into a buffer kept for the next file: a short read is the
    // end. A file longer than listed is read on.
    thread_local! {
        static TEXT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    let want = usize::try_from(file_size.saturating_sub(byte)).unwrap_or(usize::MAX - 1) + 1;
    TEXT.with_borrow_mut(|text| {
        if text.len() < want {
            text.resize(want.next_power_of_two(), 0);
        }
        let mut len = 0;
        loop {
            match file.read(&mut text[len..]) {
                Ok(0) => break,
                Ok(n) => {
                    len += n;
                    if len < want {
                        break;
                    }
                    if len == text.len() {
                        text.resize(len * 2, 0);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io_failure(&e)),
            }
        }
        let mut facts = Lines::new(line, byte, most);
        for one in text[..len].split_inclusive(|b| *b == b'\n') {
            if facts.full() {
                break;
            }
            facts.take(one);
        }
        Ok(facts.done())
    })
}

/// The facts of a file taken line by line from a position on, until `most`.
struct Lines {
    line: u64,
    byte: u64,
    most: usize,
    facts: Vec<(u64, u64, serde_json::Map<String, Value>)>,
}

impl Lines {
    fn new(line: u64, byte: u64, most: usize) -> Self {
        Lines {
            line,
            byte,
            most,
            facts: Vec::new(),
        }
    }

    fn full(&self) -> bool {
        self.facts.len() >= self.most
    }

    fn take(&mut self, one: &[u8]) {
        if let Ok(Value::Object(fact)) = serde_json::from_slice::<Value>(one) {
            self.facts.push((self.line, self.byte, fact));
        }
        self.line += 1;
        self.byte += one.len() as u64;
    }

    fn done(self) -> FileFacts {
        FileFacts {
            facts: self.facts,
            end: (self.line, self.byte),
        }
    }
}

/// Reads the files of a page, in order, several at once, at most `most` facts of each (one more than
/// the page holds, so a file that does not fit is seen not to): a file not in memory yet costs a wait
/// on the disk, which reading one file at a time pays once per file.
fn read_files(todo: &[(Arrived, u64, u64)], most: usize) -> Vec<Result<FileFacts, Failure>> {
    let read = |part: &[(Arrived, u64, u64)]| {
        part.iter()
            .map(|(file, line, byte)| facts_in(file, *line, *byte, most))
            .collect::<Vec<_>>()
    };
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(READERS));
    if threads < 2 || todo.len() < 2 * READ_RUN {
        return read(todo);
    }
    // Runs of neighbouring files handed out in turn, so every reader keeps busy to the end.
    let runs: Vec<_> = todo.chunks(READ_RUN).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut done: Vec<Option<Vec<Result<FileFacts, Failure>>>> = Vec::new();
    done.resize_with(runs.len(), || None);
    let done = std::sync::Mutex::new(done);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(run) = runs.get(i) else { break };
                    let facts = read(run);
                    done.lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)[i] = Some(facts);
                }
            });
        }
    });
    let done = done
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    done.into_iter()
        .zip(&runs)
        .flat_map(|(facts, run)| facts.unwrap_or_else(|| read(run)))
        .collect()
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
