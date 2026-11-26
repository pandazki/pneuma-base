//! `changed`'s budget (section 4) and `subscribe` (section 6): whoever stays listens, whoever runs
//! once asks with a budget. A provider with `cursor: false` answers both `cannot_say` at once. One
//! with `cursor: true` sends what it hears to a subscriber; it may also answer `changed` from any
//! process out of what a live subscriber recorded, and the checks that need that say "not
//! exercised" for a provider that does not.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::changes::{
    DEADLINE, RELIABLE, UNRELIABLE, assert_cannot_say, changes_until, cursor_of, reported,
};
use crate::harness::*;
use crate::{Outcome, not_exercised};

const NOT_RECORDED: &str = "this provider does not answer changed from what a subscriber recorded";
/// How long a provider may take to answer `changed` with no budget, inside `serve` (no process to
/// start): far less than any replay of a journal.
const AT_ONCE: Duration = Duration::from_millis(50);

/// A `serve` session subscribed to its library from `cursor` (from now when `None`).
fn subscribed(lib: &Lib, cursor: Option<&str>) -> Serve {
    let mut serve = lib.serve();
    let request = cursor.map_or(json!({}), |c| json!({ "cursor": c }));
    serve.request(json!("sub"), "subscribe", request);
    serve
}

/// The places the subscription's progress lines report until every one of `want` is there, each
/// line held to the shape of a `changed` answer. Panics past the deadline.
fn heard_until(serve: &mut Serve, want: &[String]) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let started = Instant::now();
    while !want.iter().all(|w| reported(&seen, w)) {
        let left = DEADLINE.saturating_sub(started.elapsed());
        let Some(line) = serve.receive_within(left) else {
            panic!("within {DEADLINE:?}: wanted {want:?}, the subscription sent {seen:?}");
        };
        assert_eq!(line["id"], "sub", "only the subscription sends: {line}");
        let progress = &line["progress"];
        assert!(
            progress.is_object(),
            "a subscription sends progress until cancelled: {line}"
        );
        check_answer("changed", progress);
        if progress["outcome"] == "done" {
            assert!(progress["cursor"].is_string(), "{progress}");
            seen.extend(strings_of(&progress["places"]));
        } else {
            assert_cannot_say(progress);
        }
    }
    seen
}

/// `changed` from `cursor` in a process of its own, with no budget to replay.
fn at_once(lib: &Lib, cursor: &str) -> Value {
    lib.run("changed", json!({ "cursor": cursor, "budget": 0 }))
}

/// Waits until `changed` with no budget is answered `done` from another process: a live
/// subscriber's record answers it. Gives that answer's cursor; `None` when it never is.
fn recorded(lib: &Lib) -> Option<String> {
    poll(DEADLINE, || {
        let answer = at_once(lib, &cursor_of(lib));
        (answer["outcome"] == "done").then(|| answer["cursor"].as_str().unwrap().to_owned())
    })
}

/// The places `changed` with no budget reports from `cursor`, following `more`, until each of
/// `want` is there. Gives them and the cursor after them; `None` when it answers `cannot_say`.
fn recorded_until(lib: &Lib, cursor: &str, want: &[String]) -> Option<(BTreeSet<String>, String)> {
    let mut seen = BTreeSet::new();
    let mut cursor = cursor.to_owned();
    let found = poll(DEADLINE, || {
        loop {
            let answer = at_once(lib, &cursor);
            if answer["reason"] == "cannot_say" {
                return Some(false);
            }
            assert_done(&answer);
            seen.extend(strings_of(&answer["places"]));
            cursor = answer["cursor"].as_str().unwrap().to_owned();
            if answer["more"] != true {
                break;
            }
        }
        want.iter().all(|w| reported(&seen, w)).then_some(true)
    });
    match found {
        Some(true) => Some((seen, cursor)),
        Some(false) => None,
        None => panic!("within {DEADLINE:?}: wanted {want:?}, reported {seen:?}"),
    }
}

