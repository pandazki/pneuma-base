//! The local folder: the one implementation of the storage contract today. Content is the
//! folder itself; records live in `<root>/.pneuma-base/`, caches in `<root>/.pneuma-base/cache/`,
//! a record place's own content in `<root>/.pneuma-base/<name>/`, the root declaration in
//! `<root>/.pneuma-base/config.json`.

mod area;
#[cfg(target_os = "macos")]
mod changelog;
mod declaration;
mod deep;
mod facets;
mod facts;
mod fingerprint;
#[cfg(target_os = "macos")]
mod fsevents;
mod holds;
mod journal;
#[cfg(target_os = "macos")]
mod listen;
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
    ChangedAnswer, ChangedRequest, ContentAnswer, ContentRequest, Ctx, DeclarationAnswer,
    DeclarationWriteRequest, DeclarationWritten, FactsAppendAnswer, FactsAppendRequest,
    FactsCarryAnswer, FactsCarryRequest, FactsSinceAnswer, FactsSinceRequest, Failure,
    GlanceAnswer, GlanceRequest, HoldAnswer, HoldRequest, InitAnswer, LookAnswer, LookFrom,
    LookItem, LookPage, LookRequest, MoveAnswer, MoveRequest, NoiseAnswer, NoiseChange, NoiseEdit,
    OverviewAnswer, OverviewRequest, Place, ProbeAnswer, ProbeRequest, ReadAnswer, ReadRequest,
    Reason, RecordPlace, RemoveAnswer, RemoveRequest, RowsGetAnswer, RowsGetRequest, RowsPage,
    RowsPutRequest, RowsUnderRequest, RowsWhereAnswer, RowsWhereRequest, Storage, StorageInfo,
    SubscribeRequest, Time, WriteAnswer, WriteRequest,
};

use area::absent;

pub use noise::DEFAULT_NAMES;

pub const RECORD_AREA: &str = ".pneuma-base";

