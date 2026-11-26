//! The contract suite: `STORAGE.md` (version 1), checked sentence by sentence against the built
//! binary only. Fixtures are made with `std`; every operation goes through the binary.
//!
//! | STORAGE.md sentence | Checked by |
//! | --- | --- |
//! | 序：「同一批操作也可以经一个常驻进程按行收发（`serve`）」 | `serve_answers_like_one_shot` |
//! | §1 位置：「用 `/` 分隔的相对路径写，不以 `/` 开头，不含 `.` 和 `..` 段」 | `malformed_places_are_bad_requests` |
//! | §2.1「不下探。列出只列一层。」 | `overview_lists_one_level` |
//! | §2.2「有界。每个会列出或计数的操作都有上限；到上限就停，答「至少」。」 | `listing_stops_at_the_limit_and_says_at_least`, `probe_stops_at_the_budget`, `count_stops_at_its_cap` |
//! | §2.3「变化靠游标。没有哪个操作靠遍历去发现变化。」 | `facts_since_gives_only_what_follows_the_cursor`, `look_at_a_dir_does_not_descend`; `changed`: deferred, not built |
//! | §2.4「内容只在被要求时读。只有 `content`、`read`、`write`、`copy` 读写字节。」 | `metadata_operations_do_not_read_bytes` |
//! | §2.5「写带预期。预期不成立时不改任何东西，答 `refused` 和现状。」 | `rows_put_with_a_wrong_expectation_changes_nothing`; `write`/`move`/`remove`: deferred, not built |
//! | §2.6「读带令牌。`read` 和 `content` 的答复带所读那一版的令牌。」 | deferred: `read` and `content` not built |
//! | §2.7「噪音不报、不进。对噪音位置的任何操作答 `noise`。」 | `noise_places_answer_noise`, `noise_is_neither_listed_nor_entered` |
//! | §2.8「缓存可删。实现可以有缓存；删掉后答复不变，只变慢。」 | `deleting_the_cache_area_changes_no_answer`, `a_changed_directory_is_listed_again` |
//! | §2.9「多个进程同时操作不损坏任何东西、不死锁」 | `concurrent_appends_and_puts_lose_nothing` |
//! | §2.9「一次写要么完成，要么等于没发生。」 | `an_interrupted_append_leaves_no_half_file` |
//! | §2.10「每个答复是 JSON，失败也是，带固定的 `reason`；没有给人看的句子。」 | `every_answer_is_a_json_object_with_a_fixed_reason` |
//! | §3「`glance` 和 `overview` 里的每个条目都是这个形状」 | `descriptions_have_the_contract_shape` |
//! | §3「中性的部分是 `kind`、`token`、`size`、`modified`。」 | `descriptions_have_the_contract_shape` |
//! | §3「`dir` 的 `size` 是它这一层的条目数。」 | `a_dir_size_is_its_entry_count` |
//! | §3「`facets` 是可有可无的。每个面有自己的名字和字段，在第 7 节列出」 | `facets_are_the_ones_section_7_names` |
//! | §3「不认识的面原样传递。」 | deferred: a duty of the kernel, which receives the facets |
//! | §3「取面守同样的规则：不下探、有界」 | `facets_of_an_unreadable_dir_need_no_listing` |
//! | §3「不为了看一眼而走网络、不触发占位文件的下载。」 | deferred: the `placeholder` facet is not built |
//! | §3「代价更高的面要按名字单独要。」 | deferred: no costlier facet (`macos`, `placeholder`) is built |
//! | §3「双方都有的分量里任何一个不同，就是变了。」 | `a_differing_shared_component_is_a_change` |
//! | §3「一方没有的分量不参与比较。」 | `a_component_on_one_side_only_is_not_compared` |
//! | §3「标明「标识内容」的分量相同，则内容相同；`content` 可以直接据此回答，不读字节。」 | deferred: `content` not built; this implementation has no such component |
//! | §4 `glance`「每个位置一个描述；没有的是 `kind: none`」 | `glance_describes_each_place_and_none_for_missing` |
//! | §4 `overview`「`entries`、`more`（`at_least` 和续页用的 `after`）、`total`」，`limit`（默认 200） | `overview_pages_with_after_and_defaults_to_200` |
//! | §4 `probe`「在预算内数到的文件数、目录数、字节数，`exceeded`，顶层发现的标记名」 | `probe_counts_files_dirs_and_bytes` |
//! | §4 `probe`「`budget`（默认 500）」 | `probe_budget_defaults_to_500` |
//! | §4 `look`「每个位置：`same`、`changed`（带新描述）、`gone`」 | `look_answers_same_changed_and_gone` |
//! | §4 `changed`、`content`、`read`、`write`、`move`、`remove` 各行 | deferred: not built |
//! | §4「代价的上界」一列 | timed by the benchmark (`bench/`): cost is time, not an answer |
//! | §4「在对象存储上」一列 | deferred: constrains the abstraction, not this implementation |
//! | §4「`overview` 的条目按名字排序，目录和文件混排；`after` 是上一页最后一个名字。」 | `overview_sorts_by_name_bytes_mixing_dirs_and_files` |
//! | §4「噪音条目不出现，但答复里给出被略去的噪音名字的列表（只是名字，不进去）。」 | `overview_names_the_noise_it_left_out` |
//! | §4「`probe` 发现的标记是顶层几个众所周知的文件名…由实现列出」 | `probe_reports_top_level_markers` |
//! | §4「`changed` 的粒度由存储定。…」 | deferred: `changed` not built |
//! | §4「内容规则：…」 | deferred: `content` and `write` not built |
//! | §4「存储不提供「对整个库做什么」的操作。」 | `describe_lists_no_whole_library_operation` |
//! | §5 `facts.append`「每条事实得到的次序标记」 | `append_gives_one_order_per_fact` |
//! | §5 `facts.since`「事实（按次序）和新游标」 | `facts_since_gives_only_what_follows_the_cursor` |
//! | §5 `facts.since`「新事实的条数，与已有总数无关」 | `facts_since_with_nothing_new_reads_no_old_day` (cost in time: benchmark) |
//! | §5 `rows.put`「完成」、`rows.get`「行」 | `rows_put_then_get_round_trips` |
//! | §5 `rows.under`「一页行，和 `more`」 | `rows_under_pages_by_prefix` |
//! | §5 `rows.where`「一页行或个数」 | `rows_where_pages_and_counts` |
//! | §5 `rows.reset`「清空这个记录处的行和它的事实游标」 | `rows_reset_drops_rows_and_cursor` |
//! | §5「事实是本体：只追加，随库同步，多个写入者同时写不冲突（各写各的文件）。」 | `each_append_is_its_own_file_under_its_day`, `concurrent_appends_and_puts_lose_nothing` |
//! | §5「事实文件按日期分目录存放；旧版式（不分日期）仍然读。」 | `each_append_is_its_own_file_under_its_day`, `the_old_layout_is_still_read` |
//! | §5「行是缓存：不同步，可以整个删掉。」 | `rows_are_a_cache_that_can_be_deleted` |
//! | §5「游标和行在同一次提交里更新。」 | `rows_and_cursor_change_in_one_commit` |
//! | §5「可查的字段在 `rows.put` 时随行给出，每张表最多 4 个，值是字符串。」 | `fields_are_at_most_four_strings_per_table` |
//! | §5「不提供任意查询。」 | `there_is_no_query_operation` |
//! | README `facts.since`：`limit` 0 给出最新事实之后的游标 | `limit_zero_gives_a_cursor_at_the_end` |
//! | README `facts.since`：没有新事实时，最新事实之后的游标每次是同一段字 | `the_cursor_at_the_end_is_the_same_while_nothing_changes` |
//! | README `facts.since`：不再对得上的游标答 `refused` | `a_cursor_that_no_longer_fits_is_refused` |
//! | README `facts.since`：晚链入、时间在 10 秒内的文件照样给出 | `a_late_linked_file_is_still_given` |
//! | §6 `init`「建立库的记录区和缓存区，写下默认的噪音名单。已是库则什么都不改」 | `init_makes_the_areas_once` |
//! | §6 `describe`「实现的名字、契约版本、能不能给出可靠的游标、能给哪些面」 | `describe_says_what_the_storage_is` |
//! | §6 `noise.list`、`noise.add`、`noise.remove`「读和改库根上声明的噪音名字与路径」 | `noise_is_listed_added_and_removed` |
//! | §6 `hold`、`release` | deferred: not built |
//! | §6 `serve`「每行一个带 `id` 的请求，答复带同一个 `id`」 | `serve_echoes_ids` |
//! | §6 `serve`「长操作先发若干条进度再发结果」 | deferred: no operation built is long enough to send progress |
//! | §6 `serve`「可按 `id` 取消」 | `serve_cancels_by_id` |
//! | §7 `fs`「`inode`、`device`、`created`、`mode`，总有」 | `the_fs_facet_is_always_there` |
//! | §7 `macos`、`placeholder` | deferred: not built |
//! | §7「令牌的分量：`size`、`modified`、`changed`、`inode`。」 | `the_token_moves_with_size_mtime_ctime_and_inode` |
//! | §7「本机实现没有标识内容的分量」 | `the_token_has_no_content_component` |
//! | §7「一个位置在写入后的极短时间内被再次修改时…下一次比较时读内容确认。」 | deferred: needs `content` |
//! | §8「每个失败的答复是 `{ "outcome": "failed" \| "refused", "reason": "…", … }`」 | `every_answer_is_a_json_object_with_a_fixed_reason` |
//! | §8 `no_such_place`、`not_a_dir` | `listing_a_missing_or_file_place_fails` |
//! | §8 `noise` | `noise_places_answer_noise` |
//! | §8 `outside`「位置指到了库外」 | `places_below_a_link_or_in_the_record_area_are_outside` |
//! | §8 `refused`「预期不成立，带 `actual`」 | `rows_put_with_a_wrong_expectation_changes_nothing` |
//! | §8 `unreadable`「存储读不了它，带系统给的原因」 | `an_unreadable_dir_does_not_stop_the_rest` |
//! | §8 `bad_request` | `malformed_places_are_bad_requests`, `every_answer_is_a_json_object_with_a_fixed_reason` |
//! | §8 `cancelled` | `serve_cancels_by_id` |
//! | §8 `not_a_file`、`too_many`、`elsewhere`、`held`、`cannot_say` | deferred: only `read`/`content`/`hold`/`changed` answer them |
//! | §8 `busy` | deferred: needs a lock held past the 10 s wait, which no built operation does |

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, Permissions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_pneuma-base-core");

