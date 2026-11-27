//! The storage abstraction of Pneuma Base (contract `STORAGE.md`, version 1): the questions the
//! domain asks of wherever a library lives. It knows no file system.

mod answer;
pub mod base64;
mod place;
pub mod request;
mod time;
mod token;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{Map, Value, json};

pub use answer::*;
pub use place::{Area, Place, PlaceArg, RecordPlace, STORAGE_NAMES};
use request::Req;
pub use request::{
    ChangedRequest, ContentRequest, ContentRule, CursorExpect, DeclarationWriteRequest, DeepLook,
    Expect, FactsAppendRequest, FactsSinceRequest, GlanceRequest, HoldRequest, LookFrom, LookItem,
    LookRequest, LookRows, ManifestPage, MoveRequest, NoiseEdit, OverviewRequest, ProbeRequest,
    ReadRequest, RemoveRequest, RowChange, RowsGetRequest, RowsPutRequest, RowsUnderRequest,
    RowsWhereRequest, Source, SubscribeRequest, WriteRequest,
};
pub use time::Time;
pub use token::{DeepToken, Token, Trust};

pub const CONTRACT_VERSION: u32 = 1;

type ProgressSink = Arc<dyn Fn(&Value) + Send + Sync>;

/// What a running operation can reach besides its request: the flag `serve`'s `cancel` sets,
/// which it polls at its safe points, and where its progress goes.
#[derive(Clone, Default)]
pub struct Ctx {
    cancelled: Arc<AtomicBool>,
    progress: Option<ProgressSink>,
    /// Whether standard input is free to carry a write's bytes (one request per process).
    pub stdin_free: bool,
}

