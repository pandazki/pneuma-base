//! The preamble and section 1: the program, its versions, and the words.

use std::fs;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub fn describe_names_contract_1_and_addresses(env: &Env) -> Outcome {
    let describe = &env.describe;
    assert_eq!(describe["outcome"], "done", "describe: {describe}");
    assert_eq!(describe["contract"], 1, "{describe}");
    let addresses = describe["addresses"]
        .as_array()
        .unwrap_or_else(|| panic!("addresses: {describe}"));
    assert!(!addresses.is_empty(), "{describe}");
    assert!(
        addresses
            .iter()
            .all(|a| a.as_str().is_some_and(|a| !a.is_empty()))
    );
    Ok(())
}

/// Every operation `describe` lists runs as one subcommand that answers one JSON object.
pub fn every_op_is_a_subcommand(env: &Env) -> Outcome {
    let lib = env.lib();
    let ops = strings_of(&env.describe["ops"]);
    for op in OPS {
        assert!(ops.iter().any(|o| o == op), "describe does not list {op}");
    }
    for op in &ops {
        // The answer is checked against 2.10 and 8 by the harness; any outcome will do.
        let answer = lib.run(op, json!({}));
        assert!(answer.is_object(), "{op}: {answer}");
    }
    Ok(())
}

pub fn serve_answers_like_one_shot(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("notes/a.md", "alpha");
    lib.write("notes/b.md", "beta");
    let token = lib.token("notes/a.md");
    // Answers about unchanged places agree once their last change has settled.
    for place in ["", "notes", "notes/b.md"] {
        lib.token(place);
    }
    let mut serve = lib.serve();
    for (op, request) in [
        (
            "glance",
            json!({ "places": ["notes", "notes/a.md", "missing"] }),
        ),
        ("overview", json!({ "place": "notes" })),
        ("probe", json!({ "place": "" })),
        (
            "look",
            json!({ "places": [{ "place": "notes/a.md", "token": token }] }),
        ),
        ("content", json!({ "place": "notes" })),
        ("read", json!({ "place": "notes/b.md" })),
        ("noise.list", json!({})),
        (
            "rows.get",
            json!({ "place": "p", "table": "t", "keys": ["k"] }),
        ),
    ] {
        let one = lib.run(op, request.clone());
        let served = serve.ask(json!(op), op, request);
        assert_eq!(served, one, "{op}");
    }
    assert_eq!(serve.finish(), 0);
    Ok(())
}

pub fn malformed_places_are_bad_requests(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("ok.txt", "x");
    let token = lib.token("ok.txt");
    let src = scratch();
    let source = src.path().join("s.txt");
    fs::write(&source, "s").unwrap();
    for bad in ["/a", "a/", "a//b", ".", "a/./b", "..", "a/../b"] {
        assert_failed(&lib.run("overview", json!({ "place": bad })), "bad_request");
        assert_failed(&lib.run("probe", json!({ "place": bad })), "bad_request");
        assert_failed(&lib.run("content", json!({ "place": bad })), "bad_request");
        assert_failed(&lib.run("read", json!({ "place": bad })), "bad_request");
        assert_failed(&lib.run("hold", json!({ "place": bad })), "bad_request");
        assert_failed(
            &lib.run(
                "write",
                json!({ "place": bad, "from": source, "expect": "empty" }),
            ),
            "bad_request",
        );
        assert_failed(
            &lib.run("remove", json!({ "place": bad, "expect": token })),
            "bad_request",
        );
        let entry = lib.glance_one(bad);
        assert_eq!(entry["place"], bad);
        assert_eq!(entry["reason"], "bad_request", "{entry}");
        let looked = lib.look_one(bad, &token);
        assert_eq!(looked["failed"][0]["reason"], "bad_request", "{looked}");
    }
    Ok(())
}

pub fn kinds_are_file_dir_other_none(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "x");
    lib.mkdir("d");
    std::os::unix::fs::symlink("f.txt", lib.at("link")).unwrap();
    let fifo = std::ffi::CString::new(lib.at("pipe").to_str().unwrap()).unwrap();
    // SAFETY: makes a named pipe at a path in the temporary library.
    let made_fifo = unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) } == 0;
    let answer = lib.run(
        "glance",
        json!({ "places": ["f.txt", "d", "link", "pipe", "missing"] }),
    );
    let kinds: Vec<&Value> = answer["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["kind"])
        .collect();
    assert_eq!(kinds[0], "file", "{answer}");
    assert_eq!(kinds[1], "dir", "{answer}");
    assert_eq!(kinds[2], "other", "{answer}");
    if made_fifo {
        assert_eq!(kinds[3], "other", "{answer}");
    }
    assert_eq!(kinds[4], "none", "{answer}");
    // The library does not take them for things: a listing shows them as `other`, nothing more.
    let listed = lib.run("overview", json!({ "place": "" }));
    for entry in listed["entries"].as_array().unwrap() {
        if entry["place"] == "link" {
            assert_eq!(entry["kind"], "other");
        }
    }
    Ok(())
}

