//! Section 4's reading operations: `content` and `read`, the content rule, and progress.

use std::fs;

use serde_json::json;

use crate::Outcome;
use crate::harness::*;

pub fn file_content_is_fingerprint_token_size(env: &Env) -> Outcome {
    let lib = env.lib();
    let bytes = bytes_of(100_000, 7);
    lib.write_bytes("f.bin", &bytes);
    lib.write("empty", "");
    for (place, bytes) in [("f.bin", &bytes[..]), ("empty", &b""[..])] {
        let answer = lib.run("content", json!({ "place": place }));
        assert_eq!(answer["kind"], "file", "{answer}");
        assert_eq!(
            answer["fingerprint"],
            sha256_hex(bytes),
            "SHA-256 of the bytes: {answer}"
        );
        assert_eq!(answer["size"], bytes.len(), "{answer}");
        assert!(
            lib.same(place, answer["token"].as_str().unwrap()),
            "{answer}"
        );
    }
    Ok(())
}

pub fn dir_content_is_manifest_fingerprint_files_token(env: &Env) -> Outcome {
    let lib = env.lib();
    for top in ["one", "two"] {
        lib.write(&format!("{top}/a.txt"), "alpha");
        lib.write(&format!("{top}/sub/b.txt"), "beta");
        lib.write(&format!("{top}/sub/deeper/c.txt"), "gamma");
    }
    lib.mkdir("empty");
    lib.token("one");
    let one = lib.run("content", json!({ "place": "one" }));
    let two = lib.run("content", json!({ "place": "two" }));
    assert_eq!(one["kind"], "dir", "{one}");
    assert_eq!(one["files"], 3, "{one}");
    assert!(one["fingerprint"].is_string(), "{one}");
    assert_eq!(
        one["fingerprint"], two["fingerprint"],
        "same content, same fingerprint"
    );
    assert!(lib.same("one", one["token"].as_str().unwrap()), "{one}");
    lib.write("two/sub/b.txt", "betA");
    let changed = lib.run("content", json!({ "place": "two" }));
    assert_ne!(
        changed["fingerprint"], one["fingerprint"],
        "one byte differs"
    );
    fs::rename(lib.at("two/sub/b.txt"), lib.at("two/sub/b2.txt")).unwrap();
    lib.write("two/sub/b2.txt", "beta");
    let renamed = lib.run("content", json!({ "place": "two" }));
    assert_ne!(renamed["fingerprint"], one["fingerprint"], "a path differs");
    let empty = lib.run("content", json!({ "place": "empty" }));
    assert_eq!(empty["files"], 0, "{empty}");
    assert_ne!(empty["fingerprint"], one["fingerprint"]);
    Ok(())
}

pub fn content_stops_at_its_file_limit(env: &Env) -> Outcome {
    let lib = env.lib();
    for i in 0..30 {
        lib.write(&format!("many/f{i:02}"), "x");
    }
    let answer = lib.run("content", json!({ "place": "many", "limit": 10 }));
    assert_failed(&answer, "too_many");
    let at_least = answer["at_least"].as_u64().unwrap_or(0);
    assert!(
        (11..=30).contains(&at_least),
        "at least more than the limit: {answer}"
    );
    let whole = lib.run("content", json!({ "place": "many", "limit": 30 }));
    assert_eq!(whole["files"], 30, "{whole}");
    let src = scratch();
    for i in 0..30 {
        fs::write(src.path().join(format!("f{i:02}")), "x").unwrap();
    }
    let write = lib.run(
        "write",
        json!({ "place": "copy", "from": src.path(), "expect": "empty", "limit": 10 }),
    );
    assert_failed(&write, "too_many");
    assert_eq!(
        lib.glance_one("copy")["kind"],
        "none",
        "a refused write placed nothing"
    );
    Ok(())
}

pub fn content_sends_progress(env: &Env) -> Outcome {
    let lib = env.lib();
    many_files(&lib.at("big"), 400, 1);
    let mut serve = lib.serve();
    let id = json!("c");
    serve.request(id.clone(), "content", json!({ "place": "big" }));
    let (progress, answer) = serve.answer_for(&id);
    assert_eq!(answer["files"], 400, "{answer}");
    assert!(!progress.is_empty(), "a progress line before the answer");
    Ok(())
}

