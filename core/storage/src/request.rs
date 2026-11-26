//! Requests as the operations take them, parsed once from the wire's JSON objects.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::{Failure, Place, PlaceArg, RecordPlace, Row, Token};

pub const OVERVIEW_LIMIT: (u64, u64, u64) = (200, 1, 1_000);
pub const PROBE_BUDGET: (u64, u64, u64) = (500, 1, 100_000);
pub const SINCE_LIMIT: (u64, u64, u64) = (1_000, 0, 10_000);
pub const ROWS_LIMIT: (u64, u64, u64) = (100, 1, 10_000);
/// The most a `rows.where` count goes to when the request gives no `limit`.
pub const COUNT_CAP: u64 = 10_000;
pub const MAX_FIELDS: usize = 4;

pub struct OverviewRequest {
    pub place: Place,
    pub limit: usize,
    pub after: Option<String>,
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
pub enum Expect {
    Unchecked,
    Cursor(Option<String>),
}

pub struct RowsPutRequest {
    pub place: RecordPlace,
    pub tables: Vec<(String, Vec<RowChange>)>,
    pub cursor: Option<String>,
    pub expect: Expect,
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
        Place::parse(&self.string("place")?).ok_or_else(Failure::bad_request)
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

pub fn glance(req: &Req) -> Parsed<Vec<PlaceArg>> {
    Ok(req
        .strings("places")?
        .iter()
        .map(|text| PlaceArg::parse(text))
        .collect())
}

pub fn overview(req: &Req) -> Parsed<OverviewRequest> {
    Ok(OverviewRequest {
        place: req.place()?,
        limit: usize_of(req.count("limit", OVERVIEW_LIMIT)?),
        after: req.opt_string("after")?,
    })
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
        None => Expect::Unchecked,
        Some(Value::Null) => Expect::Cursor(None),
        Some(Value::String(cursor)) => Expect::Cursor(Some(cursor.clone())),
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
    let valid_name = |name: &String| {
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
    };
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
