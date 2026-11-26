//! Rule 2.9, first half: processes at once corrupt nothing and do not deadlock. For every write
//! guarded by an expectation, two processes on one place: exactly one is `done`, the other
//! `refused` with what the winner left, and what is there is the winner's.

use std::collections::BTreeSet;
use std::fs;

use serde_json::{Value, json};

use crate::Outcome;
use crate::harness::*;

const ROUNDS: usize = 4;

/// Starts both requests at once, each in its own process, and gives both answers.
fn race(lib: &Lib, op: &str, requests: [Value; 2]) -> [Value; 2] {
    let answers = at_once(2, |i| lib.start(op, &requests[i]).answer());
    [answers[0].clone(), answers[1].clone()]
}

/// The index of the one `done` answer; the other must be `refused`.
fn one_winner(answers: &[Value; 2]) -> usize {
    let done: Vec<usize> = (0..2)
        .filter(|&i| answers[i]["outcome"] == "done")
        .collect();
    assert_eq!(done.len(), 1, "exactly one is done: {answers:?}");
    assert_refused(&answers[1 - done[0]]);
    done[0]
}

pub fn two_writers_of_one_file(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    let sources: Vec<_> = (0..2)
        .map(|i| {
            let path = src.path().join(format!("s{i}"));
            fs::write(&path, bytes_of(1_000_000 + i, i as u8)).unwrap();
            path
        })
        .collect();
    for round in 0..ROUNDS {
        let place = format!("f{round}.bin");
        let answers = race(
            &lib,
            "write",
            [0, 1].map(|i| json!({ "place": place, "from": sources[i], "expect": "empty" })),
        );
        let winner = one_winner(&answers);
        let loser = &answers[1 - winner];
        assert_eq!(loser["actual"]["size"], 1_000_000 + winner, "{loser}");
        assert_eq!(sha256_file(&lib.at(&place)), sha256_file(&sources[winner]));
        // Both again, over what is there now, expecting its token.
        let token = lib.token(&place);
        let answers = race(
            &lib,
            "write",
            [1, 0].map(|i| json!({ "place": place, "from": sources[i], "expect": token })),
        );
        let winner = one_winner(&answers);
        let source = &sources[[1, 0][winner]];
        assert_eq!(
            sha256_file(&lib.at(&place)),
            sha256_file(source),
            "{answers:?}"
        );
        assert_eq!(lib.fingerprint(&place), answers[winner]["fingerprint"]);
    }
    Ok(())
}

pub fn two_writers_of_one_directory(env: &Env) -> Outcome {
    let lib = env.lib();
    let src = scratch();
    let sources: Vec<_> = (0..2)
        .map(|i| {
            let path = src.path().join(format!("tree{i}"));
            many_files(&path, 300 + i, i as u8);
            path
        })
        .collect();
    for round in 0..ROUNDS {
        let place = format!("d{round}");
        let answers = race(
            &lib,
            "write",
            [0, 1].map(|i| json!({ "place": place, "from": sources[i], "expect": "empty" })),
        );
        let winner = one_winner(&answers);
        assert_eq!(answers[1 - winner]["actual"]["kind"], "dir", "{answers:?}");
        let content = lib.run("content", json!({ "place": place }));
        assert_eq!(content["fingerprint"], answers[winner]["fingerprint"]);
        assert_eq!(content["files"], 300 + winner);
        let token = lib.token(&place);
        let answers = race(
            &lib,
            "write",
            [0, 1].map(|i| json!({ "place": place, "from": sources[i], "expect": token })),
        );
        let winner = one_winner(&answers);
        let content = lib.run("content", json!({ "place": place }));
        assert_eq!(content["fingerprint"], answers[winner]["fingerprint"]);
    }
    Ok(())
}

