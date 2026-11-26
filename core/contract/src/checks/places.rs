//! Section 3 (a place's description, facets, the token's comparison) and the describing
//! operations of section 4: `glance`, `overview`, `probe`, `look`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::harness::*;
use crate::{Outcome, not_exercised};

pub fn descriptions_have_the_contract_shape(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/f.txt", "four");
    let moment = UNIX_EPOCH + Duration::from_millis(1_795_679_280_123);
    set_mtime(&lib.at("d/f.txt"), moment);
    // Two descriptions of one unchanged place agree once its last change has settled.
    lib.token("d/f.txt");
    let glanced = lib.glance_one("d/f.txt");
    let listed = lib.run("overview", json!({ "place": "d" }))["entries"][0].clone();
    for entry in [&glanced, &listed] {
        let keys: BTreeSet<&str> = entry
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from(["place", "kind", "token", "size", "modified", "facets"]),
            "{entry}"
        );
        assert_eq!(entry["place"], "d/f.txt");
        assert_eq!(entry["kind"], "file");
        assert!(entry["token"].is_string());
        assert_eq!(entry["size"], 4);
        assert_eq!(entry["modified"], "2026-11-26T07:48:00.123Z");
    }
    assert_eq!(glanced, listed);
    let dir = lib.glance_one("d");
    assert_eq!(dir["kind"], "dir");
    assert!(dir["token"].is_string());
    assert!(dir["modified"].as_str().unwrap().ends_with('Z'), "{dir}");
    Ok(())
}

pub fn a_dir_size_is_its_entry_count(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("three/a", "");
    lib.write("three/b", "");
    lib.mkdir("three/c");
    let size = &lib.glance_one("three")["size"];
    if size.is_null() {
        return not_exercised("the provider gives no entry count for a directory (size null)");
    }
    assert_eq!(*size, 3);
    Ok(())
}

/// The fields section 7 gives each facet it names.
fn section_7_fields(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "fs" => Some(&["inode", "device", "created", "mode"]),
        "macos" => Some(&["where_from", "quarantine", "tags"]),
        "placeholder" => Some(&["provider", "size_elsewhere"]),
        _ => None,
    }
}

