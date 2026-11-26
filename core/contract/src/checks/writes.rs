//! Section 4's writing operations, `write`, `move` and `remove`, and rule 2.5: a write whose
//! expectation does not hold changes nothing and answers `refused` with what is there.

use std::fs;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

/// What `refused` reports must be what is there now.
fn assert_actual_is(lib: &Lib, actual: &Value, place: &str) {
    let now = lib.glance_one(place);
    assert_eq!(actual["place"], place, "{actual}");
    assert_eq!(actual["kind"], now["kind"], "actual {actual} vs now {now}");
    if now["kind"] != "none" {
        // The checks settle a place before the refused write, so its token then is settled too.
        assert_eq!(
            actual["token"],
            lib.token(place).as_str(),
            "actual {actual} vs now {now}"
        );
        assert_eq!(actual["size"], now["size"], "{actual}");
    }
}

pub fn write_places_bytes_from_a_path_or_stdin(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    let bytes = bytes_of(70_000, 3);
    let source = src.path().join("s.bin");
    fs::write(&source, &bytes).unwrap();
    let written = lib.run(
        "write",
        json!({ "place": "new/deeper/s.bin", "from": source, "expect": "empty" }),
    );
    assert_done(&written);
    assert_eq!(written["fingerprint"], sha256_hex(&bytes), "{written}");
    let entry = &written["entry"];
    assert_eq!(entry["place"], "new/deeper/s.bin", "{written}");
    assert_eq!(entry["kind"], "file", "{written}");
    assert_eq!(entry["size"], bytes.len(), "{written}");
    assert!(lib.same("new/deeper/s.bin", entry["token"].as_str().unwrap()));
    assert_eq!(fs::read(lib.at("new/deeper/s.bin")).unwrap(), bytes);
    assert_eq!(lib.glance_one("new")["kind"], "dir");

    let piped = bytes_of(5_000, 9);
    let answer = lib.run_with_stdin(
        "write",
        &json!({ "place": "piped.bin", "from": "-", "expect": "empty" }),
        &piped,
    );
    assert_done(&answer);
    assert_eq!(answer["fingerprint"], sha256_hex(&piped), "{answer}");
    assert_eq!(fs::read(lib.at("piped.bin")).unwrap(), piped);

    // Only from outside the library, never onto its root, never from nothing.
    lib.write("inside.txt", "inside");
    let inside = lib.run(
        "write",
        json!({ "place": "copy.txt", "from": lib.at("inside.txt"), "expect": "empty" }),
    );
    assert_eq!(
        inside["outcome"], "failed",
        "a source inside the library: {inside}"
    );
    assert_eq!(lib.glance_one("copy.txt")["kind"], "none");
    let root = lib.run(
        "write",
        json!({ "place": "", "from": source, "expect": "empty" }),
    );
    assert_failed(&root, "bad_request");
    let nothing = lib.run(
        "write",
        json!({ "place": "x.txt", "from": src.path().join("missing"), "expect": "empty" }),
    );
    assert_eq!(nothing["outcome"], "failed", "{nothing}");
    assert_eq!(lib.glance_one("x.txt")["kind"], "none");
    let mut serve = lib.serve();
    let served = serve.ask(
        json!(1),
        "write",
        json!({ "place": "served.bin", "from": "-", "expect": "empty" }),
    );
    assert_failed(&served, "bad_request");
    Ok(())
}

pub fn write_replaces_with_a_token(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    let file = src.path().join("new.txt");
    fs::write(&file, "the new bytes").unwrap();
    let dir = src.path().join("tree");
    fs::create_dir_all(dir.join("sub")).unwrap();
    fs::write(dir.join("sub/n.txt"), "n").unwrap();
    lib.write("over-file", "old");
    lib.write("over-dir/old.txt", "old");
    lib.write("dir-over-file", "old");
    for (place, from) in [
        ("over-file", &file),
        ("over-dir", &file),
        ("dir-over-file", &dir),
    ] {
        let token = lib.token(place);
        let answer = lib.run(
            "write",
            json!({ "place": place, "from": from, "expect": token }),
        );
        assert_done(&answer);
        assert_eq!(
            lib.fingerprint(place),
            answer["fingerprint"],
            "{place}: {answer}"
        );
        assert!(lib.same(place, answer["entry"]["token"].as_str().unwrap()));
    }
    assert_eq!(
        fs::read_to_string(lib.at("over-file")).unwrap(),
        "the new bytes"
    );
    assert_eq!(lib.glance_one("over-dir")["kind"], "file");
    assert_eq!(lib.glance_one("over-dir/old.txt")["kind"], "none");
    assert_eq!(lib.glance_one("dir-over-file/sub/n.txt")["kind"], "file");
    let entries = places_of(&lib.run("overview", json!({ "place": "" }))["entries"]);
    assert_eq!(entries, ["dir-over-file", "over-dir", "over-file"]);
    Ok(())
}

