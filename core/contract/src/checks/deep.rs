//! A deep `look` (section 4): a directory compared by its deep token, which stands for the states
//! of every file the caller's content rule counts under it, taken without reading content.

use std::fs;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::checks::local::same_size_edit;
use crate::harness::*;
use crate::{Outcome, not_exercised};

/// A deep look of one place with `token` expected there.
fn look_deep(lib: &Lib, place: &str, token: &str, deep: &Value) -> Value {
    lib.run(
        "look",
        json!({ "places": [{ "place": place, "token": token }], "deep": deep }),
    )
}

/// The deep token of the directory at `place` now: a deep look expecting nothing there answers
/// it as changed.
fn deep_now(lib: &Lib, place: &str, deep: &Value) -> String {
    let looked = look_deep(lib, place, "empty", deep);
    looked["changed"][0]["deep"]
        .as_str()
        .unwrap_or_else(|| panic!("no deep token for {place}: {looked}"))
        .to_owned()
}

/// A deep token of the directory at `place` that a deep look answers `same` for. One taken too
/// soon after a change may never be (4.deep.8), so this follows `changed` to the newer token, as
/// `Lib::token` does for a token.
fn settled_deep(lib: &Lib, place: &str, deep: &Value) -> String {
    let mut token = deep_now(lib, place, deep);
    let deadline = Instant::now() + SETTLE;
    loop {
        let looked = look_deep(lib, place, &token, deep);
        if looked["same"] == 1 {
            return token;
        }
        assert!(
            Instant::now() < deadline,
            "a deep look never answered same for {place} within {SETTLE:?}: {looked}"
        );
        token = looked["changed"][0]["deep"]
            .as_str()
            .unwrap_or_else(|| panic!("{place} is no directory to settle: {looked}"))
            .to_owned();
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Whether a deep look says the directory is still what `token` stands for.
fn same_deep(lib: &Lib, place: &str, token: &str, deep: &Value) -> bool {
    look_deep(lib, place, token, deep)["same"] == 1
}

/// The one `changed` entry of a look, with the deep token it carries.
fn changed_with_deep(answer: &Value, place: &str) -> String {
    let changed = answer["changed"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "{answer}");
    assert_eq!(changed[0]["place"], place, "{answer}");
    assert_eq!(
        changed[0]["entry"]["kind"], "dir",
        "its usual description: {answer}"
    );
    changed[0]["deep"]
        .as_str()
        .unwrap_or_else(|| panic!("a deep token beside the description: {answer}"))
        .to_owned()
}

pub fn an_unchanged_directory_keeps_its_deep_token(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/a.txt", "a");
    lib.write("d/sub/b.txt", "b");
    lib.write("d/sub/deeper/c.txt", "c");
    let deep = json!({});
    let token = settled_deep(&lib, "d", &deep);
    let looked = look_deep(&lib, "d", &token, &deep);
    assert_eq!(looked["same"], 1, "{looked}");
    assert_eq!(looked["changed"], json!([]), "{looked}");
    assert_eq!(deep_now(&lib, "d", &deep), token, "the same text again");
    assert_eq!(deep_now(&lib, "d", &deep), token, "and again");
    let level = lib.token("d");
    assert_ne!(level, token, "a deep token is no level token");
    let from_level = changed_with_deep(&look_deep(&lib, "d", &level, &deep), "d");
    assert_eq!(from_level, token, "whatever was expected: {from_level}");
    let mut serve = lib.serve();
    let served = serve.ask(
        json!(1),
        "look",
        json!({ "places": [{ "place": "d", "token": token }], "deep": deep }),
    );
    assert_eq!(
        served["same"], 1,
        "another process, the same token: {served}"
    );
    Ok(())
}

/// A file three levels down written in place, as long as before, changes the directory's deep
/// token; the directory's own token does not move.
pub fn a_change_far_down_changes_the_deep_token(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/a/b/c/f.txt", "abcd");
    lib.write("d/top.txt", "top");
    let deep = json!({});
    let level = lib.token("d");
    let token = settled_deep(&lib, "d", &deep);
    same_size_edit(&lib.at("d/a/b/c/f.txt"), b"wxyz");
    set_mtime(&lib.at("d/a/b/c/f.txt"), an_hour_ago());
    assert!(
        lib.same("d", &level),
        "the directory's own level did not change"
    );
    let looked = look_deep(&lib, "d", &token, &deep);
    let now = changed_with_deep(&looked, "d");
    assert_ne!(now, token, "a new deep token: {looked}");
    assert!(same_deep(&lib, "d", &now, &deep), "{now}");
    Ok(())
}

pub fn deep_tokens_follow_files_added_removed_and_renamed(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/x/y/one.txt", "one");
    let deep = json!({});
    let changes: [(&str, &dyn Fn()); 4] = [
        ("a file added", &|| lib.write("d/x/y/two.txt", "two")),
        ("a file renamed", &|| {
            fs::rename(lib.at("d/x/y/two.txt"), lib.at("d/x/y/three.txt")).unwrap()
        }),
        ("a directory renamed", &|| {
            fs::rename(lib.at("d/x/y"), lib.at("d/x/z")).unwrap()
        }),
        ("a file removed", &|| {
            fs::remove_file(lib.at("d/x/z/three.txt")).unwrap()
        }),
    ];
    for (what, change) in changes {
        let token = settled_deep(&lib, "d", &deep);
        change();
        assert!(!same_deep(&lib, "d", &token, &deep), "{what}");
    }
    Ok(())
}

/// Noise, the caller's names, what the ignore file excludes, links and empty directories are not
/// counted, so changing them changes no deep token; a file the rule counts does.
pub fn what_the_rule_leaves_out_does_not_change_the_deep_token(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/a.txt", "a");
    lib.write("d/.gitignore", "*.log\nbuild/\n");
    lib.write("d/sub/k.txt", "k");
    let deep = json!({ "rule": { "noise": ["extra"], "ignore_file": ".gitignore" } });
    let token = settled_deep(&lib, "d", &deep);
    let changes: [(&str, &dyn Fn()); 8] = [
        ("library noise", &|| {
            lib.write("d/node_modules/x/index.js", "x")
        }),
        ("a noise name deep down", &|| {
            lib.write("d/sub/.DS_Store", "")
        }),
        ("the caller's noise name", &|| {
            lib.write("d/extra/y.txt", "y")
        }),
        ("an ignored file", &|| lib.write("d/sub/z.log", "log")),
        ("an ignored directory", &|| {
            lib.write("d/build/out.txt", "out")
        }),
        ("a link", &|| {
            std::os::unix::fs::symlink("../a.txt", lib.at("d/sub/link")).unwrap()
        }),
        ("a link pointed elsewhere", &|| {
            fs::remove_file(lib.at("d/sub/link")).unwrap();
            std::os::unix::fs::symlink("k.txt", lib.at("d/sub/link")).unwrap();
        }),
        ("empty directories", &|| lib.mkdir("d/empty/deeper")),
    ];
    for (what, change) in changes {
        change();
        assert!(same_deep(&lib, "d", &token, &deep), "{what}");
    }
    lib.write("d/sub/counted.txt", "counted");
    assert!(!same_deep(&lib, "d", &token, &deep), "a counted file");
    let without_rule = deep_now(&lib, "d", &json!({}));
    assert_ne!(
        without_rule,
        deep_now(&lib, "d", &deep),
        "the caller's rule decides what counts"
    );
    Ok(())
}

/// A deep token compares only with a deep token: a directory's own token, or any other text, is
/// `changed`, and so is `empty` while the directory is there.
pub fn only_a_deep_token_compares_with_a_deep_token(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/a.txt", "a");
    lib.write("e/a.txt", "a");
    let deep = json!({});
    let level = lib.token("d");
    let other = settled_deep(&lib, "e", &deep);
    let token = settled_deep(&lib, "d", &deep);
    for expected in [
        level.as_str(),
        "not a token at all",
        "empty",
        other.as_str(),
    ] {
        let looked = look_deep(&lib, "d", expected, &deep);
        assert_eq!(looked["failed"], json!([]), "{expected}: {looked}");
        assert_eq!(
            changed_with_deep(&looked, "d"),
            token,
            "{expected}: {looked}"
        );
    }
    Ok(())
}

pub fn a_file_in_a_deep_look_is_compared_as_usual(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "abc");
    let deep = json!({});
    let token = lib.token("f.txt");
    let looked = look_deep(&lib, "f.txt", &token, &deep);
    assert_eq!(looked["same"], 1, "{looked}");
    lib.write("f.txt", "abcdef");
    let looked = look_deep(&lib, "f.txt", &token, &deep);
    let changed = &looked["changed"][0];
    assert_eq!(changed["entry"]["kind"], "file", "{looked}");
    assert_eq!(changed["entry"]["size"], 6, "{looked}");
    assert!(
        changed.get("deep").is_none(),
        "no deep token for a file: {looked}"
    );
    Ok(())
}

pub fn a_deep_look_stops_at_its_file_limit(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..30 {
        lib.write(&format!("many/s{}/f{i:02}", i % 3), "x");
    }
    let looked = look_deep(&lib, "many", "empty", &json!({ "limit": 10 }));
    assert_eq!(looked["same"], 0, "{looked}");
    assert_eq!(looked["changed"], json!([]), "{looked}");
    let failed = &looked["failed"][0];
    assert_eq!(failed["place"], "many", "{looked}");
    assert_eq!(failed["reason"], "too_many", "{looked}");
    let at_least = failed["at_least"].as_u64().unwrap_or(0);
    assert!(
        (11..=30).contains(&at_least),
        "at least more than the limit: {looked}"
    );
    let whole = look_deep(&lib, "many", "empty", &json!({ "limit": 30 }));
    changed_with_deep(&whole, "many");
    // The default bound is 5,000 files.
    many_files(&lib.at("big"), 5_001, 1);
    let looked = look_deep(&lib, "big", "empty", &json!({}));
    assert_eq!(looked["failed"][0]["reason"], "too_many", "{looked}");
    assert!(
        looked["failed"][0]["at_least"].as_u64().unwrap_or(0) > 5_000,
        "{looked}"
    );
    let bounded = look_deep(&lib, "big", "empty", &json!({ "limit": 5_001 }));
    changed_with_deep(&bounded, "big");
    Ok(())
}

/// A deep look whose expectations are a table's rows: directories by their deep tokens, a file
/// as usual, only the differences answered.
pub fn a_deep_look_takes_expectations_from_a_table(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("p/kept/a/x.txt", "x");
    lib.write("p/touched/a/x.txt", "x");
    lib.write("p/level/a/x.txt", "x");
    lib.write("p/file.txt", "f");
    let deep = json!({});
    let row =
        |key: &str, token: &str| json!({ "key": key, "fields": { "token": token }, "value": 1 });
    let rows = vec![
        row("p/file.txt", &lib.token("p/file.txt")),
        row("p/kept", &settled_deep(&lib, "p/kept", &deep)),
        row("p/level", &lib.token("p/level")),
        row("p/touched", &settled_deep(&lib, "p/touched", &deep)),
    ];
    assert_done(&lib.run(
        "rows.put",
        json!({ "place": "looker", "table": "deep", "rows": rows }),
    ));
    lib.write("p/touched/a/b/new.txt", "new");
    let looked = lib.run(
        "look",
        json!({ "rows": { "place": "looker", "table": "deep", "field": "token" }, "deep": deep }),
    );
    assert_done(&looked);
    assert_eq!(looked["compared"], 4, "{looked}");
    assert_eq!(looked["same"], 2, "{looked}");
    let changed: Vec<(String, bool)> = looked["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["place"].as_str().unwrap().to_owned(),
                c["deep"].is_string(),
            )
        })
        .collect();
    assert_eq!(changed.len(), 2, "only the differences: {looked}");
    for place in ["p/level", "p/touched"] {
        assert!(
            changed.contains(&(place.to_owned(), true)),
            "{place} with its deep token: {looked}"
        );
    }
    Ok(())
}