const REASONS: [&str; 14] = [
    "no_such_place",
    "not_a_dir",
    "not_a_file",
    "noise",
    "outside",
    "refused",
    "too_many",
    "elsewhere",
    "held",
    "cannot_say",
    "unreadable",
    "bad_request",
    "cancelled",
    "busy",
];

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

// ---------------------------------------------------------------------------------------------
// Harness

/// A library folder of its own, removed when dropped.
struct Lib {
    dir: tempfile::TempDir,
}

impl Lib {
    fn new() -> Lib {
        let lib = Lib::bare();
        assert_eq!(lib.run("init", json!({}))["created"], true);
        lib
    }

    fn bare() -> Lib {
        let dir = tempfile::Builder::new()
            .prefix("pneuma-base-contract.")
            .tempdir()
            .expect("temporary folder");
        Lib { dir }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn at(&self, place: &str) -> PathBuf {
        self.root().join(place)
    }

    fn write(&self, place: &str, text: &str) {
        let path = self.at(place);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn mkdir(&self, place: &str) {
        fs::create_dir_all(self.at(place)).unwrap();
    }

    fn run(&self, op: &str, request: Value) -> Value {
        let (answer, code) = call(
            &[op, "--root", self.root().to_str().unwrap(), "-"],
            Some(&request.to_string()),
        );
        assert_eq!(code, 0, "{op} exited {code}: {answer}");
        answer
    }

    fn glance_one(&self, place: &str) -> Value {
        self.run("glance", json!({ "places": [place] }))["entries"][0].clone()
    }

    fn token(&self, place: &str) -> String {
        self.glance_one(place)["token"]
            .as_str()
            .expect("a token")
            .to_owned()
    }

    fn look_one(&self, place: &str, token: &str) -> Value {
        self.run(
            "look",
            json!({ "places": [{ "place": place, "token": token }] }),
        )
    }

    fn serve(&self) -> Serve {
        let mut child = Command::new(BIN)
            .args(["serve", "--root"])
            .arg(self.root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("serve starts");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Serve {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }
}

fn call(args: &[&str], stdin: Option<&str>) -> (Value, i32) {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("binary starts");
    let mut input = child.stdin.take().unwrap();
    if let Some(text) = stdin {
        input.write_all(text.as_bytes()).unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    let text = String::from_utf8(output.stdout).expect("UTF-8 output");
    assert_eq!(text.lines().count(), 1, "one answer line: {text:?}");
    let answer = serde_json::from_str(&text).expect("JSON answer");
    (answer, output.status.code().unwrap_or(-1))
}

struct Serve {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Serve {
    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("JSON line: {line:?}"))
    }

    fn ask(&mut self, id: Value, op: &str, mut request: Value) -> Value {
        request["id"] = id;
        request["op"] = json!(op);
        self.send(&request.to_string());
        self.receive()
    }

    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

/// Makes a path unreadable and restores it when dropped, before the folder is removed.
struct Locked(PathBuf);

impl Locked {
    fn new(path: PathBuf) -> Option<Locked> {
        fs::set_permissions(&path, Permissions::from_mode(0o000)).unwrap();
        let locked = Locked(path);
        // Root reads anything; the property cannot be shown then.
        if fs::read_dir(&locked.0).is_ok() {
            eprintln!("skipped: permissions do not apply to this user");
            return None;
        }
        Some(locked)
    }
}

impl Drop for Locked {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, Permissions::from_mode(0o755));
    }
}

fn places_of(entries: &Value) -> Vec<String> {
    entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["place"].as_str().unwrap().to_owned())
        .collect()
}

fn assert_failed(answer: &Value, reason: &str) {
    assert_eq!(answer["outcome"], "failed", "{answer}");
    assert_eq!(answer["reason"], reason, "{answer}");
}

fn set_mtime(path: &Path, when: SystemTime) {
    File::open(path).unwrap().set_modified(when).unwrap();
}

fn an_hour_ago() -> SystemTime {
    SystemTime::now() - Duration::from_secs(3_600)
}

fn token_parts(token: &str) -> BTreeMap<String, String> {
    let mut parts = token.split(';');
    assert_eq!(parts.next(), Some("v1"));
    parts
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap();
            (k.to_owned(), v.to_owned())
        })
        .collect()
}

