# pneuma-base-core

The storage layer of Pneuma Base: the local-folder implementation of the storage contract
([`STORAGE.md`](../STORAGE.md), contract version 1), as one command-line program, and the suite that
vets any program claiming to implement that contract. The kernel is the program's only caller.
Everything here is the wire form of that contract; where this file and the contract disagree, the
contract wins. The product target is Apple-silicon macOS; on Linux the program builds and passes the
contract suite, without a change journal (`changed` always answers `cannot_say`, `subscribe` too) or the `macos` facet.

## Layout

| Crate | Path | What it is |
| --- | --- | --- |
| `pneuma-base-storage` | `storage/` | The abstraction: the `Storage` trait, places, descriptions, tokens' comparison rule, requests and answers. Knows no file system. |
| `pneuma-base-local` | `local/` | The local folder: `LocalFolder`, the one implementation of `Storage` today. |
| `pneuma-base-core` | `cli/` | The binary: parses the command line, runs one operation or `serve`, prints JSON. Its test (`cli/tests/contract.rs`) runs the contract suite against it. |
| `pneuma-base-contract` | `contract/` | The contract suite: one check per sentence of `STORAGE.md`, run against any provider's executable. `pneuma-base-contract --provider <path> [--report] [--filter <text>]`; `--report` lists every sentence as met, unmet, not exercised or not checkable from outside. |
| `pneuma-base-bench` | `bench/` | The benchmark against the storage targets. `cargo run --release -p pneuma-base-bench` builds its own library; `-- --library <folder>` also times the operations that only read on a real library, changing nothing there. |

## Command line

```
pneuma-base-core <op> --root <library folder> [<request JSON> | -]
pneuma-base-core serve --root <library folder>
```

- `<op>` is one of the operations below. The request is one JSON object; absent means `{}`, `-` reads it from standard input.
- One answer is printed as one JSON line on standard output. The exit status is 0 whenever an answer was printed, whatever its outcome; 2 when the command line itself is wrong (a `bad_request` answer is still printed).
- `--root` must name an existing directory. It is the library: the content is the folder, the record area is `<root>/.pneuma-base/`, the cache area is `<root>/.pneuma-base/cache/`, a record place's own area is `<root>/.pneuma-base/<name>/`, the root declaration is `<root>/.pneuma-base/config.json`.

### serve

One request per line on standard input: the request object plus `"id"` (a string or a number) and `"op"`. One answer per line on standard output: the answer object plus the same `"id"`. Requests may run concurrently; answers may come out of order. A long operation (`content`, `write`, `remove` of a directory) first sends lines `{"id": …, "progress": { "files", "bytes", "total_files", "total_bytes" }}` (totals `null` while unknown), at most one per 100 ms. `{"id": "c1", "op": "cancel", "target": "<id>"}` cancels a request not yet answered (its answer is `failed`/`cancelled`) and is answered `done` itself. A line that is not a JSON object is answered `{"id": null, "outcome": "failed", "reason": "bad_request"}`. End of input: cancel the subscriptions, finish what is running, then exit 0.

Each request runs on one of eight worker threads, at the user-initiated class on macOS: at the default class the system moves a thread that mostly waits on the file system to the slower cores as soon as other work runs. The thread that reads standard input takes only `id`, `op` and `target` from a line; the worker parses the rest.

A `serve` process keeps the SQLite connections it opened to rows, one per file at a time a request uses it, and opens another when the file at the path is not the one it was opened on (removed, or the cache area deleted).

### subscribe

`{"id": "s", "op": "subscribe", "cursor"?: string}`, only in `serve` (`bad_request` as a one-shot command). It runs until cancelled, sending progress lines whose `progress` is what `changed` from the subscription's last cursor would answer: `{ "outcome": "done", "places", "cursor", "more" }`, first once when it starts listening (perhaps with no places), then whenever it hears of places; `{ "outcome": "failed", "reason": "cannot_say", "cursor" }` when the log no longer covers its cursor (it carries on from the fresh one). Without a cursor (or with one this library did not give) it starts where the log starts or now. Its final answer is `cancelled`; on Linux, and on a volume with no FSEvents history, it answers `cannot_say` at once.

