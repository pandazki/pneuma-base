//! Section 6: `init`, `describe`, noise, `hold` and `release`, `serve`.

use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

/// The default noise names the wire (core/README.md) gives.
const DEFAULT_NOISE: [&str; 26] = [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    ".pnpm-store",
    ".yarn",
    "bower_components",
    "__pycache__",
    ".venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".cache",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".Trash",
    ".Spotlight-V100",
    ".fseventsd",
    ".TemporaryItems",
];

fn path_addressed(env: &Env) -> bool {
    env.describe["addresses"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x == "path"))
}

pub fn init_makes_the_areas_once(env: &Env) -> Outcome {
    let lib = env.bare();
    assert_eq!(lib.run("init", json!({}))["created"], true);
    if path_addressed(env) {
        // A folder provider keeps the record area and the cache area where the wire says.
        assert!(lib.at(".pneuma-base").is_dir());
        assert!(lib.at(".pneuma-base/cache").is_dir());
    }
    let listed = lib.run("noise.list", json!({}));
    assert_eq!(listed["declared"], true, "{listed}");
    assert_eq!(listed["names"], json!(DEFAULT_NOISE), "{listed}");
    lib.run("noise.add", json!({ "names": ["build"] }));
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    lib.write("kept.txt", "kept");
    assert_eq!(lib.run("init", json!({}))["created"], false);
    let names = strings_of(&lib.run("noise.list", json!({}))["names"]);
    assert!(
        names.contains(&"build".to_owned()),
        "init again changed nothing"
    );
    assert_eq!(all_facts(&lib, "log"), [json!({ "n": 1 })]);
    assert_eq!(fs::read_to_string(lib.at("kept.txt")).unwrap(), "kept");
    Ok(())
}

pub fn describe_says_what_the_provider_is(env: &Env) -> Outcome {
    let answer = &env.describe;
    assert_eq!(answer["outcome"], "done", "{answer}");
    assert!(
        answer["name"].as_str().is_some_and(|n| !n.is_empty()),
        "{answer}"
    );
    assert!(
        answer["version"].as_str().is_some_and(|v| !v.is_empty()),
        "{answer}"
    );
    assert_eq!(answer["contract"], 1, "{answer}");
    assert!(!strings_of(&answer["addresses"]).is_empty(), "{answer}");
    assert!(answer["cursor"].is_boolean(), "{answer}");
    let _ = strings_of(&answer["facets"]);
    let _ = strings_of(&answer["ops"]);
    let again = env.lib().run("describe", json!({}));
    assert_eq!(&again, answer, "the same on any library");
    Ok(())
}

pub fn noise_is_listed_added_and_removed(env: &Env) -> Outcome {
    let lib = env.bare();
    let listed = lib.run("noise.list", json!({}));
    assert_eq!(
        listed,
        json!({ "outcome": "done", "names": DEFAULT_NOISE, "paths": [], "declared": false })
    );
    lib.write("build/out.bin", "x");
    lib.write("docs/tmp/scratch.md", "x");
    let added = lib.run(
        "noise.add",
        json!({ "names": ["build"], "paths": ["docs/tmp"] }),
    );
    assert_eq!(added["declared"], true);
    assert!(strings_of(&added["names"]).contains(&"build".to_owned()));
    assert_eq!(added["paths"], json!(["docs/tmp"]));
    assert_eq!(lib.glance_one("build/out.bin")["reason"], "noise");
    assert_eq!(lib.glance_one("docs/tmp/scratch.md")["reason"], "noise");
    assert_eq!(
        lib.run("noise.list", json!({})),
        added,
        "declared at the root: it lasts"
    );
    let removed = lib.run(
        "noise.remove",
        json!({ "names": ["build", "node_modules"], "paths": ["docs/tmp"] }),
    );
    let names = strings_of(&removed["names"]);
    assert!(!names.contains(&"build".to_owned()));
    assert!(!names.contains(&"node_modules".to_owned()));
    assert_eq!(removed["paths"], json!([]));
    assert_eq!(lib.glance_one("build/out.bin")["kind"], "file");
    assert_failed(
        &lib.run("noise.add", json!({ "names": ["a/b"] })),
        "bad_request",
    );
    assert_failed(
        &lib.run("noise.add", json!({ "paths": [""] })),
        "bad_request",
    );
    Ok(())
}

