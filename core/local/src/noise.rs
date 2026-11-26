use std::collections::HashSet;
use std::fs::File;
use std::os::fd::AsRawFd;

use pneuma_base_storage::{Failure, NoiseAnswer, NoiseChange, NoiseEdit, Place};
use serde::{Deserialize, Serialize};

use crate::{LocalFolder, fnv64, sys};

pub const DEFAULT_NAMES: [&str; 26] = [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    ".pnpm-store",
    ".yarn",
    "bower_components",
    "__pycache__",
    ".venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".cache",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".Trash",
    ".Spotlight-V100",
    ".fseventsd",
    ".TemporaryItems",
];

/// `noise.json` on disk.
#[derive(Serialize, Deserialize, Clone, Default)]
struct NoiseFile {
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
}

/// The library's noise declaration, as every content operation reads it.
pub struct Noise {
    names: Vec<String>,
    paths: Vec<Place>,
    name_set: HashSet<String>,
    declared: bool,
}

impl Noise {
    fn from_file(file: NoiseFile, declared: bool) -> Noise {
        let paths = file.paths.iter().filter_map(|p| Place::parse(p)).collect();
        Noise {
            name_set: file.names.iter().cloned().collect(),
            names: file.names,
            paths,
            declared,
        }
    }

    /// No noise at all: a record place's own area has none.
    fn none() -> Noise {
        Noise::from_file(NoiseFile::default(), false)
    }

    fn defaults() -> Noise {
        let file = NoiseFile {
            names: DEFAULT_NAMES.iter().map(|n| (*n).to_owned()).collect(),
            paths: Vec::new(),
        };
        Noise::from_file(file, false)
    }

    pub fn is_noise(&self, place: &Place) -> bool {
        place.segments().iter().any(|s| self.name_set.contains(*s))
            || self.paths.iter().any(|p| place.is_at_or_under(p))
    }

    pub fn is_noise_name(&self, name: &str) -> bool {
        self.name_set.contains(name)
    }

    /// Whether the entry `name` directly in the directory `parent` is noise. `parent` itself is
    /// known not to be.
    pub fn is_noise_entry(&self, parent: &Place, name: &str) -> bool {
        self.is_noise_name(name)
            || (!self.paths.is_empty() && {
                let place = parent.child(name);
                self.paths.iter().any(|p| place.is_at_or_under(p))
            })
    }

    /// Changes whenever the declaration does; part of a cached listing's key.
    pub fn fingerprint(&self) -> u64 {
        let mut text = Vec::new();
        for name in &self.names {
            text.extend_from_slice(name.as_bytes());
            text.push(0);
        }
        text.push(1);
        for path in &self.paths {
            text.extend_from_slice(path.as_str().as_bytes());
            text.push(0);
        }
        fnv64(&text)
    }

    pub fn answer(&self) -> NoiseAnswer {
        NoiseAnswer {
            names: self.names.clone(),
            paths: self.paths.iter().map(|p| p.as_str().to_owned()).collect(),
            declared: self.declared,
        }
    }
}

impl LocalFolder {
    fn noise_path(&self) -> std::path::PathBuf {
        self.record_area().join("noise.json")
    }

    /// The declaration; without a readable `noise.json`, the default list. Noise is a property
    /// of the content: a record place's own area has none.
    pub fn noise(&self) -> Noise {
        if self.records.is_some() {
            return Noise::none();
        }
        match std::fs::read(self.noise_path()) {
            Ok(bytes) => match serde_json::from_slice::<NoiseFile>(&bytes) {
                Ok(file) => Noise::from_file(file, true),
                Err(_) => Noise::defaults(),
            },
            Err(_) => Noise::defaults(),
        }
    }

    pub fn write_default_noise(&self) -> Result<(), Failure> {
        let file = NoiseFile {
            names: DEFAULT_NAMES.iter().map(|n| (*n).to_owned()).collect(),
            paths: Vec::new(),
        };
        self.write_noise_file(&file)
    }

    fn write_noise_file(&self, file: &NoiseFile) -> Result<(), Failure> {
        let mut bytes = serde_json::to_vec_pretty(file).map_err(|_| Failure::bad_request())?;
        bytes.push(b'\n');
        crate::write_atomic(&self.noise_path(), &bytes)
    }

    pub fn edit_noise(
        &self,
        edit: &NoiseEdit,
        change: NoiseChange,
    ) -> Result<NoiseAnswer, Failure> {
        self.ensure_record_area()?;
        // Two editors at once must not lose each other's change: hold an exclusive lock over
        // the read, the change and the write.
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.record_area().join("noise.lock"))
            .map_err(|e| Failure::unreadable(sys::io_errno(&e)))?;
        // SAFETY: a valid descriptor; the lock is released when `lock` closes.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(Failure::unreadable(sys::io_errno(
                &std::io::Error::last_os_error(),
            )));
        }
        let current = self.noise();
        let mut file = NoiseFile {
            names: current.names,
            paths: current
                .paths
                .iter()
                .map(|p| p.as_str().to_owned())
                .collect(),
        };
        let paths: Vec<String> = edit.paths.iter().map(|p| p.as_str().to_owned()).collect();
        match change {
            NoiseChange::Add => {
                for name in &edit.names {
                    if !file.names.contains(name) {
                        file.names.push(name.clone());
                    }
                }
                for path in paths {
                    if !file.paths.contains(&path) {
                        file.paths.push(path);
                    }
                }
            }
            NoiseChange::Remove => {
                file.names.retain(|n| !edit.names.contains(n));
                file.paths.retain(|p| !paths.contains(p));
            }
        }
        self.write_noise_file(&file)?;
        drop(lock);
        Ok(self.noise().answer())
    }
}
