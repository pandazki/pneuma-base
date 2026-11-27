//! `glance`, `look`, `overview` and `probe`: questions about the content half, answered from
//! metadata only, one directory level at a time.

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use pneuma_base_storage::{
    Changed, Ctx, DeepLook, DeepToken, Description, Expect, Failure, GlanceAnswer, GlanceRequest,
    Kind, LookAnswer, LookItem, More, OverviewAnswer, OverviewRequest, Place, PlaceArg,
    PlaceFailure, ProbeAnswer, ProbeRequest, Reason, Seen, Token, Trust,
};

use crate::LocalFolder;
use crate::facets::{self, At};
use crate::noise::Noise;
use crate::sys::{self, DirStream, EntryType, Errno, Stat};

/// Checked by name at the top of a probed place.
const MARKERS: [&str; 13] = [
    "package.json",
    ".git",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pnpm-workspace.yaml",
    "requirements.txt",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "Package.swift",
    "CMakeLists.txt",
    "Makefile",
];

/// Lists of at least this many places are split over a few threads.
const PARALLEL_FROM: usize = 4_096;
const MAX_THREADS: usize = 4;

/// Why a directory on the way to a place could not be opened.
#[derive(Clone, Copy, Debug)]
pub enum Broken {
    Gone,
    NotDir,
    Link,
    Unreadable(Errno),
}

fn unreadable(errno: Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

/// The chain of directories open from the root to the last one asked for. Asking for places in
/// depth-first order opens each directory once, and checks each for a symbolic link once.
pub struct Walker<'a> {
    root: &'a OwnedFd,
    stack: Vec<(String, Result<OwnedFd, Broken>)>,
}

impl<'a> Walker<'a> {
    pub fn new(root: &'a OwnedFd) -> Walker<'a> {
        Walker {
            root,
            stack: Vec::new(),
        }
    }

    fn top(&self) -> RawFd {
        match self.stack.last() {
            Some((_, Ok(fd))) => fd.as_raw_fd(),
            _ => self.root.as_raw_fd(),
        }
    }

    /// Drops what it knows, after the directories changed under it.
    pub fn forget(&mut self) {
        self.stack.clear();
    }

    /// The directory at `segments`, or the index of the segment that failed and why.
    pub fn enter(&mut self, segments: &[&str]) -> Result<RawFd, (usize, Broken)> {
        let common = self
            .stack
            .iter()
            .zip(segments)
            .take_while(|((name, _), segment)| name == *segment)
            .count();
        self.stack.truncate(common);
        if let Some((_, Err(broken))) = self.stack.last() {
            return Err((self.stack.len() - 1, *broken));
        }
        for (index, segment) in segments.iter().enumerate().skip(common) {
            let opened = open_child(self.top(), segment);
            let broken = opened.as_ref().err().copied();
            self.stack.push(((*segment).to_owned(), opened));
            if let Some(broken) = broken {
                return Err((index, broken));
            }
        }
        Ok(self.top())
    }
}

fn open_child(parent: RawFd, name: &str) -> Result<OwnedFd, Broken> {
    let c_name = sys::c_name(name.as_bytes());
    match sys::open_dir_at(parent, &c_name) {
        Ok(fd) => Ok(fd),
        Err(libc::ENOENT) => Err(Broken::Gone),
        Err(errno @ (libc::ENOTDIR | libc::ELOOP)) => Err(match sys::stat_at(parent, &c_name) {
            Ok(stat) if stat.kind == Kind::Dir => Broken::Unreadable(errno),
            Ok(stat) if is_link(&stat) => Broken::Link,
            Ok(_) => Broken::NotDir,
            Err(libc::ENOENT) => Broken::Gone,
            Err(errno) => Broken::Unreadable(errno),
        }),
        Err(errno) => Err(Broken::Unreadable(errno)),
    }
}

// `mode_t` is 16 bits on macOS and 32 on Linux, so the casts are needed on one and not the other.
#[allow(clippy::unnecessary_cast)]
pub fn is_link(stat: &Stat) -> bool {
    stat.mode & libc::S_IFMT as u32 == libc::S_IFLNK as u32
}

/// What is at a place: its metadata and, for a directory, its entry count when cheap.
pub struct Located {
    pub stat: Stat,
    pub count: Option<u64>,
}

pub fn locate_at(dir: RawFd, name: &str) -> Result<Option<Located>, Errno> {
    let c_name = sys::c_name(name.as_bytes());
    match sys::stat_at(dir, &c_name) {
        Ok(stat) => {
            let count = if stat.kind == Kind::Dir {
                sys::entry_count_at(dir, Some(&c_name))
            } else {
                None
            };
            Ok(Some(Located { stat, count }))
        }
        Err(libc::ENOENT | libc::ENOTDIR) => Ok(None),
        Err(errno) => Err(errno),
    }
}

/// Orders places depth first, `/` sorting before every other byte, so a walker sees each
/// directory's places together.
fn depth_first(places: &[Option<&Place>]) -> Vec<usize> {
    let key = |byte: &u8| if *byte == b'/' { 0 } else { *byte };
    let mut order: Vec<usize> = (0..places.len()).collect();
    order.sort_by(|&a, &b| match (places[a], places[b]) {
        (Some(a), Some(b)) => a
            .as_str()
            .as_bytes()
            .iter()
            .map(key)
            .cmp(b.as_str().as_bytes().iter().map(key)),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
    });
    order
}

impl LocalFolder {
    pub fn describe(&self, place: &Place, found: &Located, wanted: &[String]) -> Description {
        let at = At {
            folder: self,
            place,
            stat: &found.stat,
        };
        facets::describe(&at, found.count, wanted, None)
    }