fn token_from(parts: &BTreeMap<String, String>) -> String {
    let mut text = "v1".to_owned();
    for (k, v) in parts {
        text.push_str(&format!(";{k}={v}"));
    }
    text
}

fn facts_of(answer: &Value) -> Vec<Value> {
    answer["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["fact"].clone())
        .collect()
}

fn orders_of(answer: &Value) -> Vec<String> {
    answer["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["order"].as_str().unwrap().to_owned())
        .collect()
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

// ---------------------------------------------------------------------------------------------
// Preamble and section 1

#[test]
fn serve_answers_like_one_shot() {
    let lib = Lib::new();
    lib.write("notes/a.md", "alpha");
    lib.write("notes/b.md", "beta");
    let mut serve = lib.serve();
    for (op, request) in [
        (
            "glance",
            json!({ "places": ["notes", "notes/a.md", "missing"] }),
        ),
        ("overview", json!({ "place": "notes" })),
        ("probe", json!({ "place": "" })),
        ("noise.list", json!({})),
    ] {
        let one = lib.run(op, request.clone());
        let mut served = serve.ask(json!(op), op, request);
        assert_eq!(served["id"], json!(op));
        served.as_object_mut().unwrap().remove("id");
        assert_eq!(served, one, "{op}");
    }
    assert_eq!(serve.finish(), 0);
}

#[test]
fn malformed_places_are_bad_requests() {
    let lib = Lib::new();
    for bad in ["/a", "a/", "a//b", ".", "a/./b", "..", "a/../b"] {
        assert_failed(&lib.run("overview", json!({ "place": bad })), "bad_request");
        let entry = lib.glance_one(bad);
        assert_eq!(entry["place"], bad);
        assert_eq!(entry["reason"], "bad_request", "{entry}");
    }
}

// ---------------------------------------------------------------------------------------------
// Section 2: rules

#[test]
fn overview_lists_one_level() {
    let lib = Lib::new();
    lib.write("a/b/c.txt", "c");
    lib.write("a/d.txt", "d");
    let answer = lib.run("overview", json!({ "place": "a" }));
    assert_eq!(places_of(&answer["entries"]), ["a/b", "a/d.txt"]);
}

#[test]
fn listing_stops_at_the_limit_and_says_at_least() {
    let lib = Lib::new();
    for i in 0..30 {
        lib.write(&format!("many/f{i:02}"), "");
    }
    let answer = lib.run("overview", json!({ "place": "many", "limit": 10 }));
    assert_eq!(answer["entries"].as_array().unwrap().len(), 10);
    let at_least = answer["more"]["at_least"].as_u64().unwrap();
    assert!(
        (1..=20).contains(&at_least),
        "at least {at_least} of the 20 that follow"
    );
    assert_eq!(answer["more"]["after"], "f09");
}

#[test]
fn probe_stops_at_the_budget() {
    let lib = Lib::new();
    for i in 0..30 {
        lib.write(&format!("many/f{i:02}"), "x");
    }
    let answer = lib.run("probe", json!({ "place": "many", "budget": 10 }));
    assert_eq!(answer["exceeded"], true);
    assert_eq!(
        answer["files"].as_u64().unwrap() + answer["dirs"].as_u64().unwrap(),
        10
    );
}

#[test]
fn count_stops_at_its_cap() {
    let lib = Lib::new();
    let rows: Vec<Value> = (0..15)
        .map(|i| json!({ "key": format!("k{i:02}"), "fields": { "kind": "x" }, "value": i }))
        .collect();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": rows }),
    );
    let capped = lib.run("rows.where", json!({ "place": "p", "table": "t", "field": "kind", "value": "x", "count": true, "limit": 10 }));
    assert_eq!(capped["count"], 10);
    assert_eq!(capped["exceeded"], true);
    let whole = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "kind", "value": "x", "count": true }),
    );
    assert_eq!(whole["count"], 15);
    assert_eq!(whole["exceeded"], false);
}

#[test]
fn look_at_a_dir_does_not_descend() {
    let lib = Lib::new();
    lib.write("a/b/c.txt", "short");
    let token = lib.token("a");
    lib.write("a/b/c.txt", "a much longer content than before");
    let answer = lib.look_one("a", &token);
    assert_eq!(answer["same"], 1, "{answer}");
}

#[test]
fn metadata_operations_do_not_read_bytes() {
    let lib = Lib::new();
    lib.write("box/secret.txt", "12345");
    let token = lib.token("box/secret.txt");
    fs::set_permissions(lib.at("box/secret.txt"), Permissions::from_mode(0o000)).unwrap();
    let entry = lib.glance_one("box/secret.txt");
    assert_eq!(entry["kind"], "file");
    assert_eq!(entry["size"], 5);
    let listed = lib.run("overview", json!({ "place": "box" }));
    assert_eq!(places_of(&listed["entries"]), ["box/secret.txt"]);
    assert_eq!(lib.run("probe", json!({ "place": "box" }))["bytes"], 5);
    // chmod moved the change time, so the place changed; it was still described from metadata.
    let looked = lib.look_one("box/secret.txt", &token);
    assert_eq!(looked["changed"][0]["entry"]["size"], 5, "{looked}");
    fs::set_permissions(lib.at("box/secret.txt"), Permissions::from_mode(0o644)).unwrap();
}

#[test]
fn rows_put_with_a_wrong_expectation_changes_nothing() {
    let lib = Lib::new();
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
    assert_eq!(refused["outcome"], "refused");
    assert_eq!(refused["reason"], "refused");
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
    let fresh = Lib::new();
    let first = fresh.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [], "cursor": "c1", "expect": null }),
    );
    assert_eq!(first["outcome"], "done");
}

