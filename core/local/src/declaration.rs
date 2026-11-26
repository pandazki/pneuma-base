//! The library's root declaration: one JSON object in `<root>/.pneuma-base/config.json`, kept
//! whole, handed back whole, never interpreted. Other programs read that file, so it is written
//! as `JSON.stringify(object, null, 2)` and a newline would write it: two-space indent, keys in
//! the order given. A write replaces it whole with one rename, under a lock on the record area,
//! and only when the caller's expectation holds there.

use std::io::Read;
use std::os::fd::AsRawFd;

use pneuma_base_storage::{
    DeclarationAnswer, DeclarationWriteRequest, DeclarationWritten, Failure, Kind, Place, Reason,
    Token,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::facets::{self, At};
use crate::fingerprint::{hex, open_place_file, same_state};
use crate::metadata::Walker;
use crate::sys::{self, Stat};
use crate::write::Locked;
use crate::{LocalFolder, RECORD_AREA, io_failure, write_atomic};

const FILE: &str = "config.json";
/// How many times a read that saw the file change under it is tried again.
const TRIES: usize = 3;

/// The declaration's place from the library root: in the record area, outside the content.
fn declaration_place() -> Place {
    Place::root().child(RECORD_AREA).child(FILE)
}

fn unreadable(errno: sys::Errno) -> Failure {
    Failure::unreadable(sys::errno_name(errno))
}

impl LocalFolder {
    /// The token of the declaration file in the state `stat`, carrying its fingerprint so a
    /// racy state can still be confirmed by its content.
    fn declaration_token(&self, place: &Place, stat: &Stat, bytes: &[u8]) -> Token {
        let at = At {
            folder: self,
            place,
            stat,
        };
        facets::token(&at, Some(&hex(&Sha256::digest(bytes))))
    }

    /// Reading makes nothing: without the file (or the record area) both are `None`. A file that
    /// is not a JSON object reads as no declaration, with its token, so a write can replace it.
    pub fn read_declaration(&self) -> Result<DeclarationAnswer, Failure> {
        let place = declaration_place();
        let mut walker = Walker::new(&self.root_fd);
        for _ in 0..TRIES {
            let Some(found) = self.locate(&mut walker, &place)? else {
                return Ok(DeclarationAnswer {
                    declaration: None,
                    token: None,
                });
            };
            if found.stat.kind != Kind::File {
                return Err(Failure::new(Reason::NotAFile));
            }
            self.settle(&found.stat);
            let mut opened = match open_place_file(&mut walker, &place) {
                Err(failure) if failure.reason == Reason::NoSuchPlace => continue,
                other => other?,
            };
            let mut bytes = Vec::new();
            opened
                .file
                .read_to_end(&mut bytes)
                .map_err(|e| io_failure(&e))?;
            let after = sys::stat_fd(opened.file.as_raw_fd()).map_err(unreadable)?;
            if !same_state(&opened.stat, &after) {
                continue;
            }
            let declaration = match serde_json::from_slice(&bytes) {
                Ok(Value::Object(object)) => Some(object),
                _ => None,
            };
            return Ok(DeclarationAnswer {
                declaration,
                token: Some(self.declaration_token(&place, &after, &bytes)),
            });
        }
        Err(Failure::new(Reason::Busy))
    }

    /// Writes the declaration whole when `expect` holds, making the record area if needed;
    /// refused with the token there now (`null` without a declaration) when it does not.
    pub fn write_declaration(
        &self,
        req: &DeclarationWriteRequest,
    ) -> Result<DeclarationWritten, Failure> {
        let mut bytes =
            serde_json::to_vec_pretty(&req.declaration).map_err(|_| Failure::bad_request())?;
        bytes.push(b'\n');
        let place = declaration_place();
        self.ensure_record_area()?;
        let area = sys::open_root(&self.record_area()).map_err(unreadable)?;
        let lock = Locked::take(area.as_raw_fd())?;
        let (holds, found) = self.expectation_holds(lock.fd(), &place, FILE, &req.expect)?;
        if !holds {
            let actual = found.map(|found| self.describe(&place, &found, &[]).token);
            return Err(Failure::refused(Some(
                serde_json::to_value(actual).unwrap_or(Value::Null),
            )));
        }
        write_atomic(&self.record_area().join(FILE), &bytes)?;
        let placed = self
            .settled(lock.fd(), FILE)?
            .ok_or_else(|| Failure::new(Reason::Busy))?;
        let token = self.declaration_token(&place, &placed.stat, &bytes);
        drop(lock);
        Ok(DeclarationWritten { token })
    }
}
