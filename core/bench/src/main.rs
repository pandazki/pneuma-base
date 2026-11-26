//! Times the real `pneuma-base-core` binary against the storage targets (architecture 9.3), one
//! process per operation and through `serve`. Builds its fixtures in its own temporary folder;
//! with `--library <path>` it also times the operations that only read on a real library, and
//! changes nothing there. Always exits 0: it reports, it does not gate.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const RUNS: usize = 30;
const WARMUP: usize = 3;
const BIG_DIR: usize = 60_000;
const PLACE_DIRS: usize = 100;
const PLACES_PER_DIR: usize = 200;
const FACT_DAYS: usize = 200;
const FILES_PER_DAY: usize = 5;
const FACTS_PER_FILE: usize = 100;
const ROWS: usize = 20_000;
const TEN_MB: usize = 10 << 20;
const SMALL_FILES: usize = 1_000;
const CHANGES: usize = 1_000;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut library = None;
    while let Some(arg) = args.next() {
        if arg == "--library" {
            library = args.next().map(PathBuf::from);
        }
    }
    if let Err(problem) = run(library.as_deref()) {
        println!("benchmark could not run: {problem}");
    }
}

fn binary() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PNEUMA_BASE_CORE") {
        return Ok(PathBuf::from(path));
    }
    let here = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = here.with_file_name("pneuma-base-core");
    // Under `cargo run`, make sure the binary next to this one is built and current.
    if let Ok(cargo) = std::env::var("CARGO") {
        let profile = if here.parent().is_some_and(|p| p.ends_with("release")) {
            vec!["--release"]
        } else {
            vec![]
        };
        let status = Command::new(cargo)
            .args(["build", "-q", "-p", "pneuma-base-core"])
            .args(profile)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("building pneuma-base-core failed".into());
        }
    }
    if sibling.exists() {
        Ok(sibling)
    } else {
        Err(format!("no binary at {}", sibling.display()))
    }
}

/// Makes the request for run `n`, outside the timing: a write needs a fresh place, a move or a
/// removal a fresh thing and its token.
type Prepare<'a> = Box<dyn FnMut(usize) -> Result<Value, String> + 'a>;

struct Case<'a> {
    name: &'static str,
    target_ms: Option<f64>,
    op: &'static str,
    prepare: Prepare<'a>,
    /// Says whether an answer did the work the case is about.
    check: fn(&Value) -> bool,
}

fn fixed<'a>(request: Value) -> Prepare<'a> {
    Box::new(move |_| Ok(request.clone()))
}

fn run(library: Option<&Path>) -> Result<(), String> {
    let bin = binary()?;
    let temp = tempfile::Builder::new()
        .prefix("pneuma-base-bench.")
        .tempdir()
        .map_err(|e| e.to_string())?;
    // The provider gets a home of its own, never the real one.
    let home = temp.path().join("home");
    std::fs::create_dir(&home).map_err(|e| e.to_string())?;
    let env = Env {
        bin: bin.clone(),
        home,
    };
    if let Some(library) = library {
        let cases = real_cases(&env, library)?;
        println!("real library: {}", library.display());
        return time_cases(&env, library, cases);
    }
    let lib = temp.path().join("lib");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&lib).map_err(|e| e.to_string())?;
    std::fs::create_dir(&outside).map_err(|e| e.to_string())?;
    let t = Instant::now();
    env.one_shot(&lib, "init", &json!({}))?;
    build_fixtures(&env, &lib, &outside)?;
    println!(
        "fixtures: {BIG_DIR}-entry directory, {} places, {} facts over {FACT_DAYS} days, {ROWS} rows, \
         a 10 MB file, {SMALL_FILES} small files outside ({:.1} s)",
        PLACE_DIRS * PLACES_PER_DIR,
        FACT_DAYS * FILES_PER_DAY * FACTS_PER_FILE,
        t.elapsed().as_secs_f64()
    );
    let cases = synthetic_cases(&env, &lib, &outside)?;
    time_cases(&env, &lib, cases)
}

