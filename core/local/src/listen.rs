//! `subscribe`, in `serve`: whoever stays listens. While anyone in this process subscribes to the
//! library, one thread listens to the system's journal for it and keeps the change log
//! (`changelog.rs`), unless another process already does; then it waits to take over. It starts
//! with one replay from where the log ended (or from the subscriber's cursor, when there is no
//! log) to cover the time nobody listened, then hears changes live. Each subscription reads the
//! log from its own cursor and sends what is new as progress, shaped as `changed` would answer.

use std::collections::HashMap;
use std::fs::File;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use pneuma_base_storage::{Ctx, Failure, Place, SubscribeRequest, Time};
use serde_json::json;

use crate::changelog::{self, BEAT, Heard, Writer};
use crate::fsevents::{self, Event, Stream};
use crate::journal::Cursor;
use crate::{LocalFolder, RECORD_AREA, sys};

/// How long the system may gather events before delivering them.
const LATENCY: f64 = 0.03;
/// A subscription looks at the log at least this often, for what a listener in another process
/// recorded.
const POLL: Duration = Duration::from_millis(250);
/// The most places one progress line carries.
const PAGE: usize = 1_000;
/// A gap whose replay would take longer than this is not replayed: the log starts again.
const CATCH_UP_LIMIT: Duration = Duration::from_secs(10);
/// How often in a row the listener hears the history again after events were dropped on their
/// way to it, before it gives up on the time since its last heartbeat.
const REPLAYS: u32 = 5;
/// How long it waits before it does.
const RETRY_PAUSE: Duration = Duration::from_millis(100);
/// After a delivery, how soon the next heartbeat confirms what it flushed.
const CONFIRM: Duration = Duration::from_millis(50);

/// The listening for one library in this process.
struct Listener {
    library: PathBuf,
    state: Mutex<State>,
    news: Condvar,
}

#[derive(Default)]
struct State {
    subscribers: usize,
    running: bool,
    /// Bumped whenever the log changed here or the listener's standing did.
    generation: u64,
    /// The library's folder went away, or its volume keeps no history: nothing to listen to.
    gone: bool,
}

/// How one spell of writing the log ended.
enum Ended {
    /// Nobody here subscribes any more.
    Stopped,
    /// The log could not be kept here (the cache area was replaced, or could not be written).
    Again,
    Gone,
}

fn listeners() -> &'static Mutex<HashMap<PathBuf, Arc<Listener>>> {
    static LISTENERS: OnceLock<Mutex<HashMap<PathBuf, Arc<Listener>>>> = OnceLock::new();
    LISTENERS.get_or_init(Mutex::default)
}

