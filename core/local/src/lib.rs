//! The local folder: the one implementation of the storage contract today. Content is the
//! folder itself; records live in `<root>/.pneuma-base/`, caches in `<root>/.pneuma-base/cache/`.

mod facets;
mod facts;
mod fingerprint;
mod holds;
mod journal;
mod metadata;
mod names;
mod noise;
mod rows;
mod rule;
mod sys;
mod write;

use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use pneuma_base_storage::{
    ChangedAnswer, ChangedRequest, ContentAnswer, ContentRequest, Ctx, FactsAppendAnswer,
    FactsAppendRequest, FactsSinceAnswer, FactsSinceRequest, Failure, GlanceAnswer, GlanceRequest,
    HoldAnswer, HoldRequest, InitAnswer, LookAnswer, LookItem, MoveAnswer, MoveRequest,
    NoiseAnswer, NoiseChange, NoiseEdit, OverviewAnswer, OverviewRequest, Place, ProbeAnswer,
    ProbeRequest, ReadAnswer, ReadRequest, Reason, RecordPlace, RemoveAnswer, RemoveRequest,
    RowsGetAnswer, RowsGetRequest, RowsPage, RowsPutRequest, RowsUnderRequest, RowsWhereAnswer,
    RowsWhereRequest, Storage, StorageInfo, Time, WriteAnswer, WriteRequest,
};

pub use noise::DEFAULT_NAMES;

pub const RECORD_AREA: &str = ".pneuma-base";

pub struct LocalFolder {
    /// Canonical, in the case the volume keeps.
    root: PathBuf,
    root_fd: OwnedFd,
    /// How close to a change a state can be taken before the file system's clock cannot tell a
    /// second change from the first.
    racy_ns: i128,
}

impl LocalFolder {
    /// `root` must be an existing directory.
    pub fn open(root: &Path) -> Result<LocalFolder, Failure> {
        let root = root
            .canonicalize()
            .map_err(|_| Failure::new(Reason::NoSuchPlace))?;
        if !root.is_dir() {
            return Err(Failure::new(Reason::NotADir));
        }
        let root_fd = sys::open_root(&root).map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
        #[cfg(target_os = "macos")]
        let root = sys::path_of(root_fd.as_raw_fd()).unwrap_or(root);
        sys::forbid_fetching();
        let racy_ns = racy_window(sys::fs_type(root_fd.as_raw_fd()).as_deref());
        Ok(LocalFolder {
            root,
            root_fd,
            racy_ns,
        })
    }

    fn record_area(&self) -> PathBuf {
        self.root.join(RECORD_AREA)
    }

    fn cache_area(&self) -> PathBuf {
        self.record_area().join("cache")
    }

    fn has_record_area(&self) -> bool {
        std::fs::symlink_metadata(self.record_area()).is_ok_and(|m| m.is_dir())
    }

    /// Writing records makes the record area; reading never does.
    fn ensure_record_area(&self) -> Result<(), Failure> {
        std::fs::create_dir_all(self.record_area()).map_err(|e| io_failure(&e))
    }

    /// The absolute path of a place.
    pub fn path_of(&self, place: &Place) -> PathBuf {
        if place.is_root() {
            self.root.clone()
        } else {
            self.root.join(place.as_str())
        }
    }

    /// A state taken within the racy window of its last change, or of a change dated in the
    /// future, cannot vouch for itself.
    pub fn is_racy(&self, stat: &sys::Stat, now: Time) -> bool {
        now.nanos() - stat.last_change_ns() < self.racy_ns
    }

    /// After its own change, a write waits out a short racy window before it describes what it
    /// placed, so the token it answers can vouch for itself (a millisecond on APFS).
    pub fn settle(&self, stat: &sys::Stat) -> bool {
        let wait = stat.last_change_ns() + self.racy_ns - Time::now().nanos();
        if wait <= 0 {
            return false;
        }
        if wait > SETTLE_MAX_NS {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_nanos(wait as u64 + 1));
        true
    }
}

/// The longest a write waits for its own change to settle.
const SETTLE_MAX_NS: i128 = 25_000_000;

/// APFS gives every change its own timestamp (measured: 2,000 same-size rewrites in a row, no
/// two alike), so a millisecond is margin. Linux's file systems stamp with the coarse clock, one
/// tick of up to 10 ms; anything else may round to seconds.
fn racy_window(fs_type: Option<&str>) -> i128 {
    const MS: i128 = 1_000_000;
    match fs_type {
        Some("apfs") => MS,
        // ext4, xfs, btrfs, tmpfs, overlayfs (`statfs.f_type` in hexadecimal).
        Some("ef53" | "58465342" | "9123683e" | "1021994" | "794c7630") => 20 * MS,
        _ => 2_000 * MS,
    }
}

fn io_failure(error: &std::io::Error) -> Failure {
    Failure::unreadable(sys::io_errno(error))
}

