# pneuma-base-core

The storage layer of Pneuma Base: the local-folder implementation of the storage contract
(`STORAGE.md`, contract version 1), as one command-line program. The kernel is its only caller.
Everything here is the wire form of that contract; where this file and the contract disagree, the
contract wins.

## Layout

| Crate | Path | What it is |
| --- | --- | --- |
| `pneuma-base-storage` | `storage/` | The abstraction: the `Storage` trait, places, descriptions, tokens' comparison rule, requests and answers. Knows no file system. |
| `pneuma-base-local` | `local/` | The local folder: `LocalFolder`, the one implementation of `Storage` today. |
| `pneuma-base-core` | `cli/` | The binary: parses the command line, runs one operation or `serve`, prints JSON. Its tests (`cli/tests/`) drive only the binary: the contract suite. |
| `pneuma-base-bench` | `bench/` | The benchmark against the storage targets of the architecture's acceptance. `cargo run --release -p pneuma-base-bench`. |

## Command line

```
pneuma-base-core <op> --root <library folder> [<request JSON> | -]
pneuma-base-core serve --root <library folder>
```

- `<op>` is one of the operations below. The request is one JSON object; absent means `{}`, `-` reads it from standard input.
- One answer is printed as one JSON line on standard output. The exit status is 0 whenever an answer was printed, whatever its outcome; 2 when the command line itself is wrong (a `bad_request` answer is still printed).
- `--root` must name an existing directory. It is the library: the content is the folder, the record area is `<root>/.pneuma-base/`, the cache area is `<root>/.pneuma-base/cache/`.

### serve

One request per line on standard input: the request object plus `"id"` (a string or a number) and `"op"`. One answer per line on standard output: the answer object plus the same `"id"`. Requests may run concurrently; answers may come out of order. A long operation may first send lines `{"id": …, "progress": {…}}`. `{"id": "c1", "op": "cancel", "target": "<id>"}` cancels a request not yet answered (its answer is `failed`/`cancelled`) and is answered `done` itself. A line that is not a JSON object is answered `{"id": null, "outcome": "failed", "reason": "bad_request"}`. End of input: finish what is running, then exit 0.

## Answers

Every answer is a JSON object with `"outcome"`: `"done"`, or `"failed"` / `"refused"` with a fixed `"reason"` (contract section 8: `no_such_place`, `not_a_dir`, `not_a_file`, `noise`, `outside`, `refused`, `too_many`, `elsewhere`, `held`, `cannot_say`, `unreadable`, `bad_request`, `cancelled`, `busy`). `unreadable` carries `"detail"`, the system's reason. No answer holds a sentence for people.

## Places

A place is a relative path with `/` separators: no leading `/`, no empty, `.` or `..` segment. `""` is the root. Anything else is `bad_request`.

- A place below a symbolic link answers `outside` (no operation follows a link inside the library; the link itself is `kind: "other"`).
- The record area `.pneuma-base` and everything under it is not content: `outside` for every content operation, and never listed.
- Noise: a place is noise when one of its segments is a noise name, or it is or lies under a noise path. Every operation on a noise place answers `noise` (for a list operation, per place). No listing shows a noise entry and no probe enters one.

### Description

```json
{ "place": "notes/a.md", "kind": "file", "token": "…", "size": 2048, "modified": "2026-11-26T07:48:00.123Z", "facets": { "fs": { "inode": 1234, "device": 16777230, "created": "2026-11-20T01:02:03.456Z", "mode": 33188 } } }
```

- `kind`: `file`, `dir`, `other` (links, devices, sockets), `none`.
- `size`: a file's bytes; a dir's number of entries in its level when the platform gives it without listing (macOS `ATTR_DIR_ENTRYCOUNT`), else `null`.
- `modified`: ISO 8601 UTC with milliseconds.
- `facets.fs` is always there for `file`, `dir` and `other`. `created` is `null` when the platform gives no birth time.
- A `none` description is `{ "place": …, "kind": "none" }`.

### Token

An opaque string to the kernel. This implementation writes `v1;s=<size>;m=<mtime ns>;c=<ctime ns>;i=<inode>` (`s` is the raw `st_size`, also for directories). Comparison (done only by the implementation, in `look`): parse both into components; the place changed when any component present in both differs; a component present in only one is not compared. This implementation has no component that identifies content.

## Operations on content

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `glance` | `{ "places": [place…] }` | `{ "entries": [description or { "place", "kind": "none" } or { "place", "outcome": "failed", "reason" }…] }` in request order |
| `overview` | `{ "place": p, "limit"?: 200, "after"?: name }` (`limit` 1 to 1000) | `{ "entries": [description…], "more": { "at_least": n, "after": name } \| null, "total": n \| null, "noise": [name…] }` |
| `probe` | `{ "place": p, "budget"?: 500 }` | `{ "files": n, "dirs": n, "bytes": n, "exceeded": bool, "markers": [name…] }` |
| `look` | `{ "places": [{ "place", "token" }…] }` | `{ "same": n, "changed": [{ "place", "entry": description }…], "gone": [place…], "failed": [{ "place", "reason" }…] }` |

