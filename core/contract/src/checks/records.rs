//! Section 5: facts and rows. Checks that place files in the local-folder record layout
//! (`.pneuma-base/<record place>/facts/…`) run only where the provider keeps that layout.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub const NO_FACT_LAYOUT: &str = "the provider does not keep facts in the local-folder layout (.pneuma-base/<place>/facts/<day>/)";

/// The facts directory of `place` in the local-folder layout, after one append made it.
fn facts_dir(lib: &Lib, place: &str) -> Option<PathBuf> {
    let dir = lib.at(&format!(".pneuma-base/{place}/facts"));
    let dated = fs::read_dir(&dir).ok()?.flatten().any(|e| {
        let name = e.file_name();
        let name = name.to_string_lossy();
        name.len() == 10 && name.as_bytes()[4] == b'-' && e.path().is_dir()
    });
    dated.then_some(dir)
}

fn local_fact_layout(lib: &Lib) -> bool {
    lib.run(
        "facts.append",
        json!({ "place": "probe-layout", "facts": [{ "layout": true }] }),
    );
    facts_dir(lib, "probe-layout").is_some()
}

pub fn append_gives_one_order_per_fact(env: &Env) -> Outcome {
    let lib = env.lib();
    let appended = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "a": 1 }, { "b": [2, "x"] }, { "c": { "d": null } }] }),
    );
    let orders = strings_of(&appended["orders"]);
    assert_eq!(orders.len(), 3);
    assert_eq!(orders.iter().collect::<BTreeSet<_>>().len(), 3);
    let since = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(orders_of(&since), orders);
    assert_eq!(
        facts_of(&since),
        [
            json!({ "a": 1 }),
            json!({ "b": [2, "x"] }),
            json!({ "c": { "d": null } })
        ]
    );
    let one = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "e": 5 }] }),
    );
    assert_eq!(one["orders"].as_array().unwrap().len(), 1, "{one}");
    for bad in [
        json!({ "place": "log", "facts": [1] }),
        json!({ "place": "Bad Name", "facts": [{}] }),
    ] {
        assert_failed(&lib.run("facts.append", bad), "bad_request");
    }
    Ok(())
}

pub fn facts_since_gives_only_what_follows_the_cursor(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }, { "n": 2 }] }),
    );
    let first = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(facts_of(&first), [json!({ "n": 1 }), json!({ "n": 2 })]);
    assert_eq!(first["more"], false);
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 3 }, { "n": 4 }, { "n": 5 }] }),
    );
    let second = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": first["cursor"] }),
    );
    assert_eq!(
        facts_of(&second),
        [json!({ "n": 3 }), json!({ "n": 4 }), json!({ "n": 5 })]
    );
    let third = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": second["cursor"] }),
    );
    assert_eq!(facts_of(&third), Vec::<Value>::new());
    assert_eq!(third["more"], false);
    let mut paged = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = lib.run(
            "facts.since",
            json!({ "place": "log", "cursor": cursor, "limit": 2 }),
        );
        assert!(page["facts"].as_array().unwrap().len() <= 2, "{page}");
        paged.extend(facts_of(&page));
        cursor = page["cursor"].clone();
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(
        paged,
        (1..=5).map(|n| json!({ "n": n })).collect::<Vec<_>>()
    );
    Ok(())
}

pub fn a_long_read_gives_every_fact_once_in_order(env: &Env) -> Outcome {
    let lib = env.lib();
    let mut appended = Vec::new();
    for n in 0..300 {
        let answer = lib.run(
            "facts.append",
            json!({ "place": "log", "facts": [{ "n": n }] }),
        );
        appended.extend(strings_of(&answer["orders"]));
    }
    let (mut orders, mut facts, mut cursor) = (Vec::new(), Vec::new(), Value::Null);
    loop {
        let page = lib.run(
            "facts.since",
            json!({ "place": "log", "cursor": cursor, "limit": 200 }),
        );
        orders.extend(orders_of(&page));
        facts.extend(facts_of(&page));
        cursor = page["cursor"].clone();
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(orders, appended);
    assert_eq!(
        facts,
        (0..300).map(|n| json!({ "n": n })).collect::<Vec<_>>()
    );
    Ok(())
}

pub fn a_read_from_no_cursor_counts_the_facts_files(env: &Env) -> Outcome {
    let lib = env.lib();
    for facts in [
        json!([{ "n": 1 }]),
        json!([{ "n": 2 }, { "n": 3 }]),
        json!([{ "n": 4 }]),
    ] {
        lib.run("facts.append", json!({ "place": "log", "facts": facts }));
    }
    let first = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": null, "limit": 1 }),
    );
    match first.get("files") {
        Some(files) => assert_eq!(files, &json!(3), "{first}"),
        None if facts_dir(&lib, "log").is_some() => {
            panic!("the local layout counts its facts files: {first}")
        }
        None => return not_exercised("the provider does not count facts files"),
    }
    Ok(())
}

