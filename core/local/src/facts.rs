//! Facts: append only, one new file per append, in day directories, so that reading what is
//! new costs what is new.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use pneuma_base_storage::{
    Cancel, Fact, FactsAppendAnswer, FactsAppendRequest, FactsSinceAnswer, FactsSinceRequest,
    Failure, RecordPlace, Time,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sys::{self, Stat};
use crate::{LocalFolder, io_failure};

/// A file linked late is still given when its time is this close to the newest file covered.
const WINDOW_MS: i64 = 10_000;
/// A directory changed this close to when its token was taken may change again within the
/// same clock tick without its token moving; such a token does not vouch for "nothing new".
const SETTLED_MS: i64 = 2_000;

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

/// How far into one file a cursor has read: its directory (day or old scene), its name, the
/// lines and bytes consumed, and whether that is all of it.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Mark {
    d: String,
    f: String,
    l: u64,
    b: u64,
    w: bool,
}

impl Mark {
    fn before_all() -> Mark {
        Mark {
            d: String::new(),
            f: String::new(),
            l: 0,
            b: 0,
            w: true,
        }
    }

    fn time(&self) -> Option<i64> {
        Time::parse_stamp(&self.f).map(Time::millis)
    }
}

/// The cursor, serialized as the opaque string the kernel keeps.
#[derive(Serialize, Deserialize, Debug)]
struct Cursor {
    v: u32,
    /// The inode of `facts/` when the cursor was made; a cursor made on another folder no longer
    /// fits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fi: Option<u64>,
    /// Where the old layout is being read; absent once it has been read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    old: Option<Mark>,
    /// The furthest dated file read; absent before the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pos: Option<Mark>,
    /// Files before `pos` read within the late-link window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    win: Vec<Mark>,
    /// Present when the cursor reached the end: the tokens that vouch for "nothing new".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tok: Option<Tokens>,
}

/// No moment is kept, so the cursor at the end of facts that did not change is the same text
/// each time it is asked for: a reader can tell "nothing new" by comparing two of them.
#[derive(Serialize, Deserialize, Debug)]
struct Tokens {
    /// Whether every directory below had not changed for `SETTLED_MS` when its token was taken.
    settled: bool,
    facts: String,
    days: Vec<(String, String)>,
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
        cancel: &Cancel,
    ) -> Result<FactsSinceAnswer, Failure> {
        let facts_dir = self.facts_dir(&req.place);
        let mut cursor = match &req.cursor {
            None => Cursor {
                v: 1,
                fi: None,
                old: Some(Mark::before_all()),
                pos: None,
                win: Vec::new(),
                tok: None,
            },
            Some(text) => serde_json::from_str::<Cursor>(text)
                .ok()
                .filter(|cursor| cursor.v == 1)
                .ok_or_else(Failure::bad_request)?,
        };
        let facts_stat = stat_dir(&facts_dir)?;
        if let Some(inode) = cursor.fi
            && facts_stat.map(|stat| stat.inode) != Some(inode)
        {
            return Err(refused());
        }
        // Taken before any listing: a change after it leaves its directory unsettled.
        let started = Time::now().millis();
        if req.limit == 0 {
            return end_of_facts(&facts_dir, facts_stat, started);
        }
        if let (Some(text), None, Some(tokens)) = (&req.cursor, &cursor.old, &cursor.tok)
            && tokens_hold(&facts_dir, facts_stat, tokens)
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
        let mut stopped = false;
        if let Some(old) = cursor.old.take()
            && let Some(mark) = scan_old(&facts_dir, old, &mut collected, cancel)?
        {
            cursor.old = Some(mark);
            stopped = true;
        }
        let days = list_days(&facts_dir)?;
        if !stopped {
            stopped = scan_dated(&facts_dir, &days, &mut cursor, &mut collected, cancel)?;
        }
        cursor.fi = facts_stat.map(|stat| stat.inode);
        cursor.tok = if stopped {
            None
        } else {
            take_tokens(&facts_dir, facts_stat, &days, cursor.pos.as_ref(), started)?
        };
        Ok(FactsSinceAnswer {
            facts: collected.facts,
            cursor: encode(&cursor),
            more: stopped,
        })
    }
}

fn encode(cursor: &Cursor) -> String {
    serde_json::to_string(cursor).unwrap_or_default()
}

