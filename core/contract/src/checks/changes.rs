//! `changed` (section 4, rule 2.3). What a provider owes depends on what `describe` says: with
//! `cursor: false` every `changed` given a cursor answers `cannot_say`; with `cursor: true` a
//! change made after a cursor is reported (the system's journal delivers with latency, so these
//! checks poll with a deadline), noise and the record area are not, and a cursor made on another
//! folder answers `cannot_say`.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub(super) const DEADLINE: Duration = Duration::from_secs(10);
pub(super) const UNRELIABLE: &str = "describe says cursor: false";
pub(super) const RELIABLE: &str = "describe says cursor: true";

pub(super) fn cursor_of(lib: &Lib) -> String {
    let answer = lib.run("changed", json!({}));
    assert_done(&answer);
    answer["cursor"].as_str().unwrap().to_owned()
}

pub(super) fn assert_cannot_say(answer: &Value) {
    assert_failed(answer, "cannot_say");
    assert!(
        answer["cursor"].as_str().is_some_and(|c| !c.is_empty()),
        "cannot_say comes with a new cursor: {answer}"
    );
}

/// Whether `place` was reported, itself or as the directory it is in (4.s6).
pub(super) fn reported(places: &BTreeSet<String>, place: &str) -> bool {
    let parent = place.rsplit_once('/').map_or("", |(dir, _)| dir);
    places.contains(place) || places.contains(parent)
}

/// Asks from `cursor`, following `more`, until `want` is reported or the deadline passes; gives
/// every place reported on the way, or `None` when the provider answers `cannot_say`.
pub(super) fn changes_until(
    lib: &Lib,
    cursor: &str,
    limit: Option<u64>,
    want: &[String],
) -> Option<BTreeSet<String>> {
    let mut seen = BTreeSet::new();
    let found = poll(DEADLINE, || {
        let mut cursor = cursor.to_owned();
        loop {
            let mut request = json!({ "cursor": cursor });
            if let Some(limit) = limit {
                request["limit"] = json!(limit);
            }
            let answer = lib.run("changed", request);
            if answer["reason"] == "cannot_say" {
                assert_cannot_say(&answer);
                return Some(false);
            }
            assert_done(&answer);
            let places = strings_of(&answer["places"]);
            if let Some(limit) = limit {
                assert!(places.len() as u64 <= limit, "at most the limit: {answer}");
            }
            seen.extend(places);
            cursor = answer["cursor"].as_str().unwrap().to_owned();
            if answer["more"] != true {
                break;
            }
        }
        want.iter().all(|w| reported(&seen, w)).then_some(true)
    });
    match found {
        Some(true) => Some(seen),
        Some(false) => None,
        None => panic!("within {DEADLINE:?}: wanted {want:?}, reported {seen:?}"),
    }
}

/// Runs `attempt` until it is not answered `cannot_say`. A reliable cursor may still answer
/// `cannot_say` for a period the system's journal cannot vouch for (events dropped under load),
/// but not every time.
fn reliably<T>(mut attempt: impl FnMut(usize) -> Option<T>) -> T {
    // Spread over about ten seconds: on a loaded machine the journal can be unsettled for a few
    // seconds at a stretch, and attempts made back to back would all fall inside one such stretch.
    const ATTEMPTS: usize = 8;
    for k in 0..ATTEMPTS {
        if let Some(done) = attempt(k) {
            return done;
        }
        std::thread::sleep(std::time::Duration::from_millis(100 << k.min(5)));
    }
    panic!("cannot_say {ATTEMPTS} times in a row, from a provider whose describe says cursor: true")
}

pub fn changed_cannot_say_without_a_reliable_cursor(env: &Env) -> Outcome {
    if env.cursor() {
        return not_exercised(RELIABLE);
    }
    let lib = env.lib();
    let mut cursor = cursor_of(&lib);
    for k in 0..3 {
        lib.write(&format!("f{k}"), "x");
        let answer = lib.run("changed", json!({ "cursor": cursor }));
        assert_cannot_say(&answer);
        cursor = answer["cursor"].as_str().unwrap().to_owned();
    }
    let other = env.lib();
    assert_cannot_say(&lib.run("changed", json!({ "cursor": cursor_of(&other) })));
    Ok(())
}

