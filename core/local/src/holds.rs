//! `hold` and `release`: "this place is being written, its records follow". A hold is one small
//! file in the record area until it is released or its time runs out; a place at or under a held
//! place is held. Expired holds count for nothing and are removed by whoever meets them.

use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::PathBuf;

use pneuma_base_storage::{Failure, HoldAnswer, HoldRequest, Place, Reason, Time};
use serde::{Deserialize, Serialize};

use crate::{LocalFolder, io_failure, sys};

#[derive(Serialize, Deserialize)]
struct HoldFile {
    place: String,
    until_ms: i64,
}

/// A hold that has not run out.
pub struct Hold {
    pub id: String,
    pub place: Place,
    pub until: Time,
}

/// The live holds, read once per operation.
pub struct Holds(Vec<Hold>);

impl Holds {
    /// Whether `place` lies at or under a held place.
    pub fn covers(&self, place: &Place) -> bool {
        self.0.iter().any(|h| place.is_at_or_under(&h.place))
    }

    /// The first hold other than `own` that a write at `place` would cut across: one on the
    /// place, above it, or below it.
    pub fn blocking(&self, place: &Place, own: Option<&str>) -> Option<&Hold> {
        self.0.iter().find(|h| {
            Some(h.id.as_str()) != own
                && (place.is_at_or_under(&h.place) || h.place.is_at_or_under(place))
        })
    }

    pub fn refuse(&self, place: &Place, own: Option<&str>) -> Result<(), Failure> {
        match self.blocking(place, own) {
            Some(hold) => Err(Failure::held(hold.until)),
            None => Ok(()),
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl LocalFolder {
    fn holds_dir(&self) -> PathBuf {
        self.record_area().join("holds")
    }

    pub fn live_holds(&self) -> Holds {
        let Ok(entries) = std::fs::read_dir(self.holds_dir()) else {
            return Holds(Vec::new());
        };
        let now = Time::now();
        let mut live = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            let parsed = std::fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<HoldFile>(&bytes).ok());
            let Some(file) = parsed else { continue };
            let until = Time::from_millis(file.until_ms);
            match Place::parse(&file.place) {
                Some(place) if until > now => live.push(Hold {
                    id: id.to_owned(),
                    place,
                    until,
                }),
                _ => {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Holds(live)
    }

    pub fn hold_place(&self, req: &HoldRequest) -> Result<HoldAnswer, Failure> {
        let noise = self.noise();
        self.admit(&req.place, &noise)?;
        self.ensure_record_area()?;
        let dir = self.holds_dir();
        std::fs::create_dir_all(&dir).map_err(|e| io_failure(&e))?;
        // Two holders at once must not both get the place: decide under a lock.
        let lock = File::open(&dir).map_err(|e| io_failure(&e))?;
        sys::lock(lock.as_raw_fd()).map_err(|e| Failure::unreadable(sys::errno_name(e)))?;
        self.live_holds().refuse(&req.place, None)?;
        let id = crate::unique_name("h");
        let until = Time::from_millis(Time::now().millis() + req.ttl_ms as i64);
        let file = HoldFile {
            place: req.place.as_str().to_owned(),
            until_ms: until.millis(),
        };
        let bytes = serde_json::to_vec(&file).map_err(|_| Failure::bad_request())?;
        crate::write_atomic(&dir.join(format!("{id}.json")), &bytes)?;
        Ok(HoldAnswer { hold: id, until })
    }

    /// Releasing a hold that is gone or never was is done all the same.
    pub fn release_hold(&self, id: &str) -> Result<(), Failure> {
        if !valid_id(id) {
            return Err(Failure::new(Reason::BadRequest));
        }
        match std::fs::remove_file(self.holds_dir().join(format!("{id}.json"))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_failure(&e)),
        }
    }
}