#[test]
fn noise_places_answer_noise() {
    let lib = Lib::new();
    lib.write("node_modules/x.js", "x");
    lib.write("notes/.git/HEAD", "ref");
    for place in [
        "node_modules",
        "node_modules/x.js",
        "notes/.git",
        "notes/.git/HEAD",
    ] {
        assert_eq!(lib.glance_one(place)["reason"], "noise", "{place}");
        assert_failed(&lib.run("overview", json!({ "place": place })), "noise");
        assert_failed(&lib.run("probe", json!({ "place": place })), "noise");
        let looked = lib.look_one(place, "v1;s=1");
        assert_eq!(looked["failed"][0]["reason"], "noise", "{looked}");
    }
}

#[test]
fn noise_is_neither_listed_nor_entered() {
    let lib = Lib::new();
    lib.write("app/src/main.rs", "fn main() {}");
    for i in 0..20 {
        lib.write(&format!("app/node_modules/pkg{i}/index.js"), "x");
    }
    let probed = lib.run("probe", json!({ "place": "app" }));
    assert_eq!(probed["files"], 1);
    assert_eq!(probed["dirs"], 1);
    let listed = lib.run("overview", json!({ "place": "app" }));
    assert_eq!(places_of(&listed["entries"]), ["app/src"]);
}

#[test]
fn deleting_the_cache_area_changes_no_answer() {
    let lib = Lib::new();
    for i in 0..1_500 {
        lib.write(&format!("big/e{i:04}"), "");
    }
    set_mtime(&lib.at("big"), an_hour_ago());
    let ask = |after: Option<&str>| {
        let mut request = json!({ "place": "big", "limit": 300 });
        if let Some(after) = after {
            request["after"] = json!(after);
        }
        lib.run("overview", request)
    };
    let first = ask(None);
    let page = ask(Some("e0700"));
    let cache = lib.at(".pneuma-base/cache");
    let cached_files = walk_files(&cache);
    assert!(!cached_files.is_empty(), "the large listing was cached");
    assert_eq!(ask(None), first);
    fs::remove_dir_all(&cache).unwrap();
    assert_eq!(ask(None), first);
    assert_eq!(ask(Some("e0700")), page);
}

fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(walk_files(&path));
            } else {
                found.push(path);
            }
        }
    }
    found
}

#[test]
fn a_changed_directory_is_listed_again() {
    let lib = Lib::new();
    for i in 0..1_500 {
        lib.write(&format!("big/e{i:04}"), "");
    }
    set_mtime(&lib.at("big"), an_hour_ago());
    let before = lib.run("overview", json!({ "place": "big", "after": "e1400" }));
    assert_eq!(before["entries"].as_array().unwrap().len(), 99);
    lib.write("big/zz-new", "");
    fs::remove_file(lib.at("big/e1499")).unwrap();
    let after = lib.run("overview", json!({ "place": "big", "after": "e1400" }));
    let places = places_of(&after["entries"]);
    assert!(places.contains(&"big/zz-new".to_owned()));
    assert!(!places.contains(&"big/e1499".to_owned()));
}

#[test]
fn concurrent_appends_and_puts_lose_nothing() {
    let lib = Lib::new();
    let (writers, rounds, per_append) = (8, 8, 5);
    std::thread::scope(|scope| {
        for w in 0..writers {
            let lib = &lib;
            scope.spawn(move || {
                for r in 0..rounds {
                    let facts: Vec<Value> = (0..per_append)
                        .map(|n| json!({ "w": w, "r": r, "n": n }))
                        .collect();
                    let answer = lib.run("facts.append", json!({ "place": "log", "facts": facts }));
                    assert_eq!(
                        answer["orders"].as_array().unwrap().len(),
                        per_append,
                        "{answer}"
                    );
                }
            });
            scope.spawn(move || {
                for r in 0..rounds {
                    let rows: Vec<Value> = (0..per_append)
                        .map(|n| json!({ "key": format!("w{w}/r{r}/n{n}"), "fields": { "w": w.to_string() }, "value": { "r": r, "n": n } }))
                        .collect();
                    let answer = lib.run("rows.put", json!({ "place": "log", "table": "t", "rows": rows }));
                    assert_eq!(answer["outcome"], "done", "{answer}");
                }
            });
        }
    });
    let since = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": null, "limit": 10_000 }),
    );
    let facts = facts_of(&since);
    assert_eq!(facts.len(), writers * rounds * per_append);
    let distinct: BTreeSet<String> = facts.iter().map(Value::to_string).collect();
    assert_eq!(distinct.len(), facts.len());
    let orders: BTreeSet<String> = orders_of(&since).into_iter().collect();
    assert_eq!(orders.len(), facts.len());
    let rows = lib.run(
        "rows.under",
        json!({ "place": "log", "table": "t", "prefix": "", "limit": 10_000 }),
    );
    let rows = rows["rows"].as_array().unwrap();
    assert_eq!(rows.len(), writers * rounds * per_append);
    for w in 0..writers {
        let count = lib.run("rows.where", json!({ "place": "log", "table": "t", "field": "w", "value": w.to_string(), "count": true }));
        assert_eq!(count["count"], rounds * per_append);
    }
}

#[test]
fn an_interrupted_append_leaves_no_half_file() {
    let lib = Lib::new();
    // Large facts make writing the file a good part of an append, so kills land inside it.
    let batch_size = 200;
    let payload = "x".repeat(20_000);
    let append = |batch: u64, kill_after: Option<Duration>| {
        let facts: Vec<Value> = (0..batch_size)
            .map(|n| json!({ "batch": batch, "n": n, "pad": payload }))
            .collect();
        let body = json!({ "place": "log", "facts": facts }).to_string();
        let mut child = Command::new(BIN)
            .args(["facts.append", "--root"])
            .arg(lib.root())
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let started = std::time::Instant::now();
        let feeder = std::thread::spawn(move || {
            let _ = stdin.write_all(body.as_bytes());
        });
        if let Some(delay) = kill_after {
            std::thread::sleep(delay);
            let _ = child.kill();
        }
        let _ = child.wait();
        let _ = feeder.join();
        started.elapsed()
    };
    let whole = append(0, None);
    let attempts = 16;
    for k in 1..=attempts {
        append(k, Some(whole * k as u32 / attempts as u32));
    }
    let mut counts: HashMap<u64, usize> = HashMap::new();
    let mut cursor = Value::Null;
    loop {
        let since = lib.run(
            "facts.since",
            json!({ "place": "log", "cursor": cursor, "limit": 10_000 }),
        );
        for fact in facts_of(&since) {
            *counts.entry(fact["batch"].as_u64().unwrap()).or_default() += 1;
        }
        cursor = since["cursor"].clone();
        if since["more"] != true {
            break;
        }
    }
    for (batch, count) in counts {
        assert_eq!(count, batch_size, "batch {batch} is whole or absent");
    }
}

