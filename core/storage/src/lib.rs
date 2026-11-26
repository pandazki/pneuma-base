//! The storage abstraction of Pneuma Base (contract `STORAGE.md`, version 1): the questions the
//! domain asks of wherever a library lives. It knows no file system.

mod answer;
mod place;
pub mod request;
mod time;
mod token;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{Map, Value, json};

pub use answer::*;
pub use place::{Place, PlaceArg, RecordPlace};
use request::Req;
pub use request::{
    Expect, FactsAppendRequest, FactsSinceRequest, LookItem, NoiseEdit, OverviewRequest,
    ProbeRequest, RowChange, RowsGetRequest, RowsPutRequest, RowsUnderRequest, RowsWhereRequest,
};
pub use time::Time;
pub use token::Token;

pub const CONTRACT_VERSION: u32 = 1;

/// A flag a running operation polls at its safe points; set by `serve`'s `cancel`.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), Failure> {
        if self.is_cancelled() {
            Err(Failure::new(Reason::Cancelled))
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseChange {
    Add,
    Remove,
}

/// One implementation of the contract. Every method answers data; a failure is a `Failure`
/// with a fixed reason.
pub trait Storage: Sync {
    fn glance(&self, places: &[PlaceArg], cancel: &Cancel) -> Result<GlanceAnswer, Failure>;
    fn overview(&self, req: &OverviewRequest, cancel: &Cancel) -> Result<OverviewAnswer, Failure>;
    fn probe(&self, req: &ProbeRequest, cancel: &Cancel) -> Result<ProbeAnswer, Failure>;
    fn look(&self, places: &[LookItem], cancel: &Cancel) -> Result<LookAnswer, Failure>;

    fn facts_append(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure>;
    fn facts_since(
        &self,
        req: &FactsSinceRequest,
        cancel: &Cancel,
    ) -> Result<FactsSinceAnswer, Failure>;
    fn rows_put(&self, req: &RowsPutRequest) -> Result<(), Failure>;
    fn rows_get(&self, req: &RowsGetRequest) -> Result<RowsGetAnswer, Failure>;
    fn rows_under(&self, req: &RowsUnderRequest) -> Result<RowsPage, Failure>;
    fn rows_where(&self, req: &RowsWhereRequest) -> Result<RowsWhereAnswer, Failure>;
    fn rows_reset(&self, place: &RecordPlace) -> Result<(), Failure>;

    fn init(&self) -> Result<InitAnswer, Failure>;
    fn info(&self) -> StorageInfo;
    fn noise_list(&self) -> Result<NoiseAnswer, Failure>;
    fn noise_edit(&self, edit: &NoiseEdit, change: NoiseChange) -> Result<NoiseAnswer, Failure>;
}

/// The operations a request can name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Glance,
    Overview,
    Probe,
    Look,
    FactsAppend,
    FactsSince,
    RowsPut,
    RowsGet,
    RowsUnder,
    RowsWhere,
    RowsReset,
    Init,
    Describe,
    NoiseList,
    NoiseAdd,
    NoiseRemove,
}

impl Op {
    pub const ALL: [Op; 16] = [
        Op::Glance,
        Op::Overview,
        Op::Probe,
        Op::Look,
        Op::FactsAppend,
        Op::FactsSince,
        Op::RowsPut,
        Op::RowsGet,
        Op::RowsUnder,
        Op::RowsWhere,
        Op::RowsReset,
        Op::Init,
        Op::Describe,
        Op::NoiseList,
        Op::NoiseAdd,
        Op::NoiseRemove,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Op::Glance => "glance",
            Op::Overview => "overview",
            Op::Probe => "probe",
            Op::Look => "look",
            Op::FactsAppend => "facts.append",
            Op::FactsSince => "facts.since",
            Op::RowsPut => "rows.put",
            Op::RowsGet => "rows.get",
            Op::RowsUnder => "rows.under",
            Op::RowsWhere => "rows.where",
            Op::RowsReset => "rows.reset",
            Op::Init => "init",
            Op::Describe => "describe",
            Op::NoiseList => "noise.list",
            Op::NoiseAdd => "noise.add",
            Op::NoiseRemove => "noise.remove",
        }
    }

    pub fn parse(name: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.name() == name)
    }

    /// Whether the operation changes what the storage holds. A write is cancellable only before
    /// it starts; a read's answer can be dropped at any time.
    pub fn writes(self) -> bool {
        matches!(
            self,
            Op::FactsAppend
                | Op::RowsPut
                | Op::RowsReset
                | Op::Init
                | Op::NoiseAdd
                | Op::NoiseRemove
        )
    }
}