    /// What `again` finds once the change `found` shows is past the file system's racy window,
    /// so the token described vouches for itself. The wait is at most 25 ms, and in a batch the
    /// first wait mostly covers the rest; on a file system whose clock is coarser than that, the
    /// token says it is racy instead.
    pub fn once_settled(
        &self,
        found: Located,
        again: impl FnOnce() -> Result<Option<Located>, Failure>,
    ) -> Result<Option<Located>, Failure> {
        if self.settle(&found.stat) {
            again()
        } else {
            Ok(Some(found))
        }
    }

    /// What the view keeps out of its root (the record area, or a record place's facts) is not
    /// in it, and noise is neither reported nor entered.
    pub fn admit(&self, place: &Place, noise: &Noise) -> Result<(), Failure> {
        if place.segments().first() == Some(&self.hidden()) {
            return Err(Failure::new(Reason::Outside));
        }
        if noise.is_noise(place) {
            return Err(Failure::new(Reason::Noise));
        }
        Ok(())
    }

    pub fn locate(&self, walker: &mut Walker, place: &Place) -> Result<Option<Located>, Failure> {
        let segments = place.segments();
        let Some((name, parents)) = segments.split_last() else {
            let root = self.root_fd.as_raw_fd();
            let stat = sys::stat_fd(root).map_err(unreadable)?;
            let count = sys::entry_count_at(root, None);
            return Ok(Some(Located { stat, count }));
        };
        match walker.enter(parents) {
            Ok(dir) => locate_at(dir, name).map_err(unreadable),
            Err((_, Broken::Gone | Broken::NotDir)) => Ok(None),
            Err((_, Broken::Link)) => Err(Failure::new(Reason::Outside)),
            Err((_, Broken::Unreadable(errno))) => Err(unreadable(errno)),
        }
    }

    /// Opens a place to list or probe it.
    pub fn open_level(&self, walker: &mut Walker, place: &Place) -> Result<RawFd, Failure> {
        let segments = place.segments();
        walker.enter(&segments).map_err(|(index, broken)| {
            let is_place = index + 1 == segments.len();
            match broken {
                Broken::Gone => Failure::new(Reason::NoSuchPlace),
                Broken::NotDir | Broken::Link if is_place => Failure::new(Reason::NotADir),
                Broken::NotDir => Failure::new(Reason::NoSuchPlace),
                Broken::Link => Failure::new(Reason::Outside),
                Broken::Unreadable(errno) => unreadable(errno),
            }
        })
    }