While any subscription in a process is open, one thread of that process keeps the change log, unless another process already does; that thread tries to take over once a second. The log is in the cache area: `.pneuma-base/cache/changes/log.sqlite`, written only by the holder of an exclusive `flock` on `.pneuma-base/cache/changes/listener.lock`, which the system releases when the holder dies, however it dies.

- The holder carries the log on from where it ended when the log's origin (volume event database, device and inode of the library folder) is this library's, else starts it afresh at the subscriber's cursor or now. It first replays FSEvents from there to cover the time nobody listened (not when that would take more than 10 s by the estimate below: then the log starts again now), then listens live, latency 30 ms, `.pneuma-base` excluded.
- A place is kept once, with the id of the newest event that named it, leaving out noise and the record area. At most 10,000 places: past that the oldest 1,000 or more go and the log's floor rises to the newest id that went. UserDropped (this process fell behind; the volume's history is whole) makes the holder hear the history again from the head, up to five times in a row; after that, or when the drop is older than the head, it raises the floor to the system's newest id. The other events that say some were lost (KernelDropped, EventIdsWrapped, Mount, Unmount, MustScanSubDirs alone), and a change to `noise.json`, raise the floor at once; RootChanged ends the log and the subscriptions (`cannot_say`).
- The heartbeat: once a second, and 50 ms after any delivery, the holder takes the system's newest event id and flushes its stream: every event up to that id has then been delivered and kept. The system can report a drop after later events, so the id becomes the log's head at the next heartbeat, if no drop was reported in between; each heartbeat writes the head, the time and `live`. When it stops it writes `live` false and drops the lock. A deleted or replaced cache area is noticed within a second; the log starts again there.
- A reader (`changed` in any process) trusts the log when the lock is held, `live` is true, the heartbeat is at most 3 s old, the origin is the cursor's and the cursor is not older than the floor. It answers the places kept with ids after the cursor up to the head, in id order, noise as declared now left out, and the cursor `max(cursor, head)`; with `more`, the id of the last place given. About a millisecond; the cost follows the places changed.

## Answers

Every answer is a JSON object with `"outcome"`: `"done"`, or `"failed"` / `"refused"` with a fixed `"reason"` (contract section 8: `no_such_place`, `not_a_dir`, `not_a_file`, `noise`, `outside`, `refused`, `too_many`, `elsewhere`, `held`, `cannot_say`, `unreadable`, `bad_request`, `cancelled`, `busy`). `unreadable` carries `"detail"`, the system's reason. A failure a write's source causes carries `"side": "from"`. No answer holds a sentence for people.

## Places

A place is a relative path with `/` separators: no leading `/`, no empty, `.` or `..` segment. `""` is the root. Anything else is `bad_request`.

