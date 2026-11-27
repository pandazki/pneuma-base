//! Requests as the operations take them, parsed once from the wire's JSON objects.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::{Area, Failure, Place, PlaceArg, RecordPlace, Row, Token, base64};

pub const OVERVIEW_LIMIT: (u64, u64, u64) = (200, 1, 1_000);
pub const PROBE_BUDGET: (u64, u64, u64) = (500, 1, 100_000);
pub const SINCE_LIMIT: (u64, u64, u64) = (1_000, 0, 10_000);
pub const ROWS_LIMIT: (u64, u64, u64) = (100, 1, 10_000);
/// How many rows of a table one `look` compares, when the table holds what it expects.
pub const LOOK_LIMIT: (u64, u64, u64) = (10_000, 1, 100_000);
/// How many files of a directory's manifest one `content` answer lists.
pub const MANIFEST_LIMIT: (u64, u64, u64) = (1_000, 1, 10_000);
pub const CHANGED_LIMIT: (u64, u64, u64) = (1_000, 1, 10_000);
/// How long, in milliseconds, a `changed` caller waits for an answer before `cannot_say`.
pub const CHANGED_BUDGET_MS: (u64, u64, u64) = (5_000, 0, 600_000);
/// The most files a directory's content may have before `content` or `write` answers `too_many`.
pub const FILES_LIMIT: (u64, u64, u64) = (5_000, 1, 10_000_000);
/// The most bytes one `read` answer or `write` request carries in `data`; `read`'s `to` has no
/// such bound.
pub const DATA_MAX: u64 = 16 << 20;
/// A hold's life in milliseconds.
pub const HOLD_TTL_MS: (u64, u64, u64) = (30_000, 1, 600_000);
/// The most a `rows.where` count goes to when the request gives no `limit`.
pub const COUNT_CAP: u64 = 10_000;
pub const MAX_FIELDS: usize = 4;

/// Which of a directory's files are its content: never the library's noise, and also not the
/// names given here nor what the named ignore file (`.gitignore`) of each directory excludes.
#[derive(Clone, Debug, Default)]
pub struct ContentRule {
    pub noise: Vec<String>,
    pub ignore_file: Option<String>,
}

pub struct OverviewRequest {
    pub area: Area,
    pub place: Place,
    pub limit: usize,
    pub after: Option<String>,
    pub facets: Vec<String>,
}

pub struct GlanceRequest {
    pub area: Area,
    pub places: Vec<PlaceArg>,
    pub facets: Vec<String>,
}

pub struct ChangedRequest {
    pub cursor: Option<String>,
    pub limit: usize,
    pub budget_ms: u64,
}

pub struct SubscribeRequest {
    pub cursor: Option<String>,
}

pub struct ContentRequest {
    pub area: Area,
    pub place: Place,
    pub rule: ContentRule,
    pub limit: u64,
    pub fetch: bool,
    /// A directory's answer also lists this page of the manifest it computed.
    pub manifest: Option<ManifestPage>,
}

/// One page of a directory's manifest: the files after `after` in the byte order of their paths.
pub struct ManifestPage {
    pub limit: usize,
    pub after: Option<String>,
}

pub struct ReadRequest {
    pub area: Area,
    pub place: Place,
    pub offset: u64,
    pub length: Option<u64>,
    pub fetch: bool,
    /// Write the bytes to this path outside the library instead of answering them.
    pub to: Option<PathBuf>,
}

/// What a write expects to find where it writes.
#[derive(Clone, Debug)]
pub enum Expect {
    Empty,
    Token(Token),
}

pub enum Source {
    Path(PathBuf),
    Stdin,
    /// Bytes carried in the request, at most `DATA_MAX`.
    Data(Vec<u8>),
    /// A place in the store: the write is a copy. Never overlapping the target in one area.
    Place(Area, Place),
}

pub struct WriteRequest {
    pub area: Area,
    pub place: Place,
    pub from: Source,
    pub expect: Expect,
    pub rule: ContentRule,
    pub limit: u64,
    pub hold: Option<String>,
}