- `overview`: entries of one level, sorted by the UTF-8 bytes of their names, directories and files mixed; `after` is the last name of the previous page. Noise entries are left out and their names listed in `noise`. `more.at_least` is how many entries at least follow this page. Failures: `no_such_place`, `not_a_dir`, `unreadable`, `noise`, `outside`. Its cost is bounded by `limit`, not by the size of the directory: a large directory's sorted names are kept in the cache area keyed by the directory's token, so only the first look at a changed directory reads all its names.
- `probe`: counts what lies under the place, breadth first, up to `budget` entries (files and directories, not entering noise or unreadable directories), and stops there with `exceeded: true`. `markers` are the well-known names present at the top of the place (`package.json`, `.git`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pnpm-workspace.yaml`, `requirements.txt`, `Gemfile`, `pom.xml`, `build.gradle`, `Package.swift`, `CMakeLists.txt`, `Makefile`), checked by name, not by listing, noise or not.
- `look`: places not listed in `changed`, `gone` or `failed` are the same. `gone` covers a place that now has kind `none`; a place whose kind changed is `changed`.

## Operations on records

A record place is a name the kernel gives (`[a-z0-9][a-z0-9-]*`); its facts are under `.pneuma-base/<name>/facts/`, its rows in the cache area.

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `facts.append` | `{ "place": name, "facts": [object…] }` | `{ "orders": [order…] }` |
| `facts.since` | `{ "place": name, "cursor": string \| null, "limit"?: 1000 }` (`limit` 0 to 10000) | `{ "facts": [{ "order", "fact" }…], "cursor": string, "more": bool }`; `limit` 0 answers no facts and a cursor after the newest fact there is |
| `rows.put` | `{ "place": name, "table"?: t, "rows"?: [row…], "tables"?: { t: [row…] }, "cursor"?: string, "expect"?: string \| null }` | `{}`; `refused` with `"actual": cursor \| null` when `expect` is given and is not the saved cursor |
| `rows.get` | `{ "place": name, "table": t, "keys": [key…] }` | `{ "rows": [row…], "cursor": string \| null }` |
| `rows.under` | `{ "place": name, "table": t, "prefix": s, "limit"?: 100, "after"?: key }` (`limit` 1 to 10000) | `{ "rows": [row…], "more": { "after": key } \| null }` |
| `rows.where` | `{ "place": name, "table": t, "field": f, "value": s, "limit"?: 100, "after"?: key, "count"?: bool }` | `{ "rows": [row…], "more": … }`, or with `count` `{ "count": n }` |
| `rows.reset` | `{ "place": name }` | `{}` |

- Facts: one `facts.append` writes one new file `.pneuma-base/<name>/facts/<YYYY-MM-DD>/<UTC yyyymmddHHMMSSmmm>-<writer>-<seq>.jsonl` (temporary name, then a hard link to the final name that never replaces a file, then the temporary name removed), one fact per line, as given. An order is `<day>/<file>#<line>`. The old layout, `facts/<scene>/*.jsonl` (any subdirectory whose name is not a date), is read when the cursor is `null`, before the dated files, with orders `old/<scene>/<file>#<line>`; it is not looked at again after that. A line that is not a JSON object is skipped.
- A cursor that no longer fits the facts (the `facts/` directory it was made on is gone or replaced, or the file it stands on is gone) is answered `refused` (reason `refused`): the caller drops what it derived and starts again from `null`.
- `facts.since` costs what is new, not what is there: with nothing new it only compares the tokens of `facts/` and of the newest day's directory with those the cursor carries. A file whose name sorts before the cursor but was linked after it was made is still given, when its time is within 10 seconds of the newest file the cursor covers (writers' clocks and the moment of linking differ). While nothing changes, the cursor after the newest fact is the same text each time it is asked for, so a reader can compare two to tell whether there is anything new.
- A row is `{ "key": string, "fields"?: { name: string } (at most 4), "value": any JSON }`; a `value` of `null` in `rows.put` deletes the row. Keys sort by their UTF-8 bytes. `rows.put` writes all its rows and the cursor in one transaction. The saved cursor is the place's fact cursor, answered by every `rows.get`.
- Rows are a cache: `rows.reset` drops the place's rows and cursor; so does deleting the cache area.

## Other operations

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `init` | `{}` | `{ "created": bool }`: makes `.pneuma-base/`, `.pneuma-base/cache/` and `.pneuma-base/noise.json` with the default list; changes nothing in a folder that already has `.pneuma-base/` |
| `describe` | `{}` | `{ "implementation": "local-folder", "contract": 1, "version": s, "cursor": false, "facets": ["fs"], "ops": [op…] }` |
| `noise.list` | `{}` | `{ "names": [s…], "paths": [place…], "declared": bool }`; without `noise.json` the default list, `declared: false` |
| `noise.add`, `noise.remove` | `{ "names"?: [s…], "paths"?: [place…] }` | as `noise.list`, after writing `noise.json` |

The default noise names: `.git`, `.svn`, `.hg`, `node_modules`, `.pnpm-store`, `.yarn`, `bower_components`, `__pycache__`, `.venv`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.next`, `.nuxt`, `.turbo`, `.parcel-cache`, `.gradle`, `.cache`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.Trash`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`.

Not built yet (step 2): `changed`, `content`, `read`, `write`, `move`, `remove`, `hold`, `release`, and the `macos` and `placeholder` facets.