pub fn facts_are_only_appended(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }, { "n": 2 }] }),
    );
    let before = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    for n in 3..6 {
        lib.run(
            "facts.append",
            json!({ "place": "log", "facts": [{ "n": n }] }),
        );
    }
    let after = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    let (old, new) = (
        before["facts"].as_array().unwrap(),
        after["facts"].as_array().unwrap(),
    );
    assert_eq!(new.len(), 5);
    assert_eq!(
        &new[..2],
        &old[..],
        "what was there stays, in its order, with its orders"
    );
    Ok(())
}

/// Facts live in the library folder: a copy of the folder reads the same facts.
pub fn facts_travel_with_the_folder(env: &Env) -> Outcome {
    let lib = env.lib();
    for n in 0..3 {
        lib.run(
            "facts.append",
            json!({ "place": "log", "facts": [{ "n": n }] }),
        );
    }
    let copy = env.bare();
    copy_tree(lib.root(), copy.root());
    assert_eq!(all_facts(&copy, "log"), all_facts(&lib, "log"));
    Ok(())
}

pub fn limit_zero_gives_a_cursor_at_the_end(env: &Env) -> Outcome {
    let lib = env.lib();
    if local_fact_layout(&lib) {
        lib.write(".pneuma-base/log/facts/scene-a/001.jsonl", "{\"old\":1}\n");
    }
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }, { "n": 2 }] }),
    );
    let end = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": null, "limit": 0 }),
    );
    assert_eq!(facts_of(&end), Vec::<Value>::new());
    assert_eq!(end["more"], false);
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 3 }] }),
    );
    let next = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": end["cursor"] }),
    );
    assert_eq!(facts_of(&next), [json!({ "n": 3 })]);
    let empty = env.lib();
    let nothing = empty.run(
        "facts.since",
        json!({ "place": "log", "cursor": null, "limit": 0 }),
    );
    empty.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "first": true }] }),
    );
    let first = empty.run(
        "facts.since",
        json!({ "place": "log", "cursor": nothing["cursor"] }),
    );
    assert_eq!(facts_of(&first), [json!({ "first": true })]);
    Ok(())
}

pub fn the_cursor_at_the_end_is_the_same_while_nothing_changes(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    let ask = || {
        lib.run(
            "facts.since",
            json!({ "place": "log", "cursor": null, "limit": 0 }),
        )["cursor"]
            .clone()
    };
    let first = ask();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(ask(), first);
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 2 }] }),
    );
    assert_ne!(ask(), first);
    Ok(())
}

