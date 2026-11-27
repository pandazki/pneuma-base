use std::collections::BTreeMap;

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::{DeepToken, Place, Time, Token};

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

/// A failed or refused answer: the reason and the fields that reason carries (`detail` for
/// `unreadable`, `actual` for `refused`, `at_least` for `too_many`, `size` for `elsewhere`,
/// `until` for `held`, `cursor` for `cannot_say`).
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub reason: Reason,
    pub fields: Map<String, Value>,
}

impl Failure {
    pub fn new(reason: Reason) -> Failure {
        Failure {
            reason,
            fields: Map::new(),
        }
    }

    fn with(reason: Reason, key: &str, value: Value) -> Failure {
        let mut failure = Failure::new(reason);
        failure.fields.insert(key.to_owned(), value);
        failure
    }

    pub fn bad_request() -> Failure {
        Failure::new(Reason::BadRequest)
    }

    pub fn unreadable(detail: impl Into<String>) -> Failure {
        Failure::with(Reason::Unreadable, "detail", Value::String(detail.into()))
    }

    pub fn refused(actual: Option<Value>) -> Failure {
        match actual {
            Some(actual) => Failure::with(Reason::Refused, "actual", actual),
            None => Failure::new(Reason::Refused),
        }
    }

    pub fn too_many(at_least: u64) -> Failure {
        Failure::with(Reason::TooMany, "at_least", at_least.into())
    }

    pub fn elsewhere(size: u64) -> Failure {
        Failure::with(Reason::Elsewhere, "size", size.into())
    }

    pub fn held(until: Time) -> Failure {
        Failure::with(Reason::Held, "until", Value::String(until.iso()))
    }

    pub fn cannot_say(cursor: String) -> Failure {
        Failure::with(Reason::CannotSay, "cursor", Value::String(cursor))
    }

    /// The failure said of a write's source, not its target (`"side": "from"`), when it is one a
    /// source can cause.
    pub fn of_source(mut self) -> Failure {
        use Reason::*;
        if matches!(
            self.reason,
            NoSuchPlace | NotADir | NotAFile | Noise | Outside | Unreadable | Elsewhere
        ) {
            self.fields.insert("side".to_owned(), Value::from("from"));
        }
        self
    }

    pub fn outcome(&self) -> &'static str {
        if self.reason == Reason::Refused {
            "refused"
        } else {
            "failed"
        }
    }

    pub fn detail(&self) -> Option<&str> {
        self.fields.get("detail").and_then(Value::as_str)
    }

    fn write_fields<M: SerializeMap>(&self, map: &mut M) -> Result<(), M::Error> {
        map.serialize_entry("reason", &self.reason)?;
        for (key, value) in &self.fields {
            map.serialize_entry(key, value)?;
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

/// The facets of one place, by name, in the order their sources gave them. The abstraction does
/// not know what any facet means; each implementation names its own.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facets(Vec<(&'static str, Value)>);

impl Facets {
    pub fn push(&mut self, name: &'static str, value: Value) {
        self.0.push((name, value));
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.0.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
    }
}

impl Serialize for Facets {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, value) in &self.0 {
            map.serialize_entry(name, value)?;
        }
        map.end()
    }
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
    /// Present, and true, when someone declared the place is being written (`hold`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
}

/// What is at a place: a description, or nothing.
#[derive(Clone, Debug)]
pub enum Present {
    Is(Description),
    None(Place),
}

impl Serialize for Present {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Present::Is(description) => description.serialize(serializer),
            Present::None(place) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("place", place)?;
                map.serialize_entry("kind", "none")?;
                map.end()
            }
        }
    }
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
    /// A directory a deep look compared: its deep token now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep: Option<DeepToken>,
}

#[derive(Debug, Default, Serialize)]
pub struct LookAnswer {
    pub same: u64,
    pub changed: Vec<Changed>,
    pub gone: Vec<Place>,
    pub failed: Vec<PlaceFailure>,
    /// The asked places someone declared are being written, whatever else is said of them.
    pub held: Vec<Place>,
    /// When a table held the expectations: how many rows this page compared, and where the next
    /// page starts.
    #[serde(flatten)]
    pub page: Option<LookPage>,
}

#[derive(Debug, Serialize)]
pub struct LookPage {
    pub compared: u64,
    pub more: Option<After>,
}

#[derive(Debug, Serialize)]
pub struct ChangedAnswer {
    pub places: Vec<Place>,
    pub cursor: String,
    pub more: bool,
}

/// A file's or a directory's content fingerprint, as `content` gives it.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContentAnswer {
    File {
        fingerprint: String,
        token: Token,
        size: u64,
    },
    Dir {
        fingerprint: String,
        files: u64,
        bytes: u64,
        token: Token,
        #[serde(skip_serializing_if = "Option::is_none")]
        manifest: Option<Manifest>,
    },
}

/// A page of a directory's manifest: each file its content rule counts, by the bytes of its path.
#[derive(Debug, Serialize)]
pub struct Manifest {
    pub entries: Vec<ManifestEntry>,
    pub more: Option<After>,
}

/// A file of a directory's content: its path relative to the directory, its fingerprint, its size.
#[derive(Debug, Serialize)]
pub struct ManifestEntry {
    pub path: String,
    pub fingerprint: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct ReadAnswer {
    pub token: Token,
    pub size: u64,
    pub offset: u64,
    pub length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteAnswer {
    pub entry: Description,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct MoveAnswer {
    pub entry: Description,
}

#[derive(Debug, Serialize)]
pub struct RemoveAnswer {
    pub removed: bool,
}

#[derive(Debug, Serialize)]
pub struct HoldAnswer {
    pub hold: String,
    pub until: Time,
}

#[derive(Debug, Serialize)]
pub struct FactsAppendAnswer {
    pub orders: Vec<String>,
}

/// `carried`: false when a facts file of that name was there already, which is left as it was.
#[derive(Debug, Serialize)]
pub struct FactsCarryAnswer {
    pub carried: bool,
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
    /// Read without a cursor: how many facts files there are, so a reader starting from nothing
    /// knows how much it faces without reading it twice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
}

/// A stored row. `fields` are the queryable string fields, at most four.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Row {
    pub key: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    /// The value as JSON text, as it is stored.
    pub value: String,
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

/// The library's root declaration as stored, and its token; both `None` when there is none.
#[derive(Debug, Serialize)]
pub struct DeclarationAnswer {
    pub declaration: Option<Map<String, Value>>,
    pub token: Option<Token>,
}

#[derive(Debug, Serialize)]
pub struct DeclarationWritten {
    pub token: Token,
}

#[derive(Debug, Serialize)]
pub struct InitAnswer {
    pub created: bool,
}

/// What an implementation says about itself (`describe`); the dispatch adds the contract version
/// and the operations.
#[derive(Debug, Serialize)]
pub struct StorageInfo {
    pub name: &'static str,
    pub version: &'static str,
    /// The kinds of library address it answers.
    pub addresses: Vec<&'static str>,
    /// Whether `changed` can give a reliable cursor here.
    pub cursor: bool,
    pub facets: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct NoiseAnswer {
    pub names: Vec<String>,
    pub paths: Vec<String>,
    pub declared: bool,
}
