//! FSEvents, the macOS change journal: a per-volume history of file events that survives restarts
//! and reboots. A stream names a folder and an event id to start after; it delivers the history
//! since that id, then a `HISTORY_DONE` event, then live events until it is dropped.

use std::ffi::{CStr, c_char, c_void};

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
    fn FSEventStreamSetExclusionPaths(stream: *mut c_void, paths: CFRef) -> u8;
    fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
    fn FSEventStreamStart(stream: *mut c_void) -> u8;
    fn FSEventStreamFlushSync(stream: *mut c_void);
    fn FSEventStreamStop(stream: *mut c_void);
    fn FSEventStreamInvalidate(stream: *mut c_void);
    fn FSEventStreamRelease(stream: *mut c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeArrayCallBacks: c_void;
    fn CFUUIDCreateString(allocator: CFRef, uuid: CFRef) -> CFRef;
    fn CFStringGetCString(string: CFRef, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
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
    fn dispatch_sync_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    fn dispatch_release(object: *mut c_void);
}

const UTF8: u32 = 0x0800_0100;
pub const NO_DEFER: u32 = 0x02;
pub const WATCH_ROOT: u32 = 0x04;
pub const FILE_EVENTS: u32 = 0x10;
pub const MUST_SCAN_SUB_DIRS: u32 = 0x01;
pub const USER_DROPPED: u32 = 0x02;
pub const KERNEL_DROPPED: u32 = 0x04;
pub const IDS_WRAPPED: u32 = 0x08;
pub const HISTORY_DONE: u32 = 0x10;
pub const ROOT_CHANGED: u32 = 0x20;
pub const MOUNT: u32 = 0x40;
pub const UNMOUNT: u32 = 0x80;
/// Flags that say events were lost, or must be rescanned, for the period they cover.
pub const UNTRUSTED: u32 = MUST_SCAN_SUB_DIRS
    | USER_DROPPED
    | KERNEL_DROPPED
    | IDS_WRAPPED
    | ROOT_CHANGED
    | MOUNT
    | UNMOUNT;

/// One event as the stream delivered it: its id, flags and absolute path.
pub struct Event {
    pub id: u64,
    pub flags: u32,
    pub path: Vec<u8>,
}

type Sink = Box<dyn Fn(Vec<Event>) + Send + Sync>;

extern "C" fn on_events(
    _stream: *const c_void,
    info: *mut c_void,
    count: usize,
    paths: *mut c_void,
    flags: *const u32,
    ids: *const u64,
) {
    // SAFETY: `info` is the `Sink` the stream was made with, alive until the stream is released;
    // FSEvents passes `count` paths, flags and ids.
    let sink = unsafe { &*(info as *const Sink) };
    let paths = paths as *const *const c_char;
    let events = (0..count)
        .map(|i| {
            // SAFETY: as above.
            unsafe {
                Event {
                    id: *ids.add(i),
                    flags: *flags.add(i),
                    path: CStr::from_ptr(*paths.add(i)).to_bytes().to_vec(),
                }
            }
        })
        .collect();
    sink(events);
}

extern "C" fn nothing(_: *mut c_void) {}

/// The newest event id the system has given out, on any volume.
pub fn current_event() -> u64 {
    // SAFETY: a plain query.
    unsafe { FSEventsGetCurrentEventId() }
}

/// The UUID of the volume's event database, or `None` when the volume keeps no history.
pub fn volume_uuid(device: u64) -> Option<String> {
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

/// An array of CFStrings made from `paths`; the caller releases it.
unsafe fn path_array(paths: &[&[u8]]) -> CFRef {
    // SAFETY: CoreFoundation calls with valid arguments; the array retains its strings.
    unsafe {
        let strings: Vec<CFRef> = paths
            .iter()
            .map(|p| {
                CFStringCreateWithBytes(std::ptr::null(), p.as_ptr(), p.len() as isize, UTF8, 0)
            })
            .collect();
        let array = CFArrayCreate(
            std::ptr::null(),
            strings.as_ptr(),
            strings.len() as isize,
            &kCFTypeArrayCallBacks,
        );
        for s in strings {
            CFRelease(s);
        }
        array
    }
}

/// A started stream. Its events go to the sink on a queue of its own; dropping it stops the
/// stream and waits until no callback runs.
pub struct Stream {
    stream: *mut c_void,
    queue: *mut c_void,
    sink: *mut Sink,
}

// SAFETY: the stream and queue are FSEvents and dispatch objects, safe to use from any thread;
// the sink is `Send + Sync`.
unsafe impl Send for Stream {}

impl Stream {
    /// Watches `root` (an absolute path) from the event after `since`, leaving out what lies
    /// under the `exclude` paths. `None` when the system refuses the stream.
    pub fn start(
        root: &[u8],
        since: u64,
        latency: f64,
        flags: u32,
        exclude: &[&[u8]],
        sink: impl Fn(Vec<Event>) + Send + Sync + 'static,
    ) -> Option<Stream> {
        let sink: *mut Sink = Box::into_raw(Box::new(Box::new(sink)));
        let context = StreamContext {
            version: 0,
            info: sink as *mut c_void,
            retain: None,
            release: None,
            copy_description: None,
        };
        // SAFETY: CoreFoundation, FSEvents and dispatch calls with valid arguments. On failure
        // everything made here is released, the sink last.
        unsafe {
            let paths = path_array(&[root]);
            let stream = FSEventStreamCreate(
                std::ptr::null(),
                on_events,
                &context,
                paths,
                since,
                latency,
                flags,
            );
            CFRelease(paths);
            if stream.is_null() {
                drop(Box::from_raw(sink));
                return None;
            }
            if !exclude.is_empty() {
                let excluded = path_array(exclude);
                FSEventStreamSetExclusionPaths(stream, excluded);
                CFRelease(excluded);
            }
            let queue = dispatch_queue_create(c"pneuma-base.changes".as_ptr(), std::ptr::null());
            FSEventStreamSetDispatchQueue(stream, queue);
            let started = Stream {
                stream,
                queue,
                sink,
            };
            if FSEventStreamStart(stream) == 0 {
                return None;
            }
            Some(started)
        }
    }

    /// Returns once the sink has been given every event that had happened when it was called.
    pub fn flush(&self) {
        // SAFETY: the stream is started and not yet released.
        unsafe { FSEventStreamFlushSync(self.stream) }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: stopping a stream that may not have started is allowed; invalidating it and
        // then running an empty block on its queue makes sure no callback is running or due, so
        // the sink can go.
        unsafe {
            FSEventStreamStop(self.stream);
            FSEventStreamInvalidate(self.stream);
            dispatch_sync_f(self.queue, std::ptr::null_mut(), nothing);
            FSEventStreamRelease(self.stream);
            dispatch_release(self.queue);
            drop(Box::from_raw(self.sink));
        }
    }
}

/// The place an event's path names, when it lies under `root`, as the relative path below it
/// (empty for `root` itself).
pub fn relative<'a>(root: &[u8], path: &'a [u8]) -> Option<&'a str> {
    let path = path.strip_suffix(b"/").unwrap_or(path);
    let rest = path.strip_prefix(root)?;
    match rest {
        [] => Some(""),
        [b'/', rest @ ..] => std::str::from_utf8(rest).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_become_relative() {
        let root = b"/lib/root";
        assert_eq!(relative(root, b"/lib/root/a/b.md"), Some("a/b.md"));
        assert_eq!(relative(root, b"/lib/root/"), Some(""));
        assert_eq!(relative(root, b"/lib/root"), Some(""));
        assert_eq!(relative(root, b"/lib/rootless/a"), None);
        assert_eq!(relative(root, b"/elsewhere/a"), None);
    }
}