pub fn changed_answers_within_its_budget(env: &Env) -> Outcome {
    let lib = env.lib();
    let cursor = cursor_of(&lib);
    lib.write("notes/a.md", "a");
    assert_failed(
        &lib.run("changed", json!({ "cursor": cursor, "budget": -1 })),
        "bad_request",
    );
    // No budget and nobody listening: nothing is tried, `cannot_say` comes at once.
    let mut serve = lib.serve();
    let started = Instant::now();
    let answer = serve.ask(
        json!(1),
        "changed",
        json!({ "cursor": cursor, "budget": 0 }),
    );
    let took = started.elapsed();
    assert_cannot_say(&answer);
    assert!(
        took < AT_ONCE,
        "cannot_say at once, not after trying: took {took:?}"
    );
    if env.cursor() {
        // A budget a replay fits in: the change is reported.
        changes_until(&lib, &cursor, None, &["notes/a.md".to_owned()])
            .expect("a reliable cursor with a budget of seconds says what changed");
    }
    Ok(())
}

pub fn subscribe_is_cannot_say_without_a_reliable_cursor(env: &Env) -> Outcome {
    if env.cursor() {
        return not_exercised(RELIABLE);
    }
    let lib = env.lib();
    let mut serve = lib.serve();
    assert_cannot_say(&serve.ask(json!("sub"), "subscribe", json!({})));
    Ok(())
}

pub fn subscribe_sends_what_changes_until_cancelled(env: &Env) -> Outcome {
    let lib = env.lib();
    assert_failed(&lib.run("subscribe", json!({})), "bad_request");
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    lib.mkdir("node_modules/pkg");
    let cursor = cursor_of(&lib);
    let mut serve = subscribed(&lib, Some(&cursor));
    lib.write("node_modules/pkg/index.js", "noise");
    lib.write("notes/a.md", "seen");
    lib.write("notes/b.md", "seen");
    let seen = heard_until(
        &mut serve,
        &["notes/a.md".to_owned(), "notes/b.md".to_owned()],
    );
    assert!(
        !seen.iter().any(|p| p.starts_with("node_modules")),
        "noise is not sent: {seen:?}"
    );
    serve.request(json!("c"), "cancel", json!({ "target": "sub" }));
    let (_, ended) = serve.answer_for(&json!("sub"));
    assert_failed(&ended, "cancelled");
    assert_eq!(serve.finish(), 0);
    Ok(())
}

pub fn subscribe_covers_the_gap_from_its_cursor(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    let cursor = cursor_of(&lib);
    lib.write("before/a.md", "written while nobody listened");
    let mut serve = subscribed(&lib, Some(&cursor));
    heard_until(&mut serve, &["before/a.md".to_owned()]);
    lib.write("after/b.md", "written while listening");
    heard_until(&mut serve, &["after/b.md".to_owned()]);
    // Input ending ends the subscription too.
    assert_eq!(serve.finish(), 0);
    Ok(())
}

pub fn a_subscribers_record_answers_changed_as_a_replay_would(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    lib.mkdir("node_modules/pkg");
    let mut serve = subscribed(&lib, None);
    let Some(cursor) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    lib.write("node_modules/pkg/index.js", "noise");
    lib.write("notes/.DS_Store", "noise");
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    let want = ["notes/a.md".to_owned(), "deep/er/b.md".to_owned()];
    lib.write("notes/a.md", "a");
    lib.write("deep/er/b.md", "b");
    let (mut from_record, after) = recorded_until(&lib, &cursor, &want)
        .expect("a live subscriber's record covers a cursor taken while it listens");
    // Whatever came late is in the record by now too.
    std::thread::sleep(Duration::from_millis(500));
    from_record.extend(recorded_until(&lib, &after, &[]).map_or_else(BTreeSet::new, |(p, _)| p));
    serve.request(json!("c"), "cancel", json!({ "target": "sub" }));
    serve.answer_for(&json!("sub"));
    poll(DEADLINE, || {
        (at_once(&lib, &cursor)["reason"] == "cannot_say").then_some(())
    })
    .expect("once nobody listens, no record answers");
    let from_replay = changes_until(&lib, &cursor, None, &want).expect("a replay within budget");
    for place in &from_record {
        assert!(
            !place.starts_with(".pneuma-base")
                && !place
                    .split('/')
                    .any(|s| s == "node_modules" || s == ".DS_Store"),
            "{place} is noise or records: {from_record:?}"
        );
    }
    assert_eq!(from_record, from_replay, "the record and the replay agree");
    Ok(())
}

pub fn a_subscriber_that_stops_without_warning_is_noticed(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    let serve = subscribed(&lib, None);
    let Some(cursor) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    serve.kill();
    lib.write("after-the-kill.md", "x");
    // The next reader does not answer from the dead subscriber's record as if it were whole.
    let answer = at_once(&lib, &cursor);
    if answer["outcome"] == "done" {
        assert!(
            reported(
                &strings_of(&answer["places"]).into_iter().collect(),
                "after-the-kill.md"
            ),
            "a change after the subscriber died is not left out: {answer}"
        );
    } else {
        assert_cannot_say(&answer);
    }
    Ok(())
}

