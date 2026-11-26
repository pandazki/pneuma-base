//! Rule 2.9, second half: a write either happens or is as if it never was. Each check kills a
//! provider process (SIGKILL) inside a write, then shows the place is whole (before or after,
//! never between) and that the next write to it behaves as if the killed one never happened.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

const NO_PROGRESS: &str = "the operation answered before any progress line to kill it on";

/// Writes a large directory in `serve` and kills the process on its first progress line. `None`
/// when it answered first.
fn kill_on_first_progress(lib: &Lib, op: &str, request: Value) -> Option<()> {
    let mut serve = lib.serve();
    let id = json!("k");
    serve.request(id.clone(), op, request);
    let killed = serve.first_progress(&id).map(|_| ());
    serve.kill();
    killed
}

/// What the library's root lists, so leftovers of a killed write would show.
fn root_names(lib: &Lib) -> Vec<String> {
    places_of(&lib.run("overview", json!({ "place": "" }))["entries"])
}

pub fn a_killed_directory_write_leaves_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    many_files(src.path(), 4_000, 1);
    let whole = lib.run(
        "write",
        json!({ "place": "control", "from": src.path(), "expect": "empty" }),
    );
    let request = json!({ "place": "copy", "from": src.path(), "expect": "empty" });
    if kill_on_first_progress(&lib, "write", request.clone()).is_none() {
        return not_exercised(NO_PROGRESS);
    }
    match lib.glance_one("copy")["kind"].as_str() {
        Some("none") => {
            assert_eq!(
                root_names(&lib),
                ["control"],
                "nothing half-written is listed"
            );
            let again = lib.run("write", request);
            assert_done(&again);
            assert_eq!(again["fingerprint"], whole["fingerprint"]);
        }
        Some("dir") => assert_eq!(lib.fingerprint("copy"), whole["fingerprint"], "whole"),
        other => panic!("copy is {other:?}"),
    }
    Ok(())
}

pub fn a_killed_directory_replacement_keeps_the_old(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("tree/old.txt", "old");
    let old_fingerprint = lib.fingerprint("tree");
    let token = lib.token("tree");
    let src = scratch();
    many_files(src.path(), 4_000, 2);
    let request = json!({ "place": "tree", "from": src.path(), "expect": token });
    if kill_on_first_progress(&lib, "write", request.clone()).is_none() {
        return not_exercised(NO_PROGRESS);
    }
    if lib.same("tree", &token) {
        assert_eq!(
            lib.fingerprint("tree"),
            old_fingerprint,
            "the old one, whole"
        );
        let again = lib.run("write", request);
        assert_done(&again);
        assert_eq!(lib.fingerprint("tree"), again["fingerprint"]);
    } else {
        assert_eq!(
            lib.run("content", json!({ "place": "tree" }))["files"],
            4_000,
            "the new one, whole"
        );
    }
    assert_eq!(root_names(&lib), ["tree"]);
    Ok(())
}

pub fn a_killed_stdin_write_leaves_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("old.bin", "old bytes");
    let token = lib.token("old.bin");
    let chunk = bytes_of(256 * 1024, 4);
    for (place, expect) in [("new.bin", json!("empty")), ("old.bin", json!(token))] {
        let request = json!({ "place": place, "from": "-", "expect": expect });
        let mut running = lib.start_open("write", &request);
        for _ in 0..8 {
            running.stdin().write_all(&chunk).unwrap();
        }
        running.stdin().flush().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        // Standard input is still open: the write cannot have finished.
        running.kill();
        if place == "new.bin" {
            assert_eq!(
                lib.glance_one(place)["kind"],
                "none",
                "nothing half-written"
            );
        } else {
            assert!(lib.same(place, &token), "the old bytes, untouched");
            assert_eq!(fs::read(lib.at(place)).unwrap(), b"old bytes");
        }
        let bytes = bytes_of(10_000, 8);
        let again = lib.run_with_stdin("write", &request, &bytes);
        assert_done(&again);
        assert_eq!(fs::read(lib.at(place)).unwrap(), bytes);
    }
    assert_eq!(root_names(&lib), ["new.bin", "old.bin"]);
    Ok(())
}