/// The record half is not in the content half, and the content half is not in the records.
pub fn the_two_halves_do_not_mix(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a.txt", "a");
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    lib.run(
        "rows.put",
        json!({ "place": "log", "table": "t", "rows": [{ "key": "k", "value": 1 }] }),
    );
    let root = lib.run("overview", json!({ "place": "" }));
    assert_eq!(places_of(&root["entries"]), ["a.txt"], "{root}");
    let probed = lib.run("probe", json!({ "place": "" }));
    assert_eq!(
        (probed["files"].clone(), probed["dirs"].clone()),
        (json!(1), json!(0))
    );
    let src = scratch();
    fs::write(src.path().join("b.txt"), "b").unwrap();
    lib.run(
        "write",
        json!({ "place": "b.txt", "from": src.path().join("b.txt"), "expect": "empty" }),
    );
    assert_eq!(all_facts(&lib, "log"), [json!({ "n": 1 })]);
    Ok(())
}

pub fn a_token_handed_back_is_the_same(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "x");
    lib.mkdir("d");
    for place in ["f.txt", "d", ""] {
        let token = lib.token(place);
        assert!(!token.is_empty());
        assert!(lib.same(place, &token), "{place}: {token}");
    }
    Ok(())
}

pub fn cursors_are_text(env: &Env) -> Outcome {
    let lib = env.lib();
    let changed = lib.run("changed", json!({}));
    assert_done(&changed);
    assert!(
        changed["cursor"].as_str().is_some_and(|c| !c.is_empty()),
        "{changed}"
    );
    let since = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert!(
        since["cursor"].as_str().is_some_and(|c| !c.is_empty()),
        "{since}"
    );
    Ok(())
}

pub fn record_places_are_separate(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": "a", "facts": [{ "in": "a" }] }),
    );
    lib.run(
        "facts.append",
        json!({ "place": "b", "facts": [{ "in": "b" }] }),
    );
    assert_eq!(all_facts(&lib, "a"), [json!({ "in": "a" })]);
    assert_eq!(all_facts(&lib, "b"), [json!({ "in": "b" })]);
    let put = |place: &str, value: i64, cursor: &str| {
        lib.run(
            "rows.put",
            json!({ "place": place, "table": "t", "rows": [{ "key": "k", "value": value }], "cursor": cursor }),
        )
    };
    put("a", 1, "ca");
    put("b", 2, "cb");
    lib.run("rows.reset", json!({ "place": "a" }));
    let a = lib.run(
        "rows.get",
        json!({ "place": "a", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(a["rows"], json!([]), "{a}");
    let b = lib.run(
        "rows.get",
        json!({ "place": "b", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(b["rows"][0]["value"], 2, "{b}");
    assert_eq!(b["cursor"], "cb", "{b}");
    Ok(())
}

pub fn rows_are_overwritten_and_queried(env: &Env) -> Outcome {
    let lib = env.lib();
    for value in ["first", "second"] {
        lib.run(
            "rows.put",
            json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "fields": { "state": value }, "value": value }] }),
        );
    }
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(got["rows"][0]["value"], "second", "{got}");
    let first = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "state", "value": "first" }),
    );
    assert_eq!(first["rows"], json!([]), "{first}");
    let second = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "state", "value": "second" }),
    );
    assert_eq!(second["rows"][0]["key"], "k", "{second}");
    Ok(())
}

/// A `macos` facet next to `fs` on one place, when the provider gives both: more than one source.
pub fn a_place_has_facets_from_sources(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "x");
    let wanted: Vec<Value> = env.describe["facets"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let entry =
        lib.run("glance", json!({ "places": ["f.txt"], "facets": wanted }))["entries"][0].clone();
    let facets = entry["facets"]
        .as_object()
        .unwrap_or_else(|| panic!("facets: {entry}"));
    for (name, facet) in facets {
        assert!(facet.is_object(), "{name}: {facet}");
    }
    if !env.facet("macos") || !super::local::set_macos_attributes(&lib.at("f.txt")) {
        return if facets.is_empty() {
            not_exercised("no facet given for a plain file")
        } else {
            Ok(())
        };
    }
    let entry = lib.run(
        "glance",
        json!({ "places": ["f.txt"], "facets": ["macos"] }),
    )["entries"][0]
        .clone();
    let names: Vec<&String> = entry["facets"].as_object().unwrap().keys().collect();
    assert!(names.len() >= 2, "two sources, two facets: {entry}");
    Ok(())
}