#[test]
fn every_answer_is_a_json_object_with_a_fixed_reason() {
    let lib = Lib::new();
    let root = lib.root().to_str().unwrap();
    let missing = lib.at("not-there");
    let cases: Vec<(Vec<&str>, Option<&str>, i32)> = vec![
        (vec!["no.such.op", "--root", root], None, 2),
        (vec!["glance"], None, 2),
        (vec!["glance", "--root", missing.to_str().unwrap()], None, 2),
        (vec!["glance", "--root", root, "{not json"], None, 0),
        (vec!["glance", "--root", root, "[1,2]"], None, 0),
        (
            vec!["glance", "--root", root, "-"],
            Some("{\"places\": 7}"),
            0,
        ),
        (
            vec!["overview", "--root", root, "{\"place\":\"nope\"}"],
            None,
            0,
        ),
        (
            vec!["facts.since", "--root", root, "{\"place\":\"Bad Name\"}"],
            None,
            0,
        ),
        (
            vec![
                "facts.since",
                "--root",
                root,
                "{\"place\":\"p\",\"cursor\":\"not a cursor\"}",
            ],
            None,
            0,
        ),
        (
            vec![
                "rows.under",
                "--root",
                root,
                "{\"place\":\"p\",\"table\":\"t\",\"limit\":0}",
            ],
            None,
            0,
        ),
    ];
    for (args, stdin, code) in cases {
        let (answer, exit) = call(&args, stdin);
        assert_eq!(exit, code, "{args:?}");
        assert_eq!(answer["outcome"], "failed", "{args:?}: {answer}");
        let reason = answer["reason"].as_str().unwrap();
        assert!(REASONS.contains(&reason), "{reason}");
        no_sentences(&answer);
    }
}