pub fn a_cursor_that_no_longer_fits_is_refused(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    let Some(facts_dir) = facts_dir(&lib, "log") else {
        return not_exercised(NO_FACT_LAYOUT);
    };
    // Aged directories let the cursor vouch for "nothing new" by tokens alone.
    for entry in fs::read_dir(&facts_dir).unwrap() {
        set_mtime(&entry.unwrap().path(), an_hour_ago());
    }
    set_mtime(&facts_dir, an_hour_ago());
    let cursor =
        lib.run("facts.since", json!({ "place": "log", "cursor": null }))["cursor"].clone();
    assert_eq!(
        facts_of(&lib.run("facts.since", json!({ "place": "log", "cursor": cursor }))),
        Vec::<Value>::new()
    );
    let refused = json!({ "outcome": "refused", "reason": "refused" });
    fs::remove_dir_all(&facts_dir).unwrap();
    assert_eq!(
        lib.run("facts.since", json!({ "place": "log", "cursor": cursor })),
        refused
    );
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 2 }] }),
    );
    assert_eq!(
        lib.run("facts.since", json!({ "place": "log", "cursor": cursor })),
        refused
    );

    // A cursor standing on no dated file still belongs to the folder it was made on. The old
    // folder is moved aside rather than deleted, so a file system that reuses inode numbers
    // cannot give the new folder the old one's.
    let old_only = env.lib();
    old_only.write(".pneuma-base/log/facts/scene-a/001.jsonl", "{\"old\":1}\n");
    let cursor =
        old_only.run("facts.since", json!({ "place": "log", "cursor": null }))["cursor"].clone();
    fs::rename(
        old_only.at(".pneuma-base/log/facts"),
        old_only.at(".pneuma-base/log/facts-before"),
    )
    .unwrap();
    old_only.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    assert_eq!(
        old_only.run("facts.since", json!({ "place": "log", "cursor": cursor })),
        refused
    );

    let other = env.lib();
    let one = other.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
    let cursor =
        other.run("facts.since", json!({ "place": "log", "cursor": null }))["cursor"].clone();
    other.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 2 }] }),
    );
    let file = one["orders"][0]
        .as_str()
        .unwrap()
        .split('#')
        .next()
        .unwrap()
        .to_owned();
    fs::remove_file(other.at(&format!(".pneuma-base/log/facts/{file}"))).unwrap();
    assert_eq!(
        other.run("facts.since", json!({ "place": "log", "cursor": cursor })),
        refused
    );
    Ok(())
}

pub fn facts_since_with_nothing_new_survives_an_unreadable_old_day(env: &Env) -> Outcome {
    let lib = env.lib();
    if !local_fact_layout(&lib) {
        return not_exercised(NO_FACT_LAYOUT);
    }
    lib.write(
        ".pneuma-base/log/facts/2026-01-02/20260102030405006-old-000000.jsonl",
        "{\"old\":1}\n",
    );
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "new": 1 }] }),
    );
    let all = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(facts_of(&all), [json!({ "old": 1 }), json!({ "new": 1 })]);
    let Some(_locked) = Locked::new(lib.at(".pneuma-base/log/facts/2026-01-02")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let again = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": all["cursor"] }),
    );
    assert_eq!(
        again["outcome"], "done",
        "nothing new reads no old day: {again}"
    );
    assert_eq!(facts_of(&again), Vec::<Value>::new());
    Ok(())
}

pub fn each_append_is_its_own_file_under_its_day(env: &Env) -> Outcome {
    let lib = env.lib();
    let one = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "a": 1 }] }),
    );
    let two = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "b": 2 }] }),
    );
    if facts_dir(&lib, "log").is_none() {
        return not_exercised(NO_FACT_LAYOUT);
    }
    let file_of = |answer: &Value| {
        answer["orders"][0]
            .as_str()
            .unwrap()
            .split('#')
            .next()
            .unwrap()
            .to_owned()
    };
    let (first, second) = (file_of(&one), file_of(&two));
    assert_ne!(first, second);
    let today = day_and_stamp(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    )
    .0;
    for file in [&first, &second] {
        let (day, _) = file.split_once('/').unwrap();
        assert!(day == today || day < today.as_str(), "{day}");
        let path = lib.at(&format!(".pneuma-base/log/facts/{file}"));
        let text = fs::read_to_string(path).unwrap();
        assert_eq!(text.lines().count(), 1);
    }
    Ok(())
}

pub fn the_old_layout_is_still_read(env: &Env) -> Outcome {
    let lib = env.lib();
    if !local_fact_layout(&lib) {
        return not_exercised(NO_FACT_LAYOUT);
    }
    lib.write(
        ".pneuma-base/log/facts/scene-a/001.jsonl",
        "{\"old\":1}\nnot json\n{\"old\":2}\n",
    );
    lib.write(".pneuma-base/log/facts/scene-b/001.jsonl", "{\"old\":3}\n");
    lib.write(".pneuma-base/log/facts/0001-flat.jsonl", "{\"flat\":1}\n");
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "new": 1 }] }),
    );
    let since = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(
        facts_of(&since),
        [
            json!({ "flat": 1 }),
            json!({ "old": 1 }),
            json!({ "old": 2 }),
            json!({ "old": 3 }),
            json!({ "new": 1 })
        ]
    );
    let orders = orders_of(&since);
    assert_eq!(
        orders[..4],
        [
            "old//0001-flat.jsonl#1",
            "old/scene-a/001.jsonl#1",
            "old/scene-a/001.jsonl#3",
            "old/scene-b/001.jsonl#1"
        ]
    );
    // Old-layout files that arrive after the first read (a sync) are still given.
    lib.write(".pneuma-base/log/facts/scene-c/001.jsonl", "{\"old\":4}\n");
    let later = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": since["cursor"] }),
    );
    assert_eq!(facts_of(&later), [json!({ "old": 4 })]);
    Ok(())
}