/// A move within one area.
pub struct MoveRequest {
    pub area: Area,
    pub from: Place,
    pub to: Place,
    pub expect_from: Token,
    pub expect_to: Expect,
    pub hold: Option<String>,
}

pub struct RemoveRequest {
    pub area: Area,
    pub place: Place,
    pub expect: Token,
    pub hold: Option<String>,
}

/// One hold over one or more places.
pub struct HoldRequest {
    pub places: Vec<Place>,
    pub ttl_ms: u64,
}

pub struct ProbeRequest {
    pub place: Place,
    pub budget: u64,
}

pub struct LookItem {
    pub place: PlaceArg,
    /// What the caller remembers there: a state, or nothing (`empty`). `None` when it has no
    /// expectation, and whatever is there differs.
    pub expect: Option<Expect>,
}

/// Where a look's expectations come from.
pub enum LookFrom {
    Places(Vec<LookItem>),
    /// A record place's table: each row's key is a place, its field `field` what is expected there.
    Rows(LookRows),
}

pub struct LookRows {
    pub place: RecordPlace,
    pub table: String,
    pub field: String,
    pub limit: usize,
    pub after: Option<String>,
}

pub struct LookRequest {
    pub area: Area,
    pub from: LookFrom,
    /// Each place that is a directory is compared by its deep token.
    pub deep: Option<DeepLook>,
}

/// How a deep look counts a directory's files: as `content` does, by `rule`, at most `limit`.
pub struct DeepLook {
    pub rule: ContentRule,
    pub limit: u64,
}

impl LookItem {
    /// An expectation as a request or a row writes it: `empty`, or a token.
    pub fn new(place: &str, expect: Option<&str>) -> LookItem {
        LookItem {
            place: PlaceArg::parse(place),
            expect: expect.map(|text| match text {
                "empty" => Expect::Empty,
                token => Expect::Token(Token::new(token.to_owned())),
            }),
        }
    }
}

/// The library's root declaration, written whole when `expect` holds.
pub struct DeclarationWriteRequest {
    pub declaration: Map<String, Value>,
    pub expect: Expect,
}

pub struct FactsAppendRequest {
    pub place: RecordPlace,
    pub facts: Vec<Map<String, Value>>,
}

pub struct FactsSinceRequest {
    pub place: RecordPlace,
    pub cursor: Option<String>,
    pub limit: usize,
}

pub enum RowChange {
    Put(Row),
    Delete(String),
}

impl RowChange {
    pub fn key(&self) -> &str {
        match self {
            RowChange::Put(row) => &row.key,
            RowChange::Delete(key) => key,
        }
    }
}

/// `rows.put`'s precondition on the saved cursor.
pub enum CursorExpect {
    Unchecked,
    Cursor(Option<String>),
}

pub struct RowsPutRequest {
    pub place: RecordPlace,
    pub tables: Vec<(String, Vec<RowChange>)>,
    pub cursor: Option<String>,
    pub expect: CursorExpect,
}

pub struct RowsGetRequest {
    pub place: RecordPlace,
    pub table: String,
    pub keys: Vec<String>,
}

pub struct RowsUnderRequest {
    pub place: RecordPlace,
    pub table: String,
    pub prefix: String,
    pub limit: usize,
    pub after: Option<String>,
}

pub struct RowsWhereRequest {
    pub place: RecordPlace,
    pub table: String,
    pub field: String,
    pub value: String,
    pub limit: usize,
    pub after: Option<String>,
    /// `Some(cap)` when only the count is asked for.
    pub count: Option<u64>,
}

pub struct NoiseEdit {
    pub names: Vec<String>,
    pub paths: Vec<Place>,
}

/// A request object with typed, failing accessors. Every failure is `bad_request`.
pub struct Req<'a>(pub &'a Map<String, Value>);

type Parsed<T> = Result<T, Failure>;