impl Listener {
    fn join(library: &Path, hint: Option<u64>) -> Arc<Listener> {
        let listener = listeners()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(library.to_owned())
            .or_insert_with(|| {
                Arc::new(Listener {
                    library: library.to_owned(),
                    state: Mutex::default(),
                    news: Condvar::new(),
                })
            })
            .clone();
        let mut state = listener.lock();
        state.subscribers += 1;
        if !state.running && !state.gone {
            state.running = true;
            let running = listener.clone();
            std::thread::spawn(move || running.run(hint));
        }
        drop(state);
        listener
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn leave(&self) {
        self.lock().subscribers -= 1;
        self.news.notify_all();
    }

    fn notify(&self) {
        self.lock().generation += 1;
        self.news.notify_all();
    }

    fn subscribers(&self) -> usize {
        self.lock().subscribers
    }

    fn gone(&self) -> bool {
        self.lock().gone
    }

    /// Waits until there is news after `seen`, or `timeout`; answers the newest generation.
    fn wait(&self, seen: u64, timeout: Duration) -> u64 {
        let state = self.lock();
        let (state, _) = self
            .news
            .wait_timeout_while(state, timeout, |s| s.generation == seen && !s.gone)
            .unwrap_or_else(|e| e.into_inner());
        state.generation
    }

    fn run(self: Arc<Self>, hint: Option<u64>) {
        let folder = LocalFolder::open(&self.library);
        loop {
            let ended = match &folder {
                Err(_) => Ended::Gone,
                Ok(_) if self.subscribers() == 0 => Ended::Stopped,
                Ok(folder) => {
                    let files = folder.change_log();
                    match changelog::take_lock(&files) {
                        Ok(Some(lock)) => self.write(folder, &files, lock, hint),
                        _ => Ended::Again,
                    }
                }
            };
            {
                let mut state = self.lock();
                let gone = matches!(ended, Ended::Gone);
                if gone || state.subscribers == 0 {
                    state.running = false;
                    state.gone |= gone;
                    drop(state);
                    self.news.notify_all();
                    return;
                }
            }
            let state = self.lock();
            let _ = self
                .news
                .wait_timeout_while(state, BEAT, |s| s.subscribers > 0)
                .unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Keeps the log while this process holds its lock.
    fn write(
        &self,
        folder: &LocalFolder,
        files: &changelog::Files,
        lock: File,
        hint: Option<u64>,
    ) -> Ended {
        let Ok(now) = folder.cursor_now() else {
            return Ended::Gone;
        };
        if now.volume == "none" {
            return Ended::Gone;
        }
        let start = hint.filter(|h| *h <= now.event).unwrap_or(now.event);
        let Ok((mut writer, mut since)) = Writer::open(files, lock, &now.origin(), start) else {
            return Ended::Again;
        };
        if crate::journal::replay_estimate(since, now.event) > CATCH_UP_LIMIT {
            if writer.lost(now.event).is_err() {
                return Ended::Again;
            }
            since = now.event;
        }
        let inbox: Arc<(Mutex<Vec<Event>>, Condvar)> = Arc::default();
        let root = root_of(folder);
        let records = folder.library.join(RECORD_AREA);
        let Some(stream) = listen_from(&root, since, &records, &inbox) else {
            writer.stop();
            return Ended::Gone;
        };
        let mut hearing = Hearing {
            root,
            noise: folder.noise(),
            live: false,
            dropped: None,
        };
        let mut stream = stream;
        let mut noise_seen = noise_stamp(folder);
        let mut last_beat: Option<Instant> = None;
        // Flushed through at the last heartbeat, published at the next one if no drop was heard
        // of meanwhile: the system can report a drop after events that came later.
        let mut candidate: Option<u64> = None;
        let mut confirm_soon = false;
        let mut replays = 0;
        let ended = loop {
            let events = take(&inbox, if confirm_soon { CONFIRM } else { POLL });
            let delivered = !events.is_empty();
            match hearing.keep(&mut writer, events) {
                Ok(true) => self.notify(),
                Ok(false) => {}
                Err(ended) => break ended,
            }
            let since_beat = last_beat.map_or(BEAT, |t| t.elapsed());
            if !(hearing.live
                && (delivered || since_beat >= BEAT || (confirm_soon && since_beat >= CONFIRM)))
            {
                if self.subscribers() == 0 {
                    break Ended::Stopped;
                }
                if writer.replaced(files) {
                    return Ended::Again;
                }
                continue;
            }
            // Everything up to `upto` has happened; once flushed, it has all been delivered,
            // unless some was dropped on its way here.
            let upto = fsevents::current_event();
            stream.flush();
            if let Err(ended) = hearing.keep(&mut writer, take(&inbox, Duration::ZERO)) {
                break ended;
            }
            if let Some(at) = hearing.dropped.take() {
                candidate = None;
                confirm_soon = false;
                if at <= writer.head() || replays >= REPLAYS {
                    // Heard of too late, or again and again: whoever read past it compares.
                    if writer.lost(upto).is_err() {
                        break Ended::Again;
                    }
                } else {
                    // The volume's history is whole: hear it again from the published head.
                    replays += 1;
                    hearing.live = false;
                    drop(stream);
                    std::thread::sleep(RETRY_PAUSE);
                    match listen_from(&root_of(folder), writer.head(), &records, &inbox) {
                        Some(again) => stream = again,
                        None => {
                            writer.stop();
                            return Ended::Gone;
                        }
                    }
                    continue;
                }
            }
            let mut beat = Ok(());
            if noise_stamp(folder) != noise_seen {
                // What was noise and is not any more was not kept while it was.
                hearing.noise = folder.noise();
                noise_seen = noise_stamp(folder);
                candidate = None;
                beat = writer.lost(upto);
            }
            let publish = candidate.replace(upto).unwrap_or(0);
            if beat
                .and_then(|()| writer.beat(publish, Time::now().millis()))
                .is_err()
            {
                break Ended::Again;
            }
            replays = 0;
            confirm_soon = delivered;
            last_beat = Some(Instant::now());
            self.notify();
            if self.subscribers() == 0 {
                break Ended::Stopped;
            }
            if writer.replaced(files) {
                return Ended::Again;
            }
        };
        drop(stream);
        writer.stop();
        ended
    }
}

/// The library folder's path, as FSEvents names it.
fn root_of(folder: &LocalFolder) -> Vec<u8> {
    folder.root.as_os_str().as_bytes().to_vec()
}

/// A stream from the event after `since` that hands what it delivers to `inbox`.
fn listen_from(
    root: &[u8],
    since: u64,
    records: &Path,
    inbox: &Arc<(Mutex<Vec<Event>>, Condvar)>,
) -> Option<Stream> {
    let sink = inbox.clone();
    Stream::start(
        root,
        since,
        LATENCY,
        fsevents::NO_DEFER | fsevents::WATCH_ROOT | fsevents::FILE_EVENTS,
        &[records.as_os_str().as_bytes()],
        move |events: Vec<Event>| {
            sink.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(events);
            sink.1.notify_one();
        },
    )
}

/// What the writing thread keeps between deliveries.
struct Hearing {
    root: Vec<u8>,
    noise: crate::noise::Noise,
    /// The system's history since the stream's start has been delivered.
    live: bool,
    /// Events were dropped on their way here since the last heartbeat: the lowest id the system
    /// gave the drop.
    dropped: Option<u64>,
}

impl Hearing {
    /// Keeps one delivery in the log; answers whether it named any place.
    fn keep(&mut self, writer: &mut Writer, events: Vec<Event>) -> Result<bool, Ended> {
        let failed = |_: Failure| Ended::Again;
        let mut heard: Vec<(String, u64)> = Vec::new();
        let mut any = false;
        for e in events {
            if e.flags & fsevents::HISTORY_DONE != 0 {
                self.live = true;
                continue;
            }
            let lost = e.flags
                & fsevents::UNTRUSTED
                & !fsevents::USER_DROPPED
                & !fsevents::MUST_SCAN_SUB_DIRS;
            if e.flags & fsevents::USER_DROPPED != 0 && lost == 0 {
                self.dropped = Some(self.dropped.map_or(e.id, |d| d.min(e.id)));
                continue;
            }
            if e.flags & fsevents::UNTRUSTED != 0 {
                writer.record(&heard).map_err(failed)?;
                any |= !heard.is_empty();
                heard.clear();
                writer.lost(fsevents::current_event()).map_err(failed)?;
                if e.flags & fsevents::ROOT_CHANGED != 0 {
                    return Err(Ended::Gone);
                }
                continue;
            }
            let Some(place) = fsevents::relative(&self.root, &e.path).and_then(Place::parse) else {
                continue;
            };
            if place.segments().first() == Some(&RECORD_AREA) || self.noise.is_noise(&place) {
                continue;
            }
            heard.push((place.as_str().to_owned(), e.id));
        }
        writer.record(&heard).map_err(failed)?;
        Ok(any || !heard.is_empty())
    }
}

/// The events delivered so far, waiting up to `timeout` for the first.
fn take(inbox: &(Mutex<Vec<Event>>, Condvar), timeout: Duration) -> Vec<Event> {
    let events = inbox.0.lock().unwrap_or_else(|e| e.into_inner());
    let (mut events, _) = inbox
        .1
        .wait_timeout_while(events, timeout, |events| events.is_empty())
        .unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *events)
}

/// What says the noise declaration changed.
fn noise_stamp(folder: &LocalFolder) -> Option<(i128, u64)> {
    sys::stat_path(&folder.record_area().join("noise.json"))
        .ok()
        .map(|s| (s.ctime_ns, s.inode))
}

/// Leaves the listener when the subscription ends, however it ends.
struct Leave(Arc<Listener>);

impl Drop for Leave {
    fn drop(&mut self) {
        self.0.leave();
    }
}

impl LocalFolder {
    pub fn listen(&self, req: &SubscribeRequest, ctx: &Ctx) -> Result<(), Failure> {
        let now = self.cursor_now()?;
        if now.volume == "none" {
            return Err(Failure::cannot_say(now.text()));
        }
        let given = req
            .cursor
            .as_deref()
            .and_then(Cursor::parse)
            .filter(|c| c.origin() == now.origin() && c.event <= now.event);
        let listener = Listener::join(&self.library, given.as_ref().map(|c| c.event));
        let leave = Leave(listener);
        let explicit = given.is_some();
        let mut cursor = given.unwrap_or(now);
        let mut announced = false;
        let mut seen = 0;
        loop {
            ctx.check()?;
            if leave.0.gone() {
                return Err(Failure::cannot_say(self.cursor_now()?.text()));
            }
            match self.heard_after(&cursor, PAGE) {
                Heard::NoListener => {}
                // Asked from now, the subscription starts where the log does.
                Heard::Behind { floor } if !explicit && !announced => {
                    cursor = cursor.at(floor);
                    continue;
                }
                Heard::Behind { .. } => {
                    cursor = self.cursor_now()?;
                    ctx.progress(json!({ "outcome": "failed", "reason": "cannot_say", "cursor": cursor.text() }));
                    announced = true;
                }
                Heard::Places { places, next, more } => {
                    cursor = cursor.at(next);
                    if !announced || !places.is_empty() {
                        ctx.progress(json!({ "outcome": "done", "places": places, "cursor": cursor.text(), "more": more }));
                        announced = true;
                    }
                    if more {
                        continue;
                    }
                }
            }
            seen = leave.0.wait(seen, POLL);
        }
    }
}