fn synthetic_cases<'a>(
    env: &'a Env,
    lib: &'a Path,
    outside: &'a Path,
) -> Result<Vec<Case<'a>>, String> {
    let places: Vec<String> = (0..PLACE_DIRS)
        .flat_map(|d| (0..PLACES_PER_DIR).map(move |f| format!("places/d{d:03}/file-{f:03}.md")))
        .collect();
    let glance = env.one_shot(lib, "glance", &json!({ "places": places }))?;
    let look_places: Vec<Value> = glance["entries"]
        .as_array()
        .ok_or("glance gave no entries")?
        .iter()
        .map(|e| json!({ "place": e["place"], "token": e["token"] }))
        .collect();
    let read_at = Instant::now();
    let cursor = facts_end_cursor(env, lib)?;
    let (quiet, busy) = change_cursors(env, lib)?;

    // Directories changed in the last 2 s are not trusted to be settled; let the fixture age.
    std::thread::sleep(Duration::from_millis(2_100));
    // A reader that keeps reading: once the fixture's days are past the cursor's 10-second
    // window, one more read moves the cursor above them, as the kernel's next read would.
    std::thread::sleep(Duration::from_secs(12).saturating_sub(read_at.elapsed()));
    let again = env.one_shot(
        lib,
        "facts.since",
        &json!({ "place": "bench", "cursor": cursor }),
    )?;
    let cursor = again["cursor"].clone();

    let names_cache = lib.join(".pneuma-base/cache/names");
    let small = outside.join("small");
    Ok(vec![
        Case {
            name: "glance, 1 place",
            target_ms: Some(5.0),
            op: "glance",
            prepare: fixed(json!({ "places": ["places/d050/file-100.md"] })),
            check: |a| a["entries"][0]["kind"] == "file",
        },
        Case {
            name: "changed, nothing changed",
            target_ms: Some(20.0),
            op: "changed",
            prepare: fixed(json!({ "cursor": quiet })),
            check: |a| a["places"].as_array().is_some_and(Vec::is_empty),
        },
        Case {
            name: "changed, 1,000 changes",
            target_ms: Some(30.0),
            op: "changed",
            prepare: fixed(json!({ "cursor": busy, "limit": 10_000 })),
            check: |a| a["places"].as_array().is_some_and(|p| p.len() >= CHANGES),
        },
        Case {
            name: "rows.get, 1 key of 20,000",
            target_ms: Some(5.0),
            op: "rows.get",
            prepare: fixed(json!({ "place": "bench", "table": "items", "keys": ["item-10000"] })),
            check: |a| a["rows"].as_array().is_some_and(|r| r.len() == 1),
        },
        Case {
            name: "overview, 60,000 entries, limit 200 (warm)",
            target_ms: Some(10.0),
            op: "overview",
            prepare: fixed(json!({ "place": "big", "limit": 200 })),
            check: |a| {
                a["entries"].as_array().is_some_and(|e| e.len() == 200) && a["total"] == BIG_DIR
            },
        },
        Case {
            name: "overview, 60,000 entries, limit 200 (cold: no cache)",
            target_ms: None,
            op: "overview",
            prepare: Box::new(move |_| {
                let _ = std::fs::remove_dir_all(&names_cache);
                Ok(json!({ "place": "big", "limit": 200 }))
            }),
            check: |a| a["entries"].as_array().is_some_and(|e| e.len() == 200),
        },
        Case {
            name: "probe, budget 500",
            target_ms: Some(10.0),
            op: "probe",
            prepare: fixed(json!({ "place": "places", "budget": 500 })),
            check: |a| a["exceeded"] == true && a["dirs"].as_u64().is_some_and(|d| d > 0),
        },
        Case {
            name: "probe, budget 500, inside the 60,000",
            target_ms: Some(10.0),
            op: "probe",
            prepare: fixed(json!({ "place": "big", "budget": 500 })),
            check: |a| a["exceeded"] == true && a["files"] == 500,
        },
        Case {
            name: "look, 20,000 places, all same",
            target_ms: Some(50.0),
            op: "look",
            prepare: fixed(json!({ "places": look_places })),
            check: |a| a["same"] == PLACE_DIRS * PLACES_PER_DIR,
        },
        Case {
            name: "facts.since, nothing new, 100,000 facts",
            target_ms: Some(5.0),
            op: "facts.since",
            prepare: fixed(json!({ "place": "bench", "cursor": cursor })),
            check: |a| a["facts"].as_array().is_some_and(Vec::is_empty) && a["more"] == false,
        },
        Case {
            name: "content, a 10 MB file",
            target_ms: Some(15.0),
            op: "content",
            prepare: fixed(json!({ "place": "files/ten-mb.bin" })),
            check: |a| a["size"] == TEN_MB,
        },
        Case {
            name: "write, 1,000 small files as one directory",
            target_ms: Some(150.0),
            op: "write",
            prepare: Box::new(move |n| {
                Ok(json!({ "place": format!("written/run-{n}"), "from": small, "expect": "empty" }))
            }),
            check: |a| a["files"] == SMALL_FILES,
        },
        Case {
            name: "move, one file",
            target_ms: Some(5.0),
            op: "move",
            prepare: Box::new(move |n| {
                let from = format!("moving/from-{n}.md");
                let token = env.make_file(lib, &from)?;
                Ok(json!({
                    "from": from,
                    "to": format!("moving/to-{n}.md"),
                    "expect": { "from": token, "to": "empty" },
                }))
            }),
            check: |a| a["entry"]["kind"] == "file",
        },
        Case {
            name: "remove, one file",
            target_ms: Some(5.0),
            op: "remove",
            prepare: Box::new(move |n| {
                let place = format!("removing/file-{n}.md");
                let token = env.make_file(lib, &place)?;
                Ok(json!({ "place": place, "expect": token }))
            }),
            check: |a| a["removed"] == true,
        },
    ])
}

