# Self-describing folder formats and local-first storage: precedents for Pneuma Base

Scope: how existing "folder is the product" formats handle layout and self-description, item identity, metadata placement, concurrent writers and sync, nested units, detection of outside changes, and hand-writable record formats. Research date 2026-11-25. Every claim has an inline source. Claims I could not verify from a primary page are marked **unverified** or **secondary**. Lines marked **measured** come from a benchmark I ran on this Mac during this research. The script is at `/private/tmp/claude-501/-Users-yizhe-pneuma-base/c6cfc772-0580-49cf-bc96-8cfa52972cde/scratchpad/scanbench/scripts/bench.py`.

---

## 1. Layout and self-description: how each system lays out content, metadata and logs, and which can be read with no software

### Takeaway
Only the archival formats (BagIt, OCFL, Frictionless Data Package) and Maildir are designed so that a reader with nothing but the files can understand them. They all use a fixed declaration file at the root, plain-text or JSON manifests, and payload files that stay untouched at ordinary paths. Version-control systems (git, Fossil, Jujutsu, git-annex) are self-contained, but they keep their history in compressed or database form that needs their software, or at least zlib or SQLite, to read. Consumer libraries (Zotero, DEVONthink, Apple Photos, Eagle) put a database or an undocumented layout at the center and warn users not to touch it.

### Cited Findings

**OCFL (Oxford Common File Layout) 1.1**
- The storage root holds a NAMASTE declaration file `0=ocfl_1.1`. It can also hold an optional `ocfl_layout.json` (with `extension` and `description` keys) and an optional `extensions/` directory. "Empty directories MUST NOT appear under a storage root." — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- Each object root holds `0=ocfl_object_1.1`, `inventory.json`, `inventory.json.sha512`, and version directories `v1`, `v2`, and so on. "The version number sequence MUST start at 1 and MUST be continuous without missing integers." Content goes in a `content` subdirectory by default. — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- The inventory has a manifest that maps digest to content paths, plus one `state` per version that maps digest to logical paths. Digests give de-duplication: "This use of the content digest facilitates de-duplication of files with the same content within an object." History uses forward deltas. — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- Stated design goals: completeness, so objects can be "fully understood in the absence of original software"; parsability, so "both humans and machines can understand the layout and corresponding inventory"; robustness; versioning; and storage diversity, including cloud object stores. — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- "Once created, the contents of a version directory are expected to be immutable." The inventory digest sidecar is written last. — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- An object is identified "purely by the presence of a" NAMASTE conformance file in its root. The layout from object ID to path (flat, PairTree, hashed n-tuple) is a convention and should be recorded in `ocfl_layout.json`. Flat layouts suffer because "most filesystems begin to encounter performance issues when directories contain more than a few thousand files." — [OCFL 1.1 Implementation Notes §2.2](https://ocfl.io/1.1/implementation-notes/)

**BagIt (RFC 8493)**
- A bag is a base directory with a two-line `bagit.txt`, at least one `manifest-<alg>.txt`, and a `data/` payload directory. Optional parts are `tagmanifest-<alg>.txt`, `bag-info.txt`, `fetch.txt`, and arbitrary extra tag files. "Every payload manifest MUST list every payload file name exactly once." — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)
- "Processing a bag does not require any understanding of the payload file contents," "the payload files can be accessed without processing the BagIt metadata," and "files can be accessed using standard operating system utilities." — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)
- Complete means every required element and listed file is present. Valid means complete and every checksum has been verified. `Payload-Oxum` (byte and file count) "is strictly an optimization". Full checksum validation is still required. — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)