/// A view of a library: its content, or one record place's own area in it (`area.rs`).
pub struct LocalFolder {
    /// The library folder: canonical, in the case the volume keeps.
    library: PathBuf,
    /// Where this view's places start: the library folder, or a record place's own area.
    root: PathBuf,
    root_fd: OwnedFd,
    /// How close to a change a state can be taken before the file system's clock cannot tell a
    /// second change from the first.
    racy_ns: i128,
    /// The record place whose own area this view is; `None` for the content.
    records: Option<RecordPlace>,
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
            library: root.clone(),
            root,
            root_fd,
            racy_ns,
            records: None,
        })
    }

    /// Another view of the same library, starting at `root`.
    fn with_root(&self, root: PathBuf, root_fd: OwnedFd, records: Option<RecordPlace>) -> Self {
        LocalFolder {
            library: self.library.clone(),
            root,
            root_fd,
            racy_ns: self.racy_ns,
            records,
        }
    }

    fn record_area(&self) -> PathBuf {
        self.library.join(RECORD_AREA)
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

    /// The absolute path of a place of this view.
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
        let pending = stat.last_change_ns() + self.racy_ns > Time::now().nanos();
        pending && self.wait_past(stat.last_change_ns())
    }

    /// Waits until a change at `change_ns` is past the racy window, when that is at most 25 ms
    /// away (perhaps already past); false, without waiting, when it is further.
    pub fn wait_past(&self, change_ns: i128) -> bool {
        let wait = change_ns + self.racy_ns - Time::now().nanos();
        if wait > SETTLE_MAX_NS {
            return false;
        }
        if wait > 0 {
            std::thread::sleep(std::time::Duration::from_nanos(wait as u64 + 1));
        }
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

/// A look's expectations: the request's own, or those read from a table's rows.
enum Items<'a> {
    Given(&'a [LookItem]),
    Read(Vec<LookItem>),
}

impl Items<'_> {
    fn as_slice(&self) -> &[LookItem] {
        match self {
            Items::Given(items) => items,
            Items::Read(items) => items,
        }
    }
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
        match self.view(&req.area, false)? {
            Some(view) => view.glance_places(req, ctx),
            None => Ok(absent::glance(req)),
        }
    }

    fn overview(&self, req: &OverviewRequest, ctx: &Ctx) -> Result<OverviewAnswer, Failure> {
        match self.view(&req.area, false)? {
            Some(view) => view.overview_dir(req, ctx),
            None => absent::overview(req),
        }
    }

    fn probe(&self, req: &ProbeRequest, ctx: &Ctx) -> Result<ProbeAnswer, Failure> {
        self.probe_dir(req, ctx)
    }

    fn look(&self, req: &LookRequest, ctx: &Ctx) -> Result<LookAnswer, Failure> {
        let (items, page) = match &req.from {
            LookFrom::Places(items) => (Items::Given(items), None),
            LookFrom::Rows(rows) => {
                let (items, more) = self.expectations(rows)?;
                let compared = items.len() as u64;
                (Items::Read(items), Some(LookPage { compared, more }))
            }
        };
        let deep = req.deep.as_ref();
        let mut answer = match self.view(&req.area, false)? {
            Some(view) => view.look_places(items.as_slice(), deep, ctx)?,
            None => absent::look(items.as_slice(), deep),
        };
        answer.page = page;
        Ok(answer)
    }

    fn changed(&self, req: &ChangedRequest, ctx: &Ctx) -> Result<ChangedAnswer, Failure> {
        self.changes_since(req, ctx)
    }

    fn subscribe(&self, req: &SubscribeRequest, ctx: &Ctx) -> Result<(), Failure> {
        self.listen(req, ctx)
    }

    fn content(&self, req: &ContentRequest, ctx: &Ctx) -> Result<ContentAnswer, Failure> {
        match self.view(&req.area, false)? {
            Some(view) => view.content_of(req, ctx),
            None => absent::content(req),
        }
    }

    fn read(&self, req: &ReadRequest, ctx: &Ctx) -> Result<ReadAnswer, Failure> {
        match self.view(&req.area, false)? {
            Some(view) => view.read_bytes(req, ctx),
            None => Err(absent::read(req)),
        }
    }

    fn write(&self, req: &WriteRequest, ctx: &Ctx) -> Result<WriteAnswer, Failure> {
        let view = match self.view(&req.area, false)? {
            Some(view) => view,
            None => {
                absent::write(req)?;
                self.view(&req.area, true)?
                    .ok_or_else(|| Failure::new(Reason::Busy))?
            }
        };
        view.write_place(req, ctx)
    }

    fn move_place(&self, req: &MoveRequest, ctx: &Ctx) -> Result<MoveAnswer, Failure> {
        match self.view(&req.area, false)? {
            Some(view) => view.move_between(req, ctx),
            None => Err(absent::move_place(req)),
        }
    }

    fn remove(&self, req: &RemoveRequest, ctx: &Ctx) -> Result<RemoveAnswer, Failure> {
        match self.view(&req.area, false)? {
            Some(view) => view.remove_place(req, ctx),
            None => Err(absent::remove(req)),
        }
    }

    fn facts_append(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure> {
        self.append_facts(req)
    }

    fn facts_since(&self, req: &FactsSinceRequest, ctx: &Ctx) -> Result<FactsSinceAnswer, Failure> {
        self.facts_after(req, ctx)
    }

    fn facts_carry(&self, req: &FactsCarryRequest) -> Result<FactsCarryAnswer, Failure> {
        self.carry_facts(req)
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

    fn declaration_read(&self) -> Result<DeclarationAnswer, Failure> {
        self.read_declaration()
    }

    fn declaration_write(
        &self,
        req: &DeclarationWriteRequest,
    ) -> Result<DeclarationWritten, Failure> {
        self.write_declaration(req)
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