impl<'a> Req<'a> {
    /// Absent and `null` read the same, except where the caller asks with `raw`.
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.get(key).filter(|value| !value.is_null())
    }

    fn string(&self, key: &str) -> Parsed<String> {
        self.opt_string(key)?.ok_or_else(Failure::bad_request)
    }

    fn opt_string(&self, key: &str) -> Parsed<Option<String>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(Failure::bad_request()),
        }
    }

    fn count(&self, key: &str, (default, min, max): (u64, u64, u64)) -> Parsed<u64> {
        match self.get(key) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .filter(|n| (min..=max).contains(n))
                .ok_or_else(Failure::bad_request),
        }
    }

    fn flag(&self, key: &str) -> Parsed<bool> {
        match self.get(key) {
            None => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(Failure::bad_request()),
        }
    }

    fn strings(&self, key: &str) -> Parsed<Vec<String>> {
        match self.get(key) {
            None => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<_>>()
                .ok_or_else(Failure::bad_request),
            Some(_) => Err(Failure::bad_request()),
        }
    }

    fn array(&self, key: &str) -> Parsed<&'a Vec<Value>> {
        self.get(key)
            .and_then(Value::as_array)
            .ok_or_else(Failure::bad_request)
    }

    fn place(&self) -> Parsed<Place> {
        self.place_at("place")
    }

    fn place_at(&self, key: &str) -> Parsed<Place> {
        Place::parse(&self.string(key)?).ok_or_else(Failure::bad_request)
    }

    fn token(&self, key: &str) -> Parsed<Token> {
        let token = Token::new(self.string(key)?);
        token
            .components()
            .is_some()
            .then_some(token)
            .ok_or_else(Failure::bad_request)
    }

    /// `"empty"` or a token.
    fn expect(&self, key: &str) -> Parsed<Expect> {
        match self.string(key)?.as_str() {
            "empty" => Ok(Expect::Empty),
            _ => Ok(Expect::Token(self.token(key)?)),
        }
    }

    fn absolute_path(&self, key: &str) -> Parsed<Option<PathBuf>> {
        match self.opt_string(key)? {
            None => Ok(None),
            Some(text) if text.starts_with('/') && !text.contains('\0') => {
                Ok(Some(PathBuf::from(text)))
            }
            Some(_) => Err(Failure::bad_request()),
        }
    }

    fn rule(&self) -> Parsed<ContentRule> {
        let Some(value) = self.get("rule") else {
            return Ok(ContentRule::default());
        };
        let rule = Req(value.as_object().ok_or_else(Failure::bad_request)?);
        let noise = rule.strings("noise")?;
        if !noise.iter().all(valid_name) {
            return Err(Failure::bad_request());
        }
        let ignore_file = rule.opt_string("ignore_file")?;
        if ignore_file.as_ref().is_some_and(|name| !valid_name(name)) {
            return Err(Failure::bad_request());
        }
        Ok(ContentRule { noise, ignore_file })
    }

    fn hold(&self) -> Parsed<Option<String>> {
        self.opt_string("hold")
    }

    /// The content, or the record place named by `records`.
    fn area(&self) -> Parsed<Area> {
        match self.opt_string("records")? {
            None => Ok(Area::Content),
            Some(name) => RecordPlace::parse(&name)
                .map(Area::Records)
                .ok_or_else(Failure::bad_request),
        }
    }

    fn record_place(&self) -> Parsed<RecordPlace> {
        RecordPlace::parse(&self.string("place")?).ok_or_else(Failure::bad_request)
    }

    fn table(&self) -> Parsed<String> {
        non_empty(self.string("table")?)
    }
}

fn non_empty(text: String) -> Parsed<String> {
    if text.is_empty() {
        Err(Failure::bad_request())
    } else {
        Ok(text)
    }
}

fn usize_of(n: u64) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}

/// One segment of a path: not empty, not `.` or `..`, no `/` or NUL.
fn valid_name(name: &String) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
}

pub fn glance(req: &Req) -> Parsed<GlanceRequest> {
    Ok(GlanceRequest {
        area: req.area()?,
        places: req
            .strings("places")?
            .iter()
            .map(|text| PlaceArg::parse(text))
            .collect(),
        facets: req.strings("facets")?,
    })
}

