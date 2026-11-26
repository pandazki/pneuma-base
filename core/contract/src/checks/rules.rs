//! Section 2: the rules every provider keeps (2.9 has its own modules: `concurrency`,
//! `interruption`).

use std::fs;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub fn overview_lists_one_level(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a/b/c.txt", "c");
    lib.write("a/d.txt", "d");
    let answer = lib.run("overview", json!({ "place": "a" }));
    assert_eq!(
        places_of(&answer["entries"]),
        ["a/b", "a/d.txt"],
        "{answer}"
    );
    Ok(())
}

pub fn listing_stops_at_the_limit_and_says_at_least(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..30 {
        lib.write(&format!("many/f{i:02}"), "");
    }
    let answer = lib.run("overview", json!({ "place": "many", "limit": 10 }));
    assert_eq!(answer["entries"].as_array().unwrap().len(), 10, "{answer}");
    let at_least = answer["more"]["at_least"].as_u64().unwrap();
    assert!(
        (1..=20).contains(&at_least),
        "at least {at_least} of the 20 that follow"
    );
    assert!(answer["more"]["after"].is_string(), "{answer}");
    Ok(())
}

pub fn probe_stops_at_the_budget(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..30 {
        lib.write(&format!("many/f{i:02}"), "x");
    }
    let answer = lib.run("probe", json!({ "place": "many", "budget": 10 }));
    assert_eq!(answer["exceeded"], true, "{answer}");
    assert_eq!(
        answer["files"].as_u64().unwrap() + answer["dirs"].as_u64().unwrap(),
        10,
        "{answer}"
    );
    Ok(())
}

pub fn count_stops_at_its_cap(env: &Env) -> Outcome {
    let lib = env.lib();
    let rows: Vec<Value> = (0..15)
        .map(|i| json!({ "key": format!("k{i:02}"), "fields": { "kind": "x" }, "value": i }))
        .collect();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": rows }),
    );
    let capped = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "kind", "value": "x", "count": true, "limit": 10 }),
    );
    assert_eq!(capped["count"], 10, "{capped}");
    assert_eq!(capped["exceeded"], true, "{capped}");
    let whole = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "kind", "value": "x", "count": true }),
    );
    assert_eq!(whole["count"], 15, "{whole}");
    assert_eq!(whole["exceeded"], false, "{whole}");
    Ok(())
}

pub fn look_at_a_dir_does_not_descend(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a/b/c.txt", "short");
    let token = lib.token("a");
    lib.write("a/b/c.txt", "a much longer content than before");
    let answer = lib.look_one("a", &token);
    assert_eq!(answer["same"], 1, "{answer}");
    Ok(())
}

/// Description operations work from metadata alone: an unreadable file is still described. The
/// operations that read bytes cannot read it.
pub fn metadata_operations_do_not_read_bytes(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("box/secret.txt", "12345");
    let token = lib.token("box/secret.txt");
    let Some(_locked) = Locked::new(lib.at("box/secret.txt")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let entry = lib.glance_one("box/secret.txt");
    assert_eq!(entry["kind"], "file", "{entry}");
    assert_eq!(entry["size"], 5, "{entry}");
    let listed = lib.run("overview", json!({ "place": "box" }));
    assert_eq!(places_of(&listed["entries"]), ["box/secret.txt"]);
    assert_eq!(lib.run("probe", json!({ "place": "box" }))["bytes"], 5);
    // chmod moved the change time, so the place changed; it was still described from metadata.
    let looked = lib.look_one("box/secret.txt", &token);
    assert_eq!(looked["changed"][0]["entry"]["size"], 5, "{looked}");
    for op in ["content", "read"] {
        let answer = lib.run(op, json!({ "place": "box/secret.txt" }));
        assert_failed(&answer, "unreadable");
        assert!(
            answer["detail"].as_str().is_some_and(|d| !d.is_empty()),
            "{op}: the system's reason: {answer}"
        );
    }
    Ok(())
}

pub fn read_and_content_carry_the_token_they_read(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "version one");
    lib.write("d/a.txt", "a");
    lib.token("f.txt");
    lib.token("d");
    let read = lib.run("read", json!({ "place": "f.txt" }));
    let content = lib.run("content", json!({ "place": "f.txt" }));
    let dir = lib.run("content", json!({ "place": "d" }));
    for (answer, place) in [(&read, "f.txt"), (&content, "f.txt"), (&dir, "d")] {
        let token = answer["token"]
            .as_str()
            .unwrap_or_else(|| panic!("a token: {answer}"));
        assert!(lib.same(place, token), "{place}: {answer}");
    }
    lib.write("f.txt", "version two, longer");
    lib.write("d/b.txt", "b");
    for (answer, place) in [(&read, "f.txt"), (&content, "f.txt"), (&dir, "d")] {
        let token = answer["token"].as_str().unwrap();
        let looked = lib.look_one(place, token);
        assert_eq!(looked["changed"][0]["place"], place, "{looked}");
    }
    Ok(())
}

