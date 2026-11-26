//! Times the real `pneuma-base-core` binary against the storage targets (architecture 9.3), one
//! process per operation and through `serve`. Builds its fixtures in its own temporary folder.
//! Always exits 0: it reports, it does not gate.

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

fn main() {
    if let Err(problem) = run() {
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

struct Case {
    name: &'static str,
    target_ms: Option<f64>,
    op: &'static str,
    request: Value,
    /// Says whether an answer did the work the case is about.
    check: fn(&Value) -> bool,
    /// Run before each timed run (outside the timing).
    before: Option<Box<dyn Fn()>>,
}

fn run() -> Result<(), String> {
    let bin = binary()?;
    let temp = tempfile::Builder::new()
        .prefix("pneuma-base-bench.")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let lib = temp.path().join("lib");
    std::fs::create_dir(&lib).map_err(|e| e.to_string())?;
    let t = Instant::now();
    one_shot(&bin, &lib, "init", &json!({}))?;
    build_fixtures(&bin, &lib)?;
    println!(
        "fixtures: {BIG_DIR}-entry directory, {} places, {} facts over {FACT_DAYS} days, {ROWS} rows ({:.1} s)",
        PLACE_DIRS * PLACES_PER_DIR,
        FACT_DAYS * FILES_PER_DAY * FACTS_PER_FILE,
        t.elapsed().as_secs_f64()
    );

    let places: Vec<String> = (0..PLACE_DIRS)
        .flat_map(|d| (0..PLACES_PER_DIR).map(move |f| format!("places/d{d:03}/file-{f:03}.md")))
        .collect();
    let glance = one_shot(&bin, &lib, "glance", &json!({ "places": places }))?;
    let look_places: Vec<Value> = glance["entries"]
        .as_array()
        .ok_or("glance gave no entries")?
        .iter()
        .map(|e| json!({ "place": e["place"], "token": e["token"] }))
        .collect();
    let cursor = facts_end_cursor(&bin, &lib)?;

    // Directories changed in the last 2 s are not trusted to be settled; let the fixture age.
    std::thread::sleep(Duration::from_millis(2_100));

    let names_cache = lib.join(".pneuma-base/cache/names");
    let cases = vec![
        Case {
            name: "glance, 1 place",
            target_ms: Some(5.0),
            op: "glance",
            request: json!({ "places": ["places/d050/file-100.md"] }),
            check: |a| a["entries"][0]["kind"] == "file",
            before: None,
        },
        Case {
            name: "rows.get, 1 key of 20,000",
            target_ms: Some(5.0),
            op: "rows.get",
            request: json!({ "place": "bench", "table": "items", "keys": ["item-10000"] }),
            check: |a| a["rows"].as_array().is_some_and(|r| r.len() == 1),
            before: None,
        },
        Case {
            name: "overview, 60,000 entries, limit 200 (warm)",
            target_ms: Some(10.0),
            op: "overview",
            request: json!({ "place": "big", "limit": 200 }),
            check: |a| {
                a["entries"].as_array().is_some_and(|e| e.len() == 200) && a["total"] == BIG_DIR
            },
            before: None,
        },
        Case {
            name: "overview, 60,000 entries, limit 200 (cold: no cache)",
            target_ms: None,
            op: "overview",
            request: json!({ "place": "big", "limit": 200 }),
            check: |a| a["entries"].as_array().is_some_and(|e| e.len() == 200),
            before: Some(Box::new(move || {
                let _ = std::fs::remove_dir_all(&names_cache);
            })),
        },
        Case {
            name: "probe, budget 500",
            target_ms: Some(10.0),
            op: "probe",
            request: json!({ "place": "places", "budget": 500 }),
            check: |a| a["exceeded"] == true && a["dirs"].as_u64().is_some_and(|d| d > 0),
            before: None,
        },
        Case {
            name: "probe, budget 500, inside the 60,000",
            target_ms: Some(10.0),
            op: "probe",
            request: json!({ "place": "big", "budget": 500 }),
            check: |a| a["exceeded"] == true && a["files"] == 500,
            before: None,
        },
        Case {
            name: "look, 20,000 places, all same",
            target_ms: Some(50.0),
            op: "look",
            request: json!({ "places": look_places }),
            check: |a| a["same"] == PLACE_DIRS * PLACES_PER_DIR,
            before: None,
        },
        Case {
            name: "facts.since, nothing new, 100,000 facts",
            target_ms: Some(5.0),
            op: "facts.since",
            request: json!({ "place": "bench", "cursor": cursor }),
            check: |a| a["facts"].as_array().is_some_and(Vec::is_empty) && a["more"] == false,
            before: None,
        },
    ];

    let mut server = Server::start(&bin, &lib)?;
    println!();
    println!(
        "{:<52} {:>8} {:>11} {:>9}  result",
        "operation", "target", "one-shot", "serve"
    );
    for case in &cases {
        let shot = median(RUNS, || {
            if let Some(before) = &case.before {
                before();
            }
            let started = Instant::now();
            let answer = one_shot(&bin, &lib, case.op, &case.request)?;
            let elapsed = started.elapsed();
            verify(case, &answer)?;
            Ok(elapsed)
        });
        let served = median(RUNS, || {
            if let Some(before) = &case.before {
                before();
            }
            let started = Instant::now();
            let answer = server.ask(case.op, &case.request)?;
            let elapsed = started.elapsed();
            verify(case, &answer)?;
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

fn verify(case: &Case, answer: &Value) -> Result<(), String> {
    if answer["outcome"] == "done" && (case.check)(answer) {
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

fn one_shot(bin: &Path, lib: &Path, op: &str, request: &Value) -> Result<Value, String> {
    let mut child = Command::new(bin)
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

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Server {
    fn start(bin: &Path, lib: &Path) -> Result<Server, String> {
        let mut child = Command::new(bin)
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
        let mut answer = String::new();
        self.stdout
            .read_line(&mut answer)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&answer).map_err(|e| e.to_string())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn build_fixtures(bin: &Path, lib: &Path) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
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
        let answer = one_shot(
            bin,
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
fn facts_end_cursor(bin: &Path, lib: &Path) -> Result<Value, String> {
    let mut cursor = Value::Null;
    let mut seen = 0;
    loop {
        let answer = one_shot(
            bin,
            lib,
            "facts.since",
            &json!({ "place": "bench", "cursor": cursor, "limit": 10_000 }),
        )?;
        seen += answer["facts"].as_array().map_or(0, Vec::len);
        cursor = answer["cursor"].clone();
        if answer["more"] != true {
            break;
        }
    }
    let expected = FACT_DAYS * FILES_PER_DAY * FACTS_PER_FILE;
    if seen != expected {
        return Err(format!("read {seen} facts, expected {expected}"));
    }
    Ok(cursor)
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