pub fn two_subscribers_keep_one_log(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    let first = subscribed(&lib, None);
    let Some(cursor) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    let mut second = subscribed(&lib, Some(&cursor));
    lib.write("both/a.md", "a");
    let (_, cursor) = recorded_until(&lib, &cursor, &["both/a.md".to_owned()])
        .expect("two subscribers, one record");
    heard_until(&mut second, &["both/a.md".to_owned()]);
    // The one that came first stops; the other carries the record on.
    first.kill();
    lib.write("both/b.md", "b");
    let carried = poll(DEADLINE, || {
        let answer = at_once(&lib, &cursor);
        let places: BTreeSet<String> = match answer["outcome"].as_str() {
            Some("done") => strings_of(&answer["places"]).into_iter().collect(),
            _ => return None,
        };
        reported(&places, "both/b.md").then_some(())
    });
    assert!(
        carried.is_some(),
        "the remaining subscriber answers for the time after the other stopped"
    );
    heard_until(&mut second, &["both/b.md".to_owned()]);
    Ok(())
}

pub fn the_record_is_bounded_and_overflow_is_cannot_say(env: &Env) -> Outcome {
    // The bound is the local folder's (core/README.md): 10,000 places.
    const BOUND: usize = 10_000;
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    if !env.facet("fs") {
        return not_exercised("the bound checked is the local folder's");
    }
    let lib = env.lib();
    let _serve = subscribed(&lib, None);
    let Some(old) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    let dirs = BOUND / 1_000 + 1;
    for d in 0..dirs {
        many_files(&lib.at(&format!("many/d{d}")), 1_000, d as u8);
    }
    // A reader as old as the start is behind what the record keeps, while it still answers
    // recent readers.
    let behind = poll(DEADLINE, || {
        let answer = at_once(&lib, &old);
        let live = at_once(&lib, &cursor_of(&lib))["outcome"] == "done";
        (live && answer["reason"] == "cannot_say").then_some(answer)
    });
    assert!(
        behind.is_some(),
        "more than {BOUND} places since a cursor: cannot_say for it"
    );
    Ok(())
}

pub fn a_burst_within_the_bound_is_answered_whole(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    if !env.facet("fs") {
        return not_exercised("the bound is the local folder's");
    }
    const FILES: usize = 2_000;
    let lib = env.lib();
    many_files(&lib.at("burst"), FILES, 0);
    let _serve = subscribed(&lib, None);
    let Some(cursor) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    // Every file rewritten as fast as this process can: more than the system hands a listener at once.
    many_files(&lib.at("burst"), FILES, 1);
    let want: Vec<String> = (0..FILES)
        .map(|i| format!("burst/d{:02}/f{i:05}", i % 16))
        .collect();
    assert!(
        recorded_until(&lib, &cursor, &want).is_some(),
        "{FILES} places changed at once, within the bound: the record answers them all"
    );
    Ok(())
}

pub fn deleting_the_record_changes_only_time(env: &Env) -> Outcome {
    if !env.cursor() {
        return not_exercised(UNRELIABLE);
    }
    let lib = env.lib();
    let _serve = subscribed(&lib, None);
    let Some(cursor) = recorded(&lib) else {
        return not_exercised(NOT_RECORDED);
    };
    let cache = lib.at(".pneuma-base/cache");
    if !cache.is_dir() {
        return not_exercised(super::rules::NO_CACHE_AREA);
    }
    std::fs::remove_dir_all(&cache).unwrap();
    lib.write("after-delete.md", "x");
    // Right away: what it answers is never less than what changed.
    let answer = at_once(&lib, &cursor);
    if answer["outcome"] == "done" {
        assert!(
            reported(
                &strings_of(&answer["places"]).into_iter().collect(),
                "after-delete.md"
            ),
            "{answer}"
        );
    } else {
        assert_cannot_say(&answer);
    }
    // And the subscriber makes a new record.
    let fresh = recorded(&lib).expect("a new record after the old one was deleted");
    lib.write("later.md", "y");
    recorded_until(&lib, &fresh, &["later.md".to_owned()]).expect("the new record answers");
    Ok(())
}