/// Runs one request against a storage and gives the whole answer object as JSON text, `outcome`
/// first. The answer is written straight to text, so rows' stored values pass through unparsed.
pub fn handle(
    storage: &dyn Storage,
    op: Op,
    request: &Map<String, Value>,
    cancel: &Cancel,
) -> String {
    match run(storage, op, &Req(request), cancel) {
        Ok(answer) => answer,
        Err(failure) => failure_text(&failure),
    }
}

/// A failure's answer object as JSON text.
pub fn failure_text(failure: &Failure) -> String {
    serde_json::to_string(failure).unwrap_or_else(|_| "{}".to_owned())
}

/// The JSON object `object` with the member `member` (`"name":value`) put first.
pub fn with_first(member: &str, object: &str) -> String {
    match object.strip_prefix('{').map(str::trim_start) {
        Some(rest) if rest.starts_with('}') => format!("{{{member}}}"),
        Some(rest) => format!("{{{member},{rest}"),
        None => format!("{{{member}}}"),
    }
}

fn done<T: Serialize>(answer: T) -> Result<String, Failure> {
    let body = serde_json::to_string(&answer).map_err(|_| Failure::bad_request())?;
    Ok(with_first("\"outcome\":\"done\"", &body))
}

fn run(storage: &dyn Storage, op: Op, req: &Req, cancel: &Cancel) -> Result<String, Failure> {
    cancel.check()?;
    match op {
        Op::Glance => done(storage.glance(&request::glance(req)?, cancel)?),
        Op::Overview => done(storage.overview(&request::overview(req)?, cancel)?),
        Op::Probe => done(storage.probe(&request::probe(req)?, cancel)?),
        Op::Look => done(storage.look(&request::look(req)?, cancel)?),
        Op::FactsAppend => done(storage.facts_append(&request::facts_append(req)?)?),
        Op::FactsSince => done(storage.facts_since(&request::facts_since(req)?, cancel)?),
        Op::RowsPut => done(
            storage
                .rows_put(&request::rows_put(req)?)
                .map(|()| json!({}))?,
        ),
        Op::RowsGet => done(storage.rows_get(&request::rows_get(req)?)?),
        Op::RowsUnder => done(storage.rows_under(&request::rows_under(req)?)?),
        Op::RowsWhere => done(storage.rows_where(&request::rows_where(req)?)?),
        Op::RowsReset => done(
            storage
                .rows_reset(&request::rows_reset(req)?)
                .map(|()| json!({}))?,
        ),
        Op::Init => done(storage.init()?),
        Op::Describe => {
            let info = storage.info();
            let ops: Vec<&str> = Op::ALL.iter().map(|op| op.name()).collect();
            done(json!({
                "implementation": info.implementation,
                "contract": CONTRACT_VERSION,
                "version": info.version,
                "cursor": info.cursor,
                "facets": info.facets,
                "ops": ops,
            }))
        }
        Op::NoiseList => done(storage.noise_list()?),
        Op::NoiseAdd => done(storage.noise_edit(&request::noise_edit(req)?, NoiseChange::Add)?),
        Op::NoiseRemove => {
            done(storage.noise_edit(&request::noise_edit(req)?, NoiseChange::Remove)?)
        }
    }
}
