//! `changed`: the places that moved since a cursor, learnt from the system's change journal,
//! never by walking. On macOS that is FSEvents, whose per-volume database keeps history across
//! restarts and reboots: the cursor names the volume's event database, the library's folder, and
//! an event id.
//!
//! Two ways answer it, with the same answer at different costs:
//! - From the change log a live listener keeps (`changelog.rs`, `listen.rs`): about a millisecond,
//!   whatever happened elsewhere on the volume. Any process can read it.
//! - By replaying the journal from the cursor. A replay reads the volume's whole history since the
//!   cursor, whatever lies in the library: measured at about 0.17 us an event plus about 13 ms to
//!   set up a stream, so 2.4 s for a cursor three hours old on a busy development machine. It is
//!   started only when its estimate fits the caller's budget, and given up when it overruns it.
//!
//! The answer is `cannot_say`, with a fresh cursor, whenever neither can vouch for the period:
//! - the cursor is not one this provider made, or the volume's event database is not the one it
//!   was made on (its UUID differs: the database was discarded or replaced), or the volume keeps
//!   none;
//! - the library's folder is not the one the cursor was made on (other device or inode: it was
//!   replaced, moved, or the library now lives elsewhere);
//! - the cursor's event id is ahead of the system's (ids went back);
//! - no live listener's log covers the cursor and the replay does not fit the budget;
//! - the replay carries a flag that says events were lost or must be rescanned: MustScanSubDirs,
//!   KernelDropped, EventIdsWrapped, RootChanged, or a mount or unmount under the library.
//!   UserDropped alone (lost between the system and this process, the history itself whole) is
//!   replayed again after a pause, as long as the budget allows.
//!
//! Elsewhere (Linux) there is no such journal: always `cannot_say`, and nothing to subscribe to.

#[cfg(not(target_os = "macos"))]
use pneuma_base_storage::{ChangedAnswer, ChangedRequest, Ctx, Failure, SubscribeRequest};

use crate::LocalFolder;