/// `limit` 0: a cursor after the newest fact, reading no facts and listing only the newest days.
fn end_of_facts(
    facts_dir: &Path,
    facts_stat: Option<Stat>,
    started: i64,
) -> Result<FactsSinceAnswer, Failure> {
    let days = list_days(facts_dir)?;
    let mut newest: Option<(Mark, Vec<String>)> = None;
    for day in days.iter().rev() {
        let files = list_files(&facts_dir.join(day))?;
        if let Some(last) = files.last() {
            let mark = Mark {
                d: day.clone(),
                f: last.clone(),
                l: 0,
                b: 0,
                w: true,
            };
            newest = Some((mark, files));
            break;
        }
    }
    let mut win = Vec::new();
    if let Some((pos, newest_files)) = &newest {
        let first = window_first_day(Some(pos));
        let window_start = pos.time().map(|t| t - WINDOW_MS);
        for day in days
            .iter()
            .filter(|d| first.as_ref().is_some_and(|f| *d >= f) && **d <= pos.d)
        {
            let files = if *day == pos.d {
                newest_files.clone()
            } else {
                list_files(&facts_dir.join(day))?
            };
            for file in files {
                let before = (day.as_str(), file.as_str()) < (pos.d.as_str(), pos.f.as_str());
                let recent = Time::parse_stamp(&file)
                    .zip(window_start)
                    .is_some_and(|(t, start)| t.millis() >= start);
                if before && recent {
                    win.push(Mark {
                        d: day.clone(),
                        f: file,
                        l: 0,
                        b: 0,
                        w: true,
                    });
                }
            }
        }
    }
    let pos = newest.map(|(mark, _)| mark);
    let tok = take_tokens(facts_dir, facts_stat, &days, pos.as_ref(), started)?;
    let cursor = Cursor {
        v: 1,
        fi: facts_stat.map(|stat| stat.inode),
        old: None,
        pos,
        win,
        tok,
    };
    Ok(FactsSinceAnswer {
        facts: Vec::new(),
        cursor: encode(&cursor),
        more: false,
    })
}

/// The first day a late-linked file could still be given in, or `None` for every day.
fn window_first_day(pos: Option<&Mark>) -> Option<String> {
    let pos = pos?;
    Some(match pos.time() {
        Some(time) => pos.d.clone().min(Time::from_millis(time - WINDOW_MS).day()),
        None => pos.d.clone(),
    })
}

fn take_tokens(
    facts_dir: &Path,
    facts_stat: Option<Stat>,
    days: &[String],
    pos: Option<&Mark>,
    at: i64,
) -> Result<Option<Tokens>, Failure> {
    let Some(stat) = facts_stat else {
        return Ok(None);
    };
    let quiet = |s: &Stat| s.mtime_ns <= i128::from(at - SETTLED_MS) * 1_000_000;
    let first = window_first_day(pos);
    let mut tokens = Vec::new();
    let mut settled = quiet(&stat);
    for day in days
        .iter()
        .filter(|d| first.as_ref().is_none_or(|f| *d >= f))
    {
        if let Some(day_stat) = stat_dir(&facts_dir.join(day))? {
            settled &= quiet(&day_stat);
            tokens.push((day.clone(), day_stat.token().as_str().to_owned()));
        }
    }
    Ok(Some(Tokens {
        settled,
        facts: stat.token().as_str().to_owned(),
        days: tokens,
    }))
}

/// Nothing new when `facts/` and every day the cursor could still read from have the tokens
/// the cursor carries, and none of them changed close to when those were taken.
fn tokens_hold(facts_dir: &Path, facts_stat: Option<Stat>, tokens: &Tokens) -> bool {
    let Some(stat) = facts_stat else {
        return false;
    };
    tokens.settled
        && stat.token().as_str() == tokens.facts
        && tokens.days.iter().all(|(day, token)| {
            matches!(stat_dir(&facts_dir.join(day)), Ok(Some(s)) if s.token().as_str() == token)
        })
}

