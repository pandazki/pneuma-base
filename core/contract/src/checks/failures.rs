//! Section 8: the fixed reasons and when each is answered.

use std::fs;

use serde_json::json;

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub fn listing_a_missing_or_file_place_fails(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "x");
    for op in ["overview", "probe"] {
        assert_failed(&lib.run(op, json!({ "place": "missing" })), "no_such_place");
        assert_failed(
            &lib.run(op, json!({ "place": "f.txt/below" })),
            "no_such_place",
        );
        assert_failed(&lib.run(op, json!({ "place": "f.txt" })), "not_a_dir");
    }
    for op in ["content", "read"] {
        assert_failed(&lib.run(op, json!({ "place": "missing" })), "no_such_place");
    }
    Ok(())
}

pub fn reading_a_dir_is_not_a_file(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/f.txt", "x");
    assert_failed(&lib.run("read", json!({ "place": "d" })), "not_a_file");
    assert_failed(&lib.run("read", json!({ "place": "" })), "not_a_file");
    Ok(())
}

pub fn places_below_a_link_or_in_the_record_area_are_outside(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("notes/a.md", "a");
    let token = lib.token("notes/a.md");
    let elsewhere = scratch();
    fs::write(elsewhere.path().join("x.txt"), "x").unwrap();
    std::os::unix::fs::symlink("notes", lib.at("link")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), lib.at("ext")).unwrap();
    let record_area = lib.at(".pneuma-base").is_dir();
    let mut places = vec!["link/a.md", "ext/x.txt"];
    if record_area {
        places.extend([".pneuma-base", ".pneuma-base/noise.json"]);
    }
    for place in &places {
        assert_eq!(lib.glance_one(place)["reason"], "outside", "{place}");
        assert_eq!(
            lib.look_one(place, &token)["failed"][0]["reason"],
            "outside",
            "{place}"
        );
        for op in ["content", "read"] {
            assert_failed(&lib.run(op, json!({ "place": place })), "outside");
        }
        assert_failed(
            &lib.run("remove", json!({ "place": place, "expect": token })),
            "outside",
        );
    }
    let mut listed = vec!["link/sub"];
    if record_area {
        listed.extend([".pneuma-base", ".pneuma-base/cache"]);
    }
    for place in listed {
        assert_failed(&lib.run("overview", json!({ "place": place })), "outside");
        assert_failed(&lib.run("probe", json!({ "place": place })), "outside");
    }
    let src = scratch();
    fs::write(src.path().join("s"), "s").unwrap();
    let mut targets = vec!["link/new.md", "ext/new.txt"];
    if record_area {
        targets.push(".pneuma-base/planted.json");
    }
    for place in targets {
        let answer = lib.run(
            "write",
            json!({ "place": place, "from": src.path().join("s"), "expect": "empty" }),
        );
        assert_failed(&answer, "outside");
    }
    assert!(!lib.at("notes/new.md").exists() && !elsewhere.path().join("new.txt").exists());
    assert_eq!(lib.glance_one("link")["kind"], "other");
    // A link is not a directory, even when it points at one.
    assert_failed(
        &lib.run("overview", json!({ "place": "link" })),
        "not_a_dir",
    );
    let root = places_of(&lib.run("overview", json!({ "place": "" }))["entries"]);
    assert!(!root.contains(&".pneuma-base".to_owned()), "{root:?}");
    Ok(())
}

pub fn an_unreadable_dir_does_not_stop_the_rest(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("locked/a.txt", "a");
    lib.write("locked/inner/b.txt", "b");
    lib.write("open/x.txt", "x");
    let token = lib.token("locked/a.txt");
    let Some(_locked) = Locked::new(lib.at("locked")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let root = lib.run("overview", json!({ "place": "" }));
    assert_eq!(places_of(&root["entries"]), ["locked", "open"]);
    let probed = lib.run("probe", json!({ "place": "" }));
    assert_eq!(probed["outcome"], "done");
    assert_eq!(
        (probed["dirs"].clone(), probed["files"].clone()),
        (json!(2), json!(1))
    );
    assert_eq!(lib.run("probe", json!({ "place": "open" }))["files"], 1);
    for answer in [
        lib.run("overview", json!({ "place": "locked" })),
        lib.run("probe", json!({ "place": "locked" })),
        lib.run("content", json!({ "place": "locked" })),
    ] {
        assert_failed(&answer, "unreadable");
        assert!(
            answer["detail"]
                .as_str()
                .is_some_and(|d| !d.is_empty() && !d.contains(' ')),
            "the system's reason, not a sentence: {answer}"
        );
    }
    assert_eq!(lib.glance_one("locked/a.txt")["reason"], "unreadable");
    assert_eq!(
        lib.look_one("locked/a.txt", &token)["failed"][0]["reason"],
        "unreadable"
    );
    Ok(())
}