pub fn noise_places_answer_noise(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("node_modules/x.js", "x");
    lib.write("notes/.git/HEAD", "ref");
    lib.write("docs/tmp/scratch.md", "x");
    lib.write("plain.txt", "p");
    lib.run("noise.add", json!({ "paths": ["docs/tmp"] }));
    let token = lib.token("plain.txt");
    let src = scratch();
    let source = src.path().join("s.txt");
    fs::write(&source, "s").unwrap();
    for place in [
        "node_modules",
        "node_modules/x.js",
        "node_modules/new.js",
        "notes/.git",
        "notes/.git/HEAD",
        "docs/tmp",
        "docs/tmp/scratch.md",
    ] {
        assert_eq!(lib.glance_one(place)["reason"], "noise", "glance {place}");
        let looked = lib.look_one(place, &token);
        assert_eq!(
            looked["failed"][0]["reason"], "noise",
            "look {place}: {looked}"
        );
        for (op, request) in [
            ("overview", json!({ "place": place })),
            ("probe", json!({ "place": place })),
            ("content", json!({ "place": place })),
            ("read", json!({ "place": place })),
            ("hold", json!({ "place": place })),
            (
                "write",
                json!({ "place": place, "from": source, "expect": "empty" }),
            ),
            ("remove", json!({ "place": place, "expect": token })),
            (
                "move",
                json!({ "from": place, "to": "elsewhere", "expect": { "from": token, "to": "empty" } }),
            ),
            (
                "move",
                json!({ "from": "plain.txt", "to": place, "expect": { "from": token, "to": "empty" } }),
            ),
        ] {
            assert_failed(&lib.run(op, request), "noise");
        }
    }
    assert!(
        lib.same("plain.txt", &token),
        "a refused move left plain.txt alone"
    );
    Ok(())
}

pub fn noise_is_neither_listed_nor_entered(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("app/src/main.rs", "fn main() {}");
    for i in 0..20 {
        lib.write(&format!("app/node_modules/pkg{i}/index.js"), "x");
    }
    let probed = lib.run("probe", json!({ "place": "app" }));
    assert_eq!(probed["files"], 1, "{probed}");
    assert_eq!(probed["dirs"], 1, "{probed}");
    let listed = lib.run("overview", json!({ "place": "app" }));
    assert_eq!(places_of(&listed["entries"]), ["app/src"]);
    let content = lib.run("content", json!({ "place": "app" }));
    assert_eq!(content["files"], 1, "{content}");
    Ok(())
}

/// The local-folder layout keeps caches in `.pneuma-base/cache`; a provider without one there has
/// nothing this check can delete.
fn cache_area(lib: &Lib) -> Option<std::path::PathBuf> {
    let cache = lib.at(".pneuma-base/cache");
    cache.is_dir().then_some(cache)
}

pub const NO_CACHE_AREA: &str =
    "no cache area where the local-folder layout puts it (.pneuma-base/cache)";

