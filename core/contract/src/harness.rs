//! What the checks drive a provider with: libraries in temporary folders, one-shot calls, `serve`
//! sessions, and fixtures made with `std`. Every provider process gets a fresh temporary `HOME`
//! and `PNEUMA_BASE_HOME`, closed or fed standard input, and a time limit; every answer and
//! progress line it prints is held to rules 2.10 and 8 before a check sees it.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, Permissions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The longest any provider process may take to answer before it counts as hung (rule 2.9).
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// The longest a place may take to give a token `look` accepts after its last change.
pub const SETTLE: Duration = Duration::from_secs(5);

/// The fixed reasons of section 8.
pub const REASONS: [&str; 14] = [
    "no_such_place",
    "not_a_dir",
    "not_a_file",
    "noise",
    "outside",
    "refused",
    "too_many",
    "elsewhere",
    "held",
    "cannot_say",
    "unreadable",
    "bad_request",
    "cancelled",
    "busy",
];

/// The operations the contract names, in its order (sections 4, 5 and 6).
pub const OPS: [&str; 28] = [
    "glance",
    "overview",
    "probe",
    "look",
    "changed",
    "content",
    "read",
    "write",
    "move",
    "remove",
    "facts.append",
    "facts.since",
    "facts.carry",
    "rows.put",
    "rows.get",
    "rows.under",
    "rows.where",
    "rows.reset",
    "init",
    "describe",
    "declaration.read",
    "declaration.write",
    "noise.list",
    "noise.add",
    "noise.remove",
    "hold",
    "release",
    "subscribe",
];

/// The provider under test and what it says of itself.
pub struct Env {
    pub provider: PathBuf,
    pub describe: Value,
}

impl Env {
    pub fn new(provider: &Path) -> Env {
        let provider = provider.to_path_buf();
        let lib = Lib::bare(&provider);
        // A provider that cannot describe itself fails every check that reads `describe`.
        let ask = std::panic::AssertUnwindSafe(|| lib.run("describe", json!({})));
        let describe = std::panic::catch_unwind(ask).unwrap_or(Value::Null);
        Env { provider, describe }
    }

    /// A new library, initialised.
    pub fn lib(&self) -> Lib {
        let lib = Lib::bare(&self.provider);
        let init = lib.run("init", json!({}));
        assert_eq!(init["created"], true, "init: {init}");
        lib
    }

    /// A folder that is not yet a library.
    pub fn bare(&self) -> Lib {
        Lib::bare(&self.provider)
    }

    /// Whether `describe` says `changed` can give a reliable cursor.
    pub fn cursor(&self) -> bool {
        self.describe["cursor"] == true
    }

    /// Whether the provider answers path addresses: a local folder, whose record area the wire
    /// (core/README.md) places at `.pneuma-base/`.
    pub fn path_addressed(&self) -> bool {
        self.describe["addresses"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x == "path"))
    }

    /// Whether `describe` lists the facet.
    pub fn facet(&self, name: &str) -> bool {
        self.describe["facets"]
            .as_array()
            .is_some_and(|f| f.iter().any(|n| n == name))
    }
}

/// A temporary folder outside every library, for sources of writes and targets of reads.
pub fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pneuma-base-contract-src.")
        .tempdir()
        .expect("temporary folder")
}

/// A library folder of its own, removed when dropped.
pub struct Lib {
    provider: PathBuf,
    dir: tempfile::TempDir,
}

impl Lib {
    fn bare(provider: &Path) -> Lib {
        let dir = tempfile::Builder::new()
            .prefix("pneuma-base-contract.")
            .tempdir()
            .expect("temporary folder");
        Lib {
            provider: provider.to_path_buf(),
            dir,
        }
    }