/// Only operations that read, on places that exist in a library holding a large repository.
fn real_cases<'a>(env: &'a Env, lib: &'a Path) -> Result<Vec<Case<'a>>, String> {
    let overview = env.one_shot(lib, "overview", &json!({ "place": "react" }))?;
    let look_places: Vec<Value> = overview["entries"]
        .as_array()
        .ok_or_else(|| format!("overview: {overview}"))?
        .iter()
        .map(|e| json!({ "place": e["place"], "token": e["token"] }))
        .collect();
    let facts = facts_end_cursor_of(env, lib, "ledger")?;
    let quiet = env.one_shot(lib, "changed", &json!({}))?["cursor"].clone();
    let rule = json!({ "ignore_file": ".gitignore" });
    Ok(vec![
        Case {
            name: "glance, 1 place",
            target_ms: Some(5.0),
            op: "glance",
            prepare: fixed(json!({ "places": ["react/package.json"] })),
            check: |a| a["entries"][0]["kind"] == "file",
        },
        Case {
            name: "changed, nothing changed",
            target_ms: Some(20.0),
            op: "changed",
            prepare: fixed(json!({ "cursor": quiet })),
            check: |a| a["places"].as_array().is_some_and(Vec::is_empty),
        },
        Case {
            name: "overview, the repository's root",
            target_ms: Some(10.0),
            op: "overview",
            prepare: fixed(json!({ "place": "react" })),
            check: |a| a["entries"].as_array().is_some_and(|e| !e.is_empty()),
        },
        Case {
            name: "probe, the repository, budget 500",
            target_ms: Some(10.0),
            op: "probe",
            prepare: fixed(json!({ "place": "react", "budget": 500 })),
            check: |a| a["exceeded"] == true,
        },
        Case {
            name: "look, the repository's root entries",
            target_ms: Some(5.0),
            op: "look",
            prepare: fixed(json!({ "places": look_places })),
            check: |a| a["changed"].as_array().is_some_and(Vec::is_empty),
        },
        Case {
            name: "facts.since, nothing new",
            target_ms: Some(5.0),
            op: "facts.since",
            prepare: fixed(json!({ "place": "ledger", "cursor": facts })),
            check: |a| a["facts"].as_array().is_some_and(Vec::is_empty),
        },
        Case {
            name: "content, yarn.lock (0.7 MB)",
            target_ms: Some(5.0),
            op: "content",
            prepare: fixed(json!({ "place": "react/yarn.lock" })),
            check: |a| a["kind"] == "file",
        },
        Case {
            name: "content, packages/ under .gitignore",
            target_ms: None,
            op: "content",
            prepare: fixed(json!({ "place": "react/packages", "rule": rule, "limit": 100_000 })),
            check: |a| a["kind"] == "dir",
        },
    ])
}

fn time_cases(env: &Env, lib: &Path, mut cases: Vec<Case>) -> Result<(), String> {
    let mut server = Server::start(env, lib)?;
    let mut n = 0;
    println!();
    println!(
        "{:<52} {:>8} {:>11} {:>9}  result",
        "operation", "target", "one-shot", "serve"
    );
    for case in &mut cases {
        let shot = median(RUNS, || {
            n += 1;
            let request = (case.prepare)(n)?;
            let started = Instant::now();
            let answer = env.one_shot(lib, case.op, &request)?;
            let elapsed = started.elapsed();
            verify(case.check, &answer)?;
            Ok(elapsed)
        });
        let served = median(RUNS, || {
            n += 1;
            let request = (case.prepare)(n)?;
            let started = Instant::now();
            let answer = server.ask(case.op, &request)?;
            let elapsed = started.elapsed();
            verify(case.check, &answer)?;
            Ok(elapsed)
        });
        let result = match (&shot, case.target_ms) {
            (Err(_), _) | (_, None) => "-".to_owned(),
            (Ok(ms), Some(target)) if *ms <= target => "pass".to_owned(),
            (Ok(_), Some(_)) => "miss".to_owned(),
        };
        println!(
            "{:<52} {:>8} {:>11} {:>9}  {}",
            case.name,
            case.target_ms.map_or("-".to_owned(), |t| format!("{t} ms")),
            show(&shot),
            show(&served),
            result
        );
    }
    println!();
    println!(
        "median of {RUNS} runs after {WARMUP} warm-up runs; one-shot includes process start; warm page cache"
    );
    Ok(())
}