pub fn overview(req: &Req) -> Parsed<OverviewRequest> {
    Ok(OverviewRequest {
        area: req.area()?,
        place: req.place()?,
        limit: usize_of(req.count("limit", OVERVIEW_LIMIT)?),
        after: req.opt_string("after")?,
        facets: req.strings("facets")?,
    })
}

pub fn changed(req: &Req) -> Parsed<ChangedRequest> {
    Ok(ChangedRequest {
        cursor: req.opt_string("cursor")?,
        limit: usize_of(req.count("limit", CHANGED_LIMIT)?),
        budget_ms: req.count("budget", CHANGED_BUDGET_MS)?,
    })
}

pub fn subscribe(req: &Req) -> Parsed<SubscribeRequest> {
    Ok(SubscribeRequest {
        cursor: req.opt_string("cursor")?,
    })
}

pub fn content(req: &Req) -> Parsed<ContentRequest> {
    let manifest = match req.get("manifest") {
        None | Some(Value::Bool(false)) => None,
        Some(Value::Bool(true)) => Some(ManifestPage {
            limit: usize_of(MANIFEST_LIMIT.0),
            after: None,
        }),
        Some(Value::Object(page)) => {
            let page = Req(page);
            Some(ManifestPage {
                limit: usize_of(page.count("limit", MANIFEST_LIMIT)?),
                after: page.opt_string("after")?,
            })
        }
        Some(_) => return Err(Failure::bad_request()),
    };
    Ok(ContentRequest {
        area: req.area()?,
        place: req.place()?,
        rule: req.rule()?,
        limit: req.count("limit", FILES_LIMIT)?,
        fetch: req.flag("fetch")?,
        manifest,
    })
}

pub fn read(req: &Req) -> Parsed<ReadRequest> {
    let length = match req.get("length") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or_else(Failure::bad_request)?),
    };
    Ok(ReadRequest {
        area: req.area()?,
        place: req.place()?,
        offset: req.count("offset", (0, 0, u64::MAX))?,
        length,
        fetch: req.flag("fetch")?,
        to: req.absolute_path("to")?,
    })
}

/// `{ "data": base64 }`, or `{ "place": p, "records"?: name }`.
fn source_object(from: &Req) -> Parsed<Source> {
    match (from.get("data"), from.get("place")) {
        (Some(Value::String(text)), None) if from.get("records").is_none() => {
            // Four characters carry three bytes: too long a text is too many bytes, undecoded.
            if text.len() as u64 > DATA_MAX.div_ceil(3) * 4 {
                return Err(Failure::bad_request());
            }
            let bytes = base64::decode(text).ok_or_else(Failure::bad_request)?;
            if bytes.len() as u64 > DATA_MAX {
                return Err(Failure::bad_request());
            }
            Ok(Source::Data(bytes))
        }
        (None, Some(_)) => Ok(Source::Place(from.area()?, from.place()?)),
        _ => Err(Failure::bad_request()),
    }
}

pub fn write(req: &Req) -> Parsed<WriteRequest> {
    let from = match req.get("from") {
        Some(Value::String(text)) if text == "-" => Source::Stdin,
        Some(Value::String(_)) => Source::Path(
            req.absolute_path("from")?
                .ok_or_else(Failure::bad_request)?,
        ),
        Some(Value::Object(object)) => source_object(&Req(object))?,
        _ => return Err(Failure::bad_request()),
    };
    let (area, place) = (req.area()?, req.place()?);
    if let Source::Place(from_area, from_place) = &from
        && *from_area == area
        && (from_place.is_at_or_under(&place) || place.is_at_or_under(from_place))
    {
        return Err(Failure::bad_request());
    }
    Ok(WriteRequest {
        area,
        place,
        from,
        expect: req.expect("expect")?,
        rule: req.rule()?,
        limit: req.count("limit", FILES_LIMIT)?,
        hold: req.hold()?,
    })
}