    pub fn provider(&self) -> &Path {
        &self.provider
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn root_arg(&self) -> String {
        self.root().to_str().expect("UTF-8 path").to_owned()
    }

    pub fn at(&self, place: &str) -> PathBuf {
        if place.is_empty() {
            self.root().to_path_buf()
        } else {
            self.root().join(place)
        }
    }

    pub fn write(&self, place: &str, text: &str) {
        self.write_bytes(place, text.as_bytes());
    }

    pub fn write_bytes(&self, place: &str, bytes: &[u8]) {
        let path = self.at(place);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    pub fn mkdir(&self, place: &str) {
        fs::create_dir_all(self.at(place)).unwrap();
    }

    /// One operation in one process, the request on standard input; asserts it answered.
    pub fn run(&self, op: &str, request: Value) -> Value {
        self.start(op, &request).answer()
    }

    /// One operation in one process, started and not yet waited for.
    pub fn start(&self, op: &str, request: &Value) -> Running {
        let args = [op, "--root", &self.root_arg(), "-"].map(OsString::from);
        Running::start(
            &self.provider,
            op,
            &args,
            Input::Bytes(request.to_string().into_bytes()),
        )
    }

    /// One operation with the request as an argument and standard input left open for the caller.
    pub fn start_open(&self, op: &str, request: &Value) -> Running {
        let args = [op, "--root", &self.root_arg(), &request.to_string()].map(OsString::from);
        Running::start(&self.provider, op, &args, Input::Open)
    }

    /// One operation with the request as an argument and `bytes` on standard input.
    pub fn run_with_stdin(&self, op: &str, request: &Value, bytes: &[u8]) -> Value {
        let args = [op, "--root", &self.root_arg(), &request.to_string()].map(OsString::from);
        Running::start(&self.provider, op, &args, Input::Bytes(bytes.to_vec())).answer()
    }

    pub fn glance_one(&self, place: &str) -> Value {
        self.run("glance", json!({ "places": [place] }))["entries"][0].clone()
    }

    /// A token of the place that `look` answers `same` for. A token taken too soon after a change
    /// may be answered `changed` until a later one is used (rule 7.racy), so this glances, looks
    /// with what it got, and follows `changed` to the newer token until `look` says `same`.
    pub fn token(&self, place: &str) -> String {
        let entry = self.glance_one(place);
        let mut token = entry["token"]
            .as_str()
            .unwrap_or_else(|| panic!("no token for {place}: {entry}"))
            .to_owned();
        let deadline = std::time::Instant::now() + SETTLE;
        loop {
            let looked = self.look_one(place, &token);
            if looked["same"] == 1 {
                return token;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "look never answered same for {place} within {SETTLE:?}: {looked}"
            );
            token = looked["changed"][0]["entry"]["token"]
                .as_str()
                .unwrap_or_else(|| panic!("{place} is not there to settle: {looked}"))
                .to_owned();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn look_one(&self, place: &str, token: &str) -> Value {
        self.run(
            "look",
            json!({ "places": [{ "place": place, "token": token }] }),
        )
    }

    /// Whether `look` says the place is still what `token` stands for.
    pub fn same(&self, place: &str, token: &str) -> bool {
        self.look_one(place, token)["same"] == 1
    }

    /// The fingerprint `content` gives for the place, with a file limit no fixture reaches.
    pub fn fingerprint(&self, place: &str) -> String {
        let answer = self.run("content", json!({ "place": place, "limit": 1_000_000 }));
        answer["fingerprint"]
            .as_str()
            .unwrap_or_else(|| panic!("content of {place}: {answer}"))
            .to_owned()
    }

    pub fn serve(&self) -> Serve {
        Serve::start(&self.provider, self.root())
    }
}

enum Input {
    Bytes(Vec<u8>),
    Open,
}

/// A provider process on its way to one answer.
pub struct Running {
    op: String,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    out: Receiver<Vec<u8>>,
    _home: tempfile::TempDir,
}

/// A provider process in a process group of its own, so a kill reaches whatever it started (a
/// provider may be a script around another program).
fn command(provider: &Path, home: &Path) -> Command {
    let mut command = Command::new(provider);
    command
        .process_group(0)
        .env("HOME", home)
        .env("PNEUMA_BASE_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

/// SIGKILL to the provider's process group, then reap it.
fn kill_group(mut child: Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: signals the process group this harness made for the child.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn fresh_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pneuma-base-contract-home.")
        .tempdir()
        .expect("temporary home")
}

impl Running {
    fn start(provider: &Path, op: &str, args: &[OsString], input: Input) -> Running {
        let home = fresh_home();
        let mut child = command(provider, home.path())
            .args(args)
            .spawn()
            .unwrap_or_else(|e| panic!("cannot start the provider {}: {e}", provider.display()));
        let mut stdin = child.stdin.take();
        if let Input::Bytes(bytes) = input {
            let mut pipe = stdin.take().unwrap();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
        let mut stdout = child.stdout.take().unwrap();
        let (sender, out) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            let _ = sender.send(bytes);
        });
        Running {
            op: op.to_owned(),
            child: Some(child),
            stdin,
            out,
            _home: home,
        }
    }

    /// Standard input, when it was left open.
    pub fn stdin(&mut self) -> &mut ChildStdin {
        self.stdin.as_mut().expect("standard input left open")
    }

    /// The answer and the exit status.
    pub fn outcome(mut self) -> (Value, i32) {
        self.stdin.take();
        let bytes = match self.out.recv_timeout(TIMEOUT) {
            Ok(bytes) => bytes,
            Err(_) => panic!(
                "{} gave no answer within {}s (rule 2.9: no deadlock)",
                self.op,
                TIMEOUT.as_secs()
            ),
        };
        let status = self.child.take().unwrap().wait().unwrap();
        let text = String::from_utf8(bytes).expect("UTF-8 output");
        assert_eq!(
            text.lines().count(),
            1,
            "{}: one answer line: {text:?}",
            self.op
        );
        let answer: Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| panic!("{}: the answer is not JSON (2.10): {text:?}", self.op));
        check_answer(&self.op, &answer);
        (answer, status.code().unwrap_or(-1))
    }

    /// The answer of a process that must exit 0.
    pub fn answer(self) -> Value {
        let op = self.op.clone();
        let (answer, code) = self.outcome();
        assert_eq!(code, 0, "{op} exited {code}: {answer}");
        answer
    }

    /// SIGKILL, then reap.
    pub fn kill(mut self) {
        if let Some(child) = self.child.take() {
            kill_group(child);
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            kill_group(child);
        }
    }
}

/// Calls the provider with any arguments, the way a wrong command line would.
pub fn call_args(provider: &Path, args: &[&str], stdin: Option<&str>) -> (Value, i32) {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let op = args
        .first()
        .and_then(|a| a.to_str())
        .unwrap_or("")
        .to_owned();
    let input = Input::Bytes(stdin.unwrap_or("").as_bytes().to_vec());
    Running::start(provider, &op, &args, input).outcome()
}

/// Holds one answer to rules 2.10 and 8: a JSON object with an outcome; a failure carries a fixed
/// reason, `refused` only with `refused`, `cannot_say` only from `changed`, and no sentence.
pub fn check_answer(op: &str, answer: &Value) {
    let Some(object) = answer.as_object() else {
        panic!("{op}: the answer is not a JSON object (2.10): {answer}");
    };
    let outcome = object.get("outcome").and_then(Value::as_str);
    match outcome {
        Some("done") => {}
        Some("failed") | Some("refused") => {
            let reason = object.get("reason").and_then(Value::as_str).unwrap_or("");
            assert!(
                REASONS.contains(&reason),
                "{op}: reason {reason:?} is not one of section 8's: {answer}"
            );
            assert_eq!(
                outcome == Some("refused"),
                reason == "refused",
                "{op}: outcome refused goes with reason refused (8): {answer}"
            );
            assert!(
                reason != "cannot_say" || op == "changed" || op == "subscribe",
                "{op}: cannot_say is only for changed and subscribe (8): {answer}"
            );
            no_sentences(op, answer);
        }
        _ => panic!("{op}: no outcome done/failed/refused (8): {answer}"),
    }
}

/// No string a failure gives at its top level reads as a sentence for people.
fn no_sentences(op: &str, answer: &Value) {
    for (key, value) in answer.as_object().unwrap() {
        if let Some(text) = value.as_str() {
            assert!(
                !text.contains(' ') || key == "place",
                "{op}: {key} reads as a sentence for people (2.10): {text:?}"
            );
        }
    }
}

/// A `serve` session.
pub struct Serve {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    /// The operation each id asked for, to judge its answer.
    ops: HashMap<String, String>,
    /// A line taken by `receive_within`, judged by the `receive` that follows.
    queued: std::collections::VecDeque<String>,
    _home: tempfile::TempDir,
}

impl Serve {
    fn start(provider: &Path, root: &Path) -> Serve {
        let home = fresh_home();
        let mut child = command(provider, home.path())
            .args(["serve".as_ref(), "--root".as_ref(), root.as_os_str()])
            .spawn()
            .expect("serve starts");
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in stdout.lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Serve {
            child: Some(child),
            stdin,
            lines,
            ops: HashMap::new(),
            queued: std::collections::VecDeque::new(),
            _home: home,
        }
    }

    pub fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("serve input open");
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    /// Sends one request with its id and op.
    pub fn request(&mut self, id: Value, op: &str, mut request: Value) {
        self.ops.insert(id.to_string(), op.to_owned());
        request["id"] = id;
        request["op"] = json!(op);
        self.send(&request.to_string());
    }

    /// The next line, answer or progress, held to the rules.
    pub fn receive(&mut self) -> Value {
        let line = match self.queued.pop_front() {
            Some(line) => line,
            None => self.lines.recv_timeout(TIMEOUT).unwrap_or_else(|_| {
                panic!("serve gave no line within {}s (2.9)", TIMEOUT.as_secs())
            }),
        };
        let value: Value = serde_json::from_str(&line)
            .unwrap_or_else(|_| panic!("serve line is not JSON (2.10): {line:?}"));
        if value.get("progress").is_some() {
            assert!(
                value["progress"].is_object() && value.get("id").is_some(),
                "a progress line is an id and an object: {value}"
            );
            assert!(value.get("outcome").is_none(), "{value}");
        } else {
            let op = self
                .ops
                .get(&value["id"].to_string())
                .cloned()
                .unwrap_or_default();
            check_answer(&op, &value);
        }
        value
    }

    /// The next line within `timeout`, held to the rules; `None` when none came.
    pub fn receive_within(&mut self, timeout: Duration) -> Option<Value> {
        let line = self.lines.recv_timeout(timeout).ok()?;
        self.queued.push_back(line);
        Some(self.receive())
    }

    /// Lines up to and including the answer for `id`: its progress lines, and the answer.
    pub fn answer_for(&mut self, id: &Value) -> (Vec<Value>, Value) {
        let mut progress = Vec::new();
        loop {
            let line = self.receive();
            if &line["id"] != id {
                continue;
            }
            if line.get("progress").is_some() {
                progress.push(line);
            } else {
                return (progress, line);
            }
        }
    }

    /// Sends one request and gives its answer without its id.
    pub fn ask(&mut self, id: Value, op: &str, request: Value) -> Value {
        self.request(id.clone(), op, request);
        let (_, mut answer) = self.answer_for(&id);
        if let Some(object) = answer.as_object_mut() {
            object.remove("id");
        }
        answer
    }

    /// Waits for the first progress line of `id`; `None` if its answer came first.
    pub fn first_progress(&mut self, id: &Value) -> Option<Value> {
        loop {
            let line = self.receive();
            if &line["id"] != id {
                continue;
            }
            return line.get("progress").is_some().then_some(line);
        }
    }

    /// SIGKILL, then reap.
    pub fn kill(mut self) {
        if let Some(child) = self.child.take() {
            kill_group(child);
        }
    }

    /// Closes input and waits for the exit status.
    pub fn finish(mut self) -> i32 {
        self.stdin.take();
        let mut child = self.child.take().unwrap();
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status.code().unwrap_or(-1);
            }
            if started.elapsed() > TIMEOUT {
                kill_group(child);
                panic!("serve did not exit after its input closed (2.9)");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            kill_group(child);
        }
    }
}

/// Makes a path unreadable and restores it when dropped, before the folder is removed.
pub struct Locked(PathBuf);

impl Locked {
    /// `None` when permissions do not bind this user (root reads anything).
    pub fn new(path: PathBuf) -> Option<Locked> {
        fs::set_permissions(&path, Permissions::from_mode(0o000)).unwrap();
        let locked = Locked(path);
        let readable = if locked.0.is_dir() {
            fs::read_dir(&locked.0).is_ok()
        } else {
            File::open(&locked.0).is_ok()
        };
        (!readable).then_some(locked)
    }
}

impl Drop for Locked {
    fn drop(&mut self) {
        let mode = if self.0.is_dir() { 0o755 } else { 0o644 };
        let _ = fs::set_permissions(&self.0, Permissions::from_mode(mode));
    }
}

pub const ROOT_READS_ANYTHING: &str = "permissions do not bind this user";

// ---------------------------------------------------------------------------------------------
// Answers

pub fn places_of(entries: &Value) -> Vec<String> {
    entries
        .as_array()
        .unwrap_or_else(|| panic!("a list: {entries}"))
        .iter()
        .map(|e| e["place"].as_str().unwrap().to_owned())
        .collect()
}

pub fn strings_of(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap_or_else(|| panic!("a list: {list}"))
        .iter()
        .map(|e| e.as_str().unwrap().to_owned())
        .collect()
}

pub fn assert_done(answer: &Value) {
    assert_eq!(answer["outcome"], "done", "{answer}");
}

pub fn assert_failed(answer: &Value, reason: &str) {
    assert_eq!(answer["outcome"], "failed", "{answer}");
    assert_eq!(answer["reason"], reason, "{answer}");
}

pub fn assert_refused(answer: &Value) {
    assert_eq!(answer["outcome"], "refused", "{answer}");
    assert_eq!(answer["reason"], "refused", "{answer}");
}

pub fn facts_of(answer: &Value) -> Vec<Value> {
    answer["facts"]
        .as_array()
        .unwrap_or_else(|| panic!("facts: {answer}"))
        .iter()
        .map(|f| f["fact"].clone())
        .collect()
}

pub fn orders_of(answer: &Value) -> Vec<String> {
    answer["facts"]
        .as_array()
        .unwrap_or_else(|| panic!("facts: {answer}"))
        .iter()
        .map(|f| f["order"].as_str().unwrap().to_owned())
        .collect()
}

/// Every fact of a record place, following `more`.
pub fn all_facts(lib: &Lib, place: &str) -> Vec<Value> {
    let mut facts = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let since = lib.run(
            "facts.since",
            json!({ "place": place, "cursor": cursor, "limit": 10_000 }),
        );
        facts.extend(facts_of(&since));
        cursor = since["cursor"].clone();
        if since["more"] != true {
            return facts;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Bytes

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn sha256_file(path: &Path) -> String {
    sha256_hex(&fs::read(path).unwrap())
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// A write's source that carries `bytes` in the request.
pub fn data(bytes: &[u8]) -> Value {
    json!({ "data": base64_encode(bytes) })
}

pub fn base64_decode(text: &str) -> Vec<u8> {
    let value = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => panic!("not base64: {c}"),
        }
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | value(c);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// `n` bytes that differ from `seed` to seed.
pub fn bytes_of(n: usize, seed: u8) -> Vec<u8> {
    (0..n)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Fixtures

/// Milliseconds since the epoch of an ISO 8601 UTC time with milliseconds
/// (`2026-11-26T07:48:00.123Z`).
pub fn iso_ms(iso: &str) -> i64 {
    assert!(
        iso.len() == 24 && iso.ends_with('Z'),
        "an ISO time with milliseconds: {iso}"
    );
    let n = |r: std::ops::Range<usize>| iso[r].parse::<i64>().unwrap();
    let (y, m, d) = (n(0..4), n(5..7), n(8..10));
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    (days * 86_400 + n(11..13) * 3_600 + n(14..16) * 60 + n(17..19)) * 1_000 + n(20..23)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn set_mtime(path: &Path, when: SystemTime) {
    File::open(path).unwrap().set_modified(when).unwrap();
}

pub fn an_hour_ago() -> SystemTime {
    SystemTime::now() - Duration::from_secs(3_600)
}

/// Writes `files` small files under `dir` (made if missing), spread over subdirectories.
pub fn many_files(dir: &Path, files: usize, seed: u8) {
    for i in 0..files {
        let sub = dir.join(format!("d{:02}", i % 16));
        if i < 16 {
            fs::create_dir_all(&sub).unwrap();
        }
        fs::write(
            sub.join(format!("f{i:05}")),
            [seed, i as u8, (i >> 8) as u8],
        )
        .unwrap();
    }
}

pub fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target);
        } else if kind.is_file() {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

pub fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(walk_files(&path));
            } else {
                found.push(path);
            }
        }
    }
    found
}

/// Runs `f(0..n)` on `n` threads at once; a panic in one is the caller's panic, message kept.
pub fn at_once<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let barrier = std::sync::Barrier::new(n);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let (f, barrier) = (&f, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    f(i)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)))
            .collect()
    })
}

/// Polls `f` every 100 ms until it gives `Some`, or `deadline` passes.
pub fn poll<T>(deadline: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let started = std::time::Instant::now();
    loop {
        if let Some(found) = f() {
            return Some(found);
        }
        if started.elapsed() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