pub fn write_of_a_directory_answers_its_content(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    fs::create_dir_all(src.path().join("a/b")).unwrap();
    fs::write(src.path().join("top.txt"), "top").unwrap();
    fs::write(src.path().join("a/one.txt"), "one").unwrap();
    fs::write(src.path().join("a/b/two.txt"), "two").unwrap();
    fs::create_dir_all(src.path().join("empty")).unwrap();
    let written = lib.run(
        "write",
        json!({ "place": "tree", "from": src.path(), "expect": "empty" }),
    );
    assert_done(&written);
    assert_eq!(written["files"], 3, "{written}");
    assert_eq!(written["entry"]["kind"], "dir", "{written}");
    let content = lib.run("content", json!({ "place": "tree" }));
    assert_eq!(
        content["fingerprint"], written["fingerprint"],
        "same pass, same fingerprint"
    );
    assert_eq!(content["files"], 3);
    assert_eq!(
        fs::read_to_string(lib.at("tree/a/b/two.txt")).unwrap(),
        "two"
    );
    Ok(())
}

pub fn write_refused_changes_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    let source = src.path().join("b.txt");
    fs::write(&source, "BBBBBBBBBBBB").unwrap();
    lib.write("f.txt", "A");
    let token = lib.token("f.txt");

    let refused = lib.run(
        "write",
        json!({ "place": "f.txt", "from": source, "expect": "empty" }),
    );
    assert_refused(&refused);
    assert_actual_is(&lib, &refused["actual"], "f.txt");
    assert_eq!(fs::read_to_string(lib.at("f.txt")).unwrap(), "A");
    assert!(lib.same("f.txt", &token));

    lib.write("f.txt", "CC");
    lib.token("f.txt");
    let stale = lib.run(
        "write",
        json!({ "place": "f.txt", "from": source, "expect": token }),
    );
    assert_refused(&stale);
    assert_actual_is(&lib, &stale["actual"], "f.txt");
    assert_eq!(fs::read_to_string(lib.at("f.txt")).unwrap(), "CC");

    let missing = lib.run(
        "write",
        json!({ "place": "g.txt", "from": source, "expect": token }),
    );
    assert_refused(&missing);
    assert_eq!(
        missing["actual"],
        json!({ "place": "g.txt", "kind": "none" })
    );
    assert_eq!(lib.glance_one("g.txt")["kind"], "none");

    let deep = lib.run(
        "write",
        json!({ "place": "no/such/dirs/g.txt", "from": source, "expect": token }),
    );
    assert_refused(&deep);
    assert_eq!(deep["actual"]["kind"], "none", "{deep}");
    assert_eq!(
        lib.glance_one("no")["kind"],
        "none",
        "a refused write made no directory"
    );

    lib.write("d/inner.txt", "inner");
    lib.token("d");
    let before = lib.fingerprint("d");
    let over_dir = lib.run(
        "write",
        json!({ "place": "d", "from": source, "expect": "empty" }),
    );
    assert_refused(&over_dir);
    assert_actual_is(&lib, &over_dir["actual"], "d");
    assert_eq!(lib.fingerprint("d"), before);
    Ok(())
}

pub fn move_places_and_describes(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a.txt", "aaa");
    lib.write("tree/x/y.txt", "y");
    lib.write("occupied.txt", "old");
    lib.write("old-dir/z.txt", "z");
    lib.write("src-dir/w.txt", "w");

    let token = lib.token("a.txt");
    let moved = lib.run(
        "move",
        json!({ "from": "a.txt", "to": "new/place/b.txt", "expect": { "from": token, "to": "empty" } }),
    );
    assert_done(&moved);
    assert_eq!(moved["entry"]["place"], "new/place/b.txt", "{moved}");
    assert_eq!(moved["entry"]["kind"], "file", "{moved}");
    assert_eq!(moved["entry"]["size"], 3, "{moved}");
    assert!(lib.same("new/place/b.txt", moved["entry"]["token"].as_str().unwrap()));
    assert_eq!(lib.glance_one("a.txt")["kind"], "none");

    let token = lib.token("tree");
    let moved = lib.run(
        "move",
        json!({ "from": "tree", "to": "forest", "expect": { "from": token, "to": "empty" } }),
    );
    assert_done(&moved);
    assert_eq!(lib.glance_one("forest/x/y.txt")["kind"], "file");
    assert_eq!(lib.glance_one("tree")["kind"], "none");

    let (from, to) = (lib.token("new/place/b.txt"), lib.token("occupied.txt"));
    let over = lib.run(
        "move",
        json!({ "from": "new/place/b.txt", "to": "occupied.txt", "expect": { "from": from, "to": to } }),
    );
    assert_done(&over);
    assert_eq!(fs::read_to_string(lib.at("occupied.txt")).unwrap(), "aaa");
    assert_eq!(lib.glance_one("new/place/b.txt")["kind"], "none");

    let (from, to) = (lib.token("src-dir"), lib.token("old-dir"));
    let over = lib.run(
        "move",
        json!({ "from": "src-dir", "to": "old-dir", "expect": { "from": from, "to": to } }),
    );
    assert_done(&over);
    assert_eq!(lib.glance_one("old-dir/w.txt")["kind"], "file");
    assert_eq!(lib.glance_one("old-dir/z.txt")["kind"], "none");
    assert_eq!(
        lib.glance_one("src-dir")["kind"],
        "none",
        "the old target is not left anywhere"
    );
    let entries = places_of(&lib.run("overview", json!({ "place": "" }))["entries"]);
    assert_eq!(entries, ["forest", "new", "occupied.txt", "old-dir"]);

    let token = lib.token("forest");
    for to in ["forest", "forest/x/inside"] {
        let answer = lib.run(
            "move",
            json!({ "from": "forest", "to": to, "expect": { "from": token, "to": "empty" } }),
        );
        assert_eq!(answer["outcome"], "failed", "into itself: {answer}");
    }
    assert!(lib.same("forest", &token));
    Ok(())
}