- A place below a symbolic link answers `outside` (no operation follows a link inside the library; the link itself is `kind: "other"`).
- The record area `.pneuma-base` and everything under it is not content: `outside` for every content operation, and never listed.
- Noise: a place is noise when one of its segments is a noise name, or it is or lies under a noise path. Every operation on a noise place answers `noise` (for a list operation, per place). No listing shows a noise entry and no probe enters one.
- `"records": name` in a content request (`glance`, `overview`, `look`, `content`, `read`, `write`, `move`, `remove`) makes its places name places in that record place's own area, `<root>/.pneuma-base/<name>/`, instead of the content. There no noise applies; the first segment `facts`, the facts' own directory, answers `outside` and is never listed; holds do not apply (`look`'s `held` is empty, nothing is marked); `changed` reports nothing in it. An area not made yet reads as an empty directory at `""` (`size` 0, with a token that changes once the area is made) and `kind: none` below it, and reading it makes nothing; a `write` expecting `empty` makes it, one expecting a token is refused. A `move` with `records` moves within that one area.

### Description

```json
{ "place": "notes/a.md", "kind": "file", "token": "…", "size": 2048, "modified": "2026-11-26T07:48:00.123Z", "facets": { "fs": { "inode": 1234, "device": 16777230, "created": "2026-11-20T01:02:03.456Z", "mode": 33188 } } }
```

- `kind`: `file`, `dir`, `other` (links, devices, sockets), `none`.
- `size`: a file's bytes; a dir's number of entries in its level when the platform gives it without listing (macOS `ATTR_DIR_ENTRYCOUNT`), else `null`.
- `modified`: ISO 8601 UTC with milliseconds.
- `held: true` in `overview` entries under a live hold (see `hold`).
- A `none` description is `{ "place": …, "kind": "none" }`.

### Facets

Each facet comes from one source; the sources are composed in one list (`local/src/facets.rs`), and adding a source touches nothing else. A source can also add components to the token.

| Facet | Fields | When |
| --- | --- | --- |
| `fs` | `inode`, `device`, `created` (`null` without a birth time), `mode` | always, for `file`, `dir` and `other` |
| `macos` | `where_from` (download address list), `quarantine` (`{ "agent" }`: the program that brought it in), `tags` (Finder tag names) | macOS, only when asked for by name (`"facets": ["macos"]` in `glance` or `overview`), and only the attributes present |
| `placeholder` | `provider` (iCloud Drive, Dropbox, Google Drive, OneDrive, Box when recognised by folder), `size_elsewhere` | macOS, a file a sync service keeps only as a placeholder (`SF_DATALESS`) |

No operation fetches a placeholder unless it is asked to with `fetch: true`: the process runs with materialisation of dataless files turned off, and `overview` of a placeholder directory answers `elsewhere`.

### Token

An opaque string to the kernel. This implementation writes `v1;s=<size>;m=<mtime ns>;c=<ctime ns>;i=<inode>` (`s` is the raw `st_size`, also for directories). Comparison (done only by the implementation, in `look` and in every write's expectation): parse both into components; the place changed when any component present in both differs; a component present in only one is not compared; components whose key starts with `*` identify content. This implementation has no component that identifies content.

Racy states: a state taken within the file system's clock window of its last change (APFS: 1 ms; ext4, xfs, btrfs, tmpfs, overlayfs: 20 ms; anything else: 2 s; counted from the change time, which every change sets and no caller can) cannot vouch that a second change in the same tick would have moved it. `glance`, `overview`, `look` and every write wait out that window once per answer when it is at most 25 ms, and describe the settled state, so their tokens vouch for themselves and an unchanged place keeps the same token text. Where the window is longer, and in `content` and `read` answers taken within it, the token carries an annotation, never compared: `;!h=<sha256>` when the answer read the content, else `;!r`. `look` answers `same` for an annotated token only when the components match and, for `!h`, the file's bytes still hash to it; for `!r`, never.

## Operations on content

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `glance` | `{ "places": [place…], "records"?: name }` | `{ "entries": [description or { "place", "kind": "none" } or { "place", "outcome": "failed", "reason" }…] }` in request order |
| `overview` | `{ "place": p, "limit"?: 200, "after"?: name }` (`limit` 1 to 1000) | `{ "entries": [description…], "more": { "at_least": n, "after": name } \| null, "total": n \| null, "noise": [name…] }` |
| `probe` | `{ "place": p, "budget"?: 500 }` | `{ "files": n, "dirs": n, "bytes": n, "exceeded": bool, "markers": [name…] }` |
| `look` | `{ "places": [{ "place", "token": token \| "empty" }…] }`, or `{ "rows": { "place": name, "table": t, "field": f }, "limit"?: 10000, "after"?: key }` (`limit` 1 to 100000) | `{ "same": n, "changed": [{ "place", "entry": description }…], "gone": [place…], "failed": [{ "place", "reason" }…], "held": [place…] }`; with `rows` also `"compared": n, "more": { "after": key } \| null` |
| `changed` | `{ "cursor"?: string, "limit"?: 1000, "budget"?: 5000 }` (`limit` 1 to 10000; `budget` 0 to 600000 ms) | `{ "places": [place…], "cursor": string, "more": bool }`; without a cursor, no places and the current cursor; `failed`/`cannot_say` with a fresh `"cursor"` |
| `content` | `{ "place": p, "rule"?: { "noise"?: [name…], "ignore_file"?: name }, "limit"?: 5000, "fetch"?: bool, "manifest"?: true \| { "limit"?: 1000, "after"?: path } }` (manifest `limit` 1 to 10000) | file: `{ "kind": "file", "fingerprint", "token", "size" }`; dir: `{ "kind": "dir", "fingerprint", "files": n, "bytes": n, "token" }`, with `manifest` also `"manifest": { "entries": [{ "path", "fingerprint", "size" }…], "more": { "after": path } \| null }`; `too_many` with `at_least`; `elsewhere` with `size` |
| `read` | `{ "place": p, "offset"?: 0, "length"?: n, "fetch"?: bool, "to"?: absolute path outside the library }` | `{ "token", "size", "offset", "length", "data"?: base64 }` (at most 16 MiB in `data`; with `to`, the bytes go to that file and `to` is echoed) |
| `write` | `{ "place": p, "from": absolute path outside the library \| "-" \| { "data": base64 } \| { "place": q, "records"?: name }, "expect": "empty" \| token, "rule"?, "limit"?, "hold"?: id }` | `{ "entry": description, "fingerprint", "files"?: n, "bytes": n }` |
| `move` | `{ "from": p, "to": q, "expect": { "from": token, "to": "empty" \| token }, "hold"?: id }` | `{ "entry": description at q }` |
| `remove` | `{ "place": p, "expect": token, "hold"?: id }` | `{ "removed": true }` |

- Every request in this table but `probe` and `changed` takes `"records"?: name` (see Places).
- `overview`: entries of one level, sorted by the UTF-8 bytes of their names, directories and files mixed; `after` is the previous answer's `more.after` (here, the last name of that page). Noise entries are left out and their names listed in `noise`. `more.at_least` is how many entries at least follow this page. Failures: `no_such_place`, `not_a_dir`, `unreadable`, `noise`, `outside`. Its cost is bounded by `limit`, not by the size of the directory: a large directory's sorted names are kept in the cache area keyed by the directory's token, so only the first look at a changed directory reads all its names.
- `probe`: counts what lies under the place, breadth first, up to `budget` entries (files and directories, not entering noise or unreadable directories), and stops there with `exceeded: true`. `markers` are the well-known names present at the top of the place (`package.json`, `.git`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pnpm-workspace.yaml`, `requirements.txt`, `Gemfile`, `pom.xml`, `build.gradle`, `Package.swift`, `CMakeLists.txt`, `Makefile`), checked by name, not by listing, noise or not.
- `look`: places not listed in `changed`, `gone` or `failed` are the same. `gone` covers a place that now has kind `none`; a place whose kind changed is `changed`. `held` lists the asked places under a live hold. `"empty"` expects nothing at the place: `same` while nothing is there, else `changed`. A directory's token is its own state, which an entry added, removed or renamed in its level changes and nothing deeper does.
- `look` with `rows`: the expectations are the rows of table `t` in record place `name`, read in the byte order of their keys after `after`, at most `limit`; each key is a place and its field `f` is a token or `"empty"`. A row without that field expects nothing in particular: `changed` with what is there, or `gone`. A key that is not a place is in `failed` with `bad_request`. The rows are only read. `compared` is how many rows this page compared; `more.after` is the last key compared when rows follow. Comparing 20,000 rows takes about 25 ms (`core/bench`).
- `changed` (macOS): the places under the library that FSEvents recorded since the cursor, file by file, leaving out noise and the record area; `more` when `limit` cut it short (the next call resumes). The cursor `fse1;<volume event-database UUID>;<device>;<inode of the library folder>;<event id>` survives restarts and reboots: FSEvents keeps each volume's history on disk. A cursor may give a place again, never fewer: event ids are assigned when the system delivers a change, a moment after it happens. Two ways answer, with the same answer: a live subscriber's log (see `subscribe`), whenever it covers the cursor, whatever the budget; else a replay of FSEvents from the cursor, started only when its estimate fits the budget (13 ms to set up a stream, plus 0.17 µs for each event the system numbered since the cursor, on any volume) and given up when it overruns it. The replay's cost follows the volume's events since the cursor, not the library or its changes: measured at 0.1 s for a cursor minutes old and 2.4 s for one three hours old on a busy development machine. The answer is `cannot_say` with a fresh cursor when neither can vouch for the period: the cursor is not one of this library's (other volume event database, device or inode, unreadable, or ahead of the system's id); no live log covers it and the replay does not fit the budget or does not finish within it; the replay carries MustScanSubDirs, KernelDropped, EventIdsWrapped, RootChanged, Mount or Unmount; events dropped only on their way to this process (UserDropped alone) are replayed again after 500 ms while the budget allows. On Linux every `changed` with a cursor answers `cannot_say`.
- The content rule (`content` and a directory `write`): a directory's content is every regular file under it except noise, the names in `rule.noise`, and what the ignore file named in `rule.ignore_file` excludes, read in every directory that has one, the nearest one deciding (gitignore syntax). Links and devices are not content. The storage applies the rule; it does not choose it.
- Fingerprints: a file's is the SHA-256 of its bytes; a directory's is the SHA-256 of its manifest, `<path>\0<file fingerprint>\n` for each file in the byte order of the paths. With `manifest`, a directory's answer also gives that manifest a page at a time: the files after `after` in the byte order of their paths (relative to the directory), at most `limit`, each with its fingerprint and size; `more.after` is the last path given when files follow. Every page reads the whole content again, so its `fingerprint` is the content's as of that page. Each answer's token is the state of the version read: taken before and after, and a read that saw a change is tried again (three times, then `busy`).
- `write`'s source (`from`): an absolute path outside the library, a file or a directory by the content rule; `"-"`, standard input, only in a one-shot call whose request is an argument; `{ "data": base64 }`, standard base64 with padding, at most 16 MiB decoded (`bad_request` above), so a `serve` caller can write small content without a file; `{ "place": q, "records"?: name }`, a place in the content or in a record place's own area, either way from the target's area: a copy within the store, a file or a directory by the content rule (`rule`, `limit` and `too_many` as for a path), applied where the source is and where the copy lands, so noise at either is left out. A source at, above or below the target in the same area is `bad_request`. A failure the source causes (`no_such_place`, `not_a_file`, `noise`, `outside`, `unreadable`, `elsewhere`) carries `"side": "from"`. Every source is fingerprinted in the pass that copies it into `tmp/` and is placed as below.
- Writes: every write states what it expects at each place it changes, and is refused with what is there (`actual`: a description or `{ "place", "kind": "none" }`; for `move`, `{ "from", "to" }`) when that does not hold. Expectations are checked under an exclusive lock on the parent directory, with the comparison `look` uses, so of two writers expecting the same state one is `refused`. A write copies its source into `.pneuma-base/tmp/`, fingerprinting it in the same pass, and places it with one rename: where nothing is (`empty`), over a file (a token on a file), or by an atomic exchange when a directory is involved. A removal is one rename into `.pneuma-base/trash/`, then deletion there. A move onto a directory notes its intent in `tmp/` before the exchange. So a write interrupted at any point leaves the content as it was or as it will be: the next write, move or removal clears what an interrupted one left and finishes a noted move. A write is cancellable until it places its result. Places a write is refused at are not changed, and the parent directories it made are taken back.
- `hold` and `release`: `{ "place": p, "ttl"?: 30000 }` (ms, 1 to 600000), or `{ "places": [p…], "ttl"? }` (not empty, not with `place`), answers `{ "hold": id, "until": time }`: one id for every place given, refused `held` (with `until`) when another live hold is at, above or below any of them; `{ "hold": id }` releases it. A hold says its places are being written and their records follow: `look` lists held places, `overview` marks them, and a write, move or removal at, above or below a held place answers `held` (with `until`) unless it carries that hold's id, which passes at each of its places. A hold that has run out counts for nothing.

## Operations on records

A record place is a name the kernel gives (`[a-z0-9][a-z0-9-]*`), never `cache`, `holds`, `tmp` or `trash`, the directories the storage keeps in `.pneuma-base/` (`bad_request` for every operation that names one); its facts are under `.pneuma-base/<name>/facts/`, its own content in `.pneuma-base/<name>/` beside them (see Places), its rows in the cache area.

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `facts.append` | `{ "place": name, "facts": [object…] }` | `{ "orders": [order…] }` |
| `facts.since` | `{ "place": name, "cursor": string \| null, "limit"?: 1000 }` (`limit` 0 to 10000) | `{ "facts": [{ "order", "fact" }…], "cursor": string, "more": bool, "files"?: n }`; `files`, only on a read from no cursor, is how many facts files there are (each holds one fact or more); `limit` 0 answers no facts and a cursor after the newest fact there is |
| `rows.put` | `{ "place": name, "table"?: t, "rows"?: [row…], "tables"?: { t: [row…] }, "cursor"?: string, "expect"?: string \| null }` | `{}`; `refused` with `"actual": cursor \| null` when `expect` is given and is not the saved cursor |
| `rows.get` | `{ "place": name, "table": t, "keys": [key…] }` | `{ "rows": [row…], "cursor": string \| null }` |
| `rows.under` | `{ "place": name, "table": t, "prefix": s, "limit"?: 100, "after"?: key }` (`limit` 1 to 10000) | `{ "rows": [row…], "more": { "after": key } \| null }` |
| `rows.where` | `{ "place": name, "table": t, "field": f, "value": s, "limit"?: 100, "after"?: key, "count"?: bool }` | `{ "rows": [row…], "more": … }`, or with `count` `{ "count": n }` |
| `rows.reset` | `{ "place": name }` | `{}` |

- Facts: one `facts.append` writes one new file `.pneuma-base/<name>/facts/<YYYY-MM-DD>/<UTC yyyymmddHHMMSSmmm>-<writer>-<seq>.jsonl` (temporary name, then a hard link to the final name that never replaces a file, then the temporary name removed), one fact per line, as given. An order is `<day>/<file>#<line>`. The old layouts are still read: `facts/<scene>/*.jsonl` (any subdirectory whose name is not a date), with orders `old/<scene>/<file>#<line>`, and `facts/*.jsonl` (files right in `facts/`, as plugins wrote them before storage), with orders `old//<file>#<line>`. A line that is not a JSON object is skipped.
- A cursor that no longer fits the facts (the `facts/` directory it was made on is gone or replaced, or the file it stands on is gone) is answered `refused` (reason `refused`): the caller drops what it derived and starts again from `null`.
- `facts.since` follows arrival, not names: a file synced in late, into an older day or into the old layout, comes after the cursor all the same. When a file arrived is the moment it was added to its directory on this machine (macOS keeps it per entry; elsewhere the change time). A directory's change time moves whenever a file arrives in it, so a read lists only the directories that changed since the cursor's floor, then gives the files that arrived since, in the order of their orders (old layout first, then by day and name). Its cost follows what is new, plus one `stat` per day directory. A directory is listed with each file's times and size, many entries a call (`getattrlistbulk` on macOS; elsewhere one `stat` a file); a page's files are read by four threads at most, each file with one open and one read of its listed size. Opening a file is most of reading a small one, and more threads opening files in the same folders wait on each other. A read from no cursor also lists the names of every facts file once, to count them. The cursor carries a floor (every file that arrived before it has been given, kept 10 s behind the read to allow for clocks and the moment of linking) and the names of the files given above the floor (at most 32). With nothing new the cursor stays the same text, unless it would keep making reads list directories long settled (after a whole library was synced in at once); then it moves up. A cursor of the step-1 layout answers `refused`, and the reader starts again. `limit` 0: while nothing changes, the cursor after the newest fact is the same text each time it is asked for, so a reader can compare two to tell whether there is anything new.
- A row is `{ "key": string, "fields"?: { name: string } (at most 4), "value": any JSON }`; a `value` of `null` in `rows.put` deletes the row. Keys sort by their UTF-8 bytes. `rows.put` writes all its rows and the cursor in one transaction. The saved cursor is the place's fact cursor, answered by every `rows.get`.
- Rows are a cache: `rows.reset` drops the place's rows and cursor; so does deleting the cache area.
- `rows.put` stores each row's `value` as the JSON text it came as; `rows.get`, `rows.under` and `rows.where` give it back as stored. A rows file uses 16 KiB pages, since a row's value is often a kilobyte or more.

## Other operations

| Op | Request | Answer (`done`) |
| --- | --- | --- |
| `init` | `{}` | `{ "created": bool }`: makes `.pneuma-base/`, `.pneuma-base/cache/` and `.pneuma-base/noise.json` with the default list; changes nothing in a folder that already has `.pneuma-base/` |
| `describe` | `{}` | `{ "name": "local-folder", "version": s, "contract": 1, "addresses": ["path"], "cursor": bool, "facets": [name…], "ops": [op…] }`: `cursor` is whether `changed` can give a reliable cursor for this library (macOS: `true` when the library's volume keeps an FSEvents history; Linux: `false`), `facets` the facets this platform gives (macOS: `fs`, `macos`, `placeholder`; Linux: `fs`) |
| `declaration.read` | `{}` | `{ "declaration": object \| null, "token": string \| null }`; both `null` without `.pneuma-base/config.json`, and nothing is made |
| `declaration.write` | `{ "declaration": object, "expect": "empty" \| token }` | `{ "token" }`; `refused` with `"actual": token \| null` when the expectation does not hold |
| `hold` | `{ "place": p, "ttl"?: ms }` or `{ "places": [p…], "ttl"?: ms }` | `{ "hold": id, "until": time }` |
| `release` | `{ "hold": id }` | `{}` |
| `noise.list` | `{}` | `{ "names": [s…], "paths": [place…], "declared": bool }`; without `noise.json` the default list, `declared: false` |
| `noise.add`, `noise.remove` | `{ "names"?: [s…], "paths"?: [place…] }` | as `noise.list`, after writing `noise.json` |

- The root declaration is `.pneuma-base/config.json`, one JSON object the storage does not interpret. `declaration.write` makes the record area when needed, checks its expectation under a lock on `.pneuma-base/` with the comparison `look` uses, and writes the object whole as `JSON.stringify(object, null, 2) + "\n"` writes it (two-space indent, keys in the order given, a trailing newline; numbers as written by `serde_json`) to a temporary name, then renames it over; a refused write changes nothing. A file there that is not a JSON object reads as `"declaration": null` with its token, so a write can replace it. The noise list (`noise.json`) is a separate part of the declaration.

The default noise names: `.git`, `.svn`, `.hg`, `node_modules`, `.pnpm-store`, `.yarn`, `bower_components`, `__pycache__`, `.venv`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.next`, `.nuxt`, `.turbo`, `.parcel-cache`, `.gradle`, `.cache`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.Trash`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`.

## Dependencies

`serde`, `serde_json`, `rusqlite` (bundled SQLite) and `libc`, as in step 1; `sha2` (with its `asm` feature, for the ARMv8 SHA-256 instructions: a 10 MB file hashes in about 4 ms instead of 15) and `ignore` (gitignore matching for the content rule). macOS frameworks used directly: CoreServices (FSEvents) and CoreFoundation.