    pub fn glance_places(&self, req: &GlanceRequest, ctx: &Ctx) -> Result<GlanceAnswer, Failure> {
        let places = &req.places;
        let noise = self.noise();
        let valid: Vec<Option<&Place>> = places.iter().map(valid_place).collect();
        let mut seen: Vec<Option<Seen>> = (0..places.len()).map(|_| None).collect();
        let mut walker = Walker::new(&self.root_fd);
        for (step, index) in depth_first(&valid).into_iter().enumerate() {
            if step % 1024 == 0 {
                ctx.check()?;
            }
            seen[index] = Some(match &places[index] {
                PlaceArg::Malformed(text) => Seen::Failed(text.clone(), Failure::bad_request()),
                PlaceArg::Valid(place) => {
                    let found = self
                        .admit(place, &noise)
                        .and_then(|()| self.locate(&mut walker, place));
                    let found = found.and_then(|found| match found {
                        Some(found) => self.once_settled(found, || self.locate(&mut walker, place)),
                        None => Ok(None),
                    });
                    match found {
                        Ok(Some(found)) => Seen::Present(self.describe(place, &found, &req.facets)),
                        Ok(None) => Seen::Absent(place.as_str().to_owned()),
                        Err(failure) => Seen::Failed(place.as_str().to_owned(), failure),
                    }
                }
            });
        }
        Ok(GlanceAnswer {
            entries: seen.into_iter().flatten().collect(),
        })
    }

