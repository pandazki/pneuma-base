//! The content rule: which files under a directory are its content. Never the library's noise
//! (rule 7), nor the names the caller adds, nor what the named ignore file excludes, in each
//! directory where there is one. The storage applies the rule; it does not choose it.

use std::collections::HashSet;
use std::io::Read;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use pneuma_base_storage::{ContentRule, Ctx, Failure, Kind, Place};

use crate::noise::Noise;
use crate::sys::{self, DirStream, EntryType, Errno, Stat};

/// A place the walked directory is, or will be once copied, in its area: the noise that applies
/// there (none in a record place's own area) and the name the area keeps out of its root level.
pub struct Side<'a> {
    pub noise: &'a Noise,
    pub base: Place,
    pub hidden: &'static str,
}

/// The rule as one walk applies it: what any of its sides leaves out is left out, so a copy
/// neither enters its source's noise nor puts noise where it lands.
pub struct Matcher<'a> {
    sides: &'a [Side<'a>],
    names: HashSet<&'a str>,
    ignore_file: Option<&'a str>,
}

impl<'a> Matcher<'a> {
    pub fn new(sides: &'a [Side<'a>], rule: &'a ContentRule) -> Matcher<'a> {
        Matcher {
            sides,
            names: rule.noise.iter().map(String::as_str).collect(),
            ignore_file: rule.ignore_file.as_deref(),
        }
    }
}

/// One file of the content: its path under the walked directory.
pub struct Found {
    pub path: String,
    pub stat: Stat,
}

/// A directory of the content, given before what is in it.
pub struct FoundDir {
    pub path: String,
}

pub struct Walked {
    /// Sorted by the bytes of their paths.
    pub files: Vec<Found>,
    /// Every directory that holds content, outermost first, the walked one excluded.
    pub dirs: Vec<FoundDir>,
    pub bytes: u64,
}

