//! `write`, `move` and `remove`. Every one states what it expects to find; if that does not hold,
//! nothing changes and the answer is `refused` with what is there. A write is built whole in the
//! record area's `tmp/` and placed by one rename; a removal is one rename into `trash/` before
//! anything is deleted. So a write that is interrupted leaves its content as it was, and the
//! leftovers in `tmp/` and `trash/` are cleared by the next write or removal. Writers of one
//! directory take turns on a lock on it, so two writers cannot both see their expectation hold.

use std::ffi::CStr;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::PathBuf;

use pneuma_base_storage::{
    Ctx, Description, Expect, Failure, Kind, MoveAnswer, MoveRequest, Place, Present, Reason,
    RemoveAnswer, RemoveRequest, Source, WriteAnswer, WriteRequest,
};
use serde_json::{Value, json};

use crate::facets::{self, At};
use crate::fingerprint::{Progress, copy_hashing, dup, manifest_fingerprint};
use crate::metadata::{Broken, Located, Walker, locate_at};
use crate::noise::Noise;
use crate::rule::{self, Matcher};
use crate::sys::{self, Errno, Placing};
use crate::{LocalFolder, io_failure, unique_name};

fn unreadable(errno: Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

/// What a place holds now, as a refusal reports it.
fn present(place: &Place, found: Option<Description>) -> Value {
    let present = match found {
        Some(description) => Present::Is(description),
        None => Present::None(place.clone()),
    };
    serde_json::to_value(present).unwrap_or(Value::Null)
}

/// A directory, open and locked against other writers of the library until dropped.
struct Locked(OwnedFd);

impl Locked {
    fn take(dir: RawFd) -> Result<Locked, Failure> {
        let fd = dup(dir)?;
        sys::lock(fd.as_raw_fd()).map_err(unreadable)?;
        Ok(Locked(fd))
    }

    fn fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

/// Something built in `tmp/`, removed on drop unless it was placed.
struct Staged {
    dir: OwnedFd,
    name: String,
    placed: bool,
}

impl Staged {
    fn c_name(&self) -> std::ffi::CString {
        sys::c_name(self.name.as_bytes())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.placed {
            remove_tree(self.dir.as_raw_fd(), &self.c_name(), &mut |_| {});
        }
    }
}

/// Deletes what `name` is in `dir`, whatever it is, depth first. Best effort.
fn remove_tree(dir: RawFd, name: &CStr, removed: &mut dyn FnMut(u64)) {
    match sys::stat_at(dir, name) {
        Ok(stat) if stat.kind == Kind::Dir => {
            if let Ok(inner) = sys::open_dir_at(dir, name) {
                let mut names = Vec::new();
                if let Ok(mut stream) = sys::DirStream::open(&inner) {
                    while let Some(Ok((entry, _))) = stream.next_entry() {
                        names.push(sys::c_name(entry));
                    }
                }
                for entry in names {
                    remove_tree(inner.as_raw_fd(), &entry, removed);
                }
            }
            let _ = sys::unlink_at(dir, name, true);
            removed(1);
        }
        Ok(_) => {
            let _ = sys::unlink_at(dir, name, false);
            removed(1);
        }
        Err(_) => {}
    }
}

/// Whether a name in `tmp/` or `trash/` is one of this program's leftovers (`w-`, `i-` or `t-`,
/// then the pid that made it) and that process is gone. Anything else there belongs to someone
/// else and is left alone.
fn orphaned(name: &str) -> bool {
    let mut parts = name.split('-');
    if !matches!(parts.next(), Some("w" | "i" | "t")) {
        return false;
    }
    let Some(pid) = parts.next().and_then(|p| p.parse::<i32>().ok()) else {
        return false;
    };
    if pid == std::process::id() as i32 {
        return false;
    }
    // SAFETY: signal 0 only asks whether the process exists.
    let alive = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    !alive
}

impl LocalFolder {
    /// The record area's directory `name`, made if missing, open.
    fn area_dir(&self, name: &str) -> Result<OwnedFd, Failure> {
        self.ensure_record_area()?;
        let path: PathBuf = self.record_area().join(name);
        std::fs::create_dir_all(&path).map_err(|e| io_failure(&e))?;
        sys::open_root(&path).map_err(unreadable)
    }

    /// Clears what interrupted writes and removals left in `tmp/` or `trash/`, and finishes the
    /// moves they left half done.
    fn clear_leftovers(&self, area: &OwnedFd) {
        let mut names = Vec::new();
        if let Ok(mut stream) = sys::DirStream::open(area) {
            while let Some(Ok((name, _))) = stream.next_entry() {
                if let Ok(name) = std::str::from_utf8(name) {
                    names.push(name.to_owned());
                }
            }
        }
        for name in names.iter().filter(|n| orphaned(n)) {
            let c_name = sys::c_name(name.as_bytes());
            if name.starts_with("i-") {
                self.finish_intent(area.as_raw_fd(), &c_name);
            }
            remove_tree(area.as_raw_fd(), &c_name, &mut |_| {});
        }
    }

    /// Before each write, move or removal: whatever an interrupted one left is dealt with.
    fn recover(&self) {
        if let Ok(tmp) = sys::open_root(&self.record_area().join("tmp")) {
            self.clear_leftovers(&tmp);
        }
    }

    /// A move onto a directory swaps the two, then takes the old one out of the content. Before
    /// the swap it writes down what will be at its source afterwards; if it is interrupted in
    /// between, the next write finds the note and takes that thing out.
    fn note_intent(&self, place: &Place, old: &Located) -> Result<Intent, Failure> {
        let tmp = self.area_dir("tmp")?;
        let name = unique_name("i");
        let note = json!({
            "place": place.as_str(),
            "device": old.stat.device,
            "inode": old.stat.inode,
        });
        let mut file = sys::create_file_at(tmp.as_raw_fd(), &sys::c_name(name.as_bytes()), 0o600)
            .map_err(unreadable)?;
        std::io::Write::write_all(&mut file, note.to_string().as_bytes())
            .and_then(|()| sys::fsync(&file))
            .map_err(|e| io_failure(&e))?;
        Ok(Intent { tmp, name })
    }

    fn finish_intent(&self, tmp: RawFd, name: &CStr) {
        let Ok(file) = sys::open_file_at(tmp, name) else {
            return;
        };
        let Ok(note) = serde_json::from_reader::<_, Value>(file) else {
            return;
        };
        let Some(place) = note["place"].as_str().and_then(Place::parse) else {
            return;
        };
        let mut walker = Walker::new(&self.root_fd);
        let Ok((dir, name)) = crate::fingerprint::parent_of(&mut walker, &place) else {
            return;
        };
        let Ok(lock) = Locked::take(dir) else {
            return;
        };
        if let Ok(Some(found)) = locate_at(lock.fd(), &name)
            && Some(found.stat.device) == note["device"].as_u64()
            && Some(found.stat.inode) == note["inode"].as_u64()
        {
            self.discard(lock.fd(), &sys::c_name(name.as_bytes()), &Ctx::default());
        }
    }

    /// The parent of a place to write, open, made where missing; what it made goes in `made`.
    fn make_parent(
        &self,
        walker: &mut Walker,
        place: &Place,
        made: &mut Vec<Place>,
    ) -> Result<(RawFd, String), Failure> {
        let segments = place.segments();
        let (name, parents) = segments.split_last().ok_or_else(Failure::bad_request)?;
        loop {
            match walker.enter(parents) {
                Ok(dir) => return Ok((dir, (*name).to_owned())),
                Err((index, Broken::Gone)) => {
                    let base = walker
                        .enter(&parents[..index])
                        .map_err(|(_, b)| broken(b))?;
                    match sys::mkdir_at(base, &sys::c_name(parents[index].as_bytes()), 0o755) {
                        Ok(()) => made.extend(Place::parse(&parents[..=index].join("/"))),
                        Err(libc::EEXIST) => {}
                        Err(errno) => return Err(unreadable(errno)),
                    }
                    walker.forget();
                }
                Err((_, broken_at)) => return Err(broken(broken_at)),
            }
        }
    }

    /// The parent of a place a write expects `expect` at. A missing parent means nothing is at
    /// the place: a token cannot hold there, and nothing is made before that is known.
    fn parent_for(
        &self,
        walker: &mut Walker,
        place: &Place,
        expect: &Expect,
        made: &mut Vec<Place>,
    ) -> Result<(RawFd, String), Failure> {
        let segments = place.segments();
        let (name, parents) = segments.split_last().ok_or_else(Failure::bad_request)?;
        match walker.enter(parents) {
            Ok(dir) => Ok((dir, (*name).to_owned())),
            Err((_, Broken::Gone)) => match expect {
                Expect::Token(_) => Err(Failure::refused(Some(present(place, None)))),
                Expect::Empty => self.make_parent(walker, place, made),
            },
            Err((_, broken_at)) => Err(broken(broken_at)),
        }
    }

    /// Takes back the directories a refused write made, innermost first, unless something else
    /// has been put in them meanwhile.
    fn unmake(&self, made: &[Place]) {
        for place in made.iter().rev() {
            let mut walker = Walker::new(&self.root_fd);
            if let Ok((dir, name)) = crate::fingerprint::parent_of(&mut walker, place) {
                let _ = sys::unlink_at(dir, &sys::c_name(name.as_bytes()), true);
            }
        }
    }

    /// Whether the place still holds what `expected` says, by the same rule `look` uses.
    fn expectation_holds(
        &self,
        parent: RawFd,
        place: &Place,
        name: &str,
        expected: &Expect,
    ) -> Result<(bool, Option<Located>), Failure> {
        let found = locate_at(parent, name).map_err(unreadable)?;
        let holds = match (expected, &found) {
            (Expect::Empty, None) => true,
            (Expect::Empty, Some(_)) | (Expect::Token(_), None) => false,
            (Expect::Token(token), Some(found)) => {
                let mut walker = Walker::new(&self.root_fd);
                self.still(&mut walker, place, found, token)?
            }
        };
        Ok((holds, found))
    }

    /// What is at `place` now, found from the root.
    fn describe_place(&self, place: &Place) -> Option<Description> {
        let mut walker = Walker::new(&self.root_fd);
        let found = self.locate(&mut walker, place).ok()??;
        Some(self.describe(place, &found, &[]))
    }

    fn describe_now(&self, parent: RawFd, place: &Place, name: &str) -> Option<Description> {
        Some(self.describe(place, &self.settled(parent, name).ok()??, &[]))
    }

    /// What is at `name` once this write's own change has settled.
    fn settled(&self, parent: RawFd, name: &str) -> Result<Option<Located>, Failure> {
        match locate_at(parent, name).map_err(unreadable)? {
            Some(found) => self.once_settled(found, || locate_at(parent, name).map_err(unreadable)),
            None => Ok(None),
        }
    }

    fn writable(&self, place: &Place, noise: &Noise, hold: Option<&str>) -> Result<(), Failure> {
        if place.is_root() {
            return Err(Failure::bad_request());
        }
        self.admit(place, noise)?;
        self.live_holds().refuse(place, hold)
    }

    /// Refuses at once, before any copying, when the expectation already does not hold; it is
    /// checked again under the lock before anything is placed.
    fn precheck(&self, place: &Place, expect: &Expect) -> Result<(), Failure> {
        let mut walker = Walker::new(&self.root_fd);
        let segments = place.segments();
        let (name, parents) = segments.split_last().ok_or_else(Failure::bad_request)?;
        let parent = match walker.enter(parents) {
            Ok(dir) => dir,
            Err((_, Broken::Gone)) => {
                return match expect {
                    Expect::Token(_) => Err(Failure::refused(Some(present(place, None)))),
                    Expect::Empty => Ok(()),
                };
            }
            Err((_, broken_at)) => return Err(broken(broken_at)),
        };
        let (holds, found) = self.expectation_holds(parent, place, name, expect)?;
        if holds {
            return Ok(());
        }
        let actual = found.map(|f| self.describe(place, &f, &[]));
        Err(Failure::refused(Some(present(place, actual))))
    }

    pub fn write_place(&self, req: &WriteRequest, ctx: &Ctx) -> Result<WriteAnswer, Failure> {
        let noise = self.noise();
        self.writable(&req.place, &noise, req.hold.as_deref())?;
        self.recover();
        self.precheck(&req.place, &req.expect)?;
        let tmp = self.area_dir("tmp")?;
        let mut staged = Staged {
            dir: dup(tmp.as_raw_fd())?,
            name: unique_name("w"),
            placed: false,
        };
        let built = self.stage(req, &noise, &staged, ctx)?;
        ctx.check()?;
        let mut walker = Walker::new(&self.root_fd);
        let mut made = Vec::new();
        let (parent, name) = self.parent_for(&mut walker, &req.place, &req.expect, &mut made)?;
        let lock = Locked::take(parent)?;
        let (holds, found) = self.expectation_holds(lock.fd(), &req.place, &name, &req.expect)?;
        if !holds {
            let actual = found.map(|f| self.describe(&req.place, &f, &[]));
            drop(lock);
            self.unmake(&made);
            return Err(Failure::refused(Some(present(&req.place, actual))));
        }
        // Past this point the write takes effect: it is no longer cancelled.
        let c_name = sys::c_name(name.as_bytes());
        // A file over a file is replaced in one rename; anything else involving a directory is
        // swapped, which leaves the old one under the staged name for `staged` to delete.
        let replaces_dir = found.as_ref().is_some_and(|f| f.stat.kind == Kind::Dir);
        let placing = match req.expect {
            Expect::Empty => Placing::Exclusive,
            Expect::Token(_) if built.files.is_none() && !replaces_dir => Placing::Over,
            Expect::Token(_) => Placing::Swap,
        };
        match placing {
            Placing::Swap => swap_in(&staged, lock.fd(), &c_name)?,
            placing => place(&staged, lock.fd(), &c_name, placing)?,
        }
        staged.placed = placing != Placing::Swap;
        // Described under the lock, so the token answered is the one this write placed.
        let located = self
            .settled(parent, &name)?
            .ok_or_else(|| Failure::new(Reason::Busy))?;
        drop(lock);
        let at = At {
            folder: self,
            place: &req.place,
            stat: &located.stat,
        };
        let fingerprint = (located.stat.kind == Kind::File).then_some(built.fingerprint.as_str());
        Ok(WriteAnswer {
            entry: facets::describe(&at, located.count, &[], fingerprint),
            fingerprint: built.fingerprint,
            files: built.files,
            bytes: built.bytes,
        })
    }

    /// Builds the thing to place in `tmp/`, fingerprinting it as it is copied.
    fn stage(
        &self,
        req: &WriteRequest,
        noise: &Noise,
        staged: &Staged,
        ctx: &Ctx,
    ) -> Result<Built, Failure> {
        let tmp = staged.dir.as_raw_fd();
        let source = match &req.from {
            Source::Stdin => None,
            Source::Path(path) => {
                self.refuse_inside(path)?;
                let meta = std::fs::symlink_metadata(path)
                    .map_err(|_| Failure::new(Reason::NoSuchPlace))?;
                Some((path, meta.is_dir()))
            }
        };
        match source {
            Some((path, true)) => {
                let top = sys::open_root(path).map_err(unreadable)?;
                let matcher = Matcher::new(noise, req.place.clone(), &req.rule);
                let walked = rule::walk(top, &matcher, req.limit, ctx)?;
                sys::mkdir_at(tmp, &staged.c_name(), 0o755).map_err(unreadable)?;
                let into = sys::open_dir_at(tmp, &staged.c_name()).map_err(unreadable)?;
                for dir in &walked.dirs {
                    sys::mkdir_at(into.as_raw_fd(), &sys::c_name(dir.path.as_bytes()), 0o755)
                        .map_err(unreadable)?;
                }
                let mut progress = Progress::of_dir(ctx, walked.files.len() as u64, walked.bytes);
                let mut fingerprints = Vec::with_capacity(walked.files.len());
                let mut bytes = 0;
                for found in &walked.files {
                    let mut from =
                        File::open(path.join(&found.path)).map_err(|e| io_failure(&e))?;
                    let mut to = sys::create_file_at(
                        into.as_raw_fd(),
                        &sys::c_name(found.path.as_bytes()),
                        found.stat.mode & 0o777,
                    )
                    .map_err(unreadable)?;
                    let (fingerprint, n) = copy_hashing(&mut from, &mut to, ctx, |n| {
                        progress.bytes += n;
                        progress.tick();
                    })?;
                    sys::fsync(&to).map_err(|e| io_failure(&e))?;
                    progress.files += 1;
                    bytes += n;
                    fingerprints.push(fingerprint);
                }
                let fingerprint = manifest_fingerprint(
                    walked
                        .files
                        .iter()
                        .zip(&fingerprints)
                        .map(|(f, fp)| (f.path.as_str(), fp.as_str())),
                );
                Ok(Built {
                    fingerprint,
                    files: Some(walked.files.len() as u64),
                    bytes,
                })
            }
            Some((path, false)) => {
                let mut from = File::open(path).map_err(|e| io_failure(&e))?;
                let mode = std::os::unix::fs::PermissionsExt::mode(
                    &from.metadata().map_err(|e| io_failure(&e))?.permissions(),
                );
                self.stage_file(&mut from, mode & 0o777, staged, ctx)
            }
            None => self.stage_file(&mut std::io::stdin().lock(), 0o644, staged, ctx),
        }
    }

    fn stage_file(
        &self,
        from: &mut impl Read,
        mode: u32,
        staged: &Staged,
        ctx: &Ctx,
    ) -> Result<Built, Failure> {
        let mut to = sys::create_file_at(staged.dir.as_raw_fd(), &staged.c_name(), mode)
            .map_err(unreadable)?;
        let mut progress = Progress::new(ctx, Some(1), None);
        let (fingerprint, bytes) = copy_hashing(from, &mut to, ctx, |n| {
            progress.bytes += n;
            progress.tick();
        })?;
        // As facts are: handed to the drive before the rename (plain fsync; F_FULLFSYNC, which
        // waits for the drive's own cache, costs 5 ms a file).
        sys::fsync(&to).map_err(|e| io_failure(&e))?;
        Ok(Built {
            fingerprint,
            files: None,
            bytes,
        })
    }

    pub fn move_between(&self, req: &MoveRequest, ctx: &Ctx) -> Result<MoveAnswer, Failure> {
        let noise = self.noise();
        self.writable(&req.from, &noise, req.hold.as_deref())?;
        self.writable(&req.to, &noise, req.hold.as_deref())?;
        if req.to.is_at_or_under(&req.from) || req.from.is_at_or_under(&req.to) {
            return Err(Failure::bad_request());
        }
        self.recover();
        let mut from_walker = Walker::new(&self.root_fd);
        let mut to_walker = Walker::new(&self.root_fd);
        let (from_dir, from_name) = crate::fingerprint::parent_of(&mut from_walker, &req.from)
            .map_err(|failure| match failure.reason {
                Reason::NoSuchPlace => Failure::refused(Some(json!({
                    "from": present(&req.from, None),
                    "to": present(&req.to, self.describe_place(&req.to)),
                }))),
                _ => failure,
            })?;
        let expect_from = Expect::Token(req.expect_from.clone());
        let mut made = Vec::new();
        let to_parent = self.parent_for(&mut to_walker, &req.to, &req.expect_to, &mut made);
        let (to_dir, to_name) = match to_parent {
            Err(failure) if failure.reason == Reason::Refused => {
                let from_now = self.describe_now(from_dir, &req.from, &from_name);
                return Err(Failure::refused(Some(json!({
                    "from": present(&req.from, from_now),
                    "to": present(&req.to, None),
                }))));
            }
            other => other?,
        };
        ctx.check()?;
        // Two writers locking the same two directories take them in one order.
        let (first, second) = {
            let a = sys::stat_fd(from_dir).map_err(unreadable)?;
            let b = sys::stat_fd(to_dir).map_err(unreadable)?;
            if (a.device, a.inode) == (b.device, b.inode) {
                (Locked::take(from_dir)?, None)
            } else if (a.device, a.inode) < (b.device, b.inode) {
                (Locked::take(from_dir)?, Some(Locked::take(to_dir)?))
            } else {
                let to = Locked::take(to_dir)?;
                (Locked::take(from_dir)?, Some(to))
            }
        };
        let (from_holds, from_found) =
            self.expectation_holds(from_dir, &req.from, &from_name, &expect_from)?;
        let (to_holds, to_found) =
            self.expectation_holds(to_dir, &req.to, &to_name, &req.expect_to)?;
        if !(from_holds && to_holds) {
            let from_now = from_found.map(|f| self.describe(&req.from, &f, &[]));
            let to_now = to_found.map(|f| self.describe(&req.to, &f, &[]));
            drop(second);
            drop(first);
            self.unmake(&made);
            return Err(Failure::refused(Some(json!({
                "from": present(&req.from, from_now),
                "to": present(&req.to, to_now),
            }))));
        }
        let (from_c, to_c) = (
            sys::c_name(from_name.as_bytes()),
            sys::c_name(to_name.as_bytes()),
        );
        let is_file =
            |found: &Option<Located>| found.as_ref().is_some_and(|f| f.stat.kind != Kind::Dir);
        match (&req.expect_to, &to_found) {
            (Expect::Empty, _) | (_, None) => {
                sys::rename_at(from_dir, &from_c, to_dir, &to_c, Placing::Exclusive)
                    .map_err(unreadable)?;
            }
            // A file over a file: replaced in one rename.
            (Expect::Token(_), Some(_)) if is_file(&from_found) && is_file(&to_found) => {
                sys::rename_at(from_dir, &from_c, to_dir, &to_c, Placing::Over)
                    .map_err(unreadable)?;
            }
            (Expect::Token(_), Some(old)) => {
                let intent = self.note_intent(&req.from, old)?;
                sys::rename_at(from_dir, &from_c, to_dir, &to_c, Placing::Swap)
                    .map_err(unreadable)?;
                // What was at `to` is now at `from`: take it out of the content at once.
                self.discard(from_dir, &from_c, ctx);
                drop(intent);
            }
        }
        let entry = self
            .describe_now(to_dir, &req.to, &to_name)
            .ok_or_else(|| Failure::new(Reason::Busy))?;
        drop(second);
        drop(first);
        Ok(MoveAnswer { entry })
    }

    pub fn remove_place(&self, req: &RemoveRequest, ctx: &Ctx) -> Result<RemoveAnswer, Failure> {
        let noise = self.noise();
        self.writable(&req.place, &noise, req.hold.as_deref())?;
        let mut walker = Walker::new(&self.root_fd);
        let (parent, name) = crate::fingerprint::parent_of(&mut walker, &req.place).map_err(
            |failure| match failure.reason {
                Reason::NoSuchPlace => Failure::refused(Some(present(&req.place, None))),
                _ => failure,
            },
        )?;
        ctx.check()?;
        self.recover();
        let lock = Locked::take(parent)?;
        let expect = Expect::Token(req.expect.clone());
        let (holds, found) = self.expectation_holds(lock.fd(), &req.place, &name, &expect)?;
        if !holds {
            let actual = found.map(|f| self.describe(&req.place, &f, &[]));
            return Err(Failure::refused(Some(present(&req.place, actual))));
        }
        self.discard(lock.fd(), &sys::c_name(name.as_bytes()), ctx);
        drop(lock);
        Ok(RemoveAnswer { removed: true })
    }

    /// Moves `name` out of the content into `trash/` in one rename, then deletes it there,
    /// sending progress for a large directory. The removal has taken effect at the rename.
    fn discard(&self, dir: RawFd, name: &CStr, ctx: &Ctx) {
        let Ok(trash) = self.area_dir("trash") else {
            return;
        };
        let into = sys::c_name(unique_name("t").as_bytes());
        if sys::rename_at(dir, name, trash.as_raw_fd(), &into, Placing::Exclusive).is_err() {
            remove_tree(dir, name, &mut |_| {});
            return;
        }
        let mut progress = Progress::new(ctx, None, None);
        remove_tree(trash.as_raw_fd(), &into, &mut |n| {
            progress.files += n;
            progress.tick();
        });
        self.clear_leftovers(&trash);
    }
}

/// The note of a move onto a directory, removed once the move is done.
struct Intent {
    tmp: OwnedFd,
    name: String,
}

impl Drop for Intent {
    fn drop(&mut self) {
        let _ = sys::unlink_at(
            self.tmp.as_raw_fd(),
            &sys::c_name(self.name.as_bytes()),
            false,
        );
    }
}

/// What a write built and fingerprinted.
struct Built {
    fingerprint: String,
    files: Option<u64>,
    bytes: u64,
}

fn broken(broken: Broken) -> Failure {
    match broken {
        Broken::Gone => Failure::new(Reason::NoSuchPlace),
        Broken::NotDir => Failure::new(Reason::NotADir),
        Broken::Link => Failure::new(Reason::Outside),
        Broken::Unreadable(errno) => unreadable(errno),
    }
}

/// Places the staged thing where nothing is.
fn place(staged: &Staged, dir: RawFd, name: &CStr, placing: Placing) -> Result<(), Failure> {
    sys::rename_at(staged.dir.as_raw_fd(), &staged.c_name(), dir, name, placing).map_err(|errno| {
        match errno {
            libc::EEXIST | libc::ENOTEMPTY => Failure::new(Reason::Busy),
            errno => unreadable(errno),
        }
    })
}

/// Exchanges the staged thing with what is at the place; the old one is left in `tmp/` under
/// the staged name, where dropping `staged` deletes it.
fn swap_in(staged: &Staged, dir: RawFd, name: &CStr) -> Result<(), Failure> {
    match place(staged, dir, name, Placing::Swap) {
        // A file system without an atomic exchange: move the old one aside first.
        Err(failure) if failure.detail() == Some("EINVAL") => {
            let aside = sys::c_name(format!("{}.old", staged.name).as_bytes());
            sys::rename_at(
                dir,
                name,
                staged.dir.as_raw_fd(),
                &aside,
                Placing::Exclusive,
            )
            .map_err(unreadable)?;
            let placed = place(staged, dir, name, Placing::Exclusive);
            remove_tree(staged.dir.as_raw_fd(), &aside, &mut |_| {});
            placed
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::orphaned;

    #[test]
    fn only_this_programs_leftovers_are_cleared() {
        assert!(!orphaned("putting"));
        assert!(!orphaned("w-notapid-1"));
        assert!(!orphaned(&format!("w-{}-0-ff", std::process::id())));
        // No process has pid 2^31 - 1.
        assert!(orphaned("w-2147483647-0-ff"));
        assert!(orphaned("t-2147483647-3-ab"));
    }
}