/// No string in a failure is a sentence for people.
fn no_sentences(answer: &Value) {
    for (key, value) in answer.as_object().unwrap() {
        if let Some(text) = value.as_str() {
            assert!(!text.contains(' ') || key == "place", "{key}: {text:?}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Section 3: a place's description

#[test]
fn descriptions_have_the_contract_shape() {
    let lib = Lib::new();
    lib.write("d/f.txt", "four");
    let moment = UNIX_EPOCH + Duration::from_millis(1_795_679_280_123);
    set_mtime(&lib.at("d/f.txt"), moment);
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
            BTreeSet::from(["place", "kind", "token", "size", "modified", "facets"])
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
    assert!(dir["modified"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn a_dir_size_is_its_entry_count() {
    let lib = Lib::new();
    lib.write("three/a", "");
    lib.write("three/b", "");
    lib.mkdir("three/c");
    let size = &lib.glance_one("three")["size"];
    if cfg!(target_os = "macos") {
        assert_eq!(*size, 3);
    } else {
        // README: null where the platform does not give the count without listing.
        assert!(size.is_null() || *size == 3, "{size}");
    }
}

#[test]
fn facets_are_the_ones_section_7_names() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    std::os::unix::fs::symlink("f.txt", lib.at("link")).unwrap();
    let named = BTreeSet::from(["fs", "macos", "placeholder"]);
    for place in ["", "f.txt", "link"] {
        let facets = lib.glance_one(place)["facets"].clone();
        for name in facets.as_object().unwrap().keys() {
            assert!(named.contains(name.as_str()), "{name}");
        }
    }
    for name in lib.run("describe", json!({}))["facets"].as_array().unwrap() {
        assert!(named.contains(name.as_str().unwrap()));
    }
}

#[test]
fn facets_of_an_unreadable_dir_need_no_listing() {
    let lib = Lib::new();
    lib.write("locked/a.txt", "a");
    let path = lib.at("locked");
    let inode = fs::metadata(&path).unwrap().ino();
    let Some(_locked) = Locked::new(path) else {
        return;
    };
    let entry = lib.glance_one("locked");
    assert_eq!(entry["kind"], "dir", "{entry}");
    assert_eq!(entry["facets"]["fs"]["inode"], inode);
}

#[test]
fn a_differing_shared_component_is_a_change() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    let token = lib.token("f.txt");
    assert_eq!(lib.look_one("f.txt", &token)["same"], 1);
    let mut parts = token_parts(&token);
    let m = parts.get_mut("m").unwrap();
    *m = format!("{}", m.parse::<i128>().unwrap() - 1);
    let looked = lib.look_one("f.txt", &token_from(&parts));
    assert_eq!(looked["changed"][0]["place"], "f.txt", "{looked}");
    assert_eq!(looked["changed"][0]["entry"]["token"], token.as_str());
}

#[test]
fn a_component_on_one_side_only_is_not_compared() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    let token = lib.token("f.txt");
    let mut fewer = token_parts(&token);
    fewer.remove("c");
    assert_eq!(lib.look_one("f.txt", &token_from(&fewer))["same"], 1);
    let mut more = token_parts(&token);
    more.insert("x".into(), "elsewhere-version-7".into());
    assert_eq!(lib.look_one("f.txt", &token_from(&more))["same"], 1);
}

// ---------------------------------------------------------------------------------------------
// Section 4: the content half

#[test]
fn glance_describes_each_place_and_none_for_missing() {
    let lib = Lib::new();
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
}

#[test]
fn overview_pages_with_after_and_defaults_to_200() {
    let lib = Lib::new();
    for i in 0..250 {
        lib.write(&format!("d/n{i:03}"), "");
    }
    let first = lib.run("overview", json!({ "place": "d" }));
    assert_eq!(first["entries"].as_array().unwrap().len(), 200);
    assert_eq!(first["more"]["after"], "n199");
    let at_least = first["more"]["at_least"].as_u64().unwrap();
    assert!((1..=50).contains(&at_least));
    if !first["total"].is_null() {
        assert_eq!(first["total"], 250);
    }
    let second = lib.run("overview", json!({ "place": "d", "after": "n199" }));
    assert!(second["more"].is_null());
    let mut all = places_of(&first["entries"]);
    all.extend(places_of(&second["entries"]));
    let expected: Vec<String> = (0..250).map(|i| format!("d/n{i:03}")).collect();
    assert_eq!(all, expected);
}

#[test]
fn probe_counts_files_dirs_and_bytes() {
    let lib = Lib::new();
    lib.write("t/a.txt", "abc");
    lib.write("t/sub/b.txt", "abcde");
    lib.write("t/sub/deeper/c.txt", "abcdefg");
    let answer = lib.run("probe", json!({ "place": "t" }));
    assert_eq!(answer["files"], 3);
    assert_eq!(answer["dirs"], 2);
    assert_eq!(answer["bytes"], 15);
    assert_eq!(answer["exceeded"], false);
    assert_eq!(answer["markers"], json!([]));
}

#[test]
fn probe_budget_defaults_to_500() {
    let lib = Lib::new();
    for i in 0..600 {
        lib.write(&format!("d/f{i:03}"), "");
    }
    let answer = lib.run("probe", json!({ "place": "d" }));
    assert_eq!(answer["exceeded"], true);
    assert_eq!(answer["files"], 500);
}

#[test]
fn look_answers_same_changed_and_gone() {
    let lib = Lib::new();
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
    assert_eq!(answer["same"], 1);
    assert_eq!(answer["gone"], json!(["d/goes"]));
    let changed: BTreeMap<String, Value> = answer["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["place"].as_str().unwrap().to_owned(), c["entry"].clone()))
        .collect();
    assert_eq!(changed["d/grows"]["size"], 8);
    assert_eq!(changed["d/becomes-dir"]["kind"], "dir");
    assert_eq!(answer["failed"], json!([]));
}

#[test]
fn overview_sorts_by_name_bytes_mixing_dirs_and_files() {
    let lib = Lib::new();
    for name in ["b.txt", "Z", "é.md", "_x", "10", "9"] {
        lib.write(&format!("d/{name}"), "");
    }
    lib.mkdir("d/B-dir");
    lib.mkdir("d/a");
    let answer = lib.run("overview", json!({ "place": "d" }));
    let expected = ["10", "9", "B-dir", "Z", "_x", "a", "b.txt", "é.md"].map(|n| format!("d/{n}"));
    assert_eq!(places_of(&answer["entries"]), expected);
    let page = lib.run(
        "overview",
        json!({ "place": "d", "after": "Z", "limit": 2 }),
    );
    assert_eq!(places_of(&page["entries"]), ["d/_x", "d/a"]);
    assert_eq!(page["more"]["after"], "a");
}

#[test]
fn overview_names_the_noise_it_left_out() {
    let lib = Lib::new();
    lib.write("w/node_modules/x/index.js", "x");
    lib.write("w/.DS_Store", "");
    lib.write("w/notes/drafts/a.md", "a");
    lib.write("w/notes/kept.md", "k");
    let answer = lib.run("overview", json!({ "place": "w" }));
    assert_eq!(places_of(&answer["entries"]), ["w/notes"]);
    let noise: BTreeSet<String> = answer["noise"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        noise,
        BTreeSet::from([".DS_Store".to_owned(), "node_modules".to_owned()])
    );
    lib.run("noise.add", json!({ "paths": ["w/notes/drafts"] }));
    let notes = lib.run("overview", json!({ "place": "w/notes" }));
    assert_eq!(places_of(&notes["entries"]), ["w/notes/kept.md"]);
    assert_eq!(notes["noise"], json!(["drafts"]));
}

#[test]
fn probe_reports_top_level_markers() {
    let lib = Lib::new();
    lib.write("project/package.json", "{}");
    lib.write("project/.git/HEAD", "ref");
    lib.write("project/sub/Cargo.toml", "");
    let markers: BTreeSet<String> = lib.run("probe", json!({ "place": "project" }))["markers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        markers,
        BTreeSet::from([".git".to_owned(), "package.json".to_owned()])
    );
}

#[test]
fn describe_lists_no_whole_library_operation() {
    let lib = Lib::new();
    let ops = lib.run("describe", json!({}))["ops"].clone();
    assert_eq!(
        ops,
        json!([
            "glance",
            "overview",
            "probe",
            "look",
            "changed",
            "content",
            "read",
            "write",
            "move",
            "remove",
            "facts.append",
            "facts.since",
            "rows.put",
            "rows.get",
            "rows.under",
            "rows.where",
            "rows.reset",
            "init",
            "describe",
            "noise.list",
            "noise.add",
            "noise.remove",
            "hold",
            "release"
        ])
    );
}

// ---------------------------------------------------------------------------------------------
// Section 5: the record half

#[test]
fn append_gives_one_order_per_fact() {
    let lib = Lib::new();
    let appended = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "a": 1 }, { "b": 2 }, { "c": 3 }] }),
    );
    let orders: Vec<String> = appended["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(orders.len(), 3);
    assert_eq!(orders.iter().collect::<BTreeSet<_>>().len(), 3);
    let since = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(orders_of(&since), orders);
    assert_eq!(
        facts_of(&since),
        [json!({ "a": 1 }), json!({ "b": 2 }), json!({ "c": 3 })]
    );
}

#[test]
fn facts_since_gives_only_what_follows_the_cursor() {
    let lib = Lib::new();
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
        assert!(page["facts"].as_array().unwrap().len() <= 2);
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
}

#[test]
fn facts_since_with_nothing_new_survives_an_unreadable_old_day() {
    let lib = Lib::new();
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
        return;
    };
    let again = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": all["cursor"] }),
    );
    assert_eq!(again["outcome"], "done", "{again}");
    assert_eq!(facts_of(&again), Vec::<Value>::new());
}

#[test]
fn rows_put_then_get_round_trips() {
    let lib = Lib::new();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "items", "rows": [
        { "key": "a", "fields": { "scene": "s1" }, "value": { "title": "A", "n": [1, 2] } },
        { "key": "b", "value": "plain" },
    ] }),
    );
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
}

#[test]
fn rows_under_pages_by_prefix() {
    let lib = Lib::new();
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
    assert_eq!(one["more"]["after"], "a/2");
    let two = lib.run(
        "rows.under",
        json!({ "place": "p", "table": "t", "prefix": "a/", "limit": 2, "after": "a/2" }),
    );
    assert_eq!(keys(&two), ["a/3", "a/4"]);
    let three = lib.run(
        "rows.under",
        json!({ "place": "p", "table": "t", "prefix": "a/", "limit": 2, "after": "a/4" }),
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
}

#[test]
fn rows_where_pages_and_counts() {
    let lib = Lib::new();
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
    assert_eq!(page["more"]["after"], "k4");
    let rest = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "scene", "value": "even", "after": "k4" }),
    );
    assert_eq!(rest["rows"][0]["key"], "k6");
    assert!(rest["more"].is_null());
    let count = lib.run(
        "rows.where",
        json!({ "place": "p", "table": "t", "field": "scene", "value": "odd", "count": true }),
    );
    assert_eq!(count["count"], 3);
}

#[test]
fn rows_reset_drops_rows_and_cursor() {
    let lib = Lib::new();
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
}

#[test]
fn each_append_is_its_own_file_under_its_day() {
    let lib = Lib::new();
    let one = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "a": 1 }] }),
    );
    let two = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "b": 2 }] }),
    );
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
}