pub fn a_long_file_of_the_old_layout_is_read_page_by_page(env: &Env) -> Outcome {
    let lib = env.lib();
    if !local_fact_layout(&lib) {
        return not_exercised(NO_FACT_LAYOUT);
    }
    // More than a megabyte in one file, with a line that is not a fact in it.
    let pad = "x".repeat(200);
    let mut text = String::new();
    for n in 0..6000 {
        text.push_str(&format!("{{\"n\":{n},\"pad\":\"{pad}\"}}\n"));
        if n == 2500 {
            text.push_str("not json\n");
        }
    }
    lib.write(".pneuma-base/log/facts/scene-a/001.jsonl", &text);
    let (mut seen, mut cursor) = (Vec::new(), Value::Null);
    loop {
        let page = lib.run(
            "facts.since",
            json!({ "place": "log", "cursor": cursor, "limit": 1000 }),
        );
        assert!(page["facts"].as_array().unwrap().len() <= 1000, "{page}");
        seen.extend(facts_of(&page).iter().map(|f| f["n"].as_i64().unwrap()));
        cursor = page["cursor"].clone();
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(seen, (0..6000).collect::<Vec<_>>());
    Ok(())
}

/// Files that arrive late (a sync, a slow writer) under the newest day or an older one are still
/// given after the cursor.
pub fn a_late_linked_file_is_still_given(env: &Env) -> Outcome {
    let lib = env.lib();
    let appended = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": "newest" }] }),
    );
    if facts_dir(&lib, "log").is_none() {
        return not_exercised(NO_FACT_LAYOUT);
    }
    let cursor =
        lib.run("facts.since", json!({ "place": "log", "cursor": null }))["cursor"].clone();
    let order = appended["orders"][0].as_str().unwrap();
    let stamp = &order.split_once('/').unwrap().1[..17];
    let newest = stamp_ms(stamp);
    let place_late = |ms: i64, writer: &str, fact: &str| {
        let (day, stamp) = day_and_stamp(ms);
        lib.write(
            &format!(".pneuma-base/log/facts/{day}/{stamp}-{writer}-000000.jsonl"),
            &format!("{fact}\n"),
        );
    };
    place_late(newest - 5_000, "latewriter", "{\"n\":\"late\"}");
    place_late(newest - 86_400_000, "stalewriter", "{\"n\":\"stale\"}");
    let later = lib.run("facts.since", json!({ "place": "log", "cursor": cursor }));
    assert_eq!(
        facts_of(&later),
        [json!({ "n": "stale" }), json!({ "n": "late" })]
    );
    let again = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": later["cursor"] }),
    );
    assert_eq!(facts_of(&again), Vec::<Value>::new());
    Ok(())
}

pub fn rows_put_then_get_round_trips(env: &Env) -> Outcome {
    let lib = env.lib();
    let put = lib.run(
        "rows.put",
        json!({ "place": "p", "table": "items", "rows": [
            { "key": "a", "fields": { "scene": "s1" }, "value": { "title": "A", "n": [1, 2] } },
            { "key": "b", "value": "plain" },
        ] }),
    );
    assert_done(&put);
    lib.run(
        "rows.put",
        json!({ "place": "p", "tables": { "other": [{ "key": "a", "value": 7 }] } }),
    );
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "items", "keys": ["b", "a", "zz"] }),
    );
    assert_eq!(
        got["rows"],
        json!([
            { "key": "b", "value": "plain" },
            { "key": "a", "fields": { "scene": "s1" }, "value": { "title": "A", "n": [1, 2] } },
        ])
    );
    assert!(got["cursor"].is_null());
    assert_eq!(
        lib.run(
            "rows.get",
            json!({ "place": "p", "table": "other", "keys": ["a"] })
        )["rows"][0]["value"],
        7
    );
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "items", "rows": [{ "key": "a", "value": null }] }),
    );
    let after = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "items", "keys": ["a"] }),
    );
    assert_eq!(after["rows"], json!([]));
    let by_field = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "items", "field": "scene", "value": "s1" }),
    );
    assert_eq!(by_field["rows"], json!([]));
    Ok(())
}