    pub fn look_places(
        &self,
        items: &[LookItem],
        deep: Option<&DeepLook>,
        ctx: &Ctx,
    ) -> Result<LookAnswer, Failure> {
        let noise = self.noise();
        let holds = self.live_holds();
        let valid: Vec<Option<&Place>> =
            items.iter().map(|item| valid_place(&item.place)).collect();
        let order = depth_first(&valid);
        let threads = if items.len() >= PARALLEL_FROM {
            std::thread::available_parallelism().map_or(1, |n| n.get().min(MAX_THREADS))
        } else {
            1
        };
        let chunk = order.len().div_ceil(threads).max(1);
        let verdicts: Vec<Vec<(usize, Verdict)>> = std::thread::scope(|scope| {
            let workers: Vec<_> = order
                .chunks(chunk)
                .map(|indices| scope.spawn(|| self.look_chunk(items, indices, &noise, deep, ctx)))
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err(Failure::new(Reason::Busy)))
                })
                .collect::<Result<_, _>>()
        })?;
        let mut by_index: Vec<Option<Verdict>> = (0..items.len()).map(|_| None).collect();
        for (index, verdict) in verdicts.into_iter().flatten() {
            by_index[index] = Some(verdict);
        }
        let mut answer = LookAnswer::default();
        for item in items {
            if let PlaceArg::Valid(place) = &item.place
                && holds.covers(place)
            {
                answer.held.push(place.clone());
            }
        }
        for (item, verdict) in items.iter().zip(by_index) {
            match verdict {
                Some(Verdict::Same) | None => answer.same += 1,
                Some(Verdict::Changed(entry, deep)) => answer.changed.push(Changed {
                    place: entry.place.clone(),
                    entry,
                    deep,
                }),
                Some(Verdict::Gone(place)) => answer.gone.push(place),
                Some(Verdict::Failed(failure)) => answer.failed.push(PlaceFailure {
                    place: item.place.text().to_owned(),
                    failure,
                }),
            }
        }
        Ok(answer)
    }

    fn look_chunk(
        &self,
        items: &[LookItem],
        indices: &[usize],
        noise: &Noise,
        deep: Option<&DeepLook>,
        ctx: &Ctx,
    ) -> Result<Vec<(usize, Verdict)>, Failure> {
        let mut walker = Walker::new(&self.root_fd);
        let mut verdicts = Vec::with_capacity(indices.len());
        for (step, &index) in indices.iter().enumerate() {
            if step % 1024 == 0 {
                ctx.check()?;
            }
            match self.look_one(&mut walker, noise, &items[index], deep, ctx) {
                // A deep walk stopped by `cancel` stops the whole look.
                Verdict::Failed(failure) if failure.reason == Reason::Cancelled => {
                    return Err(failure);
                }
                verdict => verdicts.push((index, verdict)),
            }
        }
        Ok(verdicts)
    }

    fn look_one(
        &self,
        walker: &mut Walker,
        noise: &Noise,
        item: &LookItem,
        deep: Option<&DeepLook>,
        ctx: &Ctx,
    ) -> Verdict {
        let PlaceArg::Valid(place) = &item.place else {
            return Verdict::Failed(Failure::bad_request());
        };
        let remembered = Remembered::of(&item.expect, deep.is_some());
        // Outside a deep look no text but a token can be compared, wherever it is asked.
        if deep.is_none() && matches!(remembered, Remembered::Malformed) {
            return Verdict::Failed(Failure::bad_request());
        }
        let nothing = || match remembered {
            Remembered::Nothing => Verdict::Same,
            Remembered::Malformed => Verdict::Failed(Failure::bad_request()),
            _ => Verdict::Gone(place.clone()),
        };
        let found = self
            .admit(place, noise)
            .and_then(|()| self.locate(walker, place));
        let found = match found {
            Err(failure) => return Verdict::Failed(failure),
            Ok(None) => return nothing(),
            Ok(Some(found)) => found,
        };
        let (same, deep_now) = match deep {
            Some(deep) if found.stat.kind == Kind::Dir => {
                let token = self
                    .open_level(walker, place)
                    .and_then(|dir| self.deep_token(dir, place, deep, noise, ctx));
                match token {
                    Ok(token) => {
                        let same =
                            matches!(remembered, Remembered::Deep(text) if token.same_as(text));
                        (Ok(same), Some(token))
                    }
                    Err(failure) => (Err(failure), None),
                }
            }
            _ => {
                let same = match remembered {
                    Remembered::Token(token) => self.still(walker, place, &found, token),
                    Remembered::Malformed => Err(Failure::bad_request()),
                    Remembered::Nothing | Remembered::Unstated | Remembered::Deep(_) => Ok(false),
                };
                (same, None)
            }
        };
        match same {
            Ok(true) => Verdict::Same,
            Ok(false) => match self.once_settled(found, || self.locate(walker, place)) {
                Ok(Some(found)) => Verdict::Changed(self.describe(place, &found, &[]), deep_now),
                Ok(None) => nothing(),
                Err(failure) => Verdict::Failed(failure),
            },
            Err(failure) => Verdict::Failed(failure),
        }
    }

    /// Whether what is at `place` is still the state `remembered` stands for: the components
    /// say so, unless the token was racy; then only the content can, and only when the token
    /// carries its fingerprint.
    pub fn still(
        &self,
        walker: &mut Walker,
        place: &Place,
        found: &Located,
        remembered: &Token,
    ) -> Result<bool, Failure> {
        let at = At {
            folder: self,
            place,
            stat: &found.stat,
        };
        match facets::token(&at, None).changed_since(remembered) {
            None => Err(Failure::bad_request()),
            Some(true) => Ok(false),
            Some(false) => match remembered.trust() {
                Trust::Settled => Ok(true),
                Trust::Racy => Ok(false),
                Trust::RacyWith(_) if found.stat.kind != Kind::File || found.stat.dataless() => {
                    Ok(false)
                }
                Trust::RacyWith(fingerprint) => {
                    let now = self.file_fingerprint(walker, place)?;
                    Ok(now == fingerprint)
                }
            },
        }
    }

    pub fn overview_dir(
        &self,
        req: &OverviewRequest,
        ctx: &Ctx,
    ) -> Result<OverviewAnswer, Failure> {
        let noise = self.noise();
        self.admit(&req.place, &noise)?;
        let mut walker = Walker::new(&self.root_fd);
        let dir = self.open_level(&mut walker, &req.place)?;
        let stat = sys::stat_fd(dir).map_err(unreadable)?;
        // Listing a placeholder directory would make its provider fetch it.
        if stat.dataless() {
            return Err(Failure::elsewhere(stat.size));
        }
        let listing = self.listing(&req.place, dir, &stat, &noise)?;
        ctx.check()?;
        let holds = self.live_holds();
        let names = &listing.names;
        let start = req
            .after
            .as_deref()
            .map_or(0, |after| names.first_after(after));
        let end = names.len().min(start.saturating_add(req.limit));
        let mut entries = Vec::with_capacity(end.saturating_sub(start));
        for index in start..end {
            let name = names.get(index);
            // An entry removed since the listing is simply not there any more.
            let found = match locate_at(dir, name).map_err(unreadable)? {
                Some(found) => {
                    self.once_settled(found, || locate_at(dir, name).map_err(unreadable))?
                }
                None => None,
            };
            if let Some(found) = found {
                let place = req.place.child(name);
                let mut entry = self.describe(&place, &found, &req.facets);
                entry.held = holds.covers(&place);
                entries.push(entry);
            }
        }
        let more = (end < names.len()).then(|| More {
            at_least: (names.len() - end) as u64,
            after: names.get(end - 1).to_owned(),
        });
        Ok(OverviewAnswer {
            entries,
            more,
            total: Some(names.len() as u64),
            noise: listing.noise,
        })
    }

    pub fn probe_dir(&self, req: &ProbeRequest, ctx: &Ctx) -> Result<ProbeAnswer, Failure> {
        let noise = self.noise();
        self.admit(&req.place, &noise)?;
        let mut walker = Walker::new(&self.root_fd);
        let top = self.open_level(&mut walker, &req.place)?;
        let markers = MARKERS
            .iter()
            .filter(|name| sys::stat_at(top, &sys::c_name(name.as_bytes())).is_ok())
            .map(|name| (*name).to_owned())
            .collect();
        let mut answer = ProbeAnswer {
            files: 0,
            dirs: 0,
            bytes: 0,
            exceeded: false,
            markers,
        };
        // Breadth first; each queued directory is a path relative to `top`, empty for `top`.
        let mut queue: VecDeque<Vec<u8>> = VecDeque::from([Vec::new()]);
        let mut counted = 0;
        'walk: while let Some(relative) = queue.pop_front() {
            ctx.check()?;
            let opened: OwnedFd;
            let dir = if relative.is_empty() {
                top
            } else {
                match sys::open_dir_at(top, &sys::c_name(&relative)) {
                    Ok(fd) => {
                        opened = fd;
                        opened.as_raw_fd()
                    }
                    // Unreadable or gone since it was counted: counted, not entered.
                    Err(_) => continue,
                }
            };
            let Ok(mut stream) = DirStream::open(&dir) else {
                continue;
            };
            let dir_place = match std::str::from_utf8(&relative) {
                Ok("") => Some(req.place.clone()),
                Ok(relative) => Some(req.place.child(relative)),
                Err(_) => None,
            };
            let is_library_root = req.place.is_root() && relative.is_empty();
            while let Some(Ok((name, kind))) = stream.next_entry() {
                if is_library_root && name == self.hidden().as_bytes() {
                    continue;
                }
                if let Ok(name) = std::str::from_utf8(name) {
                    let noisy = match &dir_place {
                        Some(parent) => noise.is_noise_entry(parent, name),
                        None => noise.is_noise_name(name),
                    };
                    if noisy {
                        continue;
                    }
                }
                if counted == req.budget {
                    answer.exceeded = true;
                    break 'walk;
                }
                counted += 1;
                let c_name = sys::c_name(name);
                let kind = match kind {
                    EntryType::Unknown => match sys::stat_at(dir, &c_name).map(|s| s.kind) {
                        Ok(Kind::File) => EntryType::File,
                        Ok(Kind::Dir) => EntryType::Dir,
                        _ => EntryType::Other,
                    },
                    known => known,
                };
                match kind {
                    EntryType::Dir => {
                        answer.dirs += 1;
                        let mut child = relative.clone();
                        if !child.is_empty() {
                            child.push(b'/');
                        }
                        child.extend_from_slice(name);
                        queue.push_back(child);
                    }
                    EntryType::File => {
                        answer.files += 1;
                        answer.bytes += sys::stat_at(dir, &c_name).map_or(0, |s| s.size);
                    }
                    _ => {}
                }
            }
        }
        Ok(answer)
    }
}