pub fn move_refused_changes_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("a.txt", "a");
    lib.write("b.txt", "b");
    let (a, b) = (lib.token("a.txt"), lib.token("b.txt"));
    let occupied = lib.run(
        "move",
        json!({ "from": "a.txt", "to": "b.txt", "expect": { "from": a, "to": "empty" } }),
    );
    assert_refused(&occupied);
    assert_actual_is(&lib, &occupied["actual"]["from"], "a.txt");
    assert_actual_is(&lib, &occupied["actual"]["to"], "b.txt");
    lib.write("a.txt", "a changed");
    lib.token("a.txt");
    let stale = lib.run(
        "move",
        json!({ "from": "a.txt", "to": "c.txt", "expect": { "from": a, "to": "empty" } }),
    );
    assert_refused(&stale);
    assert_actual_is(&lib, &stale["actual"]["from"], "a.txt");
    assert_eq!(
        stale["actual"]["to"],
        json!({ "place": "c.txt", "kind": "none" })
    );
    let gone = lib.run(
        "move",
        json!({ "from": "nothing.txt", "to": "c.txt", "expect": { "from": a, "to": "empty" } }),
    );
    assert_refused(&gone);
    assert_eq!(gone["actual"]["from"]["kind"], "none", "{gone}");
    let wrong_to = lib.run(
        "move",
        json!({ "from": "b.txt", "to": "a.txt", "expect": { "from": b, "to": b } }),
    );
    assert_refused(&wrong_to);
    assert_eq!(fs::read_to_string(lib.at("a.txt")).unwrap(), "a changed");
    assert_eq!(fs::read_to_string(lib.at("b.txt")).unwrap(), "b");
    assert_eq!(lib.glance_one("c.txt")["kind"], "none");
    assert!(lib.same("b.txt", &b));
    Ok(())
}

pub fn remove_takes_it_away(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "f");
    lib.write("d/sub/deeper/x.txt", "x");
    lib.write("d/y.txt", "y");
    for place in ["f.txt", "d"] {
        let token = lib.token(place);
        let answer = lib.run("remove", json!({ "place": place, "expect": token }));
        assert_done(&answer);
        assert_eq!(answer["removed"], true, "{answer}");
        assert_eq!(lib.glance_one(place)["kind"], "none");
    }
    assert_eq!(
        lib.run("overview", json!({ "place": "" }))["entries"],
        json!([])
    );
    Ok(())
}

pub fn remove_refused_changes_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "f");
    let token = lib.token("f.txt");
    lib.write("f.txt", "f changed");
    lib.token("f.txt");
    let stale = lib.run("remove", json!({ "place": "f.txt", "expect": token }));
    assert_refused(&stale);
    assert_actual_is(&lib, &stale["actual"], "f.txt");
    assert_eq!(fs::read_to_string(lib.at("f.txt")).unwrap(), "f changed");
    let missing = lib.run("remove", json!({ "place": "g.txt", "expect": token }));
    assert_refused(&missing);
    assert_eq!(missing["actual"]["kind"], "none", "{missing}");
    Ok(())
}

/// Removing a large directory sends progress before its answer.
pub fn remove_sends_progress(env: &Env) -> Outcome {
    let lib = env.lib();
    many_files(&lib.at("big"), 12_000, 2);
    let token = lib.token("big");
    let mut serve = lib.serve();
    let id = json!("r");
    let started = std::time::Instant::now();
    serve.request(
        id.clone(),
        "remove",
        json!({ "place": "big", "expect": token }),
    );
    let (progress, answer) = serve.answer_for(&id);
    let took = started.elapsed();
    assert_done(&answer);
    if progress.is_empty() {
        // A removal over in a moment has nothing to report; one that took long must have said so.
        assert!(
            took < std::time::Duration::from_millis(500),
            "removing 12,000 files took {took:?} and sent no progress"
        );
        return not_exercised(format!(
            "the removal of 12,000 files took {took:?}, too short for progress"
        ));
    }
    Ok(())
}
