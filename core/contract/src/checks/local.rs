//! Section 7: the facets and the token of a local folder. Facet checks run for the facets
//! `describe` lists; token checks run for a provider that gives the `fs` facet (a local folder).

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde_json::json;

use crate::harness::*;
use crate::{Outcome, not_exercised};

const WHERE_FROMS: &str = "com.apple.metadata:kMDItemWhereFroms";
const QUARANTINE: &str = "com.apple.quarantine";
const TAGS: &str = "com.apple.metadata:_kMDItemUserTags";

/// A binary property list holding an array of short ASCII strings, as Finder and browsers write.
fn bplist_of(strings: &[&str]) -> Vec<u8> {
    let mut out = b"bplist00".to_vec();
    let mut offsets = vec![out.len()];
    out.push(0xA0 | strings.len() as u8);
    out.extend((1..=strings.len()).map(|i| i as u8));
    for s in strings {
        offsets.push(out.len());
        if s.len() < 15 {
            out.push(0x50 | s.len() as u8);
        } else {
            out.extend([0x5F, 0x10, s.len() as u8]);
        }
        out.extend(s.as_bytes());
    }
    let table = out.len();
    out.extend(offsets.iter().map(|o| *o as u8));
    out.extend([0, 0, 0, 0, 0, 0, 1, 1]);
    out.extend((offsets.len() as u64).to_be_bytes());
    out.extend(0u64.to_be_bytes());
    out.extend((table as u64).to_be_bytes());
    out
}

#[cfg(target_os = "macos")]
fn set_xattr(path: &Path, name: &str, value: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let name = std::ffi::CString::new(name).unwrap();
    // SAFETY: valid C strings and a buffer of `value.len()` bytes.
    unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        ) == 0
    }
}

#[cfg(not(target_os = "macos"))]
fn set_xattr(_path: &Path, _name: &str, _value: &[u8]) -> bool {
    false
}

/// Gives a file the three attributes the `macos` facet reads; false where they cannot be set.
pub fn set_macos_attributes(path: &Path) -> bool {
    set_xattr(
        path,
        WHERE_FROMS,
        &bplist_of(&["https://example.com/a.zip", "https://example.com/"]),
    ) && set_xattr(
        path,
        QUARANTINE,
        b"0083;6aee14ed;Safari;0A1B2C3D-0000-0000-0000-000000000000",
    ) && set_xattr(path, TAGS, &bplist_of(&["Red\n6", "Project"]))
}

pub fn the_fs_facet_is_always_there(env: &Env) -> Outcome {
    if !env.facet("fs") {
        return not_exercised("describe does not list the fs facet");
    }
    let lib = env.lib();
    lib.write("f.txt", "x");
    lib.mkdir("d");
    std::os::unix::fs::symlink("f.txt", lib.at("link")).unwrap();
    for place in ["f.txt", "d", "link", ""] {
        let entry = lib.glance_one(place);
        let fs_facet = &entry["facets"]["fs"];
        let meta = fs::symlink_metadata(lib.at(place)).unwrap();
        assert_eq!(fs_facet["inode"], meta.ino(), "{place}: {entry}");
        assert_eq!(fs_facet["device"], meta.dev(), "{place}: {entry}");
        assert_eq!(fs_facet["mode"], meta.mode(), "{place}: {entry}");
        // `created` is null where the provider has no birth time; given, it is the system's.
        let created = &fs_facet["created"];
        if let Some(text) = created.as_str() {
            let born = meta.created().expect("the system gives a birth time");
            let ms = born.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
            assert_eq!(iso_ms(text), ms, "{place}: {created}");
        } else {
            assert!(created.is_null(), "{place}: {created}");
        }
    }
    assert_eq!(lib.glance_one("link")["kind"], "other");
    Ok(())
}