fn valid_place(place: &PlaceArg) -> Option<&Place> {
    match place {
        PlaceArg::Valid(place) => Some(place),
        PlaceArg::Malformed(_) => None,
    }
}

enum Verdict {
    Same,
    /// What is there now, and a deep-looked directory's deep token.
    Changed(Description, Option<DeepToken>),
    Gone(Place),
    Failed(Failure),
}

/// What a look item remembers at its place, told apart for comparing.
#[derive(Clone, Copy)]
enum Remembered<'a> {
    /// `empty`: nothing there.
    Nothing,
    /// No expectation: whatever is there differs.
    Unstated,
    Token(&'a Token),
    /// A deep token, in a deep look: it can stand only for a directory.
    Deep(&'a str),
    /// Text that is no token: a deep look of a directory answers `changed`, any other place
    /// `bad_request`.
    Malformed,
}

impl<'a> Remembered<'a> {
    fn of(expect: &'a Option<Expect>, deep: bool) -> Remembered<'a> {
        match expect {
            None => Remembered::Unstated,
            Some(Expect::Empty) => Remembered::Nothing,
            Some(Expect::Token(token)) if token.components().is_some() => Remembered::Token(token),
            Some(Expect::Token(token)) if deep && DeepToken::is_deep(token.as_str()) => {
                Remembered::Deep(token.as_str())
            }
            Some(Expect::Token(_)) => Remembered::Malformed,
        }
    }
}