pub fn changed_reports_a_change_after_the_cursor(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    lib.mkdir("node_modules/pkg");
    let src = scratch();
    std::fs::write(src.path().join("b"), "b").unwrap();
    let seen = reliably(|k| {
        lib.mkdir(&format!("notes{k}"));
        let cursor = cursor_of(&lib);
        // Noise and records first, then the changes that must be seen: once they are, the others
        // were delivered too, and none of them may be among the places.
        lib.write(&format!("node_modules/pkg/index{k}.js"), "noise");
        lib.write(&format!("notes{k}/.DS_Store"), "noise");
        lib.run(
            "facts.append",
            json!({ "place": "log", "facts": [{ "n": k }] }),
        );
        lib.run(
            "rows.put",
            json!({ "place": "log", "table": "t", "rows": [{ "key": "k", "value": k }] }),
        );
        lib.write(&format!("notes{k}/a.md"), "seen");
        lib.run(
            "write",
            json!({ "place": format!("notes{k}/b.md"), "from": src.path().join("b"), "expect": "empty" }),
        );
        let want = [format!("notes{k}/a.md"), format!("notes{k}/b.md")];
        changes_until(&lib, &cursor, None, &want)
    });
    for place in &seen {
        assert!(
            !place.starts_with(".pneuma-base")
                && !place
                    .split('/')
                    .any(|s| s == "node_modules" || s == ".DS_Store"),
            "{place} is noise or records: {seen:?}"
        );
    }
    // The cursor an answer gives carries on, in another process (each call is one).
    reliably(|k| {
        let answer = lib.run("changed", json!({ "cursor": cursor_of(&lib) }));
        if answer["reason"] == "cannot_say" {
            return None;
        }
        assert_done(&answer);
        let later = answer["cursor"].as_str().unwrap().to_owned();
        lib.write(&format!("later{k}.md"), "later");
        changes_until(&lib, &later, None, &[format!("later{k}.md")])
    });
    Ok(())
}

pub fn changed_stops_at_its_limit(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    reliably(|k| {
        let dirs: Vec<String> = (0..6).map(|d| format!("a{k}/d{d}")).collect();
        for dir in &dirs {
            lib.mkdir(dir);
        }
        let cursor = cursor_of(&lib);
        let want: Vec<String> = dirs.iter().map(|d| format!("{d}/f")).collect();
        for place in &want {
            lib.write(place, "x");
        }
        changes_until(&lib, &cursor, Some(2), &want)
    });
    Ok(())
}

pub fn changed_cannot_say_for_another_folder(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let (here, there) = (env.lib(), env.lib());
    let foreign = cursor_of(&there);
    let answer = here.run("changed", json!({ "cursor": foreign }));
    assert_cannot_say(&answer);
    // The cursor it gives instead is good here.
    let mut fresh = answer["cursor"].clone();
    reliably(|_| {
        let answer = here.run("changed", json!({ "cursor": fresh }));
        if answer["reason"] == "cannot_say" {
            fresh = answer["cursor"].clone();
            return None;
        }
        assert_done(&answer);
        Some(())
    });
    Ok(())
}

pub fn a_record_area_is_never_reported_by_changed(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    let seen = reliably(|k| {
        let cursor = cursor_of(&lib);
        // The record place's own area first, then a change that must be seen: once it is, the
        // other was delivered too.
        let written = lib.run(
            "write",
            json!({ "records": "plug", "place": format!("only-in-records{k}.txt"), "from": data(b"r"), "expect": "empty" }),
        );
        assert_done(&written);
        lib.write(&format!("marker{k}.md"), "m");
        changes_until(&lib, &cursor, None, &[format!("marker{k}.md")])
    });
    for place in &seen {
        assert!(
            !place.contains("only-in-records") && !place.starts_with(".pneuma-base"),
            "{place} is in a record place's area: {seen:?}"
        );
    }
    Ok(())
}