impl LocalFolder {
    /// Whether `changed` can give a reliable cursor for this library: on macOS, when its volume
    /// keeps an event history.
    pub fn reliable_cursor(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            crate::sys::stat_fd(self.root_fd.as_raw_fd())
                .is_ok_and(|root| crate::fsevents::volume_uuid(root.device).is_some())
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl LocalFolder {
    /// Asked for the current cursor, it gives one; any period since a cursor it cannot vouch for.
    pub fn changes_since(
        &self,
        req: &ChangedRequest,
        _ctx: &Ctx,
    ) -> Result<ChangedAnswer, Failure> {
        const CURSOR: &str = "none";
        match req.cursor {
            None => Ok(ChangedAnswer {
                places: Vec::new(),
                cursor: CURSOR.to_owned(),
                more: false,
            }),
            Some(_) => Err(Failure::cannot_say(CURSOR.to_owned())),
        }
    }

    /// Without a journal there is nothing to listen to.
    pub fn listen(&self, _req: &SubscribeRequest, _ctx: &Ctx) -> Result<(), Failure> {
        Err(Failure::cannot_say("none".to_owned()))
    }
}

#[cfg(target_os = "macos")]
pub use macos::{Cursor, replay_estimate};

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::BTreeSet;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use pneuma_base_storage::{ChangedAnswer, ChangedRequest, Ctx, Failure, Place, Time};

    use crate::changelog::{self, Heard};
    use crate::fsevents::{self, Event, Stream};
    use crate::{LocalFolder, RECORD_AREA, sys};

    /// What a replay costs before it reads any event: making, starting and draining a stream.
    const REPLAY_SETUP: Duration = Duration::from_millis(13);
    /// What a replay costs for each event the volume recorded since the cursor.
    const REPLAY_PER_EVENT_NS: u64 = 170;
    /// How long to wait before replaying again after events were dropped on their way here.
    const RETRY_PAUSE: Duration = Duration::from_millis(500);

    /// What a replay from `since` is expected to cost, `now` being the system's newest event id.
    pub fn replay_estimate(since: u64, now: u64) -> Duration {
        REPLAY_SETUP + Duration::from_nanos(now.saturating_sub(since) * REPLAY_PER_EVENT_NS)
    }

    /// What the cursor says about where it was made.
    pub struct Cursor {
        pub volume: String,
        pub device: u64,
        pub inode: u64,
        pub event: u64,
    }

    impl Cursor {
        pub fn text(&self) -> String {
            format!("fse1;{};{}", self.origin(), self.event)
        }

        /// The volume's event database and the library folder: what an event id is an id in.
        pub fn origin(&self) -> String {
            format!("{};{};{}", self.volume, self.device, self.inode)
        }

        pub fn parse(text: &str) -> Option<Cursor> {
            let mut parts = text.split(';');
            if parts.next()? != "fse1" {
                return None;
            }
            let volume = parts.next()?.to_owned();
            let device = parts.next()?.parse().ok()?;
            let inode = parts.next()?.parse().ok()?;
            let event = parts.next()?.parse().ok()?;
            parts.next().is_none().then_some(Cursor {
                volume,
                device,
                inode,
                event,
            })
        }

        /// The same origin at another event.
        pub fn at(&self, event: u64) -> Cursor {
            Cursor {
                volume: self.volume.clone(),
                device: self.device,
                inode: self.inode,
                event,
            }
        }
    }

    #[derive(Default)]
    struct Replay {
        events: Vec<(u64, u32, Vec<u8>)>,
        done: Option<u64>,
    }

    /// Replays the events under `root` since `event`; `None` when the replay does not finish by
    /// `deadline`.
    fn replay(root: &[u8], event: u64, deadline: Instant) -> Option<Replay> {
        let shared: Arc<(Mutex<Replay>, Condvar)> = Arc::default();
        let sink = shared.clone();
        let stream = Stream::start(
            root,
            event,
            0.0,
            fsevents::NO_DEFER | fsevents::WATCH_ROOT | fsevents::FILE_EVENTS,
            &[],
            move |events: Vec<Event>| {
                let Ok(mut replay) = sink.0.lock() else {
                    return;
                };
                for e in events {
                    if e.flags & fsevents::HISTORY_DONE != 0 {
                        replay.done = Some(e.id);
                        sink.1.notify_all();
                    } else if replay.done.is_none() {
                        replay.events.push((e.id, e.flags, e.path));
                    }
                }
            },
        )?;
        let finished = {
            let mut replay = shared.0.lock().ok()?;
            while replay.done.is_none() {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                replay = shared.1.wait_timeout(replay, left).ok()?.0;
            }
            replay.done.is_some()
        };
        drop(stream);
        if !finished {
            return None;
        }
        let mut replay = shared.0.lock().ok()?;
        Some(std::mem::take(&mut *replay))
    }

    /// The place an event's path names, when it lies in the library.
    pub fn place_of(root: &[u8], path: &[u8]) -> Option<Place> {
        Place::parse(fsevents::relative(root, path)?)
    }

    impl LocalFolder {
        /// The cursor for this library at the system's newest event, or `None` when its volume
        /// keeps no history.
        pub fn cursor_now(&self) -> Result<Cursor, Failure> {
            let root = sys::stat_fd(self.root_fd.as_raw_fd())
                .map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
            Ok(Cursor {
                volume: fsevents::volume_uuid(root.device).unwrap_or_else(|| "none".to_owned()),
                device: root.device,
                inode: root.inode,
                event: fsevents::current_event(),
            })
        }

        pub(crate) fn change_log(&self) -> changelog::Files {
            changelog::Files::of(&self.cache_area())
        }

        /// What the live listener's log says after `cursor`, places that are noise now left out.
        pub(crate) fn heard_after(&self, cursor: &Cursor, limit: usize) -> Heard {
            let heard = changelog::read(
                &self.change_log(),
                &cursor.origin(),
                cursor.event,
                limit,
                Time::now().millis(),
            );
            match heard {
                Heard::Places {
                    mut places,
                    next,
                    more,
                } => {
                    let noise = self.noise();
                    places.retain(|p| !noise.is_noise(p));
                    Heard::Places { places, next, more }
                }
                other => other,
            }
        }

        pub fn changes_since(
            &self,
            req: &ChangedRequest,
            ctx: &Ctx,
        ) -> Result<ChangedAnswer, Failure> {
            let now = self.cursor_now()?;
            let Some(text) = &req.cursor else {
                return Ok(ChangedAnswer {
                    places: Vec::new(),
                    cursor: now.text(),
                    more: false,
                });
            };
            let cannot_say = || Failure::cannot_say(now.text());
            let Some(cursor) = Cursor::parse(text) else {
                return Err(cannot_say());
            };
            if now.volume == "none" || cursor.origin() != now.origin() || cursor.event > now.event {
                return Err(cannot_say());
            }
            if let Heard::Places { places, next, more } = self.heard_after(&cursor, req.limit) {
                return Ok(ChangedAnswer {
                    places,
                    cursor: cursor.at(next).text(),
                    more,
                });
            }
            let budget = Duration::from_millis(req.budget_ms);
            if replay_estimate(cursor.event, now.event) > budget {
                return Err(cannot_say());
            }
            ctx.check()?;
            let root_path = self.root.as_os_str().as_bytes();
            let deadline = Instant::now() + budget;
            let replay = loop {
                let replay = replay(root_path, cursor.event, deadline).ok_or_else(cannot_say)?;
                // Dropped on the way to this process only: the volume's history is whole, so
                // replaying it again, after a moment, can still give all of it.
                let dropped_here = replay.events.iter().any(|(_, flag, _)| {
                    flag & fsevents::USER_DROPPED != 0
                        && flag
                            & (fsevents::UNTRUSTED
                                & !fsevents::USER_DROPPED
                                & !fsevents::MUST_SCAN_SUB_DIRS)
                            == 0
                });
                if !dropped_here {
                    break replay;
                }
                if Instant::now() + RETRY_PAUSE > deadline {
                    return Err(cannot_say());
                }
                ctx.check()?;
                std::thread::sleep(RETRY_PAUSE);
            };
            let noise = self.noise();
            let mut places = BTreeSet::new();
            let mut first_left_out: Option<u64> = None;
            for (id, flag, path) in &replay.events {
                if flag & fsevents::UNTRUSTED != 0 {
                    return Err(cannot_say());
                }
                let Some(place) = place_of(root_path, path) else {
                    continue;
                };
                if place.segments().first() == Some(&RECORD_AREA) || noise.is_noise(&place) {
                    continue;
                }
                if places.len() < req.limit || places.contains(&place) {
                    places.insert(place);
                } else {
                    first_left_out = Some(first_left_out.map_or(*id, |f| f.min(*id)));
                }
            }
            let done = replay.done.unwrap_or(cursor.event);
            let (next, more) = match first_left_out {
                // Events arrive almost in id order: resume just before the first one left out.
                Some(first) if first > cursor.event + 1 => (first - 1, true),
                Some(_) => return Err(cannot_say()),
                // Where the history ended: Apple's resume point. It can trail the cursor's id;
                // a replay from there gives some places again, never fewer.
                None => (done, false),
            };
            Ok(ChangedAnswer {
                places: places.into_iter().collect(),
                cursor: cursor.at(next).text(),
                more,
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cursors_read_back() {
            let cursor = Cursor {
                volume: "F1E5-UUID".into(),
                device: 16777232,
                inode: 42,
                event: 514764355,
            };
            let parsed = Cursor::parse(&cursor.text()).unwrap();
            assert_eq!(parsed.text(), cursor.text());
            assert!(Cursor::parse("fse1;a;1;2").is_none());
            assert!(Cursor::parse("v1;none").is_none());
        }

        #[test]
        fn a_replay_is_estimated_by_the_events_since_its_cursor() {
            assert_eq!(replay_estimate(100, 100), REPLAY_SETUP);
            assert_eq!(
                replay_estimate(0, 1_000_000),
                REPLAY_SETUP + Duration::from_millis(170)
            );
            assert_eq!(replay_estimate(200, 100), REPLAY_SETUP);
        }
    }
}
