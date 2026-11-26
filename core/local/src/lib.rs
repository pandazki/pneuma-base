//! The local folder: the one implementation of the storage contract today. Content is the
//! folder itself; records live in `<root>/.pneuma-base/`, caches in `<root>/.pneuma-base/cache/`.

mod content;
mod facts;
mod names;
mod noise;
mod rows;
mod sys;

use std::io::Write;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use pneuma_base_storage::{
    Cancel, FactsAppendAnswer, FactsAppendRequest, FactsSinceAnswer, FactsSinceRequest, Failure,
    GlanceAnswer, InitAnswer, LookAnswer, LookItem, NoiseAnswer, NoiseChange, NoiseEdit,
    OverviewAnswer, OverviewRequest, PlaceArg, ProbeAnswer, ProbeRequest, Reason, RecordPlace,
    RowsGetAnswer, RowsGetRequest, RowsPage, RowsPutRequest, RowsUnderRequest, RowsWhereAnswer,
    RowsWhereRequest, Storage, StorageInfo,
};

pub use noise::DEFAULT_NAMES;

pub const RECORD_AREA: &str = ".pneuma-base";

pub struct LocalFolder {
    root: PathBuf,
    root_fd: OwnedFd,
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
        Ok(LocalFolder { root, root_fd })
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

impl Storage for LocalFolder {
    fn glance(&self, places: &[PlaceArg], cancel: &Cancel) -> Result<GlanceAnswer, Failure> {
        self.glance_places(places, cancel)
    }

    fn overview(&self, req: &OverviewRequest, cancel: &Cancel) -> Result<OverviewAnswer, Failure> {
        self.overview_dir(req, cancel)
    }

    fn probe(&self, req: &ProbeRequest, cancel: &Cancel) -> Result<ProbeAnswer, Failure> {
        self.probe_dir(req, cancel)
    }

    fn look(&self, places: &[LookItem], cancel: &Cancel) -> Result<LookAnswer, Failure> {
        self.look_places(places, cancel)
    }

    fn facts_append(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure> {
        self.append_facts(req)
    }

    fn facts_since(
        &self,
        req: &FactsSinceRequest,
        cancel: &Cancel,
    ) -> Result<FactsSinceAnswer, Failure> {
        self.facts_after(req, cancel)
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
            implementation: "local-folder",
            version: env!("CARGO_PKG_VERSION"),
            cursor: false,
            facets: vec!["fs"],
        }
    }

    fn noise_list(&self) -> Result<NoiseAnswer, Failure> {
        Ok(self.noise().answer())
    }

    fn noise_edit(&self, edit: &NoiseEdit, change: NoiseChange) -> Result<NoiseAnswer, Failure> {
        self.edit_noise(edit, change)
    }
}