#[test]
fn the_old_layout_is_still_read() {
    let lib = Lib::new();
    lib.write(
        ".pneuma-base/log/facts/scene-a/001.jsonl",
        "{\"old\":1}\nnot json\n{\"old\":2}\n",
    );
    lib.write(".pneuma-base/log/facts/scene-b/001.jsonl", "{\"old\":3}\n");
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "new": 1 }] }),
    );
    let since = lib.run("facts.since", json!({ "place": "log", "cursor": null }));
    assert_eq!(
        facts_of(&since),
        [
            json!({ "old": 1 }),
            json!({ "old": 2 }),
            json!({ "old": 3 }),
            json!({ "new": 1 })
        ]
    );
    let orders = orders_of(&since);
    assert_eq!(
        orders[..3],
        [
            "old/scene-a/001.jsonl#1",
            "old/scene-a/001.jsonl#3",
            "old/scene-b/001.jsonl#1"
        ]
    );
    lib.write(".pneuma-base/log/facts/scene-c/001.jsonl", "{\"old\":4}\n");
    let later = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": since["cursor"] }),
    );
    assert_eq!(facts_of(&later), [json!({ "old": 4 })]);
}

#[test]
fn rows_are_a_cache_that_can_be_deleted() {
    let lib = Lib::new();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": 1 }], "cursor": "c1" }),
    );
    fs::remove_dir_all(lib.at(".pneuma-base/cache")).unwrap();
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
}

#[test]
fn rows_and_cursor_change_in_one_commit() {
    let lib = Lib::new();
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
}

#[test]
fn fields_are_at_most_four_strings_per_table() {
    let lib = Lib::new();
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
}

#[test]
fn there_is_no_query_operation() {
    let lib = Lib::new();
    let (answer, code) = call(
        &["rows.query", "--root", lib.root().to_str().unwrap()],
        None,
    );
    assert_eq!(code, 2);
    assert_failed(&answer, "bad_request");
    let mut serve = lib.serve();
    assert_failed(
        &serve.ask(json!(1), "rows.query", json!({ "place": "p" })),
        "bad_request",
    );
    serve.finish();
}

#[test]
fn limit_zero_gives_a_cursor_at_the_end() {
    let lib = Lib::new();
    lib.write(".pneuma-base/log/facts/scene-a/001.jsonl", "{\"old\":1}\n");
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
    let empty = Lib::new();
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
}

#[test]
fn the_cursor_at_the_end_is_the_same_while_nothing_changes() {
    let lib = Lib::new();
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
}

#[test]
fn a_cursor_that_no_longer_fits_is_refused() {
    let lib = Lib::new();
    let facts_dir = lib.at(".pneuma-base/log/facts");
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 1 }] }),
    );
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
    fs::remove_dir_all(&facts_dir).unwrap();
    let gone = lib.run("facts.since", json!({ "place": "log", "cursor": cursor }));
    assert_eq!(gone, json!({ "outcome": "refused", "reason": "refused" }));
    lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": 2 }] }),
    );
    let replaced = lib.run("facts.since", json!({ "place": "log", "cursor": cursor }));
    assert_eq!(
        replaced,
        json!({ "outcome": "refused", "reason": "refused" })
    );

    // A cursor standing on no dated file still belongs to the folder it was made on. The old
    // folder is moved aside rather than deleted, so a file system that reuses inode numbers
    // cannot give the new folder the old one's.
    let old_only = Lib::new();
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
    let replaced = old_only.run("facts.since", json!({ "place": "log", "cursor": cursor }));
    assert_eq!(
        replaced,
        json!({ "outcome": "refused", "reason": "refused" })
    );

    let other = Lib::new();
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
    let missing = other.run("facts.since", json!({ "place": "log", "cursor": cursor }));
    assert_eq!(
        missing,
        json!({ "outcome": "refused", "reason": "refused" })
    );
}

#[test]
fn a_late_linked_file_is_still_given() {
    let lib = Lib::new();
    let appended = lib.run(
        "facts.append",
        json!({ "place": "log", "facts": [{ "n": "newest" }] }),
    );
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
}

// ---------------------------------------------------------------------------------------------
// Section 6: other operations

#[test]
fn init_makes_the_areas_once() {
    let lib = Lib::bare();
    assert_eq!(lib.run("init", json!({}))["created"], true);
    assert!(lib.at(".pneuma-base").is_dir());
    assert!(lib.at(".pneuma-base/cache").is_dir());
    let listed = lib.run("noise.list", json!({}));
    assert_eq!(listed["declared"], true);
    assert_eq!(listed["names"], json!(DEFAULT_NOISE));
    lib.run("noise.add", json!({ "names": ["build"] }));
    assert_eq!(lib.run("init", json!({}))["created"], false);
    let names = lib.run("noise.list", json!({}))["names"].clone();
    assert!(names.as_array().unwrap().contains(&json!("build")));
}

#[test]
fn describe_says_what_the_storage_is() {
    let lib = Lib::new();
    let answer = lib.run("describe", json!({}));
    assert_eq!(answer["name"], "local-folder");
    assert_eq!(answer["contract"], 1);
    assert_eq!(answer["addresses"], json!(["path"]));
    if cfg!(target_os = "macos") {
        assert_eq!(answer["cursor"], true);
        assert_eq!(answer["facets"], json!(["fs", "macos", "placeholder"]));
    } else {
        assert_eq!(answer["cursor"], false);
        assert_eq!(answer["facets"], json!(["fs"]));
    }
    assert!(answer["version"].is_string());
}

#[test]
fn noise_is_listed_added_and_removed() {
    let lib = Lib::bare();
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
    assert!(added["names"].as_array().unwrap().contains(&json!("build")));
    assert_eq!(added["paths"], json!(["docs/tmp"]));
    assert_eq!(lib.glance_one("build/out.bin")["reason"], "noise");
    assert_eq!(lib.glance_one("docs/tmp/scratch.md")["reason"], "noise");
    let removed = lib.run(
        "noise.remove",
        json!({ "names": ["build", "node_modules"], "paths": ["docs/tmp"] }),
    );
    assert!(
        !removed["names"]
            .as_array()
            .unwrap()
            .contains(&json!("build"))
    );
    assert!(
        !removed["names"]
            .as_array()
            .unwrap()
            .contains(&json!("node_modules"))
    );
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
}

