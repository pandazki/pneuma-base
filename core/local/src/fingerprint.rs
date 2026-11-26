//! `content` and `read`: the only reads of bytes. A file's fingerprint is the SHA-256 of its
//! bytes; a directory's is the SHA-256 of its manifest, `<path>\0<file fingerprint>\n` for each
//! file of its content in the byte order of the paths (the kernel's bundle fingerprint, kept so
//! fingerprints already in the records still compare). Each answer carries the token of the
//! version it read: the state is taken before and after, and a read that saw a change is tried
//! again.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;

use pneuma_base_storage::{
    After, ContentAnswer, ContentRequest, Ctx, Failure, Kind, Manifest, ManifestEntry,
    ManifestPage, Place, ReadAnswer, ReadRequest, Reason, base64, request::DATA_MAX,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::facets::{self, At};
use crate::metadata::{Broken, Walker};
use crate::rule::{self, Matcher, Side};
use crate::sys::{self, Errno, Fetching, Stat};
use crate::{LocalFolder, io_failure};

/// How many times a read that saw the place change under it is tried again.
const TRIES: usize = 3;
const CHUNK: usize = 1 << 20;
/// Progress goes out at most this often.
const PROGRESS_EVERY_NS: i128 = 100_000_000;

fn unreadable(errno: Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads a whole file through SHA-256, telling `seen` how many bytes went by.
pub fn hash_reader(
    reader: &mut impl Read,
    ctx: &Ctx,
    mut seen: impl FnMut(u64),
) -> Result<(String, u64), Failure> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        ctx.check()?;
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(read_failure(&e)),
        };
        hasher.update(&buffer[..n]);
        total += n as u64;
        seen(n as u64);
    }
    Ok((hex(&hasher.finalize()), total))
}

/// Copies `reader` to `writer` and fingerprints it in the same pass.
pub fn copy_hashing(
    reader: &mut impl Read,
    writer: &mut impl Write,
    ctx: &Ctx,
    mut seen: impl FnMut(u64),
) -> Result<(String, u64), Failure> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        ctx.check()?;
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(read_failure(&e)),
        };
        writer.write_all(&buffer[..n]).map_err(|e| io_failure(&e))?;
        hasher.update(&buffer[..n]);
        total += n as u64;
        seen(n as u64);
    }
    Ok((hex(&hasher.finalize()), total))
}

/// A placeholder's content cannot be read without its provider fetching it (`EDEADLK` while
/// fetching is off).
fn read_failure(error: &std::io::Error) -> Failure {
    match error.raw_os_error() {
        Some(libc::EDEADLK) => Failure::new(Reason::Elsewhere),
        _ => io_failure(error),
    }
}

pub fn manifest_fingerprint<'a>(entries: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    let mut hasher = Sha256::new();
    for (path, fingerprint) in entries {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(fingerprint.as_bytes());
        hasher.update(b"\n");
    }
    hex(&hasher.finalize())
}

/// Sends progress no more often than every 100 ms.
pub struct Progress<'a> {
    ctx: &'a Ctx,
    last: i128,
    pub files: u64,
    pub bytes: u64,
    pub total_files: Option<u64>,
    pub total_bytes: Option<u64>,
}