/// A deep look reads no file's bytes: a file nobody may read still counts, by its state. A
/// directory under it that cannot be listed is `unreadable`, with the system's reason.
pub fn a_deep_look_reads_no_content(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("box/secret.txt", "12345");
    lib.write("box/.gitignore", "*.log\n");
    lib.write("box/inner/open.txt", "open");
    let deep = json!({ "rule": { "ignore_file": ".gitignore" } });
    let Some(_locked) = Locked::new(lib.at("box/secret.txt")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let token = settled_deep(&lib, "box", &deep);
    let looked = look_deep(&lib, "box", &token, &deep);
    assert_eq!(looked["same"], 1, "{looked}");
    assert_eq!(looked["failed"], json!([]), "{looked}");
    let Some(_inner) = Locked::new(lib.at("box/inner")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let looked = look_deep(&lib, "box", &token, &deep);
    let failed = &looked["failed"][0];
    assert_eq!(failed["place"], "box", "{looked}");
    assert_eq!(failed["reason"], "unreadable", "{looked}");
    assert!(
        failed["detail"].as_str().is_some_and(|d| !d.is_empty()),
        "the system's reason: {looked}"
    );
    Ok(())
}

/// In a record place's own area a deep look counts every file: no noise applies there.
pub fn a_deep_look_works_in_a_record_place(env: &Env) -> Outcome {
    let lib = env.lib();
    let deep = json!({});
    let in_plug = |request: Value| {
        let mut request = request;
        request["records"] = json!("plug");
        lib.run("look", request)
    };
    let empty = in_plug(json!({ "places": [{ "place": "", "token": "empty" }], "deep": deep }));
    let unmade = changed_with_deep(&empty, "");
    let same = in_plug(json!({ "places": [{ "place": "", "token": unmade }], "deep": deep }));
    assert_eq!(same["same"], 1, "an area not made yet: {same}");
    let put = |place: &str| {
        assert_done(&lib.run(
            "write",
            json!({ "place": place, "records": "plug", "from": data(b"x"), "expect": "empty" }),
        ));
    };
    put("site/index.html");
    put("site/node_modules/x.js");
    let deep_of = |token: &str| {
        in_plug(json!({ "places": [{ "place": "site", "token": token }], "deep": deep }))
    };
    let mut token = changed_with_deep(&deep_of("empty"), "site");
    let deadline = Instant::now() + SETTLE;
    while deep_of(&token)["same"] != 1 {
        assert!(Instant::now() < deadline, "never same in the area");
        token = changed_with_deep(&deep_of(&token), "site");
    }
    put("site/node_modules/y.js");
    let looked = deep_of(&token);
    assert_ne!(
        changed_with_deep(&looked, "site"),
        token,
        "a file under node_modules counts here: {looked}"
    );
    Ok(())
}

/// A same-size edit in place, right after a change, with the old modification time put back,
/// still changes the deep token taken between the two.
pub fn a_racy_deep_edit_is_seen(env: &Env) -> Outcome {
    let lib = env.lib();
    let deep = json!({});
    for round in 0..20u8 {
        let dir = format!("d{round}");
        let file = format!("{dir}/sub/f.txt");
        lib.write_bytes(&file, &bytes_of(64, round));
        let token = deep_now(&lib, &dir, &deep);
        same_size_edit(&lib.at(&file), &bytes_of(64, round.wrapping_add(100)));
        assert!(!same_deep(&lib, &dir, &token, &deep), "round {round}");
    }
    Ok(())
}
