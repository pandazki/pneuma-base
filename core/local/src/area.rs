//! Where a content operation's places are: the content, or a record place's own area,
//! `<root>/.pneuma-base/<name>/`. A view of either is a `LocalFolder` whose places start at its
//! root. In a record place's own area no noise applies, holds do not reach, and the record place's
//! facts (`facts/`) are not in it. An area not made yet reads as an empty directory; the first
//! write makes it.

use std::ops::Deref;
use std::os::fd::AsRawFd;

use pneuma_base_storage::{
    Area, Changed, ContentAnswer, ContentRequest, DeepLook, Description, Expect, Facets, Failure,
    GlanceAnswer, GlanceRequest, Kind, LookAnswer, LookItem, Manifest, MoveRequest, OverviewAnswer,
    OverviewRequest, Place, PlaceArg, PlaceFailure, Present, ReadRequest, Reason, RecordPlace,
    RemoveRequest, Seen, Time, Token, WriteRequest,
};
use serde_json::{Value, json};

use crate::fingerprint::manifest_fingerprint;
use crate::{LocalFolder, RECORD_AREA, deep, io_failure, sys};

/// A record place's facts, kept out of its own area.
pub const FACTS: &str = "facts";

/// The view of an area: the folder asked, or one opened for the area.
pub enum View<'a> {
    Same(&'a LocalFolder),
    Opened(LocalFolder),
}

impl Deref for View<'_> {
    type Target = LocalFolder;

    fn deref(&self) -> &LocalFolder {
        match self {
            View::Same(folder) => folder,
            View::Opened(folder) => folder,
        }
    }
}

fn unreadable(errno: sys::Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

impl LocalFolder {
    /// The name kept out of this view's root level: the record area in the content, the facts in
    /// a record place's own area.
    pub fn hidden(&self) -> &'static str {
        if self.records.is_some() {
            FACTS
        } else {
            RECORD_AREA
        }
    }

    fn is_view_of(&self, area: &Area) -> bool {
        match (area, &self.records) {
            (Area::Content, None) => true,
            (Area::Records(name), Some(mine)) => name == mine,
            _ => false,
        }
    }

    /// The view where `area`'s places are. `None` for a record place's own area not made yet,
    /// unless `make`, which makes it.
    pub fn view(&self, area: &Area, make: bool) -> Result<Option<View<'_>>, Failure> {
        if self.is_view_of(area) {
            return Ok(Some(View::Same(self)));
        }
        let opened = match area {
            Area::Content => {
                let root_fd = sys::open_root(&self.library).map_err(unreadable)?;
                Some(self.with_root(self.library.clone(), root_fd, None))
            }
            Area::Records(name) => self.records_view(name, make)?,
        };
        Ok(opened.map(View::Opened))
    }

    fn records_view(&self, name: &RecordPlace, make: bool) -> Result<Option<LocalFolder>, Failure> {
        let root = self.record_area().join(name.as_str());
        if make {
            self.ensure_record_area()?;
            match std::fs::create_dir(&root) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io_failure(&e)),
            }
        }
        let records = match sys::open_root(&self.record_area()) {
            Ok(fd) => fd,
            Err(libc::ENOENT | libc::ENOTDIR) => return Ok(None),
            Err(errno) => return Err(unreadable(errno)),
        };
        // The area is the directory itself, never what a link there points to.
        match sys::open_dir_at(records.as_raw_fd(), &sys::c_name(name.as_str().as_bytes())) {
            Ok(root_fd) => Ok(Some(self.with_root(root, root_fd, Some(name.clone())))),
            Err(libc::ENOENT) => Ok(None),
            Err(libc::ELOOP | libc::ENOTDIR) => Err(Failure::new(Reason::Outside)),
            Err(errno) => Err(unreadable(errno)),
        }
    }
}

/// What a record place's own area answers before anything was written there: an empty directory
/// at its root and nothing below it, its places checked as in any record place's area.
pub mod absent {
    use super::*;

    /// The root of an area not made yet. No directory has inode 0, so once the area is made its
    /// root's token differs from this one.
    fn root() -> Description {
        Description {
            place: Place::root(),
            kind: Kind::Dir,
            token: Token::build([("s", "0".to_owned()), ("i", "0".to_owned())], []),
            size: Some(0),
            modified: Time::from_millis(0),
            facets: Facets::default(),
            held: false,
        }
    }

    /// What is at `place`: the empty root, or nothing.
    fn at(place: &Place) -> Result<Option<Description>, Failure> {
        if place.segments().first() == Some(&FACTS) {
            return Err(Failure::new(Reason::Outside));
        }
        Ok(place.is_root().then(root))
    }

