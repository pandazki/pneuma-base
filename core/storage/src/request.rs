//! Requests as the operations take them, parsed once from the wire's JSON objects.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::{Failure, Place, PlaceArg, RecordPlace, Row, Token};

pub const OVERVIEW_LIMIT: (u64, u64, u64) = (200, 1, 1_000);
pub const PROBE_BUDGET: (u64, u64, u64) = (500, 1, 100_000);
pub const SINCE_LIMIT: (u64, u64, u64) = (1_000, 0, 10_000);
pub const ROWS_LIMIT: (u64, u64, u64) = (100, 1, 10_000);
pub const CHANGED_LIMIT: (u64, u64, u64) = (1_000, 1, 10_000);
/// The most files a directory's content may have before `content` or `write` answers `too_many`.
pub const FILES_LIMIT: (u64, u64, u64) = (5_000, 1, 10_000_000);
/// The most bytes one `read` answer carries in `data`; `to` has no such bound.
pub const READ_DATA_MAX: u64 = 16 << 20;
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
    pub place: Place,
    pub limit: usize,
    pub after: Option<String>,
    pub facets: Vec<String>,
}

pub struct GlanceRequest {
    pub places: Vec<PlaceArg>,
    pub facets: Vec<String>,
}

pub struct ChangedRequest {
    pub cursor: Option<String>,
    pub limit: usize,
}

pub struct ContentRequest {
    pub place: Place,
    pub rule: ContentRule,
    pub limit: u64,
    pub fetch: bool,
}

pub struct ReadRequest {
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
}

pub struct WriteRequest {
    pub place: Place,
    pub from: Source,
    pub expect: Expect,
    pub rule: ContentRule,
    pub limit: u64,
    pub hold: Option<String>,
}

pub struct MoveRequest {
    pub from: Place,
    pub to: Place,
    pub expect_from: Token,
    pub expect_to: Expect,
    pub hold: Option<String>,
}

pub struct RemoveRequest {
    pub place: Place,
    pub expect: Token,
    pub hold: Option<String>,
}

pub struct HoldRequest {
    pub place: Place,
    pub ttl_ms: u64,
}

pub struct ProbeRequest {
    pub place: Place,
    pub budget: u64,
}

pub struct LookItem {
    pub place: PlaceArg,
    pub token: Token,
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

    fn raw(&self, key: &str) -> Option<&'a Value> {
        self.0.get(key)
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
    })
}

pub fn content(req: &Req) -> Parsed<ContentRequest> {
    Ok(ContentRequest {
        place: req.place()?,
        rule: req.rule()?,
        limit: req.count("limit", FILES_LIMIT)?,
        fetch: req.flag("fetch")?,
    })
}

pub fn read(req: &Req) -> Parsed<ReadRequest> {
    let length = match req.get("length") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or_else(Failure::bad_request)?),
    };
    Ok(ReadRequest {
        place: req.place()?,
        offset: req.count("offset", (0, 0, u64::MAX))?,
        length,
        fetch: req.flag("fetch")?,
        to: req.absolute_path("to")?,
    })
}

pub fn write(req: &Req) -> Parsed<WriteRequest> {
    let from = match req.string("from")?.as_str() {
        "-" => Source::Stdin,
        _ => Source::Path(
            req.absolute_path("from")?
                .ok_or_else(Failure::bad_request)?,
        ),
    };
    Ok(WriteRequest {
        place: req.place()?,
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
        from: req.place_at("from")?,
        to: req.place_at("to")?,
        expect_from: expect.token("from")?,
        expect_to: expect.expect("to")?,
        hold: req.hold()?,
    })
}

pub fn remove(req: &Req) -> Parsed<RemoveRequest> {
    Ok(RemoveRequest {
        place: req.place()?,
        expect: req.token("expect")?,
        hold: req.hold()?,
    })
}

pub fn hold(req: &Req) -> Parsed<HoldRequest> {
    Ok(HoldRequest {
        place: req.place()?,
        ttl_ms: req.count("ttl", HOLD_TTL_MS)?,
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

pub fn look(req: &Req) -> Parsed<Vec<LookItem>> {
    req.array("places")?
        .iter()
        .map(|item| {
            let place = item.get("place").and_then(Value::as_str);
            let token = item.get("token").and_then(Value::as_str);
            match (place, token) {
                (Some(place), Some(token)) => Ok(LookItem {
                    place: PlaceArg::parse(place),
                    token: Token::new(token.to_owned()),
                }),
                _ => Err(Failure::bad_request()),
            }
        })
        .collect()
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

fn row_change(value: &Value) -> Parsed<RowChange> {
    let object = value.as_object().ok_or_else(Failure::bad_request)?;
    let key = object
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(Failure::bad_request)?
        .to_owned();
    let Some(row_value) = object.get("value") else {
        return Err(Failure::bad_request());
    };
    if row_value.is_null() {
        return Ok(RowChange::Delete(key));
    }
    let fields = match object.get("fields") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(fields)) => fields
            .iter()
            .map(|(name, v)| Some((name.clone(), v.as_str()?.to_owned())))
            .collect::<Option<BTreeMap<_, _>>>()
            .ok_or_else(Failure::bad_request)?,
        Some(_) => return Err(Failure::bad_request()),
    };
    if fields.len() > MAX_FIELDS || fields.keys().any(String::is_empty) {
        return Err(Failure::bad_request());
    }
    Ok(RowChange::Put(Row {
        key,
        fields,
        value: row_value.clone(),
    }))
}

fn row_changes(values: &[Value]) -> Parsed<Vec<RowChange>> {
    values.iter().map(row_change).collect()
}

pub fn rows_put(req: &Req) -> Parsed<RowsPutRequest> {
    let mut tables = Vec::new();
    match (req.opt_string("table")?, req.get("rows")) {
        (Some(table), Some(Value::Array(rows))) => {
            tables.push((non_empty(table)?, row_changes(rows)?))
        }
        (None, None) => {}
        _ => return Err(Failure::bad_request()),
    }
    match req.get("tables") {
        None => {}
        Some(Value::Object(map)) => {
            for (table, rows) in map {
                let rows = rows.as_array().ok_or_else(Failure::bad_request)?;
                tables.push((non_empty(table.clone())?, row_changes(rows)?));
            }
        }
        Some(_) => return Err(Failure::bad_request()),
    }
    let expect = match req.raw("expect") {
        None => CursorExpect::Unchecked,
        Some(Value::Null) => CursorExpect::Cursor(None),
        Some(Value::String(cursor)) => CursorExpect::Cursor(Some(cursor.clone())),
        Some(_) => return Err(Failure::bad_request()),
    };
    Ok(RowsPutRequest {
        place: req.record_place()?,
        tables,
        cursor: req.opt_string("cursor")?,
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
