//! `pneuma-base-core <op> --root <library folder> [<request JSON> | -]`, or
//! `pneuma-base-core serve --root <library folder>`: one JSON answer per request.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use pneuma_base_local::LocalFolder;
use pneuma_base_storage::{Ctx, Failure, Op, Reason, Storage, failure_text, handle, with_first};
use serde_json::{Map, Value};

enum Mode {
    One { op: Op, request: Option<String> },
    Serve,
}

struct Command {
    mode: Mode,
    root: PathBuf,
}

fn parse_args() -> Option<Command> {
    let mut args = std::env::args().skip(1);
    let op = args.next()?;
    let (mut root, mut request) = (None, None);
    while let Some(arg) = args.next() {
        if arg == "--root" {
            root = Some(PathBuf::from(args.next()?));
        } else if request.is_none() {
            request = Some(arg);
        } else {
            return None;
        }
    }
    let mode = if op == "serve" {
        if request.is_some() {
            return None;
        }
        Mode::Serve
    } else {
        Mode::One {
            op: Op::parse(&op)?,
            request,
        }
    };
    Some(Command { mode, root: root? })
}

fn print(answer: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(answer.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn bad_command_line() -> ExitCode {
    print(&failure_text(&Failure::bad_request()));
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let Some(command) = parse_args() else {
        return bad_command_line();
    };
    if !command.root.is_dir() {
        return bad_command_line();
    }
    let storage = match LocalFolder::open(&command.root) {
        Ok(storage) => storage,
        Err(_) => return bad_command_line(),
    };
    match command.mode {
        Mode::One { op, request } => {
            print(&one(&storage, op, request));
            ExitCode::SUCCESS
        }
        Mode::Serve => {
            serve(Arc::new(storage));
            ExitCode::SUCCESS
        }
    }
}

fn one(storage: &LocalFolder, op: Op, request: Option<String>) -> String {
    // A subscription lasts until cancelled, which only `serve` can do.
    if op == Op::Subscribe {
        return failure_text(&Failure::bad_request());
    }
    // Standard input carries a write's bytes unless it carries the request.
    let mut ctx = Ctx::default();
    ctx.stdin_free = request.as_deref() != Some("-");
    let text = match request.as_deref() {
        None => "{}".to_owned(),
        Some("-") => {
            let mut text = String::new();
            if std::io::stdin().read_to_string(&mut text).is_err() {
                return failure_text(&Failure::bad_request());
            }
            text
        }
        Some(text) => text.to_owned(),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(request)) => handle(storage, op, &request, &ctx),
        _ => failure_text(&Failure::bad_request()),
    }
}

struct Job {
    id: Value,
    op: Op,
    request: Map<String, Value>,
    ctx: Ctx,
}

/// Requests not yet answered, by their id's JSON text, so `cancel` can reach them.
type InFlight = Arc<Mutex<HashMap<String, Ctx>>>;

fn id_key(id: &Value) -> String {
    id.to_string()
}

fn answer_line(id: &Value, answer: &str) -> String {
    with_first(&format!("\"id\":{id}"), answer)
}

fn serve(storage: Arc<LocalFolder>) {
    let in_flight: InFlight = Arc::default();
    // Subscriptions never finish on their own: each runs on a thread of its own, not a worker's,
    // and ends when cancelled or when input ends.
    let mut subscriptions: Vec<(Ctx, std::thread::JoinHandle<()>)> = Vec::new();
    let (sender, receiver) = mpsc::channel::<Job>();
    let receiver = Arc::new(Mutex::new(receiver));
    let workers = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(2, 8));
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let (storage, receiver, in_flight) =
                (storage.clone(), receiver.clone(), in_flight.clone());
            std::thread::spawn(move || {
                loop {
                    let job = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    let Ok(job) = job else { return };
                    run_job(storage.as_ref(), &in_flight, job);
                }
            })
        })
        .collect();

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Object(request)) = serde_json::from_str::<Value>(&line) else {
            print(&answer_line(
                &Value::Null,
                &failure_text(&Failure::bad_request()),
            ));
            continue;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let op_name = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if op_name == "cancel" {
            let target = request.get("target").map(id_key);
            if let (Some(target), Ok(in_flight)) = (target, in_flight.lock())
                && let Some(ctx) = in_flight.get(&target)
            {
                ctx.cancel();
            }
            print(&answer_line(&id, "{\"outcome\":\"done\"}"));
            continue;
        }
        let Some(op) = Op::parse(op_name) else {
            print(&answer_line(&id, &failure_text(&Failure::bad_request())));
            continue;
        };
        let progress_id = id.clone();
        let ctx = Ctx::with_progress(move |progress| {
            print(&format!("{{\"id\":{progress_id},\"progress\":{progress}}}"));
        });
        if let Ok(mut in_flight) = in_flight.lock() {
            in_flight.insert(id_key(&id), ctx.clone());
        }
        if op == Op::Subscribe {
            let (storage, in_flight) = (storage.clone(), in_flight.clone());
            let job = Job {
                id,
                op,
                request,
                ctx: ctx.clone(),
            };
            subscriptions.retain(|(_, thread)| !thread.is_finished());
            subscriptions.push((
                ctx,
                std::thread::spawn(move || run_job(storage.as_ref(), &in_flight, job)),
            ));
            continue;
        }
        if sender
            .send(Job {
                id,
                op,
                request,
                ctx,
            })
            .is_err()
        {
            break;
        }
    }
    drop(sender);
    for (ctx, _) in &subscriptions {
        ctx.cancel();
    }
    for handle in handles {
        let _ = handle.join();
    }
    for (_, thread) in subscriptions {
        let _ = thread.join();
    }
}

fn run_job(storage: &dyn Storage, in_flight: &InFlight, job: Job) {
    let mut answer = handle(storage, job.op, &job.request, &job.ctx);
    // Once out of the in-flight table a cancel can no longer reach this request. A read's
    // answer is dropped if the cancel came first; a write that already happened is answered
    // as it happened.
    if let Ok(mut in_flight) = in_flight.lock() {
        in_flight.remove(&id_key(&job.id));
    }
    if job.ctx.is_cancelled() && !job.op.writes() {
        answer = failure_text(&Failure::new(Reason::Cancelled));
    }
    print(&answer_line(&job.id, &answer));
}