pub fn two_movers_onto_one_place(env: &Env) -> Outcome {
    let lib = env.lib();
    for round in 0..ROUNDS {
        let sources = [format!("a{round}.txt"), format!("b{round}.txt")];
        lib.write(&sources[0], "from a");
        lib.write(&sources[1], "from b, longer");
        let tokens = [lib.token(&sources[0]), lib.token(&sources[1])];
        let target = format!("t{round}.txt");
        let answers = race(
            &lib,
            "move",
            [0, 1].map(|i| {
                json!({ "from": sources[i], "to": target, "expect": { "from": tokens[i], "to": "empty" } })
            }),
        );
        let winner = one_winner(&answers);
        let expected = ["from a", "from b, longer"][winner];
        assert_eq!(fs::read_to_string(lib.at(&target)).unwrap(), expected);
        assert_eq!(lib.glance_one(&sources[winner])["kind"], "none");
        assert!(
            lib.same(&sources[1 - winner], &tokens[1 - winner]),
            "the loser's source stays"
        );

        // One source, two targets, one expectation of it: only one move happens.
        let source = format!("s{round}.txt");
        lib.write(&source, "single");
        let token = lib.token(&source);
        let targets = [format!("x{round}.txt"), format!("y{round}.txt")];
        let answers = race(
            &lib,
            "move",
            [0, 1].map(|i| {
                json!({ "from": source, "to": targets[i], "expect": { "from": token, "to": "empty" } })
            }),
        );
        let winner = one_winner(&answers);
        assert_eq!(lib.glance_one(&targets[winner])["kind"], "file");
        assert_eq!(lib.glance_one(&targets[1 - winner])["kind"], "none");
        assert_eq!(lib.glance_one(&source)["kind"], "none");
    }
    Ok(())
}

pub fn two_removers_of_one_place(env: &Env) -> Outcome {
    let lib = env.lib();
    for round in 0..ROUNDS {
        let place = format!("d{round}");
        many_files(&lib.at(&place), 200, round as u8);
        let token = lib.token(&place);
        let answers = race(
            &lib,
            "remove",
            [0, 1].map(|_| json!({ "place": place, "expect": token })),
        );
        let winner = one_winner(&answers);
        assert_eq!(answers[winner]["removed"], true);
        assert_eq!(answers[1 - winner]["actual"]["kind"], "none", "{answers:?}");
        assert_eq!(lib.glance_one(&place)["kind"], "none");
    }
    Ok(())
}

pub fn two_putters_with_one_expected_cursor(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.run(
        "rows.put",
        json!({ "place": "p", "table": "t", "rows": [{ "key": "k", "value": "start" }], "cursor": "c0" }),
    );
    let mut cursor = "c0".to_owned();
    for round in 0..ROUNDS {
        let rows = |i: usize| -> Vec<Value> {
            (0..500)
                .map(|n| json!({ "key": format!("k{n:03}"), "fields": { "by": i.to_string() }, "value": [round, i] }))
                .collect()
        };
        let next = [format!("r{round}-0"), format!("r{round}-1")];
        let answers = race(
            &lib,
            "rows.put",
            [0, 1].map(|i| {
                json!({ "place": "p", "table": "t", "rows": rows(i), "cursor": next[i], "expect": cursor })
            }),
        );
        let winner = one_winner(&answers);
        assert_eq!(
            answers[1 - winner]["actual"],
            next[winner].as_str(),
            "{answers:?}"
        );
        let got = lib.run(
            "rows.get",
            json!({ "place": "p", "table": "t", "keys": ["k000", "k499"] }),
        );
        assert_eq!(got["cursor"], next[winner].as_str());
        assert_eq!(got["rows"][0]["value"], json!([round, winner]));
        assert_eq!(got["rows"][1]["value"], json!([round, winner]));
        let mine = lib.run(
            "rows.where",
            json!({ "place": "p", "table": "t", "field": "by", "value": winner.to_string(), "count": true }),
        );
        assert_eq!(mine["count"], 500, "every row is the winner's: {mine}");
        cursor = next[winner].clone();
    }
    Ok(())
}