impl Ctx {
    pub fn with_progress(sink: impl Fn(&Value) + Send + Sync + 'static) -> Ctx {
        Ctx {
            progress: Some(Arc::new(sink)),
            ..Ctx::default()
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), Failure> {
        if self.is_cancelled() {
            Err(Failure::new(Reason::Cancelled))
        } else {
            Ok(())
        }
    }

    pub fn progress(&self, value: Value) {
        if let Some(sink) = &self.progress {
            sink(&value);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseChange {
    Add,
    Remove,
}

/// One implementation of the contract. Every method answers data; a failure is a `Failure`
/// with a fixed reason. The content operations act where their request's `area` says: the
/// content, or a record place's own area.
pub trait Storage: Sync {
    fn glance(&self, req: &GlanceRequest, ctx: &Ctx) -> Result<GlanceAnswer, Failure>;
    fn overview(&self, req: &OverviewRequest, ctx: &Ctx) -> Result<OverviewAnswer, Failure>;
    fn probe(&self, req: &ProbeRequest, ctx: &Ctx) -> Result<ProbeAnswer, Failure>;
    fn look(&self, req: &LookRequest, ctx: &Ctx) -> Result<LookAnswer, Failure>;
    fn changed(&self, req: &ChangedRequest, ctx: &Ctx) -> Result<ChangedAnswer, Failure>;
    /// Listens to the library's changes until cancelled, sending what it hears as progress.
    /// Only in `serve`; it never answers `done`.
    fn subscribe(&self, req: &SubscribeRequest, ctx: &Ctx) -> Result<(), Failure>;
    fn content(&self, req: &ContentRequest, ctx: &Ctx) -> Result<ContentAnswer, Failure>;
    fn read(&self, req: &ReadRequest, ctx: &Ctx) -> Result<ReadAnswer, Failure>;
    fn write(&self, req: &WriteRequest, ctx: &Ctx) -> Result<WriteAnswer, Failure>;
    fn move_place(&self, req: &MoveRequest, ctx: &Ctx) -> Result<MoveAnswer, Failure>;
    fn remove(&self, req: &RemoveRequest, ctx: &Ctx) -> Result<RemoveAnswer, Failure>;

    fn facts_append(&self, req: &FactsAppendRequest) -> Result<FactsAppendAnswer, Failure>;
    fn facts_since(&self, req: &FactsSinceRequest, ctx: &Ctx) -> Result<FactsSinceAnswer, Failure>;
    fn rows_put(&self, req: &RowsPutRequest) -> Result<(), Failure>;
    fn rows_get(&self, req: &RowsGetRequest) -> Result<RowsGetAnswer, Failure>;
    fn rows_under(&self, req: &RowsUnderRequest) -> Result<RowsPage, Failure>;
    fn rows_where(&self, req: &RowsWhereRequest) -> Result<RowsWhereAnswer, Failure>;
    fn rows_reset(&self, place: &RecordPlace) -> Result<(), Failure>;

    fn init(&self) -> Result<InitAnswer, Failure>;
    fn info(&self) -> StorageInfo;
    fn declaration_read(&self) -> Result<DeclarationAnswer, Failure>;
    fn declaration_write(
        &self,
        req: &DeclarationWriteRequest,
    ) -> Result<DeclarationWritten, Failure>;
    fn noise_list(&self) -> Result<NoiseAnswer, Failure>;
    fn noise_edit(&self, edit: &NoiseEdit, change: NoiseChange) -> Result<NoiseAnswer, Failure>;
    fn hold(&self, req: &HoldRequest) -> Result<HoldAnswer, Failure>;
    fn release(&self, hold: &str) -> Result<(), Failure>;
}

/// The operations a request can name, in the order `describe` lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Glance,
    Overview,
    Probe,
    Look,
    Changed,
    Content,
    Read,
    Write,
    Move,
    Remove,
    FactsAppend,
    FactsSince,
    RowsPut,
    RowsGet,
    RowsUnder,
    RowsWhere,
    RowsReset,
    Init,
    Describe,
    DeclarationRead,
    DeclarationWrite,
    NoiseList,
    NoiseAdd,
    NoiseRemove,
    Hold,
    Release,
    Subscribe,
}

impl Op {
    pub const ALL: [Op; 27] = [
        Op::Glance,
        Op::Overview,
        Op::Probe,
        Op::Look,
        Op::Changed,
        Op::Content,
        Op::Read,
        Op::Write,
        Op::Move,
        Op::Remove,
        Op::FactsAppend,
        Op::FactsSince,
        Op::RowsPut,
        Op::RowsGet,
        Op::RowsUnder,
        Op::RowsWhere,
        Op::RowsReset,
        Op::Init,
        Op::Describe,
        Op::DeclarationRead,
        Op::DeclarationWrite,
        Op::NoiseList,
        Op::NoiseAdd,
        Op::NoiseRemove,
        Op::Hold,
        Op::Release,
        Op::Subscribe,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Op::Glance => "glance",
            Op::Overview => "overview",
            Op::Probe => "probe",
            Op::Look => "look",
            Op::Changed => "changed",
            Op::Content => "content",
            Op::Read => "read",
            Op::Write => "write",
            Op::Move => "move",
            Op::Remove => "remove",
            Op::FactsAppend => "facts.append",
            Op::FactsSince => "facts.since",
            Op::RowsPut => "rows.put",
            Op::RowsGet => "rows.get",
            Op::RowsUnder => "rows.under",
            Op::RowsWhere => "rows.where",
            Op::RowsReset => "rows.reset",
            Op::Init => "init",
            Op::Describe => "describe",
            Op::DeclarationRead => "declaration.read",
            Op::DeclarationWrite => "declaration.write",
            Op::NoiseList => "noise.list",
            Op::NoiseAdd => "noise.add",
            Op::NoiseRemove => "noise.remove",
            Op::Hold => "hold",
            Op::Release => "release",
            Op::Subscribe => "subscribe",
        }
    }

    pub fn parse(name: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.name() == name)
    }

    /// Whether the operation changes what the storage holds. A write that is cancelled before it
    /// takes effect answers `cancelled`; once it has taken effect it answers what happened. A
    /// read's answer can be dropped at any time.
    pub fn writes(self) -> bool {
        matches!(
            self,
            Op::Write
                | Op::Move
                | Op::Remove
                | Op::FactsAppend
                | Op::RowsPut
                | Op::RowsReset
                | Op::Init
                | Op::DeclarationWrite
                | Op::NoiseAdd
                | Op::NoiseRemove
                | Op::Hold
                | Op::Release
        )
    }
}

/// Runs one request, given as JSON text, against a storage and gives the whole answer object as
/// JSON text, `outcome` first. The answer is written straight to text, so rows' stored values pass
/// through unparsed; a put keeps the values as sent.
pub fn handle(storage: &dyn Storage, op: Op, request: &str, ctx: &Ctx) -> String {
    match run(storage, op, request, ctx) {
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

fn run(storage: &dyn Storage, op: Op, text: &str, ctx: &Ctx) -> Result<String, Failure> {
    ctx.check()?;
    // A put is read from the text itself, its rows' values kept as sent.
    let object = match op {
        Op::RowsPut => Map::new(),
        _ => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(object)) => object,
            _ => return Err(Failure::bad_request()),
        },
    };
    let req = &Req(&object);
    let empty = |()| json!({});
    match op {
        Op::Glance => done(storage.glance(&request::glance(req)?, ctx)?),
        Op::Overview => done(storage.overview(&request::overview(req)?, ctx)?),
        Op::Probe => done(storage.probe(&request::probe(req)?, ctx)?),
        Op::Look => done(storage.look(&request::look(req)?, ctx)?),
        Op::Changed => done(storage.changed(&request::changed(req)?, ctx)?),
        Op::Content => done(storage.content(&request::content(req)?, ctx)?),
        Op::Read => done(storage.read(&request::read(req)?, ctx)?),
        Op::Write => {
            let write = request::write(req)?;
            if matches!(write.from, Source::Stdin) && !ctx.stdin_free {
                return Err(Failure::bad_request());
            }
            done(storage.write(&write, ctx)?)
        }
        Op::Move => done(storage.move_place(&request::move_place(req)?, ctx)?),
        Op::Remove => done(storage.remove(&request::remove(req)?, ctx)?),
        Op::FactsAppend => done(storage.facts_append(&request::facts_append(req)?)?),
        Op::FactsSince => done(storage.facts_since(&request::facts_since(req)?, ctx)?),
        Op::RowsPut => done(storage.rows_put(&request::rows_put(text)?).map(empty)?),
        Op::RowsGet => done(storage.rows_get(&request::rows_get(req)?)?),
        Op::RowsUnder => done(storage.rows_under(&request::rows_under(req)?)?),
        Op::RowsWhere => done(storage.rows_where(&request::rows_where(req)?)?),
        Op::RowsReset => done(storage.rows_reset(&request::rows_reset(req)?).map(empty)?),
        Op::Init => done(storage.init()?),
        Op::Describe => {
            let info = storage.info();
            let ops: Vec<&str> = Op::ALL.iter().map(|op| op.name()).collect();
            done(json!({
                "name": info.name,
                "version": info.version,
                "contract": CONTRACT_VERSION,
                "addresses": info.addresses,
                "cursor": info.cursor,
                "facets": info.facets,
                "ops": ops,
            }))
        }
        Op::DeclarationRead => done(storage.declaration_read()?),
        Op::DeclarationWrite => done(storage.declaration_write(&request::declaration_write(req)?)?),
        Op::NoiseList => done(storage.noise_list()?),
        Op::NoiseAdd => done(storage.noise_edit(&request::noise_edit(req)?, NoiseChange::Add)?),
        Op::NoiseRemove => {
            done(storage.noise_edit(&request::noise_edit(req)?, NoiseChange::Remove)?)
        }
        Op::Hold => done(storage.hold(&request::hold(req)?)?),
        Op::Release => done(storage.release(&request::release(req)?).map(empty)?),
        Op::Subscribe => done(
            storage
                .subscribe(&request::subscribe(req)?, ctx)
                .map(empty)?,
        ),
    }
}
