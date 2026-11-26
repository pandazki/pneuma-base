use std::collections::BTreeMap;

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::{Place, Time, Token};

/// The fixed reasons of contract section 8.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NoSuchPlace,
    NotADir,
    NotAFile,
    Noise,
    Outside,
    Refused,
    TooMany,
    Elsewhere,
    Held,
    CannotSay,
    Unreadable,
    BadRequest,
    Cancelled,
    Busy,
}

/// A failed or refused answer. `detail` is the system's reason for `unreadable`; `actual` is
/// the present state for a `refused` that has one.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub reason: Reason,
    pub detail: Option<String>,
    pub actual: Option<Value>,
}

impl Failure {
    pub fn new(reason: Reason) -> Failure {
        Failure {
            reason,
            detail: None,
            actual: None,
        }
    }

    pub fn bad_request() -> Failure {
        Failure::new(Reason::BadRequest)
    }

    pub fn unreadable(detail: impl Into<String>) -> Failure {
        Failure {
            detail: Some(detail.into()),
            ..Failure::new(Reason::Unreadable)
        }
    }

    pub fn refused(actual: Option<Value>) -> Failure {
        Failure {
            actual,
            ..Failure::new(Reason::Refused)
        }
    }

    pub fn outcome(&self) -> &'static str {
        if self.reason == Reason::Refused {
            "refused"
        } else {
            "failed"
        }
    }

    fn write_fields<M: SerializeMap>(&self, map: &mut M) -> Result<(), M::Error> {
        map.serialize_entry("reason", &self.reason)?;
        if let Some(detail) = &self.detail {
            map.serialize_entry("detail", detail)?;
        }
        if let Some(actual) = &self.actual {
            map.serialize_entry("actual", actual)?;
        }
        Ok(())
    }
}

impl Serialize for Failure {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("outcome", self.outcome())?;
        self.write_fields(&mut map)?;
        map.end()
    }
}

/// What a place is, when there is something there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    File,
    Dir,
    Other,
}

#[derive(Clone, Debug, Serialize)]
pub struct FsFacet {
    pub inode: u64,
    pub device: u64,
    pub created: Option<Time>,
    pub mode: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Facets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs: Option<FsFacet>,
}

/// One place's description, as `glance`, `overview` and `look` give it.
#[derive(Clone, Debug, Serialize)]
pub struct Description {
    pub place: Place,
    pub kind: Kind,
    pub token: Token,
    pub size: Option<u64>,
    pub modified: Time,
    pub facets: Facets,
}

/// What `glance` saw at one asked place.
#[derive(Clone, Debug)]
pub enum Seen {
    Present(Description),
    Absent(String),
    Failed(String, Failure),
}

impl Serialize for Seen {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Seen::Present(description) => description.serialize(serializer),
            Seen::Absent(place) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("place", place)?;
                map.serialize_entry("kind", "none")?;
                map.end()
            }
            Seen::Failed(place, failure) => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("place", place)?;
                map.serialize_entry("outcome", failure.outcome())?;
                failure.write_fields(&mut map)?;
                map.end()
            }
        }
    }
}

/// One place's failure inside a list answer (`look`).
#[derive(Clone, Debug)]
pub struct PlaceFailure {
    pub place: String,
    pub failure: Failure,
}

impl Serialize for PlaceFailure {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("place", &self.place)?;
        self.failure.write_fields(&mut map)?;
        map.end()
    }
}

#[derive(Debug, Serialize)]
pub struct GlanceAnswer {
    pub entries: Vec<Seen>,
}

#[derive(Debug, Serialize)]
pub struct More {
    pub at_least: u64,
    pub after: String,
}

#[derive(Debug, Serialize)]
pub struct OverviewAnswer {
    pub entries: Vec<Description>,
    pub more: Option<More>,
    pub total: Option<u64>,
    pub noise: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ProbeAnswer {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub exceeded: bool,
    pub markers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Changed {
    pub place: Place,
    pub entry: Description,
}

#[derive(Debug, Default, Serialize)]
pub struct LookAnswer {
    pub same: u64,
    pub changed: Vec<Changed>,
    pub gone: Vec<Place>,
    pub failed: Vec<PlaceFailure>,
}

#[derive(Debug, Serialize)]
pub struct FactsAppendAnswer {
    pub orders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Fact {
    pub order: String,
    pub fact: Value,
}

#[derive(Debug, Serialize)]
pub struct FactsSinceAnswer {
    pub facts: Vec<Fact>,
    pub cursor: String,
    pub more: bool,
}

/// A stored row. `fields` are the queryable string fields, at most four.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Row {
    pub key: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    pub value: Value,
}

/// A row as an answer gives it: the value is the JSON text as stored, passed on without being
/// parsed into a tree and written out again, so reading many rows costs little more than their bytes.
#[derive(Clone, Debug, Serialize)]
pub struct StoredRow {
    pub key: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    pub value: Box<serde_json::value::RawValue>,
}

#[derive(Debug, Serialize)]
pub struct RowsGetAnswer {
    pub rows: Vec<StoredRow>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct After {
    pub after: String,
}

#[derive(Debug, Serialize)]
pub struct RowsPage {
    pub rows: Vec<StoredRow>,
    pub more: Option<After>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum RowsWhereAnswer {
    Page(RowsPage),
    Count { count: u64, exceeded: bool },
}

#[derive(Debug, Serialize)]
pub struct InitAnswer {
    pub created: bool,
}

/// What an implementation says about itself; the dispatch adds the contract version and the
/// operations.
#[derive(Debug, Serialize)]
pub struct StorageInfo {
    pub implementation: &'static str,
    pub version: &'static str,
    pub cursor: bool,
    pub facets: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct NoiseAnswer {
    pub names: Vec<String>,
    pub paths: Vec<String>,
    pub declared: bool,
}
