//! `changed`: the places that moved since a cursor, learnt from the system's change journal,
//! never by walking. On macOS that is FSEvents, whose per-volume database keeps history across
//! restarts and reboots: the cursor names the volume's event database, the library's folder, and
//! an event id, and a replay from that id gives every file event since, at file granularity.
//!
//! The answer is `cannot_say`, with a fresh cursor, whenever that history cannot be trusted for
//! the period:
//! - the volume's event database is not the one the cursor was made on (its UUID differs: the
//!   database was discarded or replaced), or the volume keeps none;
//! - the library's folder is not the one the cursor was made on (other device or inode: it was
//!   replaced, moved, or the library now lives elsewhere);
//! - the cursor's event id is ahead of the system's (ids went back);
//! - the replay carries a flag that says events were lost or must be rescanned: MustScanSubDirs,
//!   KernelDropped, EventIdsWrapped, RootChanged, or a mount or unmount under the library.
//!   UserDropped alone (lost between the system and this process, the history itself whole) is
//!   replayed again after a pause, as long as the time limit allows;
//! - the replay does not finish within `REPLAY_LIMIT` (a cursor far in the past makes FSEvents
//!   read that much of the volume's history: about 5 s a day on a busy volume).
//!
//! Elsewhere (Linux) there is no such journal: always `cannot_say`.

#[cfg(not(target_os = "macos"))]
use pneuma_base_storage::{ChangedAnswer, ChangedRequest, Ctx, Failure};

#[cfg(not(target_os = "macos"))]
use crate::LocalFolder;

#[cfg(target_os = "macos")]
pub const RELIABLE: bool = true;
#[cfg(not(target_os = "macos"))]
pub const RELIABLE: bool = false;

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
}

#[cfg(target_os = "macos")]
mod fsevents {
    use std::collections::BTreeSet;
    use std::ffi::{CStr, c_char, c_void};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use pneuma_base_storage::{ChangedAnswer, ChangedRequest, Ctx, Failure, Place};

    use crate::{LocalFolder, RECORD_AREA, sys};

    pub const REPLAY_LIMIT: Duration = Duration::from_secs(15);
    /// How long to wait before replaying again after events were dropped on their way here.
    const RETRY_PAUSE: Duration = Duration::from_millis(500);

    type CFRef = *const c_void;

    #[repr(C)]
    struct StreamContext {
        version: isize,
        info: *mut c_void,
        retain: Option<extern "C" fn(*const c_void) -> *const c_void>,
        release: Option<extern "C" fn(*const c_void)>,
        copy_description: Option<extern "C" fn(*const c_void) -> CFRef>,
    }