pub fn a_killed_removal_is_whole(env: &Env) -> Outcome {
    let lib = env.lib();
    many_files(&lib.at("big"), 12_000, 3);
    let before = lib.fingerprint("big");
    let token = lib.token("big");
    if kill_on_first_progress(&lib, "remove", json!({ "place": "big", "expect": token })).is_none()
    {
        return not_exercised(NO_PROGRESS);
    }
    match lib.glance_one("big")["kind"].as_str() {
        Some("none") => {
            assert_eq!(root_names(&lib), Vec::<String>::new());
            let src = scratch();
            fs::write(src.path().join("f"), "f").unwrap();
            let again = lib.run(
                "write",
                json!({ "place": "big", "from": src.path().join("f"), "expect": "empty" }),
            );
            assert_done(&again);
        }
        Some("dir") => {
            assert_eq!(lib.fingerprint("big"), before, "untouched");
            assert_done(&lib.run("remove", json!({ "place": "big", "expect": token })));
        }
        other => panic!("big is {other:?}"),
    }
    Ok(())
}

pub fn a_killed_move_onto_a_directory_is_whole(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("from/a.txt", "the moved one");
    many_files(&lib.at("to"), 12_000, 4);
    let moved = lib.fingerprint("from");
    let replaced = lib.fingerprint("to");
    let (from, to) = (lib.token("from"), lib.token("to"));
    let request = json!({ "from": "from", "to": "to", "expect": { "from": from, "to": to } });
    if kill_on_first_progress(&lib, "move", request).is_none() {
        return not_exercised(NO_PROGRESS);
    }
    match lib.glance_one("from")["kind"].as_str() {
        Some("none") => {
            assert_eq!(lib.fingerprint("to"), moved, "after: the moved one at to");
            assert_eq!(root_names(&lib), ["to"], "the replaced one is nowhere");
            let src = scratch();
            fs::write(src.path().join("f"), "f").unwrap();
            let again = lib.run(
                "write",
                json!({ "place": "from", "from": src.path().join("f"), "expect": "empty" }),
            );
            assert_done(&again);
        }
        Some("dir") => {
            assert_eq!(lib.fingerprint("from"), moved, "before: from untouched");
            assert_eq!(lib.fingerprint("to"), replaced, "before: to untouched");
        }
        other => panic!("from is {other:?}"),
    }
    Ok(())
}

/// Times one run of `op`, so kills can land across its whole length.
fn duration_of(lib: &Lib, op: &str, request: &Value) -> Duration {
    let started = Instant::now();
    lib.start(op, request).answer();
    started.elapsed()
}

pub fn killed_moves_are_whole(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("m/probe", "p");
    let token = lib.token("m/probe");
    let whole = duration_of(
        &lib,
        "move",
        &json!({ "from": "m/probe", "to": "m/probed", "expect": { "from": token, "to": "empty" } }),
    );
    for k in 0..16u32 {
        let (from, to) = (format!("m/f{k}"), format!("m/g{k}"));
        lib.write(&from, &format!("content {k}"));
        let token = lib.token(&from);
        let running = lib.start(
            "move",
            &json!({ "from": from, "to": to, "expect": { "from": token, "to": "empty" } }),
        );
        std::thread::sleep(whole * k / 16);
        running.kill();
        let (a, b) = (
            lib.glance_one(&from)["kind"].clone(),
            lib.glance_one(&to)["kind"].clone(),
        );
        let at = match (a.as_str(), b.as_str()) {
            (Some("file"), Some("none")) => &from,
            (Some("none"), Some("file")) => &to,
            other => panic!("move {k} left {other:?}"),
        };
        assert_eq!(
            fs::read_to_string(lib.at(at)).unwrap(),
            format!("content {k}")
        );
        if at == &from {
            let again = lib.run(
                "move",
                json!({ "from": from, "to": to, "expect": { "from": lib.token(&from), "to": "empty" } }),
            );
            assert_done(&again);
        }
    }
    Ok(())
}