fn scan_old(
    facts_dir: &Path,
    mark: Mark,
    collected: &mut Collected,
    cancel: &Cancel,
) -> Result<Option<Mark>, Failure> {
    if !mark.d.is_empty() && sys::stat_path(&facts_dir.join(&mark.d).join(&mark.f)).is_err() {
        return Err(refused());
    }
    for scene in list_dirs(facts_dir)?
        .into_iter()
        .filter(|name| !is_day(name) && *name >= mark.d)
    {
        cancel.check()?;
        for file in list_files(&facts_dir.join(&scene))? {
            let resume = if scene == mark.d {
                match file.cmp(&mark.f) {
                    Ordering::Less => None,
                    Ordering::Equal => (!mark.w).then_some((mark.l, mark.b)),
                    Ordering::Greater => Some((0, 0)),
                }
            } else {
                Some((0, 0))
            };
            let Some((line, byte)) = resume else {
                continue;
            };
            let path = facts_dir.join(&scene).join(&file);
            let read = read_facts(&path, line, byte, collected, |n| {
                format!("old/{scene}/{file}#{n}")
            })?;
            if !read.whole {
                return Ok(Some(Mark {
                    d: scene,
                    f: file,
                    l: read.line,
                    b: read.byte,
                    w: false,
                }));
            }
        }
    }
    Ok(None)
}

/// Reads the dated files after the cursor, and the late-linked ones before it. True when it
/// stopped at the limit with more facts to come.
fn scan_dated(
    facts_dir: &Path,
    days: &[String],
    cursor: &mut Cursor,
    collected: &mut Collected,
    cancel: &Cancel,
) -> Result<bool, Failure> {
    let start = cursor.pos.clone();
    if let Some(pos) = &start
        && sys::stat_path(&facts_dir.join(&pos.d).join(&pos.f)).is_err()
    {
        return Err(refused());
    }
    let window_start = start.as_ref().and_then(Mark::time).map(|t| t - WINDOW_MS);
    let first_day = window_first_day(start.as_ref());
    let mut window: HashMap<(String, String), Mark> = cursor
        .win
        .drain(..)
        .map(|mark| ((mark.d.clone(), mark.f.clone()), mark))
        .collect();
    let mut stopped = false;
    'days: for day in days
        .iter()
        .filter(|d| first_day.as_ref().is_none_or(|f| *d >= f))
    {
        cancel.check()?;
        for file in list_files(&facts_dir.join(day))? {
            let side = start.as_ref().map_or(Ordering::Greater, |pos| {
                (day.as_str(), file.as_str()).cmp(&(pos.d.as_str(), pos.f.as_str()))
            });
            let resume = match side {
                Ordering::Greater => Some((0, 0)),
                Ordering::Equal => start
                    .as_ref()
                    .filter(|pos| !pos.w)
                    .map(|pos| (pos.l, pos.b)),
                Ordering::Less => {
                    let late = Time::parse_stamp(&file)
                        .zip(window_start)
                        .is_some_and(|(t, start)| t.millis() >= start);
                    match window.get(&(day.clone(), file.clone())) {
                        _ if !late => None,
                        Some(mark) if mark.w => None,
                        Some(mark) => Some((mark.l, mark.b)),
                        None => Some((0, 0)),
                    }
                }
            };
            let Some((line, byte)) = resume else {
                continue;
            };
            let path = facts_dir.join(day).join(&file);
            let read = read_facts(&path, line, byte, collected, |n| {
                format!("{day}/{file}#{n}")
            })?;
            let mark = Mark {
                d: day.clone(),
                f: file.clone(),
                l: read.line,
                b: read.byte,
                w: read.whole,
            };
            if side == Ordering::Less {
                window.insert((day.clone(), file.clone()), mark);
            } else if let Some(previous) = cursor.pos.replace(mark)
                && (previous.d != *day || previous.f != file)
            {
                window.insert((previous.d.clone(), previous.f.clone()), previous);
            }
            if !read.whole {
                stopped = true;
                break 'days;
            }
        }
    }
    let window_start = cursor
        .pos
        .as_ref()
        .and_then(Mark::time)
        .map(|t| t - WINDOW_MS);
    let mut win: Vec<Mark> = window
        .into_values()
        .filter(|mark| {
            mark.time()
                .zip(window_start)
                .is_some_and(|(t, start)| t >= start)
        })
        .collect();
    win.sort_by(|a, b| (&a.d, &a.f).cmp(&(&b.d, &b.f)));
    cursor.win = win;
    Ok(stopped)
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

fn list_days(facts_dir: &Path) -> Result<Vec<String>, Failure> {
    Ok(list_dirs(facts_dir)?
        .into_iter()
        .filter(|name| is_day(name))
        .collect())
}

fn list_files(dir: &Path) -> Result<Vec<String>, Failure> {
    Ok(names_in(dir, false)?
        .into_iter()
        .filter(|name| name.ends_with(".jsonl"))
        .collect())
}