/// Replaces `path` whole: write a temporary sibling, then rename it over.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = std::fs::File::create(&temp)
        .and_then(|mut file| file.write_all(bytes))
        .and_then(|()| std::fs::rename(&temp, path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(io_failure(&error));
    }
    Ok(())
}

/// FNV-1a: stable across builds, unlike the standard hasher, so cache file names survive
/// upgrades.
fn fnv64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// A name no other process or thread will choose: process, sequence and time.
fn unique_name(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{prefix}-{}-{}-{:x}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
        Time::now().nanos() & 0xffff_ffff
    )
}

impl Storage for LocalFolder {
    fn glance(&self, req: &GlanceRequest, ctx: &Ctx) -> Result<GlanceAnswer, Failure> {
        self.glance_places(req, ctx)
    }

    fn overview(&self, req: &OverviewRequest, ctx: &Ctx) -> Result<OverviewAnswer, Failure> {
        self.overview_dir(req, ctx)
    }

    fn probe(&self, req: &ProbeRequest, ctx: &Ctx) -> Result<ProbeAnswer, Failure> {
        self.probe_dir(req, ctx)
    }

    fn look(&self, places: &[LookItem], ctx: &Ctx) -> Result<LookAnswer, Failure> {
        self.look_places(places, ctx)
    }

    fn changed(&self, req: &ChangedRequest, ctx: &Ctx) -> Result<ChangedAnswer, Failure> {
        self.changes_since(req, ctx)
    }

    fn content(&self, req: &ContentRequest, ctx: &Ctx) -> Result<ContentAnswer, Failure> {
        self.content_of(req, ctx)
    }

    fn read(&self, req: &ReadRequest, ctx: &Ctx) -> Result<ReadAnswer, Failure> {
        self.read_bytes(req, ctx)
    }

    fn write(&self, req: &WriteRequest, ctx: &Ctx) -> Result<WriteAnswer, Failure> {
        self.write_place(req, ctx)
    }

    fn move_place(&self, req: &MoveRequest, ctx: &Ctx) -> Result<MoveAnswer, Failure> {
        self.move_between(req, ctx)
    }

    fn remove(&self, req: &RemoveRequest, ctx: &Ctx) -> Result<RemoveAnswer, Failure> {
        self.remove_place(req, ctx)
    }

    fn facts_append(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure> {
        self.append_facts(req)
    }

    fn facts_since(&self, req: &FactsSinceRequest, ctx: &Ctx) -> Result<FactsSinceAnswer, Failure> {
        self.facts_after(req, ctx)
    }

    fn rows_put(&self, req: &RowsPutRequest) -> Result<(), Failure> {
        self.put_rows(req)
    }

    fn rows_get(&self, req: &RowsGetRequest) -> Result<RowsGetAnswer, Failure> {
        self.get_rows(req)
    }

    fn rows_under(&self, req: &RowsUnderRequest) -> Result<RowsPage, Failure> {
        self.rows_with_prefix(req)
    }

    fn rows_where(&self, req: &RowsWhereRequest) -> Result<RowsWhereAnswer, Failure> {
        self.rows_with_field(req)
    }

    fn rows_reset(&self, place: &RecordPlace) -> Result<(), Failure> {
        self.reset_rows(place)
    }

    fn init(&self) -> Result<InitAnswer, Failure> {
        match std::fs::create_dir(self.record_area()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Ok(InitAnswer { created: false });
            }
            Err(e) => return Err(io_failure(&e)),
        }
        std::fs::create_dir_all(self.cache_area()).map_err(|e| io_failure(&e))?;
        self.write_default_noise()?;
        Ok(InitAnswer { created: true })
    }

    fn info(&self) -> StorageInfo {
        StorageInfo {
            name: "local-folder",
            version: env!("CARGO_PKG_VERSION"),
            addresses: vec!["path"],
            cursor: self.reliable_cursor(),
            facets: facets::available(),
        }
    }

    fn noise_list(&self) -> Result<NoiseAnswer, Failure> {
        Ok(self.noise().answer())
    }

    fn noise_edit(&self, edit: &NoiseEdit, change: NoiseChange) -> Result<NoiseAnswer, Failure> {
        self.edit_noise(edit, change)
    }

    fn hold(&self, req: &HoldRequest) -> Result<HoldAnswer, Failure> {
        self.hold_place(req)
    }

    fn release(&self, hold: &str) -> Result<(), Failure> {
        self.release_hold(hold)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn racy_windows_follow_the_file_system_clock() {
        assert_eq!(racy_window(Some("apfs")), 1_000_000);
        assert_eq!(racy_window(Some("ef53")), 20_000_000);
        assert_eq!(racy_window(Some("msdos")), 2_000_000_000);
        assert_eq!(racy_window(None), 2_000_000_000);
    }
}