pub fn a_killed_append_leaves_no_half_file(env: &Env) -> Outcome {
    let lib = env.lib();
    // Large facts make writing the file a good part of an append, so kills land inside it.
    let batch_size = 200;
    let payload = "x".repeat(20_000);
    let request = |batch: u32| {
        let facts: Vec<Value> = (0..batch_size)
            .map(|n| json!({ "batch": batch, "n": n, "pad": payload }))
            .collect();
        json!({ "place": "log", "facts": facts })
    };
    let whole = duration_of(&lib, "facts.append", &request(0));
    let attempts = 16;
    for k in 1..=attempts {
        let running = lib.start("facts.append", &request(k));
        std::thread::sleep(whole * k / attempts);
        running.kill();
    }
    let mut counts: HashMap<u64, usize> = HashMap::new();
    for fact in all_facts(&lib, "log") {
        *counts.entry(fact["batch"].as_u64().unwrap()).or_default() += 1;
    }
    for (batch, count) in counts {
        assert_eq!(count, batch_size, "batch {batch} is whole or absent");
    }
    let after = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "after": true }] }),
    );
    assert_done(&after);
    Ok(())
}

pub fn a_killed_rows_put_is_whole(env: &Env) -> Outcome {
    let lib = env.lib();
    let batch_size = 3_000;
    let request = |batch: u32| {
        let rows: Vec<Value> = (0..batch_size)
            .map(|n| json!({ "key": format!("b{batch}/{n:05}"), "fields": { "batch": batch.to_string() }, "value": "x".repeat(200) }))
            .collect();
        json!({ "place": "p", "table": "t", "rows": rows, "cursor": format!("c{batch}") })
    };
    let whole = duration_of(&lib, "rows.put", &request(0));
    let attempts = 16;
    for k in 1..=attempts {
        let running = lib.start("rows.put", &request(k));
        std::thread::sleep(whole * k / attempts);
        running.kill();
    }
    let mut last = Some(0);
    for k in 1..=attempts {
        let count = lib.run(
            "rows.where",
            json!({ "place": "p", "table": "t", "field": "batch", "value": k.to_string(), "count": true }),
        )["count"]
            .as_u64()
            .unwrap();
        assert!(
            count == 0 || count == batch_size as u64,
            "batch {k}: {count} rows"
        );
        if count > 0 {
            last = Some(k);
        }
    }
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": [] }),
    );
    assert_eq!(
        got["cursor"],
        json!(last.map(|k| format!("c{k}"))),
        "the cursor of the last whole put"
    );
    assert_done(&lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [], "cursor": "after", "expect": got["cursor"] }),
    ));
    Ok(())
}

pub fn a_killed_hold_is_whole(env: &Env) -> Outcome {
    let lib = env.lib();
    let whole = duration_of(&lib, "hold", &json!({ "place": "probe", "ttl": 60_000 }));
    let src = scratch();
    fs::write(src.path().join("s"), "s").unwrap();
    for k in 0..16u32 {
        let place = format!("h{k}");
        let running = lib.start("hold", &json!({ "place": place, "ttl": 60_000 }));
        std::thread::sleep(whole * k / 16);
        running.kill();
        // Held or not, never anything else: no half-made hold confuses a later operation.
        let hold = lib.run("hold", json!({ "place": place, "ttl": 60_000 }));
        let write = lib.run(
            "write",
            json!({ "place": place, "from": src.path().join("s"), "expect": "empty" }),
        );
        match hold["outcome"].as_str() {
            Some("done") => {
                assert_failed(&write, "held");
                assert_done(&lib.run("release", json!({ "hold": hold["hold"] })));
            }
            _ => {
                assert_failed(&hold, "held");
                assert_failed(&write, "held");
            }
        }
    }
    Ok(())
}