    type Callback = extern "C" fn(
        stream: *const c_void,
        info: *mut c_void,
        count: usize,
        paths: *mut c_void,
        flags: *const u32,
        ids: *const u64,
    );

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn FSEventsGetCurrentEventId() -> u64;
        fn FSEventsCopyUUIDForDevice(dev: i32) -> CFRef;
        fn FSEventStreamCreate(
            allocator: CFRef,
            callback: Callback,
            context: *const StreamContext,
            paths: CFRef,
            since: u64,
            latency: f64,
            flags: u32,
        ) -> *mut c_void;
        fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
        fn FSEventStreamStart(stream: *mut c_void) -> u8;
        fn FSEventStreamStop(stream: *mut c_void);
        fn FSEventStreamInvalidate(stream: *mut c_void);
        fn FSEventStreamRelease(stream: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeArrayCallBacks: c_void;
        fn CFUUIDCreateString(allocator: CFRef, uuid: CFRef) -> CFRef;
        fn CFStringGetCString(string: CFRef, buffer: *mut c_char, size: isize, encoding: u32)
        -> u8;
        fn CFStringCreateWithBytes(
            allocator: CFRef,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> CFRef;
        fn CFArrayCreate(
            allocator: CFRef,
            values: *const CFRef,
            count: isize,
            callbacks: *const c_void,
        ) -> CFRef;
        fn CFRelease(object: CFRef);
    }

    unsafe extern "C" {
        fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
        fn dispatch_sync_f(
            queue: *mut c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
        fn dispatch_release(object: *mut c_void);
    }

    const UTF8: u32 = 0x0800_0100;
    const NO_DEFER: u32 = 0x02;
    const WATCH_ROOT: u32 = 0x04;
    const FILE_EVENTS: u32 = 0x10;
    const MUST_SCAN_SUB_DIRS: u32 = 0x01;
    const USER_DROPPED: u32 = 0x02;
    const KERNEL_DROPPED: u32 = 0x04;
    const IDS_WRAPPED: u32 = 0x08;
    const HISTORY_DONE: u32 = 0x10;
    const ROOT_CHANGED: u32 = 0x20;
    const MOUNT: u32 = 0x40;
    const UNMOUNT: u32 = 0x80;
    const UNTRUSTED: u32 = MUST_SCAN_SUB_DIRS
        | USER_DROPPED
        | KERNEL_DROPPED
        | IDS_WRAPPED
        | ROOT_CHANGED
        | MOUNT
        | UNMOUNT;

    /// What the cursor says about where it was made.
    struct Cursor {
        volume: String,
        device: u64,
        inode: u64,
        event: u64,
    }

    impl Cursor {
        fn text(&self) -> String {
            format!(
                "fse1;{};{};{};{}",
                self.volume, self.device, self.inode, self.event
            )
        }

        fn parse(text: &str) -> Option<Cursor> {
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
    }

    #[derive(Default)]
    struct Replay {
        events: Vec<(u64, u32, Vec<u8>)>,
        done: Option<u64>,
    }

    type Shared = Arc<(Mutex<Replay>, Condvar)>;

    extern "C" fn on_events(
        _stream: *const c_void,
        info: *mut c_void,
        count: usize,
        paths: *mut c_void,
        flags: *const u32,
        ids: *const u64,
    ) {
        // SAFETY: `info` is the `Shared` the stream was made with, alive until it is released;
        // FSEvents passes `count` paths, flags and ids.
        let shared = unsafe { &*(info as *const (Mutex<Replay>, Condvar)) };
        let paths = paths as *const *const c_char;
        let Ok(mut replay) = shared.0.lock() else {
            return;
        };
        for i in 0..count {
            // SAFETY: as above.
            let (flag, id, path) = unsafe {
                (
                    *flags.add(i),
                    *ids.add(i),
                    CStr::from_ptr(*paths.add(i)).to_bytes().to_vec(),
                )
            };
            if flag & HISTORY_DONE != 0 {
                replay.done = Some(id);
                shared.1.notify_all();
            } else if replay.done.is_none() {
                replay.events.push((id, flag, path));
            }
        }
    }

    extern "C" fn nothing(_: *mut c_void) {}

    /// The UUID of the volume's event database, or `None` when the volume keeps no history.
    fn volume_uuid(device: u64) -> Option<String> {
        // SAFETY: plain CoreFoundation calls; every object made here is released here.
        unsafe {
            let uuid = FSEventsCopyUUIDForDevice(device as u32 as i32);
            if uuid.is_null() {
                return None;
            }
            let text = CFUUIDCreateString(std::ptr::null(), uuid);
            CFRelease(uuid);
            if text.is_null() {
                return None;
            }
            let mut buffer = [0 as c_char; 64];
            let ok = CFStringGetCString(text, buffer.as_mut_ptr(), 64, UTF8);
            CFRelease(text);
            (ok != 0).then(|| {
                CStr::from_ptr(buffer.as_ptr())
                    .to_string_lossy()
                    .into_owned()
            })
        }
    }

    /// Replays the events under `root` since `event`; `None` when the replay does not finish by
    /// `deadline`.
    fn replay(root: &[u8], event: u64, deadline: Instant) -> Option<Replay> {
        let shared: Shared = Arc::default();
        let context = StreamContext {
            version: 0,
            info: Arc::as_ptr(&shared) as *mut c_void,
            retain: None,
            release: None,
            copy_description: None,
        };
        // SAFETY: CoreFoundation and FSEvents calls with valid arguments. The stream is stopped,
        // invalidated, drained and released before `shared` can be dropped.
        unsafe {
            let path = CFStringCreateWithBytes(
                std::ptr::null(),
                root.as_ptr(),
                root.len() as isize,
                UTF8,
                0,
            );
            let paths = CFArrayCreate(std::ptr::null(), &path, 1, &kCFTypeArrayCallBacks);
            CFRelease(path);
            let stream = FSEventStreamCreate(
                std::ptr::null(),
                on_events,
                &context,
                paths,
                event,
                0.0,
                NO_DEFER | WATCH_ROOT | FILE_EVENTS,
            );
            CFRelease(paths);
            if stream.is_null() {
                return None;
            }
            let queue = dispatch_queue_create(c"pneuma-base.changed".as_ptr(), std::ptr::null());
            FSEventStreamSetDispatchQueue(stream, queue);
            let started = FSEventStreamStart(stream) != 0;
            let mut finished = false;
            if started {
                let mut replay = shared.0.lock().ok()?;
                while replay.done.is_none() {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    replay = shared.1.wait_timeout(replay, left).ok()?.0;
                }
                finished = replay.done.is_some();
                drop(replay);
                FSEventStreamStop(stream);
            }
            FSEventStreamInvalidate(stream);
            dispatch_sync_f(queue, std::ptr::null_mut(), nothing);
            FSEventStreamRelease(stream);
            dispatch_release(queue);
            if !finished {
                return None;
            }
            let mut replay = shared.0.lock().ok()?;
            Some(std::mem::take(&mut *replay))
        }
    }

    impl LocalFolder {
        pub fn changes_since(
            &self,
            req: &ChangedRequest,
            ctx: &Ctx,
        ) -> Result<ChangedAnswer, Failure> {
            let root = sys::stat_fd(self.root_fd.as_raw_fd())
                .map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
            // SAFETY: a plain query.
            let now_event = unsafe { FSEventsGetCurrentEventId() };
            let volume = volume_uuid(root.device);
            let fresh = |event: u64| {
                Cursor {
                    volume: volume.clone().unwrap_or_else(|| "none".to_owned()),
                    device: root.device,
                    inode: root.inode,
                    event,
                }
                .text()
            };
            let Some(text) = &req.cursor else {
                return Ok(ChangedAnswer {
                    places: Vec::new(),
                    cursor: fresh(now_event),
                    more: false,
                });
            };
            let cursor = Cursor::parse(text).ok_or_else(Failure::bad_request)?;
            let cannot_say = || Failure::cannot_say(fresh(now_event));
            if volume.as_deref() != Some(cursor.volume.as_str())
                || cursor.device != root.device
                || cursor.inode != root.inode
                || cursor.event > now_event
            {
                return Err(cannot_say());
            }
            ctx.check()?;
            let root_path = self.root.as_os_str().as_bytes();
            let deadline = Instant::now() + REPLAY_LIMIT;
            let replay = loop {
                let replay = replay(root_path, cursor.event, deadline).ok_or_else(cannot_say)?;
                // Dropped on the way to this process only: the volume's history is whole, so
                // replaying it again, after a moment, can still give all of it.
                let dropped_here = replay.events.iter().any(|(_, flag, _)| {
                    flag & USER_DROPPED != 0
                        && flag & (UNTRUSTED & !USER_DROPPED & !MUST_SCAN_SUB_DIRS) == 0
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
                if flag & UNTRUSTED != 0 {
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
                cursor: fresh(next),
                more,
            })
        }
    }

    /// The place an event's path names, when it lies in the library.
    fn place_of(root: &[u8], path: &[u8]) -> Option<Place> {
        let path = path.strip_suffix(b"/").unwrap_or(path);
        let rest = path.strip_prefix(root)?;
        let rest = match rest {
            [] => "",
            [b'/', rest @ ..] => std::str::from_utf8(rest).ok()?,
            _ => return None,
        };
        Place::parse(rest)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn paths_become_places() {
            let root = b"/lib/root";
            assert_eq!(place_of(root, b"/lib/root/a/b.md"), Place::parse("a/b.md"));
            assert_eq!(place_of(root, b"/lib/root/"), Place::parse(""));
            assert_eq!(place_of(root, b"/lib/root"), Place::parse(""));
            assert_eq!(place_of(root, b"/lib/rootless/a"), None);
            assert_eq!(place_of(root, b"/elsewhere/a"), None);
        }

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
    }
}