pub fn move_place(req: &Req) -> Parsed<MoveRequest> {
    let expect = Req(req
        .get("expect")
        .and_then(Value::as_object)
        .ok_or_else(Failure::bad_request)?);
    Ok(MoveRequest {
        area: req.area()?,
        from: req.place_at("from")?,
        to: req.place_at("to")?,
        expect_from: expect.token("from")?,
        expect_to: expect.expect("to")?,
        hold: req.hold()?,
    })
}

pub fn remove(req: &Req) -> Parsed<RemoveRequest> {
    Ok(RemoveRequest {
        area: req.area()?,
        place: req.place()?,
        expect: req.token("expect")?,
        hold: req.hold()?,
    })
}

/// `place`, or a non-empty list of `places`; not both.
pub fn hold(req: &Req) -> Parsed<HoldRequest> {
    let places = match (req.get("place"), req.get("places")) {
        (Some(_), None) => vec![req.place()?],
        (None, Some(Value::Array(items))) if !items.is_empty() => items
            .iter()
            .map(|item| item.as_str().and_then(Place::parse))
            .collect::<Option<_>>()
            .ok_or_else(Failure::bad_request)?,
        _ => return Err(Failure::bad_request()),
    };
    Ok(HoldRequest {
        places,
        ttl_ms: req.count("ttl", HOLD_TTL_MS)?,
    })
}

pub fn declaration_write(req: &Req) -> Parsed<DeclarationWriteRequest> {
    Ok(DeclarationWriteRequest {
        declaration: req
            .get("declaration")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(Failure::bad_request)?,
        expect: req.expect("expect")?,
    })
}

pub fn release(req: &Req) -> Parsed<String> {
    req.string("hold")
}

pub fn probe(req: &Req) -> Parsed<ProbeRequest> {
    Ok(ProbeRequest {
        place: req.place()?,
        budget: req.count("budget", PROBE_BUDGET)?,
    })
}

/// `places`, each with what is expected there; or `rows`, the table that holds the expectations.
pub fn look(req: &Req) -> Parsed<LookRequest> {
    let from = match (req.get("places"), req.get("rows")) {
        (Some(_), None) => LookFrom::Places(
            req.array("places")?
                .iter()
                .map(|item| {
                    let place = item.get("place").and_then(Value::as_str);
                    let token = item.get("token").and_then(Value::as_str);
                    match (place, token) {
                        (Some(place), Some(token)) => Ok(LookItem::new(place, Some(token))),
                        _ => Err(Failure::bad_request()),
                    }
                })
                .collect::<Parsed<_>>()?,
        ),
        (None, Some(Value::Object(rows))) => {
            let rows = Req(rows);
            LookFrom::Rows(LookRows {
                place: rows.record_place()?,
                table: rows.table()?,
                field: non_empty(rows.string("field")?)?,
                limit: usize_of(req.count("limit", LOOK_LIMIT)?),
                after: req.opt_string("after")?,
            })
        }
        _ => return Err(Failure::bad_request()),
    };
    let deep = match req.get("deep") {
        None => None,
        Some(Value::Object(deep)) => {
            let deep = Req(deep);
            Some(DeepLook {
                rule: deep.rule()?,
                limit: deep.count("limit", FILES_LIMIT)?,
            })
        }
        Some(_) => return Err(Failure::bad_request()),
    };
    Ok(LookRequest {
        area: req.area()?,
        from,
        deep,
    })
}

pub fn facts_append(req: &Req) -> Parsed<FactsAppendRequest> {
    let facts = req
        .array("facts")?
        .iter()
        .map(|fact| fact.as_object().cloned().ok_or_else(Failure::bad_request))
        .collect::<Parsed<_>>()?;
    Ok(FactsAppendRequest {
        place: req.record_place()?,
        facts,
    })
}

pub fn facts_since(req: &Req) -> Parsed<FactsSinceRequest> {
    Ok(FactsSinceRequest {
        place: req.record_place()?,
        cursor: req.opt_string("cursor")?,
        limit: usize_of(req.count("limit", SINCE_LIMIT)?),
    })
}