fn unreadable(errno: Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

/// A directory on the way down: open only while it or something below it is being listed.
struct Level {
    fd: OwnedFd,
    path: String,
    /// The ignore file of this directory, if it has one.
    ignore: Option<Gitignore>,
}

/// Lists the content of the directory open at `top`, depth first, never following a link and
/// never entering what the rule leaves out. Stops with `too_many` past `limit` files. Only the
/// directories from `top` to the one being listed are open at any time.
pub fn walk(top: OwnedFd, matcher: &Matcher, limit: u64, ctx: &Ctx) -> Result<Walked, Failure> {
    let mut walked = Walked {
        files: Vec::new(),
        dirs: Vec::new(),
        bytes: 0,
    };
    let mut levels: Vec<Level> = Vec::new();
    let mut top = Some(top);
    // Each entry: the directory's name in its parent, its path, its depth.
    let mut stack: Vec<(String, String, usize)> = vec![(String::new(), String::new(), 0)];
    while let Some((name, path, depth)) = stack.pop() {
        ctx.check()?;
        levels.truncate(depth);
        let fd = match top.take() {
            Some(fd) => fd,
            None => {
                let parent = levels[depth - 1].fd.as_raw_fd();
                match sys::open_dir_at(parent, &sys::c_name(name.as_bytes())) {
                    Ok(fd) => fd,
                    Err(libc::ENOENT) => continue,
                    Err(errno) => return Err(unreadable(errno)),
                }
            }
        };
        let ignore = matcher
            .ignore_file
            .and_then(|file| read_ignore(fd.as_raw_fd(), file));
        let mut names = Vec::new();
        let mut stream = DirStream::open(&fd).map_err(unreadable)?;
        while let Some(entry) = stream.next_entry() {
            let (entry_name, kind) = entry.map_err(unreadable)?;
            if let Ok(entry_name) = std::str::from_utf8(entry_name) {
                names.push((entry_name.to_owned(), kind));
            }
        }
        drop(stream);
        levels.push(Level {
            fd,
            path: path.clone(),
            ignore,
        });
        let dir = levels[depth].fd.as_raw_fd();
        names.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let mut subdirs = Vec::new();
        for (entry_name, kind) in names {
            let child = if path.is_empty() {
                entry_name.clone()
            } else {
                format!("{path}/{entry_name}")
            };
            if kind == EntryType::Other || leaves_out(matcher, &levels, &child, &entry_name) {
                continue;
            }
            let stat = match sys::stat_at(dir, &sys::c_name(entry_name.as_bytes())) {
                Ok(stat) => stat,
                Err(libc::ENOENT) => continue,
                Err(errno) => return Err(unreadable(errno)),
            };
            match stat.kind {
                Kind::File if !ignored(&levels, &child, false) => {
                    if walked.files.len() as u64 >= limit {
                        return Err(Failure::too_many(limit + 1));
                    }
                    walked.bytes += stat.size;
                    walked.files.push(Found { path: child, stat });
                }
                Kind::Dir if !ignored(&levels, &child, true) => {
                    walked.dirs.push(FoundDir {
                        path: child.clone(),
                    });
                    subdirs.push((entry_name, child));
                }
                _ => {}
            }
        }
        // Depth first, in name order: push in reverse so the first name is walked first.
        for (entry_name, child) in subdirs.into_iter().rev() {
            stack.push((entry_name, child, depth + 1));
        }
    }
    walked
        .files
        .sort_unstable_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(walked)
}

/// The caller's names, and on any side noise and what the area keeps out of its root.
fn leaves_out(matcher: &Matcher, levels: &[Level], child: &str, name: &str) -> bool {
    if matcher.names.contains(name) {
        return true;
    }
    matcher.sides.iter().any(|side| {
        if side.noise.is_noise_name(name)
            || (side.base.is_root() && levels.len() == 1 && name == side.hidden)
        {
            return true;
        }
        let place = Place::parse(&if side.base.is_root() {
            child.to_owned()
        } else {
            format!("{}/{child}", side.base.as_str())
        });
        place.is_some_and(|p| side.noise.is_noise(&p))
    })
}

/// What the nearest ignore file that has a say about the path says.
fn ignored(levels: &[Level], child: &str, is_dir: bool) -> bool {
    for level in levels.iter().rev() {
        let Some(ignore) = &level.ignore else {
            continue;
        };
        let relative = if level.path.is_empty() {
            child
        } else {
            child
                .strip_prefix(level.path.as_str())
                .and_then(|r| r.strip_prefix('/'))
                .unwrap_or(child)
        };
        match ignore.matched(relative, is_dir) {
            Match::Ignore(_) => return true,
            Match::Whitelist(_) => return false,
            Match::None => {}
        }
    }
    false
}

fn read_ignore(dir: RawFd, name: &str) -> Option<Gitignore> {
    let file = sys::open_file_at(dir, &sys::c_name(name.as_bytes())).ok()?;
    let mut text = String::new();
    file.take(1 << 20).read_to_string(&mut text).ok()?;
    let mut builder = GitignoreBuilder::new("/");
    for line in text.lines() {
        let _ = builder.add_line(None, line);
    }
    builder.build().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher_of(text: &str) -> Gitignore {
        let mut builder = GitignoreBuilder::new("/");
        for line in text.lines() {
            builder.add_line(None, line).unwrap();
        }
        builder.build().unwrap()
    }

    #[test]
    fn the_nearest_ignore_file_decides() {
        let top = Level {
            fd: sys::open_root(std::path::Path::new("/")).unwrap(),
            path: String::new(),
            ignore: Some(matcher_of("*.log\nbuild/\n")),
        };
        let sub = Level {
            fd: sys::open_root(std::path::Path::new("/")).unwrap(),
            path: "keep".into(),
            ignore: Some(matcher_of("!important.log\n")),
        };
        let levels = [top, sub];
        assert!(ignored(&levels[..1], "a.log", false));
        assert!(ignored(&levels[..1], "build", true));
        assert!(!ignored(&levels[..1], "build", false));
        assert!(!ignored(&levels, "keep/important.log", false));
        assert!(ignored(&levels, "keep/other.log", false));
        assert!(!ignored(&levels, "keep/notes.md", false));
    }
}