    fn nothing_at(place: &Place) -> Value {
        serde_json::to_value(Present::None(place.clone())).unwrap_or(Value::Null)
    }

    /// A place a write, move or removal may change: never the root.
    fn writable(place: &Place) -> Result<(), Failure> {
        if place.is_root() {
            return Err(Failure::bad_request());
        }
        at(place).map(|_| ())
    }

    pub fn glance(req: &GlanceRequest) -> GlanceAnswer {
        let entries = req
            .places
            .iter()
            .map(|arg| match arg {
                PlaceArg::Malformed(text) => Seen::Failed(text.clone(), Failure::bad_request()),
                PlaceArg::Valid(place) => match at(place) {
                    Ok(Some(root)) => Seen::Present(root),
                    Ok(None) => Seen::Absent(place.as_str().to_owned()),
                    Err(failure) => Seen::Failed(place.as_str().to_owned(), failure),
                },
            })
            .collect();
        GlanceAnswer { entries }
    }

    pub fn overview(req: &OverviewRequest) -> Result<OverviewAnswer, Failure> {
        at(&req.place)?.ok_or_else(|| Failure::new(Reason::NoSuchPlace))?;
        Ok(OverviewAnswer {
            entries: Vec::new(),
            more: None,
            total: Some(0),
            noise: Vec::new(),
        })
    }

    /// A deep look sees the empty root as a directory with no files in it.
    pub fn look(items: &[LookItem], deep: Option<&DeepLook>) -> LookAnswer {
        let mut answer = LookAnswer::default();
        let no_files = deep.map(|_| deep::token_of(&[], false));
        for item in items {
            let failed = |failure| PlaceFailure {
                place: item.place.text().to_owned(),
                failure,
            };
            let PlaceArg::Valid(place) = &item.place else {
                answer.failed.push(failed(Failure::bad_request()));
                continue;
            };
            let changed = |answer: &mut LookAnswer, root: Description| {
                answer.changed.push(Changed {
                    place: root.place.clone(),
                    entry: root,
                    deep: no_files.clone(),
                })
            };
            match (at(place), &item.expect) {
                (Err(failure), _) => answer.failed.push(failed(failure)),
                (Ok(None), Some(Expect::Empty)) => answer.same += 1,
                (Ok(None), _) => answer.gone.push(place.clone()),
                (Ok(Some(root)), expect) if let Some(token) = &no_files => match expect {
                    Some(Expect::Token(remembered)) if token.same_as(remembered.as_str()) => {
                        answer.same += 1
                    }
                    _ => changed(&mut answer, root),
                },
                (Ok(Some(root)), Some(Expect::Token(token))) => {
                    match root.token.changed_since(token) {
                        None => answer.failed.push(failed(Failure::bad_request())),
                        Some(false) => answer.same += 1,
                        Some(true) => changed(&mut answer, root),
                    }
                }
                (Ok(Some(root)), _) => changed(&mut answer, root),
            }
        }
        answer
    }

    pub fn content(req: &ContentRequest) -> Result<ContentAnswer, Failure> {
        let root = at(&req.place)?.ok_or_else(|| Failure::new(Reason::NoSuchPlace))?;
        Ok(ContentAnswer::Dir {
            fingerprint: manifest_fingerprint(std::iter::empty()),
            files: 0,
            bytes: 0,
            token: root.token,
            manifest: req.manifest.as_ref().map(|_| Manifest {
                entries: Vec::new(),
                more: None,
            }),
        })
    }

    pub fn read(req: &ReadRequest) -> Failure {
        match at(&req.place) {
            Err(failure) => failure,
            Ok(Some(_)) => Failure::new(Reason::NotAFile),
            Ok(None) => Failure::new(Reason::NoSuchPlace),
        }
    }

    /// A write may make the area only where it expects nothing.
    pub fn write(req: &WriteRequest) -> Result<(), Failure> {
        writable(&req.place)?;
        match req.expect {
            Expect::Empty => Ok(()),
            Expect::Token(_) => Err(Failure::refused(Some(nothing_at(&req.place)))),
        }
    }

    pub fn move_place(req: &MoveRequest) -> Failure {
        if let Err(failure) = writable(&req.from).and_then(|()| writable(&req.to)) {
            return failure;
        }
        if req.to.is_at_or_under(&req.from) || req.from.is_at_or_under(&req.to) {
            return Failure::bad_request();
        }
        Failure::refused(Some(json!({
            "from": nothing_at(&req.from),
            "to": nothing_at(&req.to),
        })))
    }

    pub fn remove(req: &RemoveRequest) -> Failure {
        match writable(&req.place) {
            Err(failure) => failure,
            Ok(()) => Failure::refused(Some(nothing_at(&req.place))),
        }
    }
}