fn show(result: &Result<f64, String>) -> String {
    match result {
        Ok(ms) => format!("{ms:.2} ms"),
        Err(problem) => format!("error: {problem}"),
    }
}

fn verify(check: fn(&Value) -> bool, answer: &Value) -> Result<(), String> {
    if answer["outcome"] == "done" && check(answer) {
        Ok(())
    } else {
        let text = answer.to_string();
        Err(text.chars().take(160).collect())
    }
}

fn median(runs: usize, mut once: impl FnMut() -> Result<Duration, String>) -> Result<f64, String> {
    for _ in 0..WARMUP {
        once()?;
    }
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        times.push(once()?.as_secs_f64() * 1_000.0);
    }
    times.sort_by(f64::total_cmp);
    Ok(times[runs / 2])
}

/// How to start the provider: its binary, and the temporary home it runs under.
struct Env {
    bin: PathBuf,
    home: PathBuf,
}

impl Env {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.bin);
        command
            .env("HOME", &self.home)
            .env("PNEUMA_BASE_HOME", &self.home);
        command
    }

    fn one_shot(&self, lib: &Path, op: &str, request: &Value) -> Result<Value, String> {
        let mut child = self
            .command()
            .args([op, "--root"])
            .arg(lib)
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let body = request.to_string();
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(body.as_bytes())
            .map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
    }

    /// Puts a small file at `place` behind the provider's back and returns its token.
    fn make_file(&self, lib: &Path, place: &str) -> Result<Value, String> {
        let path = lib.join(place);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, b"# a note\n").map_err(|e| e.to_string())?;
        // Past APFS's racy window, so the token vouches for itself.
        std::thread::sleep(Duration::from_millis(2));
        let glance = self.one_shot(lib, "glance", &json!({ "places": [place] }))?;
        Ok(glance["entries"][0]["token"].clone())
    }
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Server {
    fn start(env: &Env, lib: &Path) -> Result<Server, String> {
        let mut child = env
            .command()
            .args(["serve", "--root"])
            .arg(lib)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Server {
            child,
            stdin,
            stdout,
            next: 0,
        })
    }

    fn ask(&mut self, op: &str, request: &Value) -> Result<Value, String> {
        self.next += 1;
        let mut line = request.clone();
        line["id"] = json!(self.next);
        line["op"] = json!(op);
        let mut text = line.to_string();
        text.push('\n');
        self.stdin
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        loop {
            let mut line = String::new();
            self.stdout
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            let answer: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if answer.get("progress").is_none() {
                return Ok(answer);
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn build_fixtures(env: &Env, lib: &Path, outside: &Path) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    std::fs::create_dir(lib.join("files")).map_err(io)?;
    // Bytes that do not repeat, so nothing below the hash can shortcut them.
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let ten_mb: Vec<u8> = (0..TEN_MB)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect();
    std::fs::write(lib.join("files/ten-mb.bin"), ten_mb).map_err(io)?;
    let small = outside.join("small");
    std::fs::create_dir_all(small.join("notes")).map_err(io)?;
    for i in 0..SMALL_FILES {
        let path = if i % 2 == 0 {
            small.join(format!("page-{i:04}.md"))
        } else {
            small.join(format!("notes/note-{i:04}.md"))
        };
        std::fs::write(path, format!("# page {i}\n\n{}\n", "text ".repeat(100))).map_err(io)?;
    }
    let big = lib.join("big");
    std::fs::create_dir(&big).map_err(io)?;
    for i in 0..BIG_DIR {
        std::fs::write(big.join(format!("entry-{i:05}.txt")), b"").map_err(io)?;
    }
    for d in 0..PLACE_DIRS {
        let dir = lib.join(format!("places/d{d:03}"));
        std::fs::create_dir_all(&dir).map_err(io)?;
        for f in 0..PLACES_PER_DIR {
            std::fs::write(dir.join(format!("file-{f:03}.md")), b"# a note\n").map_err(io)?;
        }
    }
    // The dated layout README.md describes, spread over many past days.
    let facts = lib.join(".pneuma-base/bench/facts");
    let first_day_ms: i64 = 1_779_000_000_000;
    for day in 0..FACT_DAYS {
        let ms = first_day_ms + day as i64 * 86_400_000;
        let (date, stamp) = day_and_stamp(ms);
        let dir = facts.join(&date);
        std::fs::create_dir_all(&dir).map_err(io)?;
        for file in 0..FILES_PER_DAY {
            let mut text = String::new();
            for n in 0..FACTS_PER_FILE {
                text.push_str(
                    &json!({ "kind": "bench", "day": day, "file": file, "n": n }).to_string(),
                );
                text.push('\n');
            }
            let name = format!("{stamp}-benchwriter0-{file:06}.jsonl");
            std::fs::write(dir.join(name), text).map_err(io)?;
        }
    }
    for batch in 0..ROWS / 5_000 {
        let rows: Vec<Value> = (batch * 5_000..(batch + 1) * 5_000)
            .map(|i| json!({ "key": format!("item-{i:05}"), "fields": { "group": format!("g{}", i % 10) }, "value": { "i": i } }))
            .collect();
        let answer = env.one_shot(
            lib,
            "rows.put",
            &json!({ "place": "bench", "table": "items", "rows": rows }),
        )?;
        if answer["outcome"] != "done" {
            return Err(format!("rows.put: {answer}"));
        }
    }
    Ok(())
}

/// Reads the whole fact log once to get a cursor at its end, the way a kernel would.
fn facts_end_cursor(env: &Env, lib: &Path) -> Result<Value, String> {
    let (cursor, seen) = read_all_facts(env, lib, "bench")?;
    let expected = FACT_DAYS * FILES_PER_DAY * FACTS_PER_FILE;
    if seen != expected {
        return Err(format!("read {seen} facts, expected {expected}"));
    }
    Ok(cursor)
}

fn facts_end_cursor_of(env: &Env, lib: &Path, place: &str) -> Result<Value, String> {
    Ok(read_all_facts(env, lib, place)?.0)
}

fn read_all_facts(env: &Env, lib: &Path, place: &str) -> Result<(Value, usize), String> {
    let mut cursor = Value::Null;
    let mut seen = 0;
    loop {
        let answer = env.one_shot(
            lib,
            "facts.since",
            &json!({ "place": place, "cursor": cursor, "limit": 10_000 }),
        )?;
        if answer["outcome"] != "done" {
            return Err(format!("facts.since: {answer}"));
        }
        seen += answer["facts"].as_array().map_or(0, Vec::len);
        cursor = answer["cursor"].clone();
        if answer["more"] != true {
            return Ok((cursor, seen));
        }
    }
}

/// Two `changed` cursors: one after which nothing changes, and one after which 1,000 files
/// are made. The journal numbers a change when it delivers it, which can trail a burst of
/// 100,000 file creations by seconds: first wait until a cursor sees nothing more arrive.
fn change_cursors(env: &Env, lib: &Path) -> Result<(Value, Value), String> {
    let changed = |cursor: &Value| {
        env.one_shot(
            lib,
            "changed",
            &json!({ "cursor": cursor, "limit": 10_000 }),
        )
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let cursor = env.one_shot(lib, "changed", &json!({}))?["cursor"].clone();
        std::thread::sleep(Duration::from_millis(1_000));
        let answer = changed(&cursor)?;
        if answer["places"].as_array().is_some_and(Vec::is_empty) {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("the library never went quiet: {answer}"));
        }
    }
    let busy = env.one_shot(lib, "changed", &json!({}))?["cursor"].clone();
    let churn = lib.join("churn");
    std::fs::create_dir(&churn).map_err(|e| e.to_string())?;
    for i in 0..CHANGES {
        std::fs::write(churn.join(format!("change-{i:04}.txt")), b"x")
            .map_err(|e| e.to_string())?;
    }
    loop {
        let answer = changed(&busy)?;
        if answer["places"]
            .as_array()
            .is_some_and(|p| p.len() >= CHANGES)
        {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("changed never saw the 1,000 changes: {answer}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Taken after the churn, so nothing changes after it.
    let quiet = env.one_shot(lib, "changed", &json!({}))?["cursor"].clone();
    std::thread::sleep(Duration::from_millis(1_000));
    Ok((quiet, busy))
}

fn day_and_stamp(ms: i64) -> (String, String) {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let of_day = secs.rem_euclid(86_400);
    let (h, mi, s) = (of_day / 3_600, of_day % 3_600 / 60, of_day % 60);
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!(
            "{y:04}{m:02}{d:02}{h:02}{mi:02}{s:02}{:03}",
            ms.rem_euclid(1_000)
        ),
    )
}