/// A `rows.put` as sent. A row's value stays the JSON text it came as: a large put is not built
/// into a tree and written out again.
#[derive(serde::Deserialize)]
struct SentPut {
    place: Option<String>,
    table: Option<String>,
    rows: Option<Vec<SentRow>>,
    tables: Option<BTreeMap<String, Vec<SentRow>>>,
    cursor: Option<String>,
    #[serde(default, deserialize_with = "present")]
    expect: Option<Option<String>>,
}

#[derive(serde::Deserialize)]
struct SentRow {
    key: String,
    fields: Option<BTreeMap<String, String>>,
    value: Box<serde_json::value::RawValue>,
}

/// A member that is there, `null` or not: told apart from one that is missing.
fn present<'de, D: serde::Deserializer<'de>, T: serde::Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn sent_rows(rows: Vec<SentRow>) -> Parsed<Vec<RowChange>> {
    rows.into_iter()
        .map(|row| {
            if row.value.get() == "null" {
                return Ok(RowChange::Delete(row.key));
            }
            let fields = row.fields.unwrap_or_default();
            if fields.len() > MAX_FIELDS || fields.keys().any(String::is_empty) {
                return Err(Failure::bad_request());
            }
            Ok(RowChange::Put(Row {
                key: row.key,
                fields,
                value: row.value.get().to_owned(),
            }))
        })
        .collect()
}

/// `rows.put` from the request's JSON text.
pub fn rows_put(text: &str) -> Parsed<RowsPutRequest> {
    let put: SentPut = serde_json::from_str(text).map_err(|_| Failure::bad_request())?;
    let mut tables = Vec::new();
    match (put.table, put.rows) {
        (Some(table), Some(rows)) => tables.push((non_empty(table)?, sent_rows(rows)?)),
        (None, None) => {}
        _ => return Err(Failure::bad_request()),
    }
    for (table, rows) in put.tables.unwrap_or_default() {
        tables.push((non_empty(table)?, sent_rows(rows)?));
    }
    let expect = match put.expect {
        None => CursorExpect::Unchecked,
        Some(cursor) => CursorExpect::Cursor(cursor),
    };
    let place = put.place.ok_or_else(Failure::bad_request)?;
    Ok(RowsPutRequest {
        place: RecordPlace::parse(&place).ok_or_else(Failure::bad_request)?,
        tables,
        cursor: put.cursor,
        expect,
    })
}

pub fn rows_get(req: &Req) -> Parsed<RowsGetRequest> {
    Ok(RowsGetRequest {
        place: req.record_place()?,
        table: req.table()?,
        keys: req.strings("keys")?,
    })
}

pub fn rows_under(req: &Req) -> Parsed<RowsUnderRequest> {
    Ok(RowsUnderRequest {
        place: req.record_place()?,
        table: req.table()?,
        prefix: req.opt_string("prefix")?.unwrap_or_default(),
        limit: usize_of(req.count("limit", ROWS_LIMIT)?),
        after: req.opt_string("after")?,
    })
}

pub fn rows_where(req: &Req) -> Parsed<RowsWhereRequest> {
    let limit = req.count("limit", ROWS_LIMIT)?;
    let count = if req.flag("count")? {
        Some(if req.get("limit").is_some() {
            limit
        } else {
            COUNT_CAP
        })
    } else {
        None
    };
    Ok(RowsWhereRequest {
        place: req.record_place()?,
        table: req.table()?,
        field: non_empty(req.string("field")?)?,
        value: req.string("value")?,
        limit: usize_of(limit),
        after: req.opt_string("after")?,
        count,
    })
}

pub fn rows_reset(req: &Req) -> Parsed<RecordPlace> {
    req.record_place()
}

pub fn noise_edit(req: &Req) -> Parsed<NoiseEdit> {
    let names = req.strings("names")?;
    if !names.iter().all(valid_name) {
        return Err(Failure::bad_request());
    }
    let paths = req
        .strings("paths")?
        .iter()
        .map(|text| Place::parse(text).filter(|place| !place.is_root()))
        .collect::<Option<_>>()
        .ok_or_else(Failure::bad_request)?;
    Ok(NoiseEdit { names, paths })
}
