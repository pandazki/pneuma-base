//! A record place's own area (sections 4 and 5): every content operation can name a record place,
//! and its places are then that record place's own area, apart from the content and from the
//! record place's facts. And the sources of `write` besides a path outside the library: a place in
//! the store (a copy, either way between the content and a record place) and bytes in the request.

use std::fs;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

/// The record place these checks keep content in.
const PLUG: &str = "plug";

/// `request` with the record place named.
fn in_plug(mut request: Value) -> Value {
    request["records"] = json!(PLUG);
    request
}

/// Puts `bytes` at `place` in the record place's own area.
fn put(lib: &Lib, place: &str, bytes: &[u8]) -> Value {
    let written = lib.run(
        "write",
        in_plug(json!({ "place": place, "from": data(bytes), "expect": "empty" })),
    );
    assert_done(&written);
    written
}

fn glance_in_plug(lib: &Lib, places: &[&str]) -> Vec<Value> {
    let answer = lib.run("glance", in_plug(json!({ "places": places })));
    answer["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("{answer}"))
        .clone()
}

/// A token of a place in the record place's own area that `look` answers `same` for (as
/// `Lib::token` does for the content).
fn token_in_plug(lib: &Lib, place: &str) -> String {
    let mut token = glance_in_plug(lib, &[place])[0]["token"]
        .as_str()
        .unwrap_or_else(|| panic!("no token for {place}"))
        .to_owned();
    let deadline = std::time::Instant::now() + SETTLE;
    loop {
        let looked = lib.run(
            "look",
            in_plug(json!({ "places": [{ "place": place, "token": token }] })),
        );
        if looked["same"] == 1 {
            return token;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "look never answered same for {place}: {looked}"
        );
        token = looked["changed"][0]["entry"]["token"]
            .as_str()
            .unwrap_or_else(|| panic!("{place} is not there to settle: {looked}"))
            .to_owned();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

pub fn a_record_place_keeps_content_of_its_own(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("held/a.txt", "content side");
    let written = put(&lib, "held/a.txt", b"record side");
    assert_eq!(written["entry"]["place"], "held/a.txt", "{written}");
    assert_eq!(
        written["fingerprint"],
        sha256_hex(b"record side"),
        "{written}"
    );
    assert_eq!(
        fs::read_to_string(lib.at("held/a.txt")).unwrap(),
        "content side",
        "the same place in the content is another place"
    );
    let read = lib.run("read", in_plug(json!({ "place": "held/a.txt" })));
    assert_eq!(
        base64_decode(read["data"].as_str().unwrap_or_else(|| panic!("{read}"))),
        b"record side"
    );
    let kinds: Vec<Value> = glance_in_plug(&lib, &["", "held", "held/a.txt", "held/none"])
        .iter()
        .map(|e| e["kind"].clone())
        .collect();
    assert_eq!(
        kinds,
        [json!("dir"), json!("dir"), json!("file"), json!("none")]
    );
    let listed = lib.run("overview", in_plug(json!({ "place": "held" })));
    assert_eq!(places_of(&listed["entries"]), ["held/a.txt"], "{listed}");
    let content = lib.run("content", in_plug(json!({ "place": "held" })));
    assert_eq!(content["files"], 1, "{content}");
    let token = token_in_plug(&lib, "held/a.txt");
    let other = lib.run(
        "glance",
        json!({ "records": "other", "places": ["held/a.txt"] }),
    );
    assert_eq!(
        other["entries"][0]["kind"], "none",
        "another record place's area is another area: {other}"
    );
    if env.path_addressed() {
        assert_eq!(
            fs::read(lib.at(".pneuma-base/plug/held/a.txt")).unwrap(),
            b"record side"
        );
        // What a record place's owner kept there by hand is reachable at the same path.
        lib.write(".pneuma-base/plug/held/b.txt", "by hand");
        assert_eq!(glance_in_plug(&lib, &["held/b.txt"])[0]["kind"], "file");
    }
    let removed = lib.run(
        "remove",
        in_plug(json!({ "place": "held/a.txt", "expect": token })),
    );
    assert_done(&removed);
    assert_eq!(glance_in_plug(&lib, &["held/a.txt"])[0]["kind"], "none");
    assert_eq!(
        fs::read_to_string(lib.at("held/a.txt")).unwrap(),
        "content side"
    );
    Ok(())
}

pub fn a_record_area_has_no_noise_and_no_holds(env: &Env) -> Outcome {
    let lib = env.lib();
    put(&lib, ".git/config", b"kept");
    put(&lib, "node_modules/x.js", b"kept");
    let seen = glance_in_plug(&lib, &[".git/config", "node_modules"]);
    assert_eq!(seen[0]["kind"], "file", "{seen:?}");
    assert_eq!(seen[1]["kind"], "dir", "{seen:?}");
    let listed = lib.run("overview", in_plug(json!({ "place": "" })));
    assert_eq!(
        places_of(&listed["entries"]),
        [".git", "node_modules"],
        "{listed}"
    );
    assert_eq!(listed["noise"], json!([]), "{listed}");
    let content = lib.run("content", in_plug(json!({ "place": "" })));
    assert_eq!(content["files"], 2, "{content}");
    // A hold, even on the whole content, does not reach it.
    assert_done(&lib.run("hold", json!({ "place": "", "ttl": 60_000 })));
    put(&lib, "while-held.txt", b"x");
    let token = token_in_plug(&lib, "while-held.txt");
    let looked = lib.run(
        "look",
        in_plug(json!({ "places": [{ "place": "while-held.txt", "token": token }] })),
    );
    assert_eq!(looked["held"], json!([]), "{looked}");
    let listed = lib.run("overview", in_plug(json!({ "place": "" })));
    assert!(
        listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e.get("held").is_none()),
        "{listed}"
    );
    assert_done(&lib.run(
        "remove",
        in_plug(json!({ "place": "while-held.txt", "expect": token })),
    ));
    Ok(())
}

pub fn the_facts_of_a_record_place_are_not_in_its_area(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": PLUG, "facts": [{ "n": 1 }] }),
    );
    put(&lib, "kept.txt", b"k");
    let listed = lib.run("overview", in_plug(json!({ "place": "" })));
    assert_eq!(places_of(&listed["entries"]), ["kept.txt"], "{listed}");
    for entry in glance_in_plug(&lib, &["facts", "facts/x"]) {
        assert_eq!(entry["reason"], "outside", "{entry}");
    }
    for op in ["content", "read", "overview"] {
        assert_failed(
            &lib.run(op, in_plug(json!({ "place": "facts" }))),
            "outside",
        );
    }
    assert_failed(
        &lib.run(
            "write",
            in_plug(json!({ "place": "facts/new.txt", "from": data(b"x"), "expect": "empty" })),
        ),
        "outside",
    );
    let token = token_in_plug(&lib, "kept.txt");
    assert_failed(
        &lib.run(
            "move",
            in_plug(
                json!({ "from": "kept.txt", "to": "facts/kept.txt", "expect": { "from": token, "to": "empty" } }),
            ),
        ),
        "outside",
    );
    assert_failed(
        &lib.run(
            "remove",
            in_plug(json!({ "place": "facts", "expect": token })),
        ),
        "outside",
    );
    let looked = lib.run(
        "look",
        in_plug(json!({ "places": [{ "place": "facts", "token": token }] })),
    );
    assert_eq!(looked["failed"][0]["reason"], "outside", "{looked}");
    assert_eq!(all_facts(&lib, PLUG), [json!({ "n": 1 })]);
    Ok(())
}

pub fn a_record_area_not_yet_written_reads_empty(env: &Env) -> Outcome {
    let lib = env.bare();
    let seen = glance_in_plug(&lib, &["", "x/y.txt"]);
    assert_eq!(seen[0]["kind"], "dir", "{seen:?}");
    assert_eq!(seen[0]["size"], 0, "{seen:?}");
    assert_eq!(seen[1]["kind"], "none", "{seen:?}");
    let token = seen[0]["token"]
        .as_str()
        .unwrap_or_else(|| panic!("{seen:?}"))
        .to_owned();
    let looked = lib.run(
        "look",
        in_plug(json!({ "places": [{ "place": "", "token": token }] })),
    );
    assert_eq!(looked["same"], 1, "{looked}");
    let listed = lib.run("overview", in_plug(json!({ "place": "" })));
    assert_eq!(listed["entries"], json!([]), "{listed}");
    assert_eq!(listed["more"], Value::Null, "{listed}");
    assert_failed(
        &lib.run("overview", in_plug(json!({ "place": "x" }))),
        "no_such_place",
    );
    let content = lib.run("content", in_plug(json!({ "place": "" })));
    assert_eq!(content["files"], 0, "{content}");
    assert_eq!(content["fingerprint"], sha256_hex(b""), "{content}");
    assert_failed(
        &lib.run("read", in_plug(json!({ "place": "x/y.txt" }))),
        "no_such_place",
    );
    let removed = lib.run(
        "remove",
        in_plug(json!({ "place": "x/y.txt", "expect": token })),
    );
    assert_refused(&removed);
    assert_eq!(removed["actual"]["kind"], "none", "{removed}");
    let stale = lib.run(
        "write",
        in_plug(json!({ "place": "x/y.txt", "from": data(b"no"), "expect": token })),
    );
    assert_refused(&stale);
    if env.path_addressed() {
        assert!(
            !lib.at(".pneuma-base").exists(),
            "reading a record place's area made nothing"
        );
    }
    // The first write makes it.
    put(&lib, "x/y.txt", b"first");
    assert_eq!(glance_in_plug(&lib, &["x/y.txt"])[0]["kind"], "file");
    let looked = lib.run(
        "look",
        in_plug(json!({ "places": [{ "place": "", "token": token }] })),
    );
    assert_eq!(looked["same"], 0, "the area changed: {looked}");
    Ok(())
}

pub fn a_move_in_a_record_area_stays_in_it(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a.txt", "content a");
    put(&lib, "a.txt", b"record a");
    let token = token_in_plug(&lib, "a.txt");
    let moved = lib.run(
        "move",
        in_plug(
            json!({ "from": "a.txt", "to": "sub/b.txt", "expect": { "from": token, "to": "empty" } }),
        ),
    );
    assert_done(&moved);
    assert_eq!(moved["entry"]["place"], "sub/b.txt", "{moved}");
    let kinds: Vec<Value> = glance_in_plug(&lib, &["a.txt", "sub/b.txt"])
        .iter()
        .map(|e| e["kind"].clone())
        .collect();
    assert_eq!(kinds, [json!("none"), json!("file")]);
    assert_eq!(fs::read_to_string(lib.at("a.txt")).unwrap(), "content a");
    assert_eq!(lib.glance_one("sub/b.txt")["kind"], "none");
    Ok(())
}

pub fn write_copies_between_the_content_and_a_record_place(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("tree/top.txt", "top");
    lib.write("tree/a/one.txt", "one");
    lib.write("tree/a/skip.log", "ignored");
    lib.write("tree/.gitignore", "*.log\n");
    lib.write("tree/node_modules/dep.js", "noise");
    let rule = json!({ "ignore_file": ".gitignore" });
    let source = lib.run("content", json!({ "place": "tree", "rule": rule }));
    assert_done(&source);
    let before = lib.fingerprint("tree");

    // From the content into a record place, by the content rule.
    let copied = lib.run(
        "write",
        in_plug(
            json!({ "place": "copies/tree", "from": { "place": "tree" }, "expect": "empty", "rule": rule }),
        ),
    );
    assert_done(&copied);
    assert_eq!(copied["fingerprint"], source["fingerprint"], "{copied}");
    assert_eq!(copied["files"], source["files"], "{copied}");
    assert_eq!(copied["entry"]["kind"], "dir", "{copied}");
    let there = lib.run("content", in_plug(json!({ "place": "copies/tree" })));
    assert_eq!(there["fingerprint"], copied["fingerprint"], "same pass");
    let left_out = glance_in_plug(
        &lib,
        &["copies/tree/a/skip.log", "copies/tree/node_modules"],
    );
    assert!(left_out.iter().all(|e| e["kind"] == "none"), "{left_out:?}");

    // And back, from the record place into the content.
    let back = lib.run(
        "write",
        json!({ "place": "restored", "from": { "records": PLUG, "place": "copies/tree" }, "expect": "empty" }),
    );
    assert_done(&back);
    assert_eq!(back["fingerprint"], source["fingerprint"], "{back}");
    assert_eq!(lib.fingerprint("restored"), source["fingerprint"]);

    // A file, within the content, and between two record places.
    let file = lib.run(
        "write",
        json!({ "place": "top-copy.txt", "from": { "place": "tree/top.txt" }, "expect": "empty" }),
    );
    assert_done(&file);
    assert_eq!(file["fingerprint"], sha256_hex(b"top"), "{file}");
    assert_eq!(fs::read_to_string(lib.at("top-copy.txt")).unwrap(), "top");
    let across = lib.run(
        "write",
        json!({ "records": "other", "place": "t.txt", "from": { "records": PLUG, "place": "copies/tree/top.txt" }, "expect": "empty" }),
    );
    assert_done(&across);
    assert_eq!(across["fingerprint"], sha256_hex(b"top"), "{across}");

    // Over what is there, with a token.
    let token = lib.token("top-copy.txt");
    let over = lib.run(
        "write",
        json!({ "place": "top-copy.txt", "from": { "place": "tree/a/one.txt" }, "expect": token }),
    );
    assert_done(&over);
    assert_eq!(fs::read_to_string(lib.at("top-copy.txt")).unwrap(), "one");
    assert_eq!(lib.fingerprint("tree"), before, "the source is as it was");
    Ok(())
}

pub fn a_copy_onto_itself_is_a_bad_request(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/x.txt", "x");
    put(&lib, "d/x.txt", b"x");
    let cases = [
        (None, "d/copy", json!({ "place": "d" })),
        (None, "d", json!({ "place": "d/x.txt" })),
        (None, "d", json!({ "place": "d" })),
        (None, "e", json!({ "place": "" })),
        (
            Some(PLUG),
            "d/copy",
            json!({ "records": PLUG, "place": "d" }),
        ),
    ];
    for (records, place, from) in cases {
        let mut request = json!({ "place": place, "from": from, "expect": "empty" });
        if let Some(records) = records {
            request["records"] = json!(records);
        }
        assert_failed(&lib.run("write", request), "bad_request");
    }
    assert_eq!(lib.glance_one("d/copy")["kind"], "none");
    // The same place in another area is no overlap.
    assert_done(&lib.run(
        "write",
        in_plug(json!({ "place": "d/again", "from": { "place": "d" }, "expect": "empty" })),
    ));
    Ok(())
}

pub fn a_bad_copy_source_names_its_side(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("node_modules/dep.js", "noise");
    lib.write("d/x.txt", "x");
    std::os::unix::fs::symlink("d", lib.at("link")).unwrap();
    let mut cases = vec![
        (json!({ "place": "missing.txt" }), "no_such_place"),
        (json!({ "place": "node_modules/dep.js" }), "noise"),
        (json!({ "place": "link/x.txt" }), "outside"),
        (
            json!({ "records": PLUG, "place": "missing.txt" }),
            "no_such_place",
        ),
        (json!({ "records": PLUG, "place": "facts" }), "outside"),
    ];
    if env.path_addressed() {
        cases.push((json!({ "place": ".pneuma-base/noise.json" }), "outside"));
    }
    for (from, reason) in cases {
        let answer = lib.run(
            "write",
            json!({ "place": "out.txt", "from": from, "expect": "empty" }),
        );
        assert_failed(&answer, reason);
        assert_eq!(answer["side"], "from", "{answer}");
    }
    assert_eq!(lib.glance_one("out.txt")["kind"], "none");
    let Some(_locked) = Locked::new(lib.at("d/x.txt")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let answer = lib.run(
        "write",
        json!({ "place": "out.txt", "from": { "place": "d/x.txt" }, "expect": "empty" }),
    );
    assert_failed(&answer, "unreadable");
    assert_eq!(answer["side"], "from", "{answer}");
    assert_eq!(lib.glance_one("out.txt")["kind"], "none");
    Ok(())
}

pub fn bytes_in_the_request_are_written(env: &Env) -> Outcome {
    let lib = env.lib();
    let bytes = bytes_of(100_000, 4);
    let written = lib.run(
        "write",
        json!({ "place": "d.bin", "from": data(&bytes), "expect": "empty" }),
    );
    assert_done(&written);
    assert_eq!(written["fingerprint"], sha256_hex(&bytes), "{written}");
    assert_eq!(written["entry"]["size"], bytes.len(), "{written}");
    assert_eq!(fs::read(lib.at("d.bin")).unwrap(), bytes);
    let token = lib.token("d.bin");
    let refused = lib.run(
        "write",
        json!({ "place": "d.bin", "from": data(b"other"), "expect": "empty" }),
    );
    assert_refused(&refused);
    assert_eq!(fs::read(lib.at("d.bin")).unwrap(), bytes);
    let over = lib.run(
        "write",
        json!({ "place": "d.bin", "from": data(b"other"), "expect": token }),
    );
    assert_done(&over);
    assert_eq!(over["fingerprint"], sha256_hex(b"other"), "{over}");
    let empty = lib.run(
        "write",
        json!({ "place": "empty.bin", "from": data(b""), "expect": "empty" }),
    );
    assert_done(&empty);
    assert_eq!(empty["entry"]["size"], 0, "{empty}");
    // Where standard input carries requests.
    let mut serve = lib.serve();
    let served = serve.ask(
        json!(1),
        "write",
        json!({ "place": "served.bin", "from": data(b"served"), "expect": "empty" }),
    );
    assert_done(&served);
    assert_eq!(fs::read(lib.at("served.bin")).unwrap(), b"served");
    // At most 16 MiB.
    let most = vec![7u8; 16 << 20];
    let at_most = lib.run(
        "write",
        json!({ "place": "most.bin", "from": data(&most), "expect": "empty" }),
    );
    assert_done(&at_most);
    let too_big = vec![7u8; (16 << 20) + 1];
    let answer = lib.run(
        "write",
        json!({ "place": "big.bin", "from": data(&too_big), "expect": "empty" }),
    );
    assert_failed(&answer, "bad_request");
    assert_eq!(lib.glance_one("big.bin")["kind"], "none");
    for from in [
        json!({ "data": "not base64!" }),
        json!({ "data": "QUJD", "place": "d.bin" }),
        json!({}),
    ] {
        assert_failed(
            &lib.run(
                "write",
                json!({ "place": "bad.bin", "from": from, "expect": "empty" }),
            ),
            "bad_request",
        );
    }
    Ok(())
}

pub fn names_storage_keeps_are_no_record_places(env: &Env) -> Outcome {
    if !env.path_addressed() {
        return not_exercised(
            "which names a provider keeps in its record area is its own; the wire names them for a path-addressed provider",
        );
    }
    let lib = env.lib();
    for name in ["cache", "holds", "tmp", "trash"] {
        for (op, request) in [
            (
                "facts.append",
                json!({ "place": name, "facts": [{ "n": 1 }] }),
            ),
            ("facts.since", json!({ "place": name, "cursor": null })),
            (
                "rows.get",
                json!({ "place": name, "table": "t", "keys": ["k"] }),
            ),
            ("rows.reset", json!({ "place": name })),
            ("glance", json!({ "records": name, "places": [""] })),
            (
                "write",
                json!({ "records": name, "place": "x", "from": data(b"x"), "expect": "empty" }),
            ),
            (
                "write",
                json!({ "place": "x", "from": { "records": name, "place": "y" }, "expect": "empty" }),
            ),
        ] {
            assert_failed(&lib.run(op, request), "bad_request");
        }
    }
    Ok(())
}