pub fn holds_block_other_writers(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "f");
    lib.write("d/x.txt", "x");
    let src = scratch();
    let source = src.path().join("s.txt");
    fs::write(&source, "new").unwrap();
    let held = lib.run("hold", json!({ "place": "f.txt", "ttl": 60_000 }));
    assert_done(&held);
    let id = held["hold"]
        .as_str()
        .unwrap_or_else(|| panic!("{held}"))
        .to_owned();
    let until = iso_ms(held["until"].as_str().unwrap());
    assert!(
        (until - now_ms() - 60_000).abs() < 10_000,
        "until is about the time to live: {held}"
    );
    let token = lib.token("f.txt");
    let write = |hold: Option<&str>| {
        let mut request = json!({ "place": "f.txt", "from": source, "expect": lib.token("f.txt") });
        if let Some(hold) = hold {
            request["hold"] = json!(hold);
        }
        lib.run("write", request)
    };
    let blocked = write(None);
    assert_failed(&blocked, "held");
    assert!(lib.same("f.txt", &token));
    assert_failed(
        &lib.run("remove", json!({ "place": "f.txt", "expect": token })),
        "held",
    );
    assert_failed(
        &lib.run(
            "move",
            json!({ "from": "f.txt", "to": "g.txt", "expect": { "from": token, "to": "empty" } }),
        ),
        "held",
    );
    assert_failed(&lib.run("hold", json!({ "place": "f.txt" })), "held");
    assert_failed(&lib.run("hold", json!({ "place": "" })), "held");
    assert_done(&write(Some(&id)));
    assert_eq!(fs::read_to_string(lib.at("f.txt")).unwrap(), "new");
    assert_done(&lib.run("release", json!({ "hold": id })));
    assert_done(&lib.run("release", json!({ "hold": id })));
    fs::write(&source, "after").unwrap();
    assert_done(&write(None));

    let dir = lib.run("hold", json!({ "place": "d" }));
    assert_done(&dir);
    let under = lib.run(
        "write",
        json!({ "place": "d/y.txt", "from": source, "expect": "empty" }),
    );
    assert_failed(&under, "held");
    let ahead = lib.run("hold", json!({ "place": "later/new.txt" }));
    assert_done(&ahead);
    let with = lib.run(
        "write",
        json!({ "place": "later/new.txt", "from": source, "expect": "empty", "hold": ahead["hold"] }),
    );
    assert_done(&with);
    Ok(())
}

pub fn held_places_are_marked(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/held.txt", "h");
    lib.write("d/free.txt", "f");
    let token = lib.token("d/held.txt");
    let free = lib.token("d/free.txt");
    assert_done(&lib.run("hold", json!({ "place": "d/held.txt" })));
    let looked = lib.run(
        "look",
        json!({ "places": [{ "place": "d/held.txt", "token": token }, { "place": "d/free.txt", "token": free }] }),
    );
    assert_eq!(looked["held"], json!(["d/held.txt"]), "{looked}");
    let listed = lib.run("overview", json!({ "place": "d" }));
    let held: BTreeMap<String, Value> = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["place"].as_str().unwrap().to_owned(), e["held"].clone()))
        .collect();
    assert_eq!(held["d/held.txt"], true, "{listed}");
    assert_ne!(held["d/free.txt"], true, "{listed}");
    Ok(())
}

/// A hold lives for its time to live: refused `held` before, allowed after, no longer marked.
pub fn a_hold_expires(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "f");
    let src = scratch();
    let source = src.path().join("s.txt");
    fs::write(&source, "new").unwrap();
    for ttl in [1_500u64, 4_000, 10_000] {
        let held = lib.run("hold", json!({ "place": "f.txt", "ttl": ttl }));
        assert_done(&held);
        let until = iso_ms(held["until"].as_str().unwrap());
        let token = lib.token("f.txt");
        let blocked = lib.run(
            "write",
            json!({ "place": "f.txt", "from": source, "expect": token }),
        );
        let looked = lib.look_one("f.txt", &token);
        if now_ms() >= until - 100 {
            // Too slow to see the hold alive: try a longer one.
            std::thread::sleep(Duration::from_millis(
                (until - now_ms()).max(0) as u64 + 200,
            ));
            continue;
        }
        assert_failed(&blocked, "held");
        assert_eq!(looked["held"], json!(["f.txt"]), "{looked}");
        std::thread::sleep(Duration::from_millis(
            (until - now_ms()).max(0) as u64 + 200,
        ));
        let looked = lib.look_one("f.txt", &token);
        assert_eq!(looked["held"], json!([]), "expired: {looked}");
        let listed = lib.run("overview", json!({ "place": "" }));
        assert_ne!(listed["entries"][0]["held"], true, "{listed}");
        assert_done(&lib.run(
            "write",
            json!({ "place": "f.txt", "from": source, "expect": token }),
        ));
        assert_done(&lib.run("hold", json!({ "place": "f.txt" })));
        return Ok(());
    }
    not_exercised("every hold expired before its first use could be answered")
}