impl<'a> Progress<'a> {
    pub fn new(ctx: &'a Ctx, total_files: Option<u64>, total_bytes: Option<u64>) -> Progress<'a> {
        Progress {
            ctx,
            last: pneuma_base_storage::Time::now().nanos(),
            files: 0,
            bytes: 0,
            total_files,
            total_bytes,
        }
    }

    /// For a directory: says at once how much there is to do, once it is known.
    pub fn of_dir(ctx: &'a Ctx, total_files: u64, total_bytes: u64) -> Progress<'a> {
        let progress = Progress::new(ctx, Some(total_files), Some(total_bytes));
        progress.send();
        progress
    }

    fn send(&self) {
        self.ctx.progress(json!({
            "files": self.files,
            "bytes": self.bytes,
            "total_files": self.total_files,
            "total_bytes": self.total_bytes,
        }));
    }

    pub fn tick(&mut self) {
        let now = pneuma_base_storage::Time::now().nanos();
        if now - self.last >= PROGRESS_EVERY_NS {
            self.last = now;
            self.send();
        }
    }
}

/// The place's parent directory, open, and the place's name in it.
pub fn parent_of(
    walker: &mut Walker,
    place: &Place,
) -> Result<(std::os::fd::RawFd, String), Failure> {
    let segments = place.segments();
    let (name, parents) = segments.split_last().ok_or_else(Failure::bad_request)?;
    match walker.enter(parents) {
        Ok(dir) => Ok((dir, (*name).to_owned())),
        Err((_, Broken::Gone | Broken::NotDir)) => Err(Failure::new(Reason::NoSuchPlace)),
        Err((_, Broken::Link)) => Err(Failure::new(Reason::Outside)),
        Err((_, Broken::Unreadable(errno))) => Err(unreadable(errno)),
    }
}

/// A file of the library opened for reading, with its state as of the open.
pub struct Opened {
    pub file: File,
    pub stat: Stat,
}

pub fn open_place_file(walker: &mut Walker, place: &Place) -> Result<Opened, Failure> {
    // The root is a directory like any other, not a malformed place.
    if place.is_root() {
        return Err(Failure::new(Reason::NotAFile));
    }
    let (dir, name) = parent_of(walker, place)?;
    let c_name = sys::c_name(name.as_bytes());
    let file = match sys::open_file_at(dir, &c_name) {
        Ok(file) => file,
        Err(libc::ENOENT) => return Err(Failure::new(Reason::NoSuchPlace)),
        Err(libc::ELOOP) => return Err(Failure::new(Reason::NotAFile)),
        Err(errno) => return Err(unreadable(errno)),
    };
    let stat = sys::stat_fd(file.as_raw_fd()).map_err(unreadable)?;
    if stat.kind != Kind::File {
        return Err(Failure::new(Reason::NotAFile));
    }
    Ok(Opened { file, stat })
}

pub fn same_state(a: &Stat, b: &Stat) -> bool {
    a.components() == b.components()
}

impl LocalFolder {
    /// The fingerprint of the file at `place` now, for confirming a racy token.
    pub fn file_fingerprint(&self, walker: &mut Walker, place: &Place) -> Result<String, Failure> {
        let mut opened = open_place_file(walker, place)?;
        if opened.stat.dataless() {
            return Err(Failure::elsewhere(opened.stat.size));
        }
        Ok(hash_reader(&mut opened.file, &Ctx::default(), |_| {})?.0)
    }

    pub fn content_of(&self, req: &ContentRequest, ctx: &Ctx) -> Result<ContentAnswer, Failure> {
        let noise = self.noise();
        self.admit(&req.place, &noise)?;
        let mut walker = Walker::new(&self.root_fd);
        let found = self
            .locate(&mut walker, &req.place)?
            .ok_or_else(|| Failure::new(Reason::NoSuchPlace))?;
        let _fetching = req.fetch.then(Fetching::start);
        match found.stat.kind {
            Kind::File => self.file_content(&mut walker, &req.place, req.fetch, ctx),
            Kind::Dir => self.dir_content(&mut walker, req, &noise, ctx),
            Kind::Other => Err(Failure::new(Reason::NotAFile)),
        }
    }

    fn file_content(
        &self,
        walker: &mut Walker,
        place: &Place,
        fetch: bool,
        ctx: &Ctx,
    ) -> Result<ContentAnswer, Failure> {
        for _ in 0..TRIES {
            let mut opened = open_place_file(walker, place)?;
            if opened.stat.dataless() && !fetch {
                return Err(Failure::elsewhere(opened.stat.size));
            }
            let mut progress = Progress::new(ctx, Some(1), Some(opened.stat.size));
            let (fingerprint, size) = hash_reader(&mut opened.file, ctx, |n| {
                progress.bytes += n;
                progress.tick();
            })?;
            let after = sys::stat_fd(opened.file.as_raw_fd()).map_err(unreadable)?;
            if same_state(&opened.stat, &after) {
                let at = At {
                    folder: self,
                    place,
                    stat: &after,
                };
                return Ok(ContentAnswer::File {
                    token: facets::token(&at, Some(&fingerprint)),
                    fingerprint,
                    size,
                });
            }
        }
        Err(Failure::new(Reason::Busy))
    }

    fn dir_content(
        &self,
        walker: &mut Walker,
        req: &ContentRequest,
        noise: &crate::noise::Noise,
        ctx: &Ctx,
    ) -> Result<ContentAnswer, Failure> {
        let dir = self.open_level(walker, &req.place)?;
        for _ in 0..TRIES {
            if let Some(answer) = self.dir_content_once(dir, req, noise, ctx)? {
                return Ok(answer);
            }
        }
        Err(Failure::new(Reason::Busy))
    }

    /// One pass over the directory's content; `None` when something in it changed meanwhile.
    fn dir_content_once(
        &self,
        dir: std::os::fd::RawFd,
        req: &ContentRequest,
        noise: &crate::noise::Noise,
        ctx: &Ctx,
    ) -> Result<Option<ContentAnswer>, Failure> {
        let before = sys::stat_fd(dir).map_err(unreadable)?;
        let sides = [Side {
            noise,
            base: req.place.clone(),
            hidden: self.hidden(),
        }];
        let matcher = Matcher::new(&sides, &req.rule);
        let walked = rule::walk(dup(dir)?, &matcher, req.limit, ctx)?;
        let mut progress = Progress::of_dir(ctx, walked.files.len() as u64, walked.bytes);
        let top = dup(dir)?;
        let mut chain = Walker::new(&top);
        let mut fingerprints = Vec::with_capacity(walked.files.len());
        for found in &walked.files {
            let file_place = Place::parse(&found.path).ok_or_else(Failure::bad_request)?;
            let mut opened = match open_place_file(&mut chain, &file_place) {
                Ok(opened) => opened,
                // Gone or replaced since the walk listed it.
                Err(f) if matches!(f.reason, Reason::NoSuchPlace | Reason::NotAFile) => {
                    return Ok(None);
                }
                Err(f) => return Err(f),
            };
            if !same_state(&found.stat, &opened.stat) {
                return Ok(None);
            }
            if opened.stat.dataless() && !req.fetch {
                return Err(Failure::elsewhere(opened.stat.size));
            }
            let (fingerprint, _) = hash_reader(&mut opened.file, ctx, |n| {
                progress.bytes += n;
                progress.tick();
            })?;
            let after = sys::stat_fd(opened.file.as_raw_fd()).map_err(unreadable)?;
            if !same_state(&opened.stat, &after) {
                return Ok(None);
            }
            progress.files += 1;
            fingerprints.push(fingerprint);
        }
        let after = sys::stat_fd(dir).map_err(unreadable)?;
        if !same_state(&before, &after) {
            return Ok(None);
        }
        let fingerprint = manifest_fingerprint(
            walked
                .files
                .iter()
                .zip(&fingerprints)
                .map(|(f, fp)| (f.path.as_str(), fp.as_str())),
        );
        let at = At {
            folder: self,
            place: &req.place,
            stat: &after,
        };
        let manifest = req
            .manifest
            .as_ref()
            .map(|page| manifest_page(&walked.files, &fingerprints, page));
        Ok(Some(ContentAnswer::Dir {
            fingerprint,
            files: walked.files.len() as u64,
            bytes: walked.bytes,
            token: facets::token(&at, None),
            manifest,
        }))
    }

    pub fn read_bytes(&self, req: &ReadRequest, ctx: &Ctx) -> Result<ReadAnswer, Failure> {
        let noise = self.noise();
        self.admit(&req.place, &noise)?;
        if let Some(to) = &req.to {
            self.refuse_inside(to)?;
        }
        let mut walker = Walker::new(&self.root_fd);
        let _fetching = req.fetch.then(Fetching::start);
        for _ in 0..TRIES {
            let mut opened = match open_place_file(&mut walker, &req.place) {
                Err(f) if f.reason == Reason::NotAFile => {
                    return Err(match self.locate(&mut walker, &req.place)? {
                        Some(found) if found.stat.kind == Kind::Dir => {
                            Failure::new(Reason::NotAFile)
                        }
                        _ => f,
                    });
                }
                other => other?,
            };
            if opened.stat.dataless() && !req.fetch {
                return Err(Failure::elsewhere(opened.stat.size));
            }
            let size = opened.stat.size;
            if req.offset > size {
                return Err(Failure::bad_request());
            }
            let wanted = req
                .length
                .unwrap_or(size - req.offset)
                .min(size - req.offset);
            let length = if req.to.is_some() {
                wanted
            } else {
                wanted.min(DATA_MAX)
            };
            opened
                .file
                .seek(SeekFrom::Start(req.offset))
                .map_err(|e| io_failure(&e))?;
            let mut range = (&mut opened.file).take(length);
            let whole = req.offset == 0 && length == size;
            let (data, fingerprint) = match &req.to {
                Some(to) => {
                    let mut out = File::create(to).map_err(|e| io_failure(&e))?;
                    let (fingerprint, _) = copy_hashing(&mut range, &mut out, ctx, |_| {})?;
                    (None, whole.then_some(fingerprint))
                }
                None => {
                    let mut bytes = Vec::with_capacity(length as usize);
                    range
                        .read_to_end(&mut bytes)
                        .map_err(|e| read_failure(&e))?;
                    let fingerprint = whole.then(|| hex(&Sha256::digest(&bytes)));
                    (Some(base64::encode(&bytes)), fingerprint)
                }
            };
            let after = sys::stat_fd(opened.file.as_raw_fd()).map_err(unreadable)?;
            if !same_state(&opened.stat, &after) {
                continue;
            }
            let at = At {
                folder: self,
                place: &req.place,
                stat: &after,
            };
            return Ok(ReadAnswer {
                token: facets::token(&at, fingerprint.as_deref()),
                size,
                offset: req.offset,
                length,
                data,
                to: req.to.as_ref().map(|p| p.to_string_lossy().into_owned()),
            });
        }
        Err(Failure::new(Reason::Busy))
    }

    /// A path given for bytes to come from or go to must lie outside the library (not only
    /// outside this view of it).
    pub fn refuse_inside(&self, path: &Path) -> Result<(), Failure> {
        let parent = path.parent().ok_or_else(Failure::bad_request)?;
        let parent = parent
            .canonicalize()
            .map_err(|_| Failure::new(Reason::NoSuchPlace))?;
        let full = match path.file_name() {
            Some(name) => parent.join(name),
            None => return Err(Failure::bad_request()),
        };
        let full = full.canonicalize().unwrap_or(full);
        if full.starts_with(&self.library) || self.library.starts_with(&full) {
            return Err(Failure::bad_request());
        }
        Ok(())
    }
}

/// The page of a manifest after `page.after`: the walk's files are in the byte order of their paths.
fn manifest_page(files: &[rule::Found], fingerprints: &[String], page: &ManifestPage) -> Manifest {
    let start = page.after.as_deref().map_or(0, |after| {
        files.partition_point(|f| f.path.as_bytes() <= after.as_bytes())
    });
    let end = files.len().min(start.saturating_add(page.limit));
    let entries = files[start..end]
        .iter()
        .zip(&fingerprints[start..end])
        .map(|(file, fingerprint)| ManifestEntry {
            path: file.path.clone(),
            fingerprint: fingerprint.clone(),
            size: file.stat.size,
        })
        .collect();
    let more = (end < files.len()).then(|| After {
        after: files[end - 1].path.clone(),
    });
    Manifest { entries, more }
}

/// An owned duplicate of a borrowed descriptor, so a walk can keep it.
pub fn dup(fd: std::os::fd::RawFd) -> Result<OwnedFd, Failure> {
    // SAFETY: duplicating an open descriptor.
    let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if dup < 0 {
        return Err(unreadable(
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
        ));
    }
    // SAFETY: the kernel just returned `dup` and nothing else owns it.
    Ok(unsafe { std::os::fd::FromRawFd::from_raw_fd(dup) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_sha256_and_the_kernel_manifest() {
        let (fp, n) = hash_reader(&mut &b"abc"[..], &Ctx::default(), |_| {}).unwrap();
        assert_eq!(n, 3);
        assert_eq!(
            fp,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // sha256("a.md\0<fp>\n") with the kernel's layout.
        let manifest = manifest_fingerprint([("a.md", fp.as_str())].into_iter());
        let mut expected = Sha256::new();
        expected.update(format!("a.md\0{fp}\n"));
        assert_eq!(manifest, hex(&expected.finalize()));
    }
}