pub fn rows_under_pages_by_prefix(env: &Env) -> Outcome {
    let lib = env.lib();
    let rows: Vec<Value> = ["a/1", "a/2", "a/3", "a/4", "a/5", "b/1", "a"]
        .iter()
        .map(|k| json!({ "key": k, "value": k }))
        .collect();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": rows }),
    );
    let keys = |answer: &Value| -> Vec<String> {
        answer["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["key"].as_str().unwrap().to_owned())
            .collect()
    };
    let one = lib.run(
        "rows.under",
        json!({ "place": "p", "table": "t", "prefix": "a/", "limit": 2 }),
    );
    assert_eq!(keys(&one), ["a/1", "a/2"]);
    let two = lib.run(
        "rows.under",
        json!({ "place": "p", "table": "t", "prefix": "a/", "limit": 2, "after": one["more"]["after"] }),
    );
    assert_eq!(keys(&two), ["a/3", "a/4"]);
    let three = lib.run(
        "rows.under",
        json!({ "place": "p", "table": "t", "prefix": "a/", "limit": 2, "after": two["more"]["after"] }),
    );
    assert_eq!(keys(&three), ["a/5"]);
    assert!(three["more"].is_null());
    assert_eq!(
        keys(&lib.run(
            "rows.under",
            json!({ "place": "p", "table": "t", "prefix": "b/" })
        )),
        ["b/1"]
    );
    Ok(())
}

pub fn rows_where_pages_and_counts(env: &Env) -> Outcome {
    let lib = env.lib();
    let rows: Vec<Value> = (0..7)
        .map(|i| json!({ "key": format!("k{i}"), "fields": { "scene": if i % 2 == 0 { "even" } else { "odd" } }, "value": i }))
        .collect();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": rows }),
    );
    let page = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "scene", "value": "even", "limit": 3 }),
    );
    let keys: Vec<&str> = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["k0", "k2", "k4"]);
    let rest = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "scene", "value": "even", "after": page["more"]["after"] }),
    );
    assert_eq!(rest["rows"][0]["key"], "k6");
    assert!(rest["more"].is_null());
    let count = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "scene", "value": "odd", "count": true }),
    );
    assert_eq!(count["count"], 3);
    Ok(())
}

pub fn rows_reset_drops_rows_and_cursor(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 1 }], "cursor": "c9" }),
    );
    assert_eq!(
        lib.run("rows.reset", json!({ "place": "p" }))["outcome"],
        "done"
    );
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(got["rows"], json!([]));
    assert!(got["cursor"].is_null());
    assert_eq!(
        lib.run("rows.reset", json!({ "place": "never-used" }))["outcome"],
        "done"
    );
    Ok(())
}

pub fn rows_are_a_cache_that_can_be_deleted(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 1 }], "cursor": "c1" }),
    );
    let cache = lib.at(".pneuma-base/cache");
    if !cache.is_dir() {
        return not_exercised(super::rules::NO_CACHE_AREA);
    }
    fs::remove_dir_all(&cache).unwrap();
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(got["outcome"], "done");
    assert_eq!(got["rows"], json!([]));
    assert!(got["cursor"].is_null());
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 2 }] }),
    );
    assert_eq!(
        lib.run(
            "rows.get",
            json!({ "place": "p", "table": "t", "keys": ["k"] })
        )["rows"][0]["value"],
        2
    );
    Ok(())
}