pub fn serve_echoes_ids(env: &Env) -> Outcome {
    let lib = env.lib();
    let mut serve = lib.serve();
    serve.request(json!("a"), "describe", json!({}));
    serve.request(json!(2), "glance", json!({ "places": [""] }));
    serve.send("this is not json");
    serve.request(json!(3), "nope", json!({}));
    let mut by_id = BTreeMap::new();
    for _ in 0..4 {
        let answer = serve.receive();
        by_id.insert(answer["id"].to_string(), answer);
    }
    assert_eq!(by_id["\"a\""]["contract"], 1, "{by_id:?}");
    assert_eq!(by_id["2"]["entries"][0]["kind"], "dir", "{by_id:?}");
    assert_eq!(
        by_id["null"],
        json!({ "id": null, "outcome": "failed", "reason": "bad_request" })
    );
    assert_failed(&by_id["3"], "bad_request");
    assert_eq!(serve.finish(), 0);
    Ok(())
}

pub fn serve_cancels_by_id(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.mkdir("d");
    let token = lib.token("d");
    let places: Vec<Value> = (0..500_000)
        .map(|i| json!({ "place": format!("d/n{i}"), "token": token }))
        .collect();
    let mut serve = lib.serve();
    serve.request(json!("big"), "look", json!({ "places": places }));
    serve.send(r#"{"id":"c1","op":"cancel","target":"big"}"#);
    serve.send(r#"{"id":"c2","op":"cancel","target":"never-sent"}"#);
    let mut answers = BTreeMap::new();
    while answers.len() < 3 {
        let answer = serve.receive();
        if answer.get("progress").is_none() {
            answers.insert(answer["id"].as_str().unwrap().to_owned(), answer);
        }
    }
    assert_eq!(
        answers["big"],
        json!({ "id": "big", "outcome": "failed", "reason": "cancelled" })
    );
    assert_eq!(answers["c1"], json!({ "id": "c1", "outcome": "done" }));
    assert_eq!(answers["c2"], json!({ "id": "c2", "outcome": "done" }));
    assert_eq!(serve.finish(), 0);
    Ok(())
}

/// A write cancelled before it takes effect answers `cancelled` and places nothing; one that took
/// effect first answers what it did.
pub fn a_cancelled_write_places_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    many_files(src.path(), 3_000, 5);
    let mut serve = lib.serve();
    let id = json!("w");
    serve.request(
        id.clone(),
        "write",
        json!({ "place": "copy", "from": src.path(), "expect": "empty" }),
    );
    if serve.first_progress(&id).is_none() {
        return not_exercised("the write answered before any progress line to cancel on");
    }
    serve.send(r#"{"id":"c","op":"cancel","target":"w"}"#);
    let (_, answer) = serve.answer_for(&id);
    match answer["reason"].as_str() {
        Some("cancelled") => {
            assert_eq!(
                lib.glance_one("copy")["kind"],
                "none",
                "cancelled: {answer}"
            )
        }
        _ => {
            assert_done(&answer);
            assert_eq!(lib.fingerprint("copy"), answer["fingerprint"]);
        }
    }
    let again = serve.ask(
        json!("again"),
        "write",
        json!({ "place": "copy", "from": src.path(), "expect": if answer["outcome"] == "done" { answer["entry"]["token"].clone() } else { json!("empty") } }),
    );
    assert_done(&again);
    assert_eq!(again["files"], 3_000);
    Ok(())
}