pub fn the_macos_facet_reads_its_attributes(env: &Env) -> Outcome {
    if !env.facet("macos") {
        return not_exercised("describe does not list the macos facet");
    }
    let lib = env.lib();
    lib.write("d/downloaded.zip", "zip");
    lib.write("d/plain.txt", "plain");
    if !set_macos_attributes(&lib.at("d/downloaded.zip")) {
        return not_exercised("this system cannot set macOS extended attributes");
    }
    let expected = json!({
        "where_from": ["https://example.com/a.zip", "https://example.com/"],
        "quarantine": "Safari",
        "tags": ["Red", "Project"],
    });
    let glanced = lib.run(
        "glance",
        json!({ "places": ["d/downloaded.zip", "d/plain.txt"], "facets": ["macos"] }),
    );
    assert_eq!(
        glanced["entries"][0]["facets"]["macos"], expected,
        "{glanced}"
    );
    assert!(
        glanced["entries"][1]["facets"].get("macos").is_none(),
        "no attributes, no facet: {glanced}"
    );
    let listed = lib.run("overview", json!({ "place": "d", "facets": ["macos"] }));
    assert_eq!(
        listed["entries"][0]["facets"]["macos"], expected,
        "{listed}"
    );
    Ok(())
}

const NOT_LOCAL: &str = "describe does not list the fs facet: not a local folder";

/// The token moves with the size, the modification time, the change time and the inode, each
/// alone: any one of them differing is a change (3.12).
pub fn the_token_moves_with_size_mtime_ctime_and_inode(env: &Env) -> Outcome {
    if !env.facet("fs") {
        return not_exercised(NOT_LOCAL);
    }
    let lib = env.lib();
    lib.write("f.txt", "abc");
    let changed = |what: &str, change: &dyn Fn()| {
        let token = lib.token("f.txt");
        change();
        let looked = lib.look_one("f.txt", &token);
        assert_eq!(
            looked["changed"].as_array().unwrap().len(),
            1,
            "{what}: {looked}"
        );
    };
    changed("size", &|| lib.write("f.txt", "abcdef"));
    changed("modified", &|| set_mtime(&lib.at("f.txt"), an_hour_ago()));
    changed("changed", &|| {
        fs::set_permissions(lib.at("f.txt"), Permissions::from_mode(0o600)).unwrap()
    });
    changed("inode", &|| {
        let meta = fs::metadata(lib.at("f.txt")).unwrap();
        lib.write("g.txt", "abcdef");
        File::open(lib.at("g.txt"))
            .unwrap()
            .set_modified(meta.modified().unwrap())
            .unwrap();
        fs::rename(lib.at("g.txt"), lib.at("f.txt")).unwrap();
    });
    Ok(())
}

/// Overwrites a file in place with as many different bytes and puts its modification time back.
pub fn same_size_edit(path: &Path, bytes: &[u8]) {
    let modified = fs::metadata(path).unwrap().modified().unwrap();
    let mut file = OpenOptions::new().write(true).open(path).unwrap();
    file.write_all(bytes).unwrap();
    file.set_modified(modified).unwrap();
}

/// A same-size edit in place, right after a write, with the old modification time put back, is
/// still a change.
pub fn a_racy_same_size_edit_is_seen(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    for round in 0..20u8 {
        let place = format!("f{round}.txt");
        let first = bytes_of(64, round);
        let second = bytes_of(64, round.wrapping_add(100));
        fs::write(src.path().join("s"), &first).unwrap();
        let written = lib.run(
            "write",
            json!({ "place": place, "from": src.path().join("s"), "expect": "empty" }),
        );
        let token = written["entry"]["token"].as_str().unwrap().to_owned();
        same_size_edit(&lib.at(&place), &second);
        let looked = lib.look_one(&place, &token);
        assert_eq!(
            looked["changed"].as_array().unwrap().len(),
            1,
            "after write: {looked}"
        );

        let place = format!("g{round}.txt");
        lib.write_bytes(&place, &first);
        let token = lib.token(&place);
        same_size_edit(&lib.at(&place), &second);
        let looked = lib.look_one(&place, &token);
        assert_eq!(
            looked["changed"].as_array().unwrap().len(),
            1,
            "after glance: {looked}"
        );
    }
    Ok(())
}

/// The token a write answers, taken right after its own change, still says `same` while nothing
/// changes: the write vouches for what it placed.
pub fn a_written_token_is_same_until_a_change(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    for round in 0..20u8 {
        let place = format!("f{round}.txt");
        fs::write(src.path().join("s"), bytes_of(64, round)).unwrap();
        let written = lib.run(
            "write",
            json!({ "place": place, "from": src.path().join("s"), "expect": "empty" }),
        );
        let token = written["entry"]["token"].as_str().unwrap();
        assert!(lib.same(&place, token), "{place}: {written}");
    }
    Ok(())
}