/// Pages through `place` with `limit`, handing back `more.after` as given.
fn pages(lib: &Lib, place: &str, limit: u64) -> Vec<Value> {
    let mut answers = Vec::new();
    let mut after = Value::Null;
    loop {
        let mut request = json!({ "place": place, "limit": limit });
        if !after.is_null() {
            request["after"] = after.clone();
        }
        let answer = lib.run("overview", request);
        assert_done(&answer);
        after = answer["more"]["after"].clone();
        answers.push(answer);
        if after.is_null() {
            return answers;
        }
    }
}

pub fn deleting_the_cache_area_changes_no_answer(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..1_500 {
        lib.write(&format!("big/e{i:04}"), "");
    }
    set_mtime(&lib.at("big"), an_hour_ago());
    let first = pages(&lib, "big", 300);
    let Some(cache) = cache_area(&lib) else {
        return not_exercised(NO_CACHE_AREA);
    };
    if walk_files(&cache).is_empty() {
        return not_exercised("the provider cached nothing for a 1,500-entry listing");
    }
    assert_eq!(pages(&lib, "big", 300), first);
    fs::remove_dir_all(&cache).unwrap();
    assert_eq!(pages(&lib, "big", 300), first);
    Ok(())
}

pub fn a_changed_directory_is_listed_again(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..1_500 {
        lib.write(&format!("big/e{i:04}"), "");
    }
    set_mtime(&lib.at("big"), an_hour_ago());
    let all = |lib: &Lib| -> Vec<String> {
        pages(lib, "big", 1_000)
            .iter()
            .flat_map(|page| places_of(&page["entries"]))
            .collect()
    };
    let before = all(&lib);
    assert_eq!(before.len(), 1_500);
    lib.write("big/zz-new", "");
    fs::remove_file(lib.at("big/e1499")).unwrap();
    let after = all(&lib);
    assert!(after.contains(&"big/zz-new".to_owned()));
    assert!(!after.contains(&"big/e1499".to_owned()));
    assert_eq!(after.len(), 1_500);
    Ok(())
}

pub fn every_answer_is_a_json_object_with_a_fixed_reason(env: &Env) -> Outcome {
    let lib = env.lib();
    let root = lib.root_arg();
    let missing = lib.at("not-there");
    let missing = missing.to_str().unwrap();
    let cases: Vec<(Vec<&str>, Option<&str>, i32)> = vec![
        (vec!["no.such.op", "--root", &root], None, 2),
        (vec!["glance"], None, 2),
        (vec!["glance", "--root", missing], None, 2),
        (vec!["glance", "--root", &root, "{not json"], None, 0),
        (vec!["glance", "--root", &root, "[1,2]"], None, 0),
        (
            vec!["glance", "--root", &root, "-"],
            Some("{\"places\": 7}"),
            0,
        ),
        (
            vec!["overview", "--root", &root, "{\"place\":\"nope\"}"],
            None,
            0,
        ),
        (
            vec!["facts.since", "--root", &root, "{\"place\":\"Bad Name\"}"],
            None,
            0,
        ),
        (
            vec![
                "facts.since",
                "--root",
                &root,
                "{\"place\":\"p\",\"cursor\":\"not a cursor\"}",
            ],
            None,
            0,
        ),
        (
            vec![
                "rows.under",
                "--root",
                &root,
                "{\"place\":\"p\",\"table\":\"t\",\"limit\":0}",
            ],
            None,
            0,
        ),
        (
            vec!["read", "--root", &root, "{\"place\":\"nope\"}"],
            None,
            0,
        ),
        (vec!["write", "--root", &root, "{\"place\":\"x\"}"], None, 0),
        (vec!["changed", "--root", &root, "{\"limit\":0}"], None, 0),
    ];
    for (args, stdin, code) in cases {
        // The harness holds each answer to 2.10 and 8: an object, a fixed reason, no sentence.
        let (answer, exit) = call_args(lib.provider(), &args, stdin);
        assert_eq!(exit, code, "{args:?}: {answer}");
        assert_eq!(answer["outcome"], "failed", "{args:?}: {answer}");
    }
    let mut serve = lib.serve();
    serve.send("this is not json");
    assert_eq!(
        serve.receive(),
        json!({ "id": null, "outcome": "failed", "reason": "bad_request" })
    );
    assert_eq!(serve.finish(), 0);
    Ok(())
}