#[test]
fn serve_echoes_ids() {
    let lib = Lib::new();
    let mut serve = lib.serve();
    serve.send(r#"{"id":"a","op":"describe"}"#);
    serve.send(r#"{"id":2,"op":"glance","places":[""]}"#);
    serve.send("this is not json");
    serve.send(r#"{"id":3,"op":"nope"}"#);
    let mut answers: Vec<Value> = (0..4).map(|_| serve.receive()).collect();
    answers.sort_by_key(|a| a["id"].to_string());
    let by_id: BTreeMap<String, Value> = answers
        .into_iter()
        .map(|a| (a["id"].to_string(), a))
        .collect();
    assert_eq!(by_id["\"a\""]["name"], "local-folder");
    assert_eq!(by_id["2"]["entries"][0]["kind"], "dir");
    assert_eq!(
        by_id["null"],
        json!({ "id": null, "outcome": "failed", "reason": "bad_request" })
    );
    assert_failed(&by_id["3"], "bad_request");
    assert_eq!(serve.finish(), 0);
}

#[test]
fn serve_cancels_by_id() {
    let lib = Lib::new();
    lib.mkdir("d");
    let places: Vec<Value> = (0..500_000)
        .map(|i| json!({ "place": format!("d/n{i}"), "token": "v1;s=0" }))
        .collect();
    let mut serve = lib.serve();
    let mut big = json!({ "id": "big", "op": "look", "places": places });
    serve.send(&big.take().to_string());
    serve.send(r#"{"id":"c1","op":"cancel","target":"big"}"#);
    serve.send(r#"{"id":"c2","op":"cancel","target":"never-sent"}"#);
    let answers: BTreeMap<String, Value> = (0..3)
        .map(|_| {
            let a = serve.receive();
            (a["id"].as_str().unwrap().to_owned(), a)
        })
        .collect();
    assert_eq!(
        answers["big"],
        json!({ "id": "big", "outcome": "failed", "reason": "cancelled" })
    );
    assert_eq!(answers["c1"], json!({ "id": "c1", "outcome": "done" }));
    assert_eq!(answers["c2"], json!({ "id": "c2", "outcome": "done" }));
    assert_eq!(serve.finish(), 0);
}

// ---------------------------------------------------------------------------------------------
// Section 7: the local folder's facets and token

#[test]
fn the_fs_facet_is_always_there() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    lib.mkdir("d");
    std::os::unix::fs::symlink("f.txt", lib.at("link")).unwrap();
    for place in ["f.txt", "d", "link", ""] {
        let entry = lib.glance_one(place);
        let fs_facet = &entry["facets"]["fs"];
        let meta = fs::symlink_metadata(lib.at(place)).unwrap();
        assert_eq!(fs_facet["inode"], meta.ino(), "{place}");
        assert_eq!(fs_facet["device"], meta.dev(), "{place}");
        assert_eq!(fs_facet["mode"], meta.mode(), "{place}");
        let created = &fs_facet["created"];
        if cfg!(target_os = "macos") {
            assert!(
                created.as_str().is_some_and(|c| c.ends_with('Z')),
                "{place}: {created}"
            );
        } else {
            assert!(created.is_null() || created.is_string());
        }
    }
    assert_eq!(lib.glance_one("link")["kind"], "other");
}

#[test]
fn the_token_moves_with_size_mtime_ctime_and_inode() {
    let lib = Lib::new();
    lib.write("f.txt", "abc");
    let meta = fs::metadata(lib.at("f.txt")).unwrap();
    let parts = token_parts(&lib.token("f.txt"));
    assert_eq!(parts["s"], "3");
    assert_eq!(parts["i"], meta.ino().to_string());
    assert_eq!(
        parts["m"],
        (i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec())).to_string()
    );
    assert_eq!(
        parts["c"],
        (i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())).to_string()
    );

    let changed = |change: &dyn Fn()| {
        let token = lib.token("f.txt");
        change();
        let looked = lib.look_one("f.txt", &token);
        assert_eq!(looked["changed"].as_array().unwrap().len(), 1, "{looked}");
    };
    changed(&|| lib.write("f.txt", "abcdef"));
    changed(&|| set_mtime(&lib.at("f.txt"), an_hour_ago()));
    changed(&|| fs::set_permissions(lib.at("f.txt"), Permissions::from_mode(0o600)).unwrap());
    changed(&|| {
        lib.write("g.txt", "abcdef");
        fs::rename(lib.at("g.txt"), lib.at("f.txt")).unwrap();
    });
}

#[test]
fn the_token_has_no_content_component() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    let keys: BTreeSet<String> = token_parts(&lib.token("f.txt")).into_keys().collect();
    assert_eq!(keys, BTreeSet::from(["c", "i", "m", "s"].map(String::from)));
}

// ---------------------------------------------------------------------------------------------
// Section 8: failures

#[test]
fn listing_a_missing_or_file_place_fails() {
    let lib = Lib::new();
    lib.write("f.txt", "x");
    for op in ["overview", "probe"] {
        assert_failed(&lib.run(op, json!({ "place": "missing" })), "no_such_place");
        assert_failed(
            &lib.run(op, json!({ "place": "f.txt/below" })),
            "no_such_place",
        );
        assert_failed(&lib.run(op, json!({ "place": "f.txt" })), "not_a_dir");
    }
}

#[test]
fn places_below_a_link_or_in_the_record_area_are_outside() {
    let lib = Lib::new();
    lib.write("notes/a.md", "a");
    let elsewhere = tempfile::tempdir().unwrap();
    fs::write(elsewhere.path().join("x.txt"), "x").unwrap();
    std::os::unix::fs::symlink("notes", lib.at("link")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), lib.at("ext")).unwrap();
    for place in [
        "link/a.md",
        "ext/x.txt",
        ".pneuma-base",
        ".pneuma-base/noise.json",
    ] {
        assert_eq!(lib.glance_one(place)["reason"], "outside", "{place}");
        assert_eq!(
            lib.look_one(place, "v1;s=1")["failed"][0]["reason"],
            "outside",
            "{place}"
        );
    }
    for place in ["link/sub", ".pneuma-base", ".pneuma-base/cache"] {
        assert_failed(&lib.run("overview", json!({ "place": place })), "outside");
        assert_failed(&lib.run("probe", json!({ "place": place })), "outside");
    }
    assert_eq!(lib.glance_one("link")["kind"], "other");
    // A link is not a directory, even when it points at one.
    assert_failed(
        &lib.run("overview", json!({ "place": "link" })),
        "not_a_dir",
    );
    let root = lib.run("overview", json!({ "place": "" }));
    assert!(!places_of(&root["entries"]).contains(&".pneuma-base".to_owned()));
}

#[test]
fn an_unreadable_dir_does_not_stop_the_rest() {
    let lib = Lib::new();
    lib.write("locked/a.txt", "a");
    lib.write("locked/inner/b.txt", "b");
    lib.write("open/x.txt", "x");
    let token = lib.token("locked/a.txt");
    let Some(_locked) = Locked::new(lib.at("locked")) else {
        return;
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
    ] {
        assert_failed(&answer, "unreadable");
        assert!(
            answer["detail"]
                .as_str()
                .is_some_and(|d| !d.is_empty() && !d.contains(' ')),
            "{answer}"
        );
    }
    assert_eq!(lib.glance_one("locked/a.txt")["reason"], "unreadable");
    assert_eq!(
        lib.look_one("locked/a.txt", &token)["failed"][0]["reason"],
        "unreadable"
    );
}