pub fn two_holders_of_one_place(env: &Env) -> Outcome {
    let lib = env.lib();
    lib.write("f.txt", "f");
    for round in 0..ROUNDS * 2 {
        let place = if round % 2 == 0 {
            format!("f{round}")
        } else {
            "f.txt".to_owned()
        };
        let answers = at_once(2, |_| {
            lib.start("hold", &json!({ "place": place })).answer()
        });
        let done: Vec<&Value> = answers.iter().filter(|a| a["outcome"] == "done").collect();
        assert_eq!(done.len(), 1, "exactly one holds it: {answers:?}");
        let other = answers.iter().find(|a| a["outcome"] != "done").unwrap();
        assert_failed(other, "held");
        assert_done(&lib.run("release", json!({ "hold": done[0]["hold"] })));
    }
    Ok(())
}

pub fn concurrent_appends_and_puts_lose_nothing(env: &Env) -> Outcome {
    let lib = env.lib();
    let (writers, rounds, per_append) = (8, 8, 5);
    at_once(writers * 2, |i| {
        let w = i / 2;
        for r in 0..rounds {
            if i % 2 == 0 {
                let facts: Vec<Value> = (0..per_append)
                    .map(|n| json!({ "w": w, "r": r, "n": n }))
                    .collect();
                let answer = lib.run("facts.append", json!({ "place": "log", "facts": facts }));
                assert_eq!(
                    answer["orders"].as_array().unwrap().len(),
                    per_append,
                    "{answer}"
                );
            } else {
                let rows: Vec<Value> = (0..per_append)
                    .map(|n| json!({ "key": format!("w{w}/r{r}/n{n}"), "fields": { "w": w.to_string() }, "value": { "r": r, "n": n } }))
                    .collect();
                let answer = lib.run(
                    "rows.put",
                    json!({ "place": "log", "table": "t", "rows": rows }),
                );
                assert_eq!(answer["outcome"], "done", "{answer}");
            }
        }
    });
    let since = lib.run(
        "facts.since",
        json!({ "place": "log", "cursor": null, "limit": 10_000 }),
    );
    let facts = facts_of(&since);
    assert_eq!(
        facts.len(),
        writers * rounds * per_append,
        "every fact once"
    );
    let distinct: BTreeSet<String> = facts.iter().map(Value::to_string).collect();
    assert_eq!(distinct.len(), facts.len(), "no fact twice");
    let orders: BTreeSet<String> = orders_of(&since).into_iter().collect();
    assert_eq!(orders.len(), facts.len(), "one order each");
    let rows = lib.run(
        "rows.under",
        json!({ "place": "log", "table": "t", "prefix": "", "limit": 10_000 }),
    );
    assert_eq!(
        rows["rows"].as_array().unwrap().len(),
        writers * rounds * per_append
    );
    for w in 0..writers {
        let count = lib.run(
            "rows.where",
            json!({ "place": "log", "table": "t", "field": "w", "value": w.to_string(), "count": true }),
        );
        assert_eq!(count["count"], rounds * per_append);
    }
    Ok(())
}

/// A `serve` session that wrote holds no lock once its answer is out: another process, and the
/// session's own concurrent requests, still write beside it.
pub fn a_serve_session_keeps_no_lock_after_a_write(env: &Env) -> Outcome {
    let lib = env.lib();
    let mut serve = lib.serve();
    for (id, place) in [(1, "a.txt"), (2, "d/a.txt")] {
        let served = serve.ask(
            json!(id),
            "write",
            json!({ "place": place, "from": data(b"served"), "expect": "empty" }),
        );
        assert_done(&served);
    }
    for place in ["b.txt", "d/b.txt"] {
        let other = lib.run(
            "write",
            json!({ "place": place, "from": data(b"other"), "expect": "empty" }),
        );
        assert_done(&other);
    }
    for k in 0..8 {
        serve.request(
            json!(format!("w{k}")),
            "write",
            json!({ "place": format!("c{k}.txt"), "from": data(b"c"), "expect": "empty" }),
        );
    }
    // Answers come in any order.
    let mut answered = BTreeSet::new();
    while answered.len() < 8 {
        let answer = serve.receive();
        if answer.get("progress").is_none() {
            assert_done(&answer);
            answered.insert(answer["id"].to_string());
        }
    }
    assert_eq!(serve.finish(), 0);
    Ok(())
}