/// Noise names and each directory's ignore file leave files out, but only when the caller says
/// so: without a rule only the library's noise is left out.
pub fn content_rule_leaves_out_noise_and_ignored(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("p/a.txt", "a");
    lib.write("p/node_modules/x.js", "x");
    lib.write("p/.gitignore", "*.log\n");
    lib.write("p/build.log", "log");
    lib.write("p/extra/y.txt", "y");
    lib.write("p/sub/.gitignore", "*.tmp\n");
    lib.write("p/sub/z.tmp", "z");
    lib.write("p/sub/k.txt", "k");
    let bare = lib.run("content", json!({ "place": "p" }));
    // a.txt .gitignore build.log extra/y.txt sub/.gitignore sub/z.tmp sub/k.txt
    assert_eq!(
        bare["files"], 7,
        "no rule: only the library's noise is left out: {bare}"
    );
    let ruled = lib.run(
        "content",
        json!({ "place": "p", "rule": { "noise": ["extra"], "ignore_file": ".gitignore" } }),
    );
    // a.txt .gitignore sub/.gitignore sub/k.txt
    assert_eq!(ruled["files"], 4, "{ruled}");
    let ignore_only = lib.run(
        "content",
        json!({ "place": "p", "rule": { "ignore_file": ".gitignore" } }),
    );
    assert_eq!(ignore_only["files"], 5, "{ignore_only}");
    assert_ne!(bare["fingerprint"], ruled["fingerprint"]);
    let src = scratch();
    copy_tree(&lib.at("p"), src.path());
    let written = lib.run(
        "write",
        json!({ "place": "q", "from": src.path(), "expect": "empty",
                "rule": { "noise": ["extra"], "ignore_file": ".gitignore" } }),
    );
    assert_eq!(written["files"], 4, "{written}");
    assert_eq!(written["fingerprint"], ruled["fingerprint"], "{written}");
    let listed = places_of(&lib.run("overview", json!({ "place": "q" }))["entries"]);
    assert_eq!(listed, ["q/.gitignore", "q/a.txt", "q/sub"]);
    Ok(())
}

pub fn read_gives_bytes_and_token(env: &Env) -> Outcome {
    let lib = env.lib();
    let bytes: Vec<u8> = (0..=255u8).cycle().take(1_000).collect();
    lib.write_bytes("b.bin", &bytes);
    let whole = lib.run("read", json!({ "place": "b.bin" }));
    assert_done(&whole);
    assert_eq!(base64_decode(whole["data"].as_str().unwrap()), bytes);
    assert_eq!(whole["size"], 1_000, "{whole}");
    assert!(
        lib.same("b.bin", whole["token"].as_str().unwrap()),
        "{whole}"
    );
    let range = lib.run(
        "read",
        json!({ "place": "b.bin", "offset": 250, "length": 10 }),
    );
    assert_eq!(
        base64_decode(range["data"].as_str().unwrap()),
        &bytes[250..260]
    );
    let tail = lib.run(
        "read",
        json!({ "place": "b.bin", "offset": 990, "length": 100 }),
    );
    assert_eq!(base64_decode(tail["data"].as_str().unwrap()), &bytes[990..]);
    assert_failed(
        &lib.run("read", json!({ "place": "b.bin", "offset": 1_001 })),
        "bad_request",
    );
    let out = scratch();
    let to = out.path().join("copy.bin");
    let sent = lib.run("read", json!({ "place": "b.bin", "to": to }));
    assert_done(&sent);
    assert!(sent.get("data").is_none(), "{sent}");
    assert_eq!(fs::read(&to).unwrap(), bytes);
    let inside = lib.run(
        "read",
        json!({ "place": "b.bin", "to": lib.at("again.bin") }),
    );
    assert_eq!(
        inside["outcome"], "failed",
        "a target inside the library: {inside}"
    );
    assert!(!lib.at("again.bin").exists());
    Ok(())
}

pub fn changed_without_a_cursor_gives_the_current_one(env: &Env) -> Outcome {
    let lib = env.lib();
    let answer = lib.run("changed", json!({}));
    assert_done(&answer);
    assert_eq!(answer["places"], json!([]), "{answer}");
    assert!(answer["cursor"].as_str().is_some_and(|c| !c.is_empty()));
    Ok(())
}