/// Facets may be absent; those given are objects, named by `describe`, with section 7's fields.
pub fn facets_are_named_and_listed(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "x");
    lib.mkdir("d");
    std::os::unix::fs::symlink("f.txt", lib.at("link")).unwrap();
    let listed = strings_of(&env.describe["facets"]);
    let all: Vec<Value> = listed.iter().map(|n| json!(n)).collect();
    for asked in [json!([]), json!(all)] {
        let answer = lib.run(
            "glance",
            json!({ "places": ["", "f.txt", "d", "link"], "facets": asked }),
        );
        for entry in answer["entries"].as_array().unwrap() {
            let Some(facets) = entry.get("facets") else {
                continue;
            };
            let facets = facets
                .as_object()
                .unwrap_or_else(|| panic!("facets is an object: {entry}"));
            for (name, facet) in facets {
                assert!(listed.contains(name), "{name} is not in describe's facets");
                let fields = facet
                    .as_object()
                    .unwrap_or_else(|| panic!("{name} is an object: {entry}"));
                if let Some(known) = section_7_fields(name) {
                    for field in fields.keys() {
                        assert!(known.contains(&field.as_str()), "{name}.{field}: {entry}");
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn facets_of_an_unreadable_dir_need_no_listing(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("locked/a.txt", "a");
    let before = lib.glance_one("locked");
    let Some(_locked) = Locked::new(lib.at("locked")) else {
        return not_exercised(ROOT_READS_ANYTHING);
    };
    let wanted: Vec<Value> = env.describe["facets"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let entry =
        lib.run("glance", json!({ "places": ["locked"], "facets": wanted }))["entries"][0].clone();
    assert_eq!(entry["kind"], "dir", "{entry}");
    if let Some(fs_facet) = before["facets"].get("fs") {
        assert_eq!(entry["facets"]["fs"]["inode"], fs_facet["inode"], "{entry}");
    }
    let many: Vec<String> = (0..50).map(|i| format!("locked/n{i}")).collect();
    let answer = lib.run("glance", json!({ "places": many }));
    assert_eq!(
        answer["entries"].as_array().unwrap().len(),
        50,
        "one entry per place"
    );
    Ok(())
}

/// A placeholder needs a sync service that keeps only a stub here; none is used. What can be
/// shown: a file whose content is here has no `placeholder` facet and reads without `elsewhere`.
pub fn placeholders_need_a_sync_service(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("here.txt", "here");
    let entry = lib.run(
        "glance",
        json!({ "places": ["here.txt"], "facets": ["placeholder"] }),
    )["entries"][0]
        .clone();
    assert!(entry["facets"].get("placeholder").is_none(), "{entry}");
    assert_done(&lib.run("read", json!({ "place": "here.txt" })));
    not_exercised(
        "a placeholder file needs a sync service that keeps content elsewhere; none is used here",
    )
}

pub fn costlier_facets_come_only_when_asked(env: &Env) -> Outcome {
    if !env.facet("macos") {
        return not_exercised("describe lists no facet that must be asked for by name (macos)");
    }
    let lib = env.lib();
    lib.write("d/f.txt", "x");
    if !super::local::set_macos_attributes(&lib.at("d/f.txt")) {
        return not_exercised("this system cannot set macOS extended attributes");
    }
    let plain = lib.glance_one("d/f.txt");
    assert!(
        plain["facets"].get("macos").is_none(),
        "not asked for: {plain}"
    );
    let listed = lib.run("overview", json!({ "place": "d" }));
    assert!(
        listed["entries"][0]["facets"].get("macos").is_none(),
        "{listed}"
    );
    let asked = lib.run(
        "glance",
        json!({ "places": ["d/f.txt"], "facets": ["macos"] }),
    );
    assert!(
        asked["entries"][0]["facets"].get("macos").is_some(),
        "{asked}"
    );
    let asked = lib.run("overview", json!({ "place": "d", "facets": ["macos"] }));
    assert!(
        asked["entries"][0]["facets"].get("macos").is_some(),
        "{asked}"
    );
    Ok(())
}

pub fn glance_describes_each_place_and_none_for_missing(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("d/f.txt", "x");
    let answer = lib.run(
        "glance",
        json!({ "places": ["d/f.txt", "d", "missing", "d/no/deeper", "d/f.txt/inside"] }),
    );
    let entries = answer["entries"].as_array().unwrap();
    assert_eq!(
        places_of(&answer["entries"]),
        ["d/f.txt", "d", "missing", "d/no/deeper", "d/f.txt/inside"]
    );
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[1]["kind"], "dir");
    for entry in &entries[2..] {
        assert_eq!(*entry, json!({ "place": entry["place"], "kind": "none" }));
    }
    assert_eq!(
        lib.run("glance", json!({ "places": [] }))["entries"],
        json!([])
    );
    Ok(())
}

pub fn overview_pages_with_more_after_and_defaults_to_200(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..250 {
        lib.write(&format!("d/n{i:03}"), "");
    }
    let first = lib.run("overview", json!({ "place": "d" }));
    assert_eq!(
        first["entries"].as_array().unwrap().len(),
        200,
        "default limit"
    );
    let at_least = first["more"]["at_least"].as_u64().unwrap();
    assert!((1..=50).contains(&at_least), "{first}");
    if !first["total"].is_null() {
        assert_eq!(first["total"], 250);
    }
    let second = lib.run(
        "overview",
        json!({ "place": "d", "after": first["more"]["after"] }),
    );
    assert!(second["more"].is_null(), "{second}");
    let mut all = places_of(&first["entries"]);
    all.extend(places_of(&second["entries"]));
    let expected: Vec<String> = (0..250).map(|i| format!("d/n{i:03}")).collect();
    assert_eq!(all, expected);
    Ok(())
}

pub fn probe_counts_files_dirs_and_bytes(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("t/a.txt", "abc");
    lib.write("t/sub/b.txt", "abcde");
    lib.write("t/sub/deeper/c.txt", "abcdefg");
    let answer = lib.run("probe", json!({ "place": "t" }));
    assert_eq!(answer["files"], 3, "{answer}");
    assert_eq!(answer["dirs"], 2, "{answer}");
    assert_eq!(answer["bytes"], 15, "{answer}");
    assert_eq!(answer["exceeded"], false, "{answer}");
    assert_eq!(answer["markers"], json!([]), "{answer}");
    Ok(())
}

pub fn probe_budget_defaults_to_500(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..600 {
        lib.write(&format!("d/f{i:03}"), "");
    }
    let answer = lib.run("probe", json!({ "place": "d" }));
    assert_eq!(answer["exceeded"], true, "{answer}");
    assert_eq!(answer["files"], 500, "{answer}");
    Ok(())
}

pub fn look_answers_same_changed_and_gone(env: &Env) -> Outcome {
    let lib = env.lib();
    for name in ["same", "grows", "goes", "becomes-dir"] {
        lib.write(&format!("d/{name}"), "x");
    }
    let tokens: Vec<(String, String)> = ["same", "grows", "goes", "becomes-dir"]
        .iter()
        .map(|n| (format!("d/{n}"), lib.token(&format!("d/{n}"))))
        .collect();
    lib.write("d/grows", "xxxxxxxx");
    fs::remove_file(lib.at("d/goes")).unwrap();
    fs::remove_file(lib.at("d/becomes-dir")).unwrap();
    lib.mkdir("d/becomes-dir");
    let places: Vec<Value> = tokens
        .iter()
        .map(|(p, t)| json!({ "place": p, "token": t }))
        .collect();
    let answer = lib.run("look", json!({ "places": places }));
    assert_eq!(answer["same"], 1, "{answer}");
    assert_eq!(answer["gone"], json!(["d/goes"]), "{answer}");
    let changed: BTreeMap<String, Value> = answer["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["place"].as_str().unwrap().to_owned(), c["entry"].clone()))
        .collect();
    assert_eq!(changed["d/grows"]["size"], 8);
    assert_eq!(changed["d/becomes-dir"]["kind"], "dir");
    assert_eq!(answer["failed"], json!([]));
    Ok(())
}

/// Names in byte order, directories and files mixed; a directory may compare as its name or as
/// its name plus `/`, one way for all of them. Paging with `more.after` as given yields the same.
pub fn overview_sorts_by_name_bytes_mixing_dirs_and_files(env: &Env) -> Outcome {
    let lib = env.lib();
    for name in ["b.txt", "Z", "é.md", "_x", "10", "9", "a.txt", "a-b"] {
        lib.write(&format!("d/{name}"), "");
    }
    for name in ["B-dir", "a"] {
        lib.mkdir(&format!("d/{name}"));
    }
    let answer = lib.run("overview", json!({ "place": "d" }));
    let entries = answer["entries"].as_array().unwrap();
    let key = |entry: &Value, slash: bool| -> Vec<u8> {
        let place = entry["place"].as_str().unwrap();
        let mut name = place.strip_prefix("d/").unwrap().as_bytes().to_vec();
        if slash && entry["kind"] == "dir" {
            name.push(b'/');
        }
        name
    };
    let sorted = |slash: bool| {
        entries
            .windows(2)
            .all(|w| key(&w[0], slash) < key(&w[1], slash))
    };
    assert!(sorted(false) || sorted(true), "not in byte order: {answer}");
    assert_eq!(entries.len(), 10);
    let mut paged = Vec::new();
    let mut after = Value::Null;
    loop {
        let mut request = json!({ "place": "d", "limit": 3 });
        if !after.is_null() {
            request["after"] = after.clone();
        }
        let page = lib.run("overview", request);
        paged.extend(places_of(&page["entries"]));
        after = page["more"]["after"].clone();
        if after.is_null() {
            break;
        }
    }
    assert_eq!(paged, places_of(&answer["entries"]));
    Ok(())
}

pub fn overview_names_the_noise_it_left_out(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("w/node_modules/x/index.js", "x");
    lib.write("w/.DS_Store", "");
    lib.write("w/notes/drafts/a.md", "a");
    lib.write("w/notes/kept.md", "k");
    let answer = lib.run("overview", json!({ "place": "w" }));
    assert_eq!(places_of(&answer["entries"]), ["w/notes"]);
    let noise: BTreeSet<String> = strings_of(&answer["noise"]).into_iter().collect();
    assert_eq!(
        noise,
        BTreeSet::from([".DS_Store".to_owned(), "node_modules".to_owned()])
    );
    lib.run("noise.add", json!({ "paths": ["w/notes/drafts"] }));
    let notes = lib.run("overview", json!({ "place": "w/notes" }));
    assert_eq!(places_of(&notes["entries"]), ["w/notes/kept.md"]);
    assert_eq!(notes["noise"], json!(["drafts"]));
    Ok(())
}

pub fn probe_reports_top_level_markers(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("project/package.json", "{}");
    lib.write("project/.git/HEAD", "ref");
    lib.write("project/sub/Cargo.toml", "");
    let markers: BTreeSet<String> =
        strings_of(&lib.run("probe", json!({ "place": "project" }))["markers"])
            .into_iter()
            .collect();
    assert_eq!(
        markers,
        BTreeSet::from([".git".to_owned(), "package.json".to_owned()])
    );
    for name in ["pyproject.toml", "Cargo.toml", "go.mod"] {
        let lib = env.lib();
        lib.write(&format!("p/{name}"), "");
        let markers = strings_of(&lib.run("probe", json!({ "place": "p" }))["markers"]);
        assert_eq!(markers, [name]);
    }
    Ok(())
}

/// `describe` lists the contract's operations and no operation on the whole library.
pub fn describe_lists_no_whole_library_operation(env: &Env) -> Outcome {
    let ops = strings_of(&env.describe["ops"]);
    for op in OPS {
        assert!(ops.iter().any(|o| o == op), "missing {op}");
    }
    for op in &ops {
        assert!(
            OPS.contains(&op.as_str()),
            "{op} is not an operation of the contract"
        );
    }
    Ok(())
}