pub fn rows_put_with_a_wrong_expectation_changes_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    let put = |rows: Value, extra: Value| {
        let mut request = json!({ "place": "p", "table": "t", "rows": rows });
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        lib.run("rows.put", request)
    };
    assert_eq!(
        put(
            json!([{ "key": "k1", "value": 1 }]),
            json!({ "cursor": "c1" })
        )["outcome"],
        "done"
    );
    let refused = put(
        json!([{ "key": "k1", "value": 2 }]),
        json!({ "cursor": "c2", "expect": "c0" }),
    );
    assert_refused(&refused);
    assert_eq!(refused["actual"], "c1");
    let refused = put(
        json!([{ "key": "k1", "value": 3 }]),
        json!({ "expect": null }),
    );
    assert_eq!(refused["actual"], "c1");
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k1"] }),
    );
    assert_eq!(got["rows"][0]["value"], 1);
    assert_eq!(got["cursor"], "c1");
    assert_eq!(
        put(
            json!([{ "key": "k1", "value": 4 }]),
            json!({ "cursor": "c2", "expect": "c1" })
        )["outcome"],
        "done"
    );
    let fresh = env.lib();
    let first = fresh.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [], "cursor": "c1", "expect": null }),
    );
    assert_eq!(first["outcome"], "done");
    Ok(())
}

pub fn rows_and_cursor_change_in_one_commit(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 1 }], "cursor": "c1" }),
    );
    let failed = lib.run("rows.put", json!({ "place": "p", "tables": {
        "t": [{ "key": "k", "value": 2 }],
        "u": [{ "key": "x", "fields": { "a": "1", "b": "2", "c": "3" }, "value": 0 }, { "key": "y", "fields": { "d": "4", "e": "5" }, "value": 0 }],
    }, "cursor": "c2" }));
    assert_failed(&failed, "bad_request");
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(got["rows"][0]["value"], 1);
    assert_eq!(got["cursor"], "c1");
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 3 }], "cursor": "c3" }),
    );
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k"] }),
    );
    assert_eq!(
        (got["rows"][0]["value"].clone(), got["cursor"].clone()),
        (json!(3), json!("c3"))
    );
    Ok(())
}

pub fn fields_are_at_most_four_strings_per_table(env: &Env) -> Outcome {
    let lib = env.lib();
    let put = |rows: Value| {
        lib.run(
            "rows.put",
            json!({ "place": "p", "table": "t", "rows": rows }),
        )
    };
    assert_failed(
        &put(
            json!([{ "key": "k", "fields": { "a": "1", "b": "2", "c": "3", "d": "4", "e": "5" }, "value": 0 }]),
        ),
        "bad_request",
    );
    assert_failed(
        &put(json!([{ "key": "k", "fields": { "a": 1 }, "value": 0 }])),
        "bad_request",
    );
    assert_eq!(
        put(
            json!([{ "key": "k1", "fields": { "a": "1", "b": "2", "c": "3", "d": "4" }, "value": 0 }])
        )["outcome"],
        "done"
    );
    assert_failed(
        &put(json!([{ "key": "k2", "fields": { "e": "5" }, "value": 0 }])),
        "bad_request",
    );
    let got = lib.run(
        "rows.get",
        json!({ "place": "p", "table": "t", "keys": ["k", "k2"] }),
    );
    assert_eq!(got["rows"], json!([]));
    Ok(())
}

pub fn there_is_no_query_operation(env: &Env) -> Outcome {
    let lib = env.lib();
    let root = lib.root_arg();
    let (answer, code) = call_args(lib.provider(), &["rows.query", "--root", &root], None);
    assert_eq!(code, 2);
    assert_failed(&answer, "bad_request");
    let mut serve = lib.serve();
    assert_failed(
        &serve.ask(json!(1), "rows.query", json!({ "place": "p" })),
        "bad_request",
    );
    serve.finish();
    Ok(())
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// `(YYYY-MM-DD, yyyymmddHHMMSSmmm)` of a moment in milliseconds.
fn day_and_stamp(ms: i64) -> (String, String) {
    let secs = ms.div_euclid(1_000);
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!(
            "{y:04}{m:02}{d:02}{:02}{:02}{:02}{:03}",
            s / 3_600,
            s % 3_600 / 60,
            s % 60,
            ms.rem_euclid(1_000)
        ),
    )
}

fn stamp_ms(stamp: &str) -> i64 {
    let n = |r: std::ops::Range<usize>| stamp[r].parse::<i64>().unwrap();
    let days = days_from_civil(n(0..4), n(4..6), n(6..8));
    (days * 86_400 + n(8..10) * 3_600 + n(10..12) * 60 + n(12..14)) * 1_000 + n(14..17)
}