**Frictionless Data Package (v2, current)**
- The descriptor "`MUST` be named `datapackage.json` and it `MUST` be placed on the top-level of the file structure." `resources` is required, with at least one resource. `name`, `id`, `licenses` and `profile` are recommended. `created` follows RFC 3339. Inline data in the descriptor is allowed. The page was last updated Aug 25, 2026. — [datapackage.org Data Package](https://datapackage.org/standard/data-package/)

**Maildir**
- Three subdirectories: `tmp` (being delivered), `new` (delivered, unseen), `cur` (seen). The delivery agent writes to `tmp/` under a unique name, then moves the file to `new/` with an atomic `rename` or with link plus unlink. This "guarantees that a maildir-reading program will not see a partially written message." Readers "should never look in `tmp`." — [Wikipedia: Maildir](https://en.wikipedia.org/wiki/Maildir), citing D. J. Bernstein's maildir.html (the primary page at cr.yp.to failed to fetch, so this is **secondary**)
- Message state lives in the filename: the suffix `:2,` followed by flag letters (Passed, Replied, Seen, Trashed, Draft, Flagged). — [Wikipedia: Maildir](https://en.wikipedia.org/wiki/Maildir)

**git**
- A fresh `.git` holds `config`, `description`, `HEAD`, `hooks/`, `info/`, `objects/` and `refs/`, plus an `index` (the staging area) once one is created. "These are the core parts of Git": `HEAD`, `index`, `objects`, `refs`. — [Pro Git: Plumbing and Porcelain](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- Loose objects are zlib-compressed files named by the SHA-1 of header plus content, stored at `.git/objects/<first 2 hex>/<remaining 38>`. — [Pro Git: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)

**Fossil**
- "The global state of a fossil repository is an unordered set of artifacts." Each artifact "is named by a hash of its content." Structural artifacts are UTF-8 text "cards", one per line, and a manifest ends with a `Z` card holding an MD5 of all prior lines. — [Fossil file format](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)
- The repository is one SQLite file. Metadata tables are derived: "the metadata contains no new information," and "the entire metadata corpus can be recomputed from the canonical artifacts. That is what the fossil rebuild command does." Each checkout has its own database, `_FOSSIL_` or `.fslckout`, at its root. — [Fossil technical overview](https://fossil-scm.org/home/doc/trunk/www/tech_overview.wiki)
- Durability goal: "kept simple so that it can endure in useful form for decades or centuries" and "readable, searchable, and extensible by people not yet born." Storing artifacts as compressed SQLite blobs "is an implementation detail and might change." — [Fossil file format](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)

**Jujutsu (jj)**
- Operation and view objects are stored in content-addressed storage "just like Git commits are." Current operation heads are kept "as a file in a directory": "The ID is the name of the file; it has no contents." — [jj concurrency doc](https://docs.jj-vcs.dev/latest/technical/concurrency/)

**git-annex**
- Content lives under `.git/annex/objects/` in two levels of hash directories, then a key-named directory holding a key-named file. Write bits can be removed to prevent accidental changes. "Files added to the annex get a symlink or pointer file checked into git, that points to the file content." — [git-annex internals](https://git-annex.branchable.com/internals/)
- Metadata lives on a separate, unconnected `git-annex` branch as text log files: `uuid.log`, `trust.log`, `remote.log`, `group.log`, `preferred-content.log`, and per-key logs under `aaa/bbb/<key>.log` (location), `.log.met` (metadata), `.log.web` (URLs), and others. — [git-annex internals](https://git-annex.branchable.com/internals/)

**DataLad**
- A dataset is a git and git-annex repository. Datasets nest "arbitrarily deep". The superdataset's `.gitmodules` entry carries a `datalad-id` (e.g. `b3ca2718-8901-11e8-99aa-a0369f7c647e`), and the superdataset stores only a "subproject commit" of each subdataset. — [DataLad Handbook: nesting](https://handbook.datalad.org/en/latest/basics/101-106-nesting.html)

**Perkeep (Camlistore)**
- "Every type of content in Perkeep is represented using content-addressable blobs (even metadata)." Mutations are "immutable, timestamped, GPG-signed blobs representing a mutation request." "The current state of an object is just the application of all mutation blobs up until that point in time." — [Perkeep overview](https://perkeep.org/doc/overview)
- Schema blobs are JSON with `camliVersion` and `camliType`, at most 1 MB. Types include `file`, `directory`, `static-set`, `permanode` and `claim`. — [Perkeep schema](https://perkeep.org/doc/schema/)
- Indexes are disposable: "you can lose your index at any time" and you can "delete it all and re-replicate from your storage to your index." — [Perkeep overview](https://perkeep.org/doc/overview)

**Obsidian vaults**
- Notes are "Markdown-formatted plain text files in a vault." A vault is a folder. Obsidian "creates an .obsidian configuration folder in the root folder of the vault" for hotkeys, themes and plugins. Global settings live in a system folder outside the vault (macOS `~/Library/Application Support/obsidian`). The metadata cache is kept in IndexedDB and can be rebuilt from settings. — [Obsidian: How Obsidian stores data](https://obsidian.md/help/data-storage)
- "Because notes are plain text files, you can use other text editors and file managers to edit and manage notes," and Obsidian "automatically refreshes your vault to keep up with any external changes." — [Obsidian: data storage](https://obsidian.md/help/data-storage)

**Zotero**
- The data directory holds `zotero.sqlite` (all metadata, notes and tags), a `storage/` folder with 8-character subfolders per attachment, `-wal`/`-shm` files, daily `.bak` backups, and `fulltext.sqlite`. The full-text index "isn't backed up because Zotero can recreate it." Linked files are not copied into `storage/`. — [Zotero: data directory](https://www.zotero.org/support/zotero_data)

**DEVONthink**
- DEVONthink staff say the database must stay out of Dropbox and other automatically synced folders. Sync goes through a separate "sync location" that holds raw sync data, not the database package. Imported files are stored inside the database package. — [DEVONthink forum: syncing over Dropbox](https://discourse.devontechnologies.com/t/how-does-syncing-over-dropbox-work/16719) and [DEVONthink Sync FAQ](https://devontechnologies.com/support/faq/category:Sync) (search summaries; I did not open the specific page with the staff quote, so **secondary**)
- **Unverified**: the internal folder name `Files.noindex` and its exact role. No source was found.

**Eagle (`.library`)**
- Eagle's own docs say it uses a library rather than real folders: "Since the images are not actually saved under a specified folder, Eagle can easily save the same images in multiple categories." The trade-off is that the library cannot be flexibly accessed by other software. — [Eagle docs: why a library](https://docs-en.eagle.cool/article/576-about-eagle-file-system-structure) (quoted from a search snippet. The direct fetch returned 404, so **secondary**)
- Layout per a reverse-engineered third-party description: root `metadata.json` (folder tree) and `mtime.json`, plus `images/<ITEM_ID>.info/` folders. Each folder holds a `metadata.json` next to the original file and an optional `_thumbnail.png`. Items marked `isDeleted` are soft-deleted. — [EaglePack Importer (Obsidian plugin)](https://community.obsidian.md/plugins/eaglepack-importer) (**unverified** against official Eagle docs. I found no official format spec)

**Apple packages and Photos library**
- "A package is any directory that the Finder presents to the user as if it were a single file." The Finder treats a directory as a package by known extension, by an extension an app claims, or by the package bit. Opaque treatment "prevents casual users from making changes that might adversely affect the contents," though "it is still possible for users to view and modify their contents." "A document that is implemented as a directory and treated as an opaque type is considered to be a document package." — [Apple Bundle Programming Guide](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/AboutBundles/AboutBundles.html)
- Photos library in synced folders: community moderators say "A Photos Library must not be in any synced folder, like Dropbox, or on iCloud Drive... The synching can break the internal links in the library." Users report that since macOS Sonoma, Photos refuses to open a library stored in iCloud Drive. — [Apple Community threads](https://discussions.apple.com/docs/DOC-250007905), [Dropbox forum](https://www.dropboxforum.com/discussions/101001014/photo-library-not-reachable-on-macos-after-dropbox-sync/661138) (**secondary/anecdotal**. I did not retrieve Apple's official "Move your Photos library" article)

### Inferences
- Readable with only the files: BagIt, OCFL, Frictionless and Maildir fully; Obsidian (for notes, not for links or cache); Eagle partially (JSON per item, but undocumented). git needs zlib, and Fossil needs SQLite, to read their history. Zotero, DEVONthink and Photos are not readable without their applications. This follows from the formats cited above.
- The recurring self-description pattern is a fixed-name declaration file at the root (`bagit.txt`, `0=ocfl_1.1`, `datapackage.json`, `.obsidian/`, `.stfolder` in Syncthing) plus manifests in text or JSON. OCFL also records its own layout rule in `ocfl_layout.json`. That is the closest precedent for "the root states how the folder is maintained."
- Fossil, Perkeep and Zotero's `fulltext.sqlite` all state that derived indexes can be rebuilt from canonical data. This matches the Pneuma Base rule that "records are the source of truth, the index is a cache."

### Gaps
- Jujutsu's on-disk encoding of operation and view objects (protobuf or other) was not verified.
- Perkeep's on-disk layout for local blob storage (`blobpacked`, `localdisk`) was not checked.
- Official Eagle `.library` and DEVONthink package specifications were not found. They appear to be undocumented.

---

## 2. Item identity under rename, move and edit

### Takeaway
No surveyed system gets stable identity from the filesystem alone. The systems split three ways. Path-as-identity (git, Obsidian, OCFL logical paths) reconstructs renames afterwards by heuristics or loses them. Content-hash identity (git objects, git-annex keys, OCFL digests, Perkeep blobs) survives moves but changes on every edit. Minted IDs (Perkeep permanodes, Zotero 8-character keys, Eagle item IDs, DataLad dataset UUIDs) survive both but must be stored somewhere: a database, a folder name, or a sidecar. OS-level identity (inode/file ID, macOS bookmarks, xattrs) does not survive sync, archives or other machines reliably.

### Cited Findings

**git: path plus content, renames inferred**
- git records no rename. `-M` "Detect renames... consider a delete/add pair to be a rename if more than [n]% of the file hasn't changed... The default similarity index is 50%." — [git-diff](https://git-scm.com/docs/git-diff)
- The exhaustive pairing step is O(N²) and is capped by `diff.renameLimit`, "currently 1000." `--find-copies-harder` "is a very expensive operation for large projects." — [git-diff](https://git-scm.com/docs/git-diff)
- Blob tree entries store only mode (`100644`, `100755`, `120000`), type, hash and name. "These three modes are the only ones that are valid for files (blobs) in Git." — [Pro Git: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)

**git-annex keys**
- The key includes the backend name, then size, then hash, and for `E` backends the extension (e.g. `SHA256E-s1048576--<hash>.ext`). SHA256E is the default and "combines a 256 bit SHA-2 hash of the file's content with the file's extension". Plain SHA256 "does not include the file extension in the key." WORM "assumes that any file with the same filename, size, and modification time has the same content." — [git-annex backends](https://git-annex.branchable.com/backends/)
- A user reports that `.jpg` and `.JPG` produce different E-backend keys, which breaks dedup. — [git-annex backends, comments](https://git-annex.branchable.com/backends/) (user comment)
- Moving annex symlinks with ordinary tools can break them. `git annex fix` "Fixes up symlinks that have become broken to again point to annexed content," and this "is done automatically when committing a change with git too." — [git-annex-fix](https://git-annex.branchable.com/git-annex-fix/)

**OCFL**
- Each version's `state` maps digest to logical paths. The spec defines no rename operation. A move appears as the same digest under a new logical path (my reading of the data structure; the spec does not state it). — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)

**Perkeep permanodes (minted identity)**
- "Permanodes are how Perkeep models mutable data on top of an immutable, content-addressable datastore." "To serve as a reliable (consistently nameable) object, it must have no mutable state itself." "A permanode is really just a signed random number." — [Perkeep permanode](https://perkeep.org/doc/schema/permanode)
- "The state of a permanode is the result of combining all attribute-modifying claims which reference it, in order." Claims (`set-attribute`, `add-attribute`, `del-attribute`) must be signed and carry a `claimDate`. The page does not state a conflict rule beyond "in order." — [Perkeep permanode](https://perkeep.org/doc/schema/permanode)

**Obsidian: path identity, renames only inside the app**
- Obsidian can "automatically update internal links in your vault when you rename a file" (setting under Files and links). — [Obsidian help: links](https://obsidian.md/help/links)
- Renames done outside Obsidian (file manager, git, scripts) do not fire its rename event and arrive as delete plus create. Plugins such as External Rename Handler and Image Link Updater pair delete and create events to recover. — [External Rename Handler](https://community.obsidian.md/plugins/external-rename-handler), [forum: rename from file system](https://forum.obsidian.md/t/auto-updated-links-rename-from-file-system/25682)
- Plugins must call `app.fileManager.renameFile(file, newPath)` to get link updates. — [forum: API thread](https://forum.obsidian.md/t/enable-auto-renaming-links-in-obsidian-api/63842)
- An open feature request asks Obsidian to fix links for files moved while it was closed, which suggests this is not handled today. — [forum: moved while closed](https://forum.obsidian.md/t/auto-update-links-for-files-moved-while-obsidian-is-closed/91670)

**Zotero: minted keys plus database; linked files are fragile**
- Stored attachments sit in 8-character subfolders of `storage/` (e.g. `N7SMB24A`). The doc page does not explicitly call these item keys. — [Zotero: data directory](https://www.zotero.org/support/zotero_data)
- Linked files with a "Linked Attachment Base Directory" use relative paths. Forum threads report breakage when files are "moved within the base directory outside of Zotero" or when the base directory was set differently at different times. — [Zotero forums](https://forums.zotero.org/discussion/comment/336791), [Zotero forums](https://forums.zotero.org/discussion/comment/354894) (user reports)

**Eagle**
- Items live in `images/<ITEM_ID>.info/` folders, so the minted ID is the folder name. — [EaglePack Importer](https://community.obsidian.md/plugins/eaglepack-importer) (**unverified**, reverse-engineered)

**macOS file IDs and bookmarks**
- File reference URLs identify a file "by its volume ID and file (or directory) ID" and stay valid when the path changes. But a file reference URL "should never be persistently stored, because it is not valid across system restarts or remounts of volumes. If you need to store a persistent reference... use a bookmark instead." — [Apple: File System Programming, NSURL](https://developer.apple.com/library/archive/documentation/cocoa/Conceptual/LowLevelFileMgmt/Articles/FileManagementNSURL.html) (via search snippet)
- Bookmarks are opaque binary blobs of about 1 KB. Resolution can report them stale, and periodic refresh is advised. — [Eclectic Light: aliases and bookmarks](https://eclecticlight.co/2019/01/11/aliases-and-bookmarks-are-smarter-than-you-think/)
- One developer reports bookmark renewal failing after a rename on exFAT and FAT32 volumes. — [Apple Developer Forums 849439](https://developer.apple.com/forums/thread/849439) (single report)

**Extended attributes across transports**
- **Dropbox** syncs a fixed list of xattrs. On macOS: `com.dropbox.attributes`, `com.dropbox.internal`, `com.apple.ResourceFork` (files only), `com.apple.FinderInfo`, `com.apple.metadata:_kMDItemUserTags`, `kMDItemFinderComment`, `kMDItemStarRating`, and `com.dropbox.ignored`. The page does not say custom xattrs sync. — [Dropbox: extended attributes](https://help.dropbox.com/sync/extended-attributes)
- **iCloud Drive** strips xattrs by default: "Default behaviour is for xattrs to be stripped during syncing." Under sync intent, iCloud keeps xattrs flagged `S`, or those with neither `N` nor `B`. A custom xattr survives if its name ends in `#S` (e.g. `co.eclecticlight.MyTest#S`). FileProvider caps xattrs at "about 32KiB total for each item." — [Eclectic Light 2024: how xattrs are copied](https://eclecticlight.co/2024/09/13/from-quarantine-to-provenance-how-xattrs-are-copied/)
- As of macOS Tahoe, only these sync down: Finder tags, `com.apple.lastuseddate#PS`, `com.apple.quarantine`, `com.apple.TextEncoding`, and `#S` xattrs. `com.apple.metadata:kMDItem*` "aren't likely to sync down" without `S`. — [Eclectic Light 2026-05-12](https://eclecticlight.co/2026/05/12/what-gets-synced-in-icloud-drive/)
- A May 2026 report says Apple ended default sync of `com.apple.metadata:*` in iCloud Drive. — [Eclectic Light 2026-05-17](https://eclecticlight.co/2026/05/17/last-week-on-my-mac-syncing-metadata-in-icloud-drive/) (search snippet only, **secondary**)
- **Syncthing**: `syncXattrs` and `sendXattrs` were added in 1.22.0 and are off by default because of scan-time cost. They work on Linux, macOS, FreeBSD and NetBSD, and attributes are per OS: Linux-origin xattrs are not applied on FreeBSD. — [Syncthing: syncXattrs](https://docs.syncthing.net/advanced/folder-sync-xattrs), [sendXattrs](https://docs.syncthing.net/advanced/folder-send-xattrs.html), [forum: why off by default](https://forum.syncthing.net/t/why-syncxattrs-is-not-enabled-by-default/20732)
- **git**: blob entries carry only mode, type, hash and name, so xattrs are not stored (inference from the tree format above). — [Pro Git: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)

**Syncthing rename handling**
- "Renaming a file will not cause a retransmission of that file" within a folder. Moves between two Syncthing folders are not handled specially: "most files will most likely get re-downloaded." — [Syncthing FAQ](https://docs.syncthing.net/users/faq.html)

### Inferences
- Content hashes are the best key for "is this the same bytes" and for change detection. They cannot be the identity of an item that is edited. Every system with editable items that keeps identity (Perkeep, Zotero, Eagle, DataLad) mints an ID.
- A minted ID that lives only in a database (Zotero) or only in an xattr is lost when people work on the folder by hand or sync it. The ID has to sit in the file tree itself: in a folder name (Eagle `.info`, Zotero `storage/XXXXXXXX`), in a sidecar or front matter, or in a manifest. Copying a folder by hand then copies the ID with it, so duplicates have to be detected. This is my inference; no source covers copy-duplication explicitly.
- After a rename done outside the tool, the only signals that survive are content (hash or similarity, as git and Obsidian plugins use) and any ID carried inside the file or folder. inode and file IDs do not survive sync downloads to another machine. This is inferred from Apple's statement that file reference URLs are not valid across remounts. I did not measure inode behavior under sync.

### Gaps
- How xattrs fare in zip archives (macOS Archive Utility AppleDouble `__MACOSX/` files vs Info-ZIP) was not verified in this pass.
- Whether iCloud or Dropbox downloads keep inode numbers or birth times was not found.
- Jujutsu "change IDs" (stable across rewrites) were not researched. They are commit identity, not file identity.

---

## 3. Where metadata lives: sidecar, front matter, central database, or per-item folder

### Takeaway
Archival formats put metadata in one manifest per unit (BagIt manifests, OCFL `inventory.json`, `datapackage.json`) next to untouched payload files. Consumer apps put it in a central SQLite database (Zotero, Fossil) or an opaque package (Photos, DEVONthink). Eagle uses one folder per item with a `metadata.json` sidecar. Obsidian uses YAML front matter, which works only for Markdown. git-annex shards metadata into one log file per key on a separate branch. For units that are directories, the precedents are Apple packages, OCFL objects, BagIt bags, git submodules and DataLad subdatasets. All of them mark the directory with a declaration or descriptor file and treat its inside as owned by that unit.

### Cited Findings
- **Front matter (Obsidian)**: "Properties are stored in YAML format at the top of the file." Types are Text, List, Number, Checkbox, Date, Date & time, and Tags. "Each name must be unique within a note." Nested properties are "not currently supported." — [Obsidian: Properties](https://obsidian.md/help/properties)
- **Per-item folder plus sidecar (Eagle)**: `images/<ITEM_ID>.info/metadata.json` next to the original file and `_thumbnail.png`. A root `metadata.json` holds the folder tree. — [EaglePack Importer](https://community.obsidian.md/plugins/eaglepack-importer) (**unverified**)
- **Per-unit manifest (BagIt)**: payload in `data/`, with checksums in `manifest-<alg>.txt` and free-form `bag-info.txt`. "A manifest MUST NOT reference directories." "The payload manifest MUST NOT reference files outside the payload directory." — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)
- **Per-unit manifest (OCFL)**: one `inventory.json` per object holds manifest, versions, state, and per-version message, user and created fields. "The OCFL Object Root MUST NOT contain files or directories other than those specified." — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/)
- **Per-unit descriptor (Frictionless)**: `datapackage.json` at the top level lists `resources` by relative path or inline data. — [datapackage.org](https://datapackage.org/standard/data-package/)
- **Sharded logs on a side branch (git-annex)**: metadata per key in `aaa/bbb/<key>.log.met`. Adds (`+value`) and removals (`-value`) are both recorded with timestamps, "so an old line cannot re-add a value that was later removed." — [git-annex internals](https://git-annex.branchable.com/internals/)
- **Central database (Zotero)**: `zotero.sqlite` holds "item metadata, notes, tags." Attachments are in `storage/`. — [Zotero: data directory](https://www.zotero.org/support/zotero_data)
- **Central database with canonical artifacts inside (Fossil)**: one SQLite file. Artifacts are canonical, and metadata tables are recomputable with `fossil rebuild`. — [Fossil technical overview](https://fossil-scm.org/home/doc/trunk/www/tech_overview.wiki)
- **Claims as separate blobs (Perkeep)**: metadata changes are separate signed JSON claim blobs that point at a permanode. — [Perkeep permanode](https://perkeep.org/doc/schema/permanode)
- **xattrs as metadata**: lossy across Dropbox, iCloud and Syncthing defaults (see section 2). iCloud caps xattrs at about 32 KiB per item. — [Eclectic Light 2024](https://eclecticlight.co/2024/09/13/from-quarantine-to-provenance-how-xattrs-are-copied/), [Dropbox](https://help.dropbox.com/sync/extended-attributes)
- **Directory as one item (Apple packages)**: the Finder shows the directory as one file. Users "can install, relocate, and remove bundles simply by dragging them around in the Finder." Opacity makes them "less susceptible to accidental user modifications." — [Apple Bundle Programming Guide](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/AboutBundles/AboutBundles.html)
- **Directory as one item (git submodule)**: the superproject records the subdirectory as one tree entry with mode `160000`, "recording a commit as a directory entry rather than a subdirectory or a file," and "doesn't track its contents." — [Pro Git: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
- **Directory as one item (DataLad)**: the superdataset stores only "which version of the subdataset is currently used through an identifier." — [DataLad Handbook](https://handbook.datalad.org/en/latest/basics/101-106-nesting.html)

### Inferences
- Front matter works only for text formats that tolerate a header (Markdown). Binary files (PDF, images, video) and directory items (a website, a code project) need metadata outside the file: a sidecar, a per-item folder, or a manifest. Obsidian's docs give no mechanism for properties on non-Markdown files.
- A per-item sidecar or folder (Eagle style) moves with the item when the item moves inside the tool. A person moving only the payload in Finder separates it from the sidecar. A per-unit manifest (BagIt, OCFL) avoids separation, but it becomes a single shared file that every writer must update. That is the concurrency hazard covered in section 4.
- git-annex shows a third option. Metadata sharded by stable key into many small append-only log files avoids both separation (it is keyed by ID, not path) and a single shared file.
- For directory items, every precedent uses a marker file at the directory root (`0=ocfl_object_1.1`, `bagit.txt`, `.git`, `datapackage.json`, package extension). The marker is how a scanner knows to stop descending and treat the directory as one unit.

### Gaps
- No source quantified sidecar-vs-database trade-offs, such as performance at 100k items or rates of user error. The trade-offs above are inferred.
- Obsidian's behavior on invalid YAML front matter is not documented on the Properties page.

---

## 4. Concurrent writers and sync: what survives two writers, and which layouts never produce conflict files

### Takeaway
Two writers are safe when each write creates a new file with a unique name, often content-addressed, and readers merge the set (Maildir, git objects, Jujutsu operation heads, automerge-repo chunks, git-annex union-merged logs). Every file synchronizer surveyed defines a conflict as the same path changed on both sides since the last sync, so append-only unique-name files cannot conflict. Deletions and compaction can still cause trouble. Single shared mutable files (SQLite databases, a central manifest, `.git` refs and index) are where corruption and conflicted copies come from. Zotero, SQLite, git, DEVONthink and Photos all warn against putting their stores in Dropbox or iCloud.

### Cited Findings

**Lock-free designs based on unique names**
- **Maildir**: designed "with a major goal of eliminating the need for program code to handle file locking." It uses unique names plus atomic rename from `tmp/` to `new/`. Unique-name recipes changed over time: (1) time.pid.host with a 2-second retry, (2) a per-process counter (2000), (3) concatenated sequence, boot, random, inode, device, microsecond and PID values (2003). In practice "some software that uses Maildirs also uses locks, such as Dovecot." Timo Sirainen: "Only the first step is what really guarantees that the mails won't get overwritten." — [Wikipedia: Maildir](https://en.wikipedia.org/wiki/Maildir) (**secondary**)
- **Jujutsu**: "accepting that concurrent changes can always happen." To commit an operation, jj adds a file named by the new operation ID, then removes the old head file. "Writing the new file is what makes the operation visible." With multiple heads, jj does "a 3-way merge of the view objects," and "Conflicts are recorded in the resulting view object." Content-addressed objects are "safe to write without locking." — [jj concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)
- **Jujutsu caveats for Dropbox, rsync and NFS**: "there are known bugs in this area," "with the Git backend, repository corruption is possible because the backend is not entirely lock-free," and concurrent modification "might conceivably lose some bookmark pointers." — [jj concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)
- **git-annex branch**: "The files stored in this branch are all designed to be auto-merged by simply concacenating them together." "Each line has a timestamp, to allow the most recent information to be identified." — [git-annex internals](https://git-annex.branchable.com/internals/)
- **automerge-repo storage**: keys are `[<document ID>, <chunk type>, <chunk identifier>]`, where the type is `snapshot` or `incremental`. Incremental chunks are named by the hash of the change bytes, and snapshots by the document heads. A chunk with the same name "must contain the same changes," so writes need no transactions. Compaction deletes only the chunks the compacting process loaded, because "another process might have written new changes since it started." Reliable compaction is "very fiddly for simple mediums like a directory on the local filesystem." — [Automerge: storage under the hood](https://automerge.org/docs/reference/under-the-hood/storage/)
- The NodeFS adapter "is safe for multiple processes to use the same data directory." — [Automerge: storage](https://automerge.org/docs/reference/repositories/storage/)
- A Rust port (samod) has a test for a compaction edge case in which writing the same compacted chunk leads the repo to delete a snapshot it wrongly believes superseded. — [samod-core compaction test](https://docs.rs/crate/samod-core/0.9.0/source/tests/compaction.rs) (search snippet, **secondary**)
- **OCFL**: OCFL covers objects at rest. "Updates to it should be managed by a single controlling process." Assemble the new version in a workspace on the same filesystem "to make file transfers as atomic as possible," rename it to `vN`, and update the top inventory "as the final operation." It "should never be updated in situ." "Do not start a new transaction without rereading the updated object." — [OCFL Implementation Notes §3.7](https://ocfl.io/1.1/implementation-notes/)

**CRDTs and local-first (Ink & Switch)**
- Seven ideals (2019): no spinners; not trapped on one device; network optional; seamless collaboration; the Long Now; security and privacy by default; ultimate ownership and control. — [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/)
- On Dropbox-style sync, the essay says the same file edited on two devices yields "a conflict that needs to be merged manually." Syncing any format is "both a strength... and a weakness (inability to perform format-specific merges)." Git "has no capability for real-time, fine-grained collaboration," and other formats "are treated as binary blobs that cannot meaningfully be edited or merged." — [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/)
- On CRDTs, for concurrent edits to the same property, "the CRDT keeps track of the conflicting values, and leaves it to be resolved by the application or the user." Limits: "CRDTs accumulate a large change history, which creates performance problems." — [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/)
- Later work: Patchwork ("collaborative, version-controlled, local-first, malleable software"), with a public release at Local-First Conf in July 2026. Jacquard "tracks a full provenance chain" to build all sources of an astronomy paper. — [Ink & Switch: Patchwork notebook](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/) (search snippets, **secondary**. I did not read the pages)

**File synchronizers: how they define and name conflicts**
- **Syncthing**: conflict copies are named `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`. "The file with the older modification time will be marked as the conflicting file." Ties go by device ID. Conflict files "are treated as normal files after they are created, so they are propagated." If modify and delete conflict and the deletion wins, "the file is renamed to a conflict copy." — [Syncthing: Understanding Synchronization](https://docs.syncthing.net/users/syncing.html)
- **Dropbox**: when two people edit the same file at the same time, "the editor's username, 'conflicted copy', and the save date" are added to the filename. The most recent save gets the conflicted-copy name. — [Dropbox: conflicted copy](https://help.dropbox.com/organize/conflicted-copy)
- **rclone bisync**: a conflict is a file "new or changed on both sides since the prior run" and not identical now. "If the file's content is currently identical on both sides, it is not considered a 'conflict'." The default keeps both, renamed `.conflict1` and so on. `--max-delete` defaults to 50% and aborts the run beyond that. — [rclone bisync](https://rclone.org/bisync/)
- **Unison**: "Conflicting updates are just displayed." By default "neither version will be propagated and both replicas will remain as they are." — [Unison manual](https://raw.githubusercontent.com/bcpierce00/unison/documentation/unison-manual.html)

**What breaks: SQLite, `.git`, and app libraries in synced folders**
- **git**: "It is important not to use a cloud syncing service to sync any portion of a Git repository, since this can cause corruption, such as missing objects, changed or added files, broken refs... These services tend to sync file by file on a continuous basis and don't understand the structure of a Git repository." — [gitfaq](https://git-scm.com/docs/gitfaq)
- **SQLite**: a backup copy taken mid-transaction "might contain some old and some new content, and thus be corrupt." The `-wal` or `-journal` file "must be kept together with the database." Locking bugs in network filesystems can corrupt the database. Renaming or unlinking an open database is undefined. Safe live copies use `sqlite3_rsync`, `VACUUM INTO`, or the backup API. — [SQLite: How To Corrupt](https://www.sqlite.org/howtocorrupt.html)
- **Zotero**: putting the data directory in Dropbox, Google Drive or OneDrive "is extremely likely to corrupt your database," because "cloud storage systems generally don't honor such locks." Even with locks, "you would simply end up with two conflicted copies that were impossible to merge," and these "would quickly proliferate." — [Zotero KB: cloud storage](https://www.zotero.org/support/kb/data_directory_in_cloud_storage_folder)
- **DEVONthink**: staff say never put the database in a Dropbox or other automatically cloud-synced folder. Use DEVONthink's own sync stores. — [DEVONthink forum](https://discourse.devontechnologies.com/t/how-does-syncing-over-dropbox-work/16719) (**secondary**)
- **Apple Photos**: libraries in Dropbox or iCloud Drive are reported damaged or refused. — [Apple Community](https://discussions.apple.com/docs/DOC-250007905) (**anecdotal**)
- **Syncthing's own state** is kept in "Syncthing's data directory," separate from the synced folder. A `.stfolder` marker in the synced folder is "a safety check to ensure that your folder is properly readable and present on disk." If it is missing, syncing stops. — [Syncthing FAQ](https://docs.syncthing.net/users/faq.html)

### Inferences
- **Layouts that cannot produce sync conflict files**: Syncthing, Dropbox and rclone bisync all define a conflict on a single path changed on two sides. So a layout where each event or record is a new immutable file with a globally unique name (Maildir style, content-addressed like git, automerge and jj, or ID-plus-timestamp style) never triggers a content conflict. Two machines only ever add different names. This matches the Pneuma Base design rule "one file per scene, append-only". To make it strict, each scene's file must be written by exactly one writer.
- **Remaining hazards with unique-name layouts**: (a) deletion or compaction racing with additions. Automerge's rule is "delete only what you loaded," and Syncthing renames modified-vs-deleted files to conflict copies. (b) Any single "head" or "current" pointer file. jj avoids this by making heads a directory of empty files named by ID. (c) A partially written file that gets synced mid-write. Maildir and OCFL avoid this by writing in `tmp` and renaming.
- **Mutable shared files are the hazard**: a central manifest, a SQLite index, a `.git` index or refs. If Pneuma Base keeps a SQLite index for the viewer, the SQLite and Zotero guidance implies it must live outside the synced folder, or be marked ignored (Dropbox `com.dropbox.ignored` xattr, Syncthing ignore), and be rebuildable.
- An append-only text log with one line per event, merged by union (git-annex) is a middle path. It stays human-readable and merges cleanly under git. Under Dropbox or Syncthing, though, one shared log file edited on two machines still makes a conflict copy, because those tools do not union-merge. Hence one file per writer or per scene, not one shared log.

### Gaps
- No primary source found on Dropbox's or iCloud's handling of rename-vs-edit races or of directories renamed on two machines.
- iCloud Drive conflict naming and behavior was not verified in a primary source.
- The "Concurrent Compaction in Automerge Repo" post (patternist.xyz, Nov 2024) was found but not read.

---

## 5. Nested units: submodules, nested repositories, storage roots

### Takeaway
Every system that nests self-contained units records the child as an opaque pointer (gitlink commit hash, DataLad subproject commit) or forbids nesting outright (OCFL object roots are terminal). Pointer-style nesting keeps each unit independently complete and movable. The cost is a second step to keep parent and child in step, plus many sharp edges in tooling (detached HEAD, separate push, recursion flags, branch switching).

### Cited Findings
- **git submodules**: the superproject "sees it as a particular commit from that repository," stored with mode `160000`. After `git submodule update` the sub-repo is in "detached HEAD" state, so "changes will quite possibly be lost the next time you run `git submodule update`." Pushing the superproject without the submodule leaves others with "no way to get the submodule changes." `git pull` "does not update the submodules." Switching branches needs `--recurse-submodules`, and converting a subdirectory to a submodule causes "already exists in the index" and checkout errors. Recovery note: submodules "keep all their Git data in the top project's `.git` directory... destroying a submodule directory won't lose any commits." — [Pro Git: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
- **Nested git repos without submodule registration**: "By default, `git add` will warn when adding an embedded repository to the index without using `git submodule add`." Option: `--no-warn-embedded-repo`. — [git-add](https://git-scm.com/docs/git-add)
- **DataLad**: each dataset "keeps their stand-alone history." Nesting gives "modular reuse." Drawback: `git log` in the superdataset "would only return the superdatasets history." — [DataLad Handbook](https://handbook.datalad.org/en/latest/basics/101-106-nesting.html)
- **OCFL**: "Storage hierarchies MUST be terminated by OCFL Object Roots" and "MUST NOT include files within intermediate directories." An object root may contain only the specified files. Large collections may use "many OCFL Storage Roots." The spec does not address an object inside another object's content. — [OCFL 1.1 spec](https://ocfl.io/1.1/spec/), [Implementation Notes](https://ocfl.io/1.1/implementation-notes/)
- **Syncthing**: moving files between two separate Syncthing folders is not special-cased and causes re-download. — [Syncthing FAQ](https://docs.syncthing.net/users/faq.html)
- **`.git` inside a synced folder**: corruption risk, as stated in the gitfaq. — [gitfaq](https://git-scm.com/docs/gitfaq)

### Inferences
- A code project or website kept as one item in Pneuma Base will often already contain a `.git`. git's own rule says not to sync any part of a repository with a cloud sync service, so a library that is synced with Dropbox or iCloud and holds item folders with `.git` inside carries that risk. The git and SQLite guidance points to keeping such items' `.git` out of file sync (ignore rules), or syncing them by git itself.
- OCFL's "terminal object root, marker file decides" rule and git's gitlink both give a scanner a clean stop condition: when it sees the marker, it stops descending and treats the directory as one unit. Without such a marker, a scan for changes made outside the tool would descend into `node_modules` or `.git` and count every file inside as library content.

### Gaps
- git subtree, monorepo sparse checkout, and `git worktree` were not researched in this pass.
- BagIt says nothing about nested bags (checked; RFC 8493 is silent).

---

## 6. Detecting changes made outside the tool, and the cost of scanning about 100,000 files

### Takeaway
Every tool surveyed detects outside changes by comparing a cached snapshot of (path, size, mtime, sometimes inode or mode) against a fresh walk, and hashes only the candidates. Some add OS file events to skip the walk. On this Mac, a full metadata walk of 100,000 files takes about a quarter of a second warm, so periodic full scans are cheap at that size. Hashing everything is about 15 times slower. Events are an optimization that must fall back to a full rescan on overflow or token mismatch.

### Cited Findings
- **git status without fsmonitor**: git must "`lstat()` every tracked file," and the untracked search enumerates every directory. Numbers from GitHub: Chromium (393K files) 17.6 s total, synthetic 1M files 41.1 s, 2M files 85.1 s. The untracked cache alone gives "roughly a 2X speed up." With the builtin FSMonitor plus the untracked cache, totals are 0.83 s, 0.59 s and 0.75 s. Builtin `fsmonitor--daemon` arrived in git 2.37.0 on macOS and Windows. If the daemon token does not match, the daemon returns "assume everything changed" and git falls back to a full scan. — [GitHub blog: FSMonitor](https://github.blog/engineering/improve-git-monorepo-performance-with-a-file-system-monitor/)
- **Measured on this Mac (Apple M4 Max, macOS 26.7.2, boot volume, warm page cache, 100,000 files of 4 KiB in 1,000 directories):**
  - Python `os.scandir` walk plus `lstat` of every file: 0.247 s, 0.230 s, 0.227 s over three passes. — measured, script above
  - `git status --porcelain` (git 2.54.0, fsmonitor and untracked cache off): 0.18–0.22 s real; 0.18 s after touching 100 files. — measured
  - Reading and SHA-256 hashing all files (410 MB), single-threaded Python: 3.35 s. — measured
  - Creating the 100,000 files: 7.68 s. — measured
  - Caveat: warm cache, small files, fast SSD. Cold cache, spinning disks, network or FUSE mounts, and file-provider (dataless) iCloud files were not measured.
- **Syncthing**: uses a filesystem watcher plus full scans: "By default the watcher is enabled and full scans are done once per hour," with intervals jittered between 3/4 and 5/4. Watcher changes are batched for 10 s, and deletions are held another minute. The scan checks "modification time, size or permission bits," and a file is "rehashed" if any changed. Block sizes run from 128 KiB to 16 MiB, each hashed with SHA-256. — [Syncthing: syncing](https://docs.syncthing.net/users/syncing.html)
- **Watchman**: on Linux the limits are `max_user_watches`, `max_user_instances` and `max_queued_events`. If the event queue overflows, Watchman "will assume that all the files have been modified and will re-crawl the directory tree." It uses FSEvents on macOS. It gives "very poor results using it on any kind of remote or distributed filesystem." — [Watchman install docs](https://meta.github.io/watchman/docs/install)
- **rclone bisync**: "retains the listings of the Path1 and Path2 filesystems from the prior run" in a workdir and compares by size and modtime by default, or by checksum with `--compare`. — [rclone bisync](https://rclone.org/bisync/)
- **Unison**: keeps an archive of last-synced state per replica in `~/.unison`. On Unix it "simply looks at each file's inode number and modtime" for a fast first pass, then fingerprints candidates. An option `-ignoreinodenumbers` exists. — [Unison manual](https://raw.githubusercontent.com/bcpierce00/unison/documentation/unison-manual.html), [unison man page](https://www.mankier.com/1/unison)
- **Obsidian**: refreshes on external changes, but outside renames show up as delete plus create (section 2). — [Obsidian: data storage](https://obsidian.md/help/data-storage), [External Rename Handler](https://community.obsidian.md/plugins/external-rename-handler)
- **BagIt**: `Payload-Oxum` (octet count and file count) is a cheap first check, but full checksum validation is still required. — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)

### Inferences
- At around 100,000 files on a local SSD, a full stat walk costs well under a second (measured). A viewer or CLI can afford a full rescan at startup and periodically. FSEvents or a watcher only adds latency gains, and correctness must not depend on it (Watchman and FSMonitor both fall back to a full crawl).
- Hashing everything is about 15 times the cost of a stat walk (measured 3.35 s vs 0.23 s for 410 MB). Large media libraries would be far slower, because hashing scales with bytes. So the snapshot cache should record (size, mtime, inode, hash) and rehash only on size or mtime change, as git, Syncthing and Unison do.
- Rename detection after outside moves can reuse the cached hash: a vanished path plus a new path with the same hash is a move. This is git's exact-rename case. git's similarity matching (50%, capped at 1000 files) covers edited moves but is O(N²).
- The snapshot cache (the "index") is disposable state and belongs outside synced storage. Syncthing keeps its database in its own data directory, Unison in `~/.unison`, and rclone in a workdir.

### Gaps
- Cold-cache and HDD or network-volume scan costs were not measured.
- FSEvents coalescing behavior and history replay (`sinceWhen` event IDs) on macOS were not researched.

---

## 7. Human-writable and agent-writable record formats

### Takeaway
Line-oriented formats with a fixed leading token (todo.txt, beancount's dated directives, git-annex timestamped log lines, Maildir flags in filenames) stay hand-writable and parse reliably. JSON Lines parses reliably and appends cleanly, but it is less pleasant to hand-edit. YAML front matter is the norm for Markdown but has type-coercion traps (YAML 1.1 booleans). Org-mode is hard to parse outside Emacs because parsing depends on per-document configuration. Checksummed text formats (Fossil `Z` card) cannot be hand-edited without tooling.

### Cited Findings
- **JSON Lines**: UTF-8 with no BOM, "each line is a valid JSON value," and `\n` terminators (`\r\n` also accepted). A final terminator is "strongly recommended." Extension `.jsonl`. "A great format for log files," and a terminator after every value makes "concatenating JSON Lines files easier." — [jsonlines.org](https://jsonlines.org/)
- **YAML front matter**: under YAML 1.1, unquoted `NO`, `yes`, `on`, `off`, `y` and `n` become booleans (the "Norway problem"). YAML 1.2 limits booleans to `true` and `false`, but a January 2026 post says many popular libraries still default to 1.1. — [bram.us: The Norway Problem](https://bram.us/2022/01/11/yaml-the-norway-problem), [lab174: YAML Norway (2026)](https://hn.jakechampion.name/reader/https://lab174.com/blog/202601-yaml-norway/) (**secondary**, no YAML spec page fetched)
- Obsidian supports only flat properties of fixed types. Nested properties are "not currently supported." — [Obsidian: Properties](https://obsidian.md/help/properties)
- **TOML**: v1.1.0 was released in December 2025. It allows newlines and trailing commas in inline tables, adds `\xHH` and `\e` escapes, allows datetimes without seconds, and clarifies comments, dotted keys and numeric limits. Sources disagree on the exact date: GitHub release Dec 24, SourceForge mirror 2025-12-18. — [toml.io v1.1.0](https://toml.io/en/v1.1.0), [toml-lang releases](https://github.com/toml-lang/toml/releases), [x-cmd blog](https://x-cmd.com/blog/251223/) (change list partly **secondary**)
- **beancount**: "The order of declaration of the directives is not important." Entries "are re-sorted chronologically after parsing." Metadata is `key: value` lines, and keys start lowercase a–z. "If an attribute is repeated multiple times, only the first value... will be retained." `include` splits files, resolved relative to the including file. **Trap**: any line not starting a valid directive "is silently ignored." — [Beancount language syntax](https://beancount.github.io/docs/beancount_language_syntax/)
- **todo.txt**: "A single line in your todo.txt text file represents a single task." Priority `(A)` comes first, completion is a lowercase `x ` prefix, dates are `YYYY-MM-DD`, projects use `+project` and contexts `@context`, and extensions use `key:value` (no whitespace or colons in keys, no whitespace in values). Goal: readable in any editor, and a plain sort yields a useful order. — [todo.txt format](https://github.com/todotxt/todo.txt)
- **Org-mode**: "Only headings, sections, property drawers, and planning lines are context-free." Todo keywords are "set on a per-document basis," so "the tokenizer must be configurable at runtime." Property drawers are `:PROPERTIES:` … `:END:` with `:NAME: VALUE` lines. — [Org Syntax (worg)](https://orgmode.org/worg/org-syntax.html)
- **Fossil manifests**: one card per line, ending with a `Z` card holding the MD5 of all prior lines. — [Fossil file format](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)
- **git-annex logs**: one fact per line with a timestamp, merged by concatenation. Values with whitespace are base64-encoded and prefixed with `!`. — [git-annex internals](https://git-annex.branchable.com/internals/)
- **BagIt manifests**: `<checksum> <path>` lines. In paths, LF, CR and `%` "MUST be percent-encoded." The separator is `/`. Implementations "SHOULD discourage the creation of bags containing files that differ only in case" and "SHOULD prevent... files that differ only in normalization form." — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493)

### Inferences
- Formats that parse reliably share three traits: one record per line, a fixed leading token or date that identifies the record type, and no dependence on order (beancount re-sorts; git-annex resolves by timestamp). These suit append-only scene records written by agents and occasionally by hand.
- YAML front matter is fine for a small, flat, fixed-key header in Markdown (Obsidian's restricted model). Values like `no`, `on`, versions and dates should be quoted or schema-typed.
- Silent skipping of bad lines (beancount) hides corruption. A records parser for Pneuma Base should report unparseable lines with file and line number. That is the inverse of beancount's choice, and my recommendation, not a sourced fact.
- Filenames and paths in records need an escaping rule (BagIt percent-encodes LF, CR and %) and a stance on case and Unicode normalization. macOS (NFD-normalizing HFS+, case-insensitive by default) and Linux differ here (RFC 8493 §6.1).

### Gaps
- No source compared parse-error rates across formats. The reliability claims are inferred from the specs.
- I did not fetch the YAML 1.2 specification directly.

---

## Ideas worth borrowing and traps to avoid

Each item restates a finding above and names its source.

### Worth borrowing
1. **A root declaration file plus a recorded layout rule.** OCFL identifies a unit "purely by the presence of" a NAMASTE file and records its path-layout scheme in `ocfl_layout.json`. BagIt requires `bagit.txt`, and Frictionless requires `datapackage.json` at the top level. — [OCFL Implementation Notes](https://ocfl.io/1.1/implementation-notes/), [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493), [datapackage.org](https://datapackage.org/standard/data-package/)
2. **Payload untouched at ordinary paths, metadata alongside.** BagIt: "the payload files can be accessed without processing the BagIt metadata." OCFL's goal is objects "fully understood in the absence of original software." — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493), [OCFL spec](https://ocfl.io/1.1/spec/)
3. **Canonical records vs rebuildable indexes.** Fossil: "the metadata contains no new information... That is what the fossil rebuild command does." Perkeep: "you can lose your index at any time." Zotero does not back up `fulltext.sqlite` because it can recreate it. — [Fossil overview](https://fossil-scm.org/home/doc/trunk/www/tech_overview.wiki), [Perkeep](https://perkeep.org/doc/overview), [Zotero](https://www.zotero.org/support/zotero_data)
4. **Unique immutable files per write, so there is no locking and no sync conflict.** Maildir uses tmp-then-rename with unique names. jj names head files by operation ID ("Writing the new file is what makes the operation visible"). Automerge names chunks by content hash, so same name means same content. — [Wikipedia: Maildir](https://en.wikipedia.org/wiki/Maildir), [jj concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/), [Automerge storage](https://automerge.org/docs/reference/under-the-hood/storage/)
5. **Delete only what you have read.** Automerge compaction deletes only the chunks it loaded, because others may have written since. — [Automerge storage](https://automerge.org/docs/reference/under-the-hood/storage/)
6. **Write staging outside the visible tree, then rename, and update the manifest last.** OCFL: assemble on the same filesystem, rename to `vN`, update the inventory "as the final operation," never in situ. — [OCFL Implementation Notes](https://ocfl.io/1.1/implementation-notes/)
7. **Minted identity separate from content.** A Perkeep permanode "is really just a signed random number," and its state is the ordered application of claims. Zotero and Eagle put minted IDs in folder names. — [Perkeep permanode](https://perkeep.org/doc/schema/permanode), [Zotero](https://www.zotero.org/support/zotero_data), [EaglePack Importer](https://community.obsidian.md/plugins/eaglepack-importer)
8. **Timestamped add and remove lines, merged by union.** git-annex logs auto-merge "by simply concacenating them," and recording removals stops a stale line from re-adding a removed value. — [git-annex internals](https://git-annex.branchable.com/internals/)
9. **Snapshot-diff change detection with stat first and hash second, and events only as a hint.** git, Syncthing and Unison all compare size, mtime (and inode or mode) before hashing. FSMonitor and Watchman fall back to a full rescan on token mismatch or overflow. Measured here: about 0.23 s to stat 100,000 files, 3.35 s to hash 410 MB. — [GitHub FSMonitor blog](https://github.blog/engineering/improve-git-monorepo-performance-with-a-file-system-monitor/), [Syncthing](https://docs.syncthing.net/users/syncing.html), [Watchman](https://meta.github.io/watchman/docs/install), [Unison manual](https://raw.githubusercontent.com/bcpierce00/unison/documentation/unison-manual.html)
10. **Marker-terminated units for directory items.** OCFL hierarchies "MUST be terminated by OCFL Object Roots." git records a nested repo as one `160000` gitlink. Apple packages are directories the Finder treats as one file. — [OCFL spec](https://ocfl.io/1.1/spec/), [Pro Git: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules), [Apple Bundle Guide](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/AboutBundles/AboutBundles.html)
11. **Line-per-record, order-independent text.** beancount re-sorts directives after parsing. todo.txt uses one task per line with fixed prefixes. JSON Lines uses one JSON value per line, which concatenates cleanly. — [beancount](https://beancount.github.io/docs/beancount_language_syntax/), [todo.txt](https://github.com/todotxt/todo.txt), [jsonlines.org](https://jsonlines.org/)

### Traps to avoid
1. **A SQLite database, or any single mutable store, inside the synced folder.** SQLite corrupts when copied mid-transaction or separated from its `-wal`. Zotero says cloud folders are "extremely likely to corrupt your database." DEVONthink and Photos give the same warning. — [SQLite](https://www.sqlite.org/howtocorrupt.html), [Zotero KB](https://www.zotero.org/support/kb/data_directory_in_cloud_storage_folder), [DEVONthink forum](https://discourse.devontechnologies.com/t/how-does-syncing-over-dropbox-work/16719), [Apple Community](https://discussions.apple.com/docs/DOC-250007905)
2. **`.git` directories under file sync.** "It is important not to use a cloud syncing service to sync any portion of a Git repository." jj, which is designed for this case, still warns of known bugs and lost bookmarks with the Git backend. — [gitfaq](https://git-scm.com/docs/gitfaq), [jj concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)
3. **Relying on xattrs for identity or metadata.** Dropbox syncs only a fixed list. iCloud strips xattrs by default unless they carry the `#S` flag, caps them at about 32 KiB, and recently dropped `com.apple.metadata:*` from default sync. Syncthing's xattr sync is off by default and per OS. git does not store them. — [Dropbox](https://help.dropbox.com/sync/extended-attributes), [Eclectic Light 2024](https://eclecticlight.co/2024/09/13/from-quarantine-to-provenance-how-xattrs-are-copied/), [Eclectic Light 2026](https://eclecticlight.co/2026/05/12/what-gets-synced-in-icloud-drive/), [Syncthing](https://docs.syncthing.net/advanced/folder-sync-xattrs), [Pro Git](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
4. **Relying on inode, file IDs or bookmarks across machines.** File reference URLs are "not valid across system restarts or remounts." Bookmarks go stale and have failed after renames on exFAT and FAT32. — [Apple NSURL docs](https://developer.apple.com/library/archive/documentation/cocoa/Conceptual/LowLevelFileMgmt/Articles/FileManagementNSURL.html), [Apple forum](https://developer.apple.com/forums/thread/849439)
5. **Path-only identity with link rewriting done only inside the app.** Obsidian updates links only for renames made through its own API. Outside renames arrive as delete plus create, and moves made while it is closed are not repaired. — [External Rename Handler](https://community.obsidian.md/plugins/external-rename-handler), [Obsidian forum](https://forum.obsidian.md/t/auto-update-links-for-files-moved-while-obsidian-is-closed/91670)
6. **Extension or case inside content keys.** git-annex SHA256E keys include the extension, and `.jpg` vs `.JPG` breaks dedup. — [git-annex backends](https://git-annex.branchable.com/backends/)
7. **A shared single log or manifest written by many writers under Dropbox or Syncthing.** These tools turn concurrent edits to one path into conflict copies, which then propagate as ordinary files. They do not union-merge. — [Syncthing](https://docs.syncthing.net/users/syncing.html), [Dropbox](https://help.dropbox.com/organize/conflicted-copy), [rclone bisync](https://rclone.org/bisync/)
8. **Submodule-style nesting without tooling that recurses.** Detached HEAD, a separate push, `git pull` not updating submodules, and branch-switch breakage are all documented. — [Pro Git: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
9. **Format traps for hand-written records.** YAML 1.1 coerces `NO` to false. Org parsing depends on per-document todo keywords. beancount silently ignores unrecognized lines. — [bram.us](https://bram.us/2022/01/11/yaml-the-norway-problem), [Org Syntax](https://orgmode.org/worg/org-syntax.html), [beancount](https://beancount.github.io/docs/beancount_language_syntax/)
10. **Undocumented internal layouts that users must not touch.** Eagle trades access by other software for multi-category placement, and its format is known only by reverse engineering. That conflicts with the goal of a folder agents can read without software. — [Eagle docs (snippet)](https://docs-en.eagle.cool/article/576-about-eagle-file-system-structure), [EaglePack Importer](https://community.obsidian.md/plugins/eaglepack-importer)
11. **Case and Unicode normalization differences between filesystems.** BagIt says implementations should prevent names that differ only in case or normalization form. gitfaq notes that Windows and macOS case-fold names by default. — [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493), [gitfaq](https://git-scm.com/docs/gitfaq)
