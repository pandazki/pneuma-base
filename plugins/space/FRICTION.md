# Friction: writing a Pneuma Base plugin as a third party

I wrote the `space` plugin, which deploys a library's websites to PneumaSpace, outside the Pneuma Base repository. I built it against the plugin contract at pneuma-base `e864a12` (2026-11-26). The plugin loads from `$PNEUMA_BASE_HOME/plugins/space/index.js` and imports nothing from Pneuma Base at runtime. `scripts/proof.sh` walks the whole lifecycle against the PneumaSpace acceptance stack.

Each entry gives three things: what I needed, what I did instead, and what would remove the friction. File and line references point into the pneuma-base repository unless they say otherwise. "Read" means I learned it from source code. "Run" means I saw it happen.

| Group | Entries |
| --- | --- |
| contract | 10 (C1–C10) |
| kit | 8 (K1–K8) |
| build and install | 7 (B1–B7) |
| presentation | 10 (P1–P10) |
| docs | 11 (D1–D11) |
| conventions | 9 (V1–V9) |
| what was easy | 9 (E1–E9) |

How much I copied, measured by `scripts/count-copied.mjs` (it compares trimmed lines of 8 or more characters against the source files I read):

| My file | Verbatim from Pneuma Base | After normalizing renames (site→app, fingerprint→bundle, `run.d`→`run.r`) | Source |
| --- | --- | --- | --- |
| `src/contract.ts` | 43 of 71 | 43 | `packages/kernel/src/types.ts` (the other 28 lines are restated by hand) |
| `src/library.ts` | 52 of 90 | 52 | `kernel/src/paths.ts`, `kernel/src/things.ts`, `plugin-deploy/src/reconcile.ts` |
| `src/model.ts` | 10 of 50 | 17 | `plugin-deploy/src/model.ts` |
| `src/store.ts` | 64 of 142 | 77 | `plugin-deploy/src/facts.ts`, `targets.ts` |
| `src/reconcile.ts` | 31 of 134 | 37 | `plugin-deploy/src/reconcile.ts` |
| `src/commands.ts` | 29 of 104 | 34 | `plugin-deploy/src/commands.ts` |
| `src/views.ts` | 31 of 130 | 35 | `plugin-deploy/src/views.ts` |
| `src/index.ts` | 56 of 112 | 61 | `plugin-deploy/src/index.ts`, `cognition/deploy-section.md` |
| `src/space.ts` | 0 of 146 | 0 | (26 lines are from pneuma-space `cli/appctl.ts`: the tar header) |
| **Total** | **316 of 979** | **356** | |

The line counts understate it. Apart from `space.ts`, the plugin is a structural fork of `plugin-deploy`: the same files, functions and order, with a different target. Only `space.ts` (the PneumaSpace client), the live-state reading in `look`, and the page columns are new.

---

## contract

**C1. No types package, so I restated the contract by hand.**
- Needed: the `Plugin`, `PluginContext`, hook argument types and the block types.
- Did instead: restated 71 lines in `src/contract.ts` from `packages/kernel/src/types.ts`. `@pneuma-base/kernel` is `"private": true` (`packages/kernel/package.json:4`) and depends on nothing a third party can install. To learn whether my restatement still matches, I wrote `scripts/contract-check/run.sh`, which points `tsc` at a checkout's `packages/kernel/dist/types.d.ts` by absolute path. The naive check (`const p: Plugin = space`) passes even when it should not, because TypeScript method parameters are bivariant. The real check compares each type in the direction that matters. I made it fail once on purpose: adding a `Tone` value turned exactly `Block`, `ViewAnswer` and `ItemSection` red.
- Would remove it: a published, versioned `@pneuma-base/plugin-api` that holds only types, with `Plugin` written so that hook parameters are checked strictly (property functions, not methods).

**C2. A plugin cannot declare which contract it targets.**
- Needed: to say "built for contract 1, pneuma-base ≥ X, Node ≥ 22.18", and have an incompatible kernel refuse me at `plugin add`, not halfway through a hook.
- Did instead: nothing. `parsePlugin` (`kernel/src/plugin-table.ts:46-56`) checks the name, the three lists and the cognition shape. A hook with the wrong shape fails when it is first called. `engines` in my `package.json` is not read by anyone.
- Would remove it: a required `contract: 1` field (and optionally `requires: { pneumaBase, node }`), checked by the loader, with the reason given in `plugin add` and in `whyNotLoaded`.

**C3. The context gives no library helpers, so I copied the kernel's.**
- Needed: to parse an agent's input into a library path, tell content from archive from kernel files, find the bundle a path lies in, tell a file from a bundle, and list the files a bundle counts.
- Did instead: copied `parseLibraryPath`, `canonical`, `regionOf`, `archivedPath`, `abs`, `kindAt`, `bundleFiles`, `enclosingBundle` and `thingPath` into `src/library.ts` (90 lines, 52 verbatim). The kernel exports these from `packages/kernel/src/index.ts` only to workspace packages. The worst case is `LEFT_OUT`, the set of names a bundle never counts (`.pneuma-item`, `.git`, `node_modules`, `.DS_Store`). It is not exported at all. My copy decides what goes into the published site, and it drifts silently when the kernel changes the set.
- Would remove it: the same functions on the context, bound to the library: `ctx.library.resolve(input) → { path, region, bundle } | null`, `ctx.library.thing(path) → { kind, files } | null`, `ctx.library.files(path)`.

**C4. Owner-command arguments are raw, and the command line decides their arity.**
- Needed: `space target set --admin <url> --prefix <p>` and `space on <path>`, with a usage error when something is missing.
- Did instead: copied `read()` from `plugin-deploy/src/commands.ts`. `OwnerArgs` is `{ positional, flags }`. How a flag takes values is fixed by the CLI's table (`cli/src/args.ts:1-25`). An unknown flag takes everything up to the next flag, so a plugin's boolean flag would swallow the positional after it. `usage` is free text for help. The UI form for the same command is a separate hand-written list of `ActionInput`s (`views.ts`, `SET_TARGET`), so the CLI and the form can disagree.
- Would remove it: a declarative argument schema on `OwnerCommand` (positionals with names, flags with kind `value|list|boolean`, required or not, a pattern). The kernel would parse against it, generate the help, and generate the form inputs.

**C5. Statement kinds are a first-come global namespace.**
- Needed: `say deployable`, as the brief requires, which the built-in `deploy` also hears.
- Did instead: claimed `deployable`. The kernel routes a `say` to the first installed plugin whose `statements` include the kind (`kernel/src/agent.ts:183`). With `deploy` and `space` both installed, the one installed second never hears `say deployable`. `plugin add` does not warn. An agent's declaration then goes to whichever plugin came first, and nothing tells the agent or the owner which one.
- Would remove it: `plugin add` refuses or warns on a claimed kind. Or kinds get qualified (`say space.deployable`), with the bare kind kept as an alias only while it is unique.

**C6. A hook can say "done, but the outside step failed" only by throwing.**
- Needed: an agent's put succeeded, but PneumaSpace refused the publish. The agent should see a problem (exit 3) worded as "your put is in, the owner must run `space sync`".
- Did instead: copied the deploy plugin's trick. `onPut` throws an `Error` whose message is the whole paragraph for the agent (`src/index.ts`, `followed`). The kernel turns a throw into a problem. A success note and a problem cannot be returned together, although `onFind` can already answer `{ hits, problems }`.
- Would remove it: `onPut`, `onArchive` and `onSay` may answer `{ note, problems }`, as `onFind` can.

**C7. Reacting to `archive purge` means string-matching an owner command.**
- Needed: to drop declarations whose things the owner purged from the archive.
- Did instead: copied `purged()`. `observe` checks `event.command === 'archive purge'` and reads untyped `event.result.data.paths`. I found the shape only in `kernel/src/owner-commands.ts:188`, as `_archive/…` paths. The `Event` type says `data?: unknown`.
- Would remove it: typed kernel events for what plugins react to (`{ kind: 'purged'; paths: LibraryPath[] }`), or a hook `onPurged(paths)`.

**C8. No lifecycle hooks: a plugin never hears its own removal.**
- Needed: on `plugin remove space`, to take the sites down or at least tell the owner that they stay online.
- Did instead: nothing is possible. The `plugin remove` event goes to "the plugins installed after it" (`kernel/src/pipeline.ts:67`, read, not run), and `space` is no longer installed by then. After a remove, every PneumaSpace app the library published stays online, and no record in the library says so. The same holds for install: there is no `onAdded` to check that the target answers.
- Would remove it: `onAdded` and `onRemoving` hooks. `onRemoving` could refuse with a reason ("3 sites are online; switch them off first, or remove with --leave-online").

**C9. No place for a credential.**
- Needed: a PneumaSpace token in hosted mode (`Authorization: Bearer`). The acceptance stack runs in local mode, so I did not implement it.
- Did instead: nothing yet. The target configuration lives in `.pneuma-base/space/config.json`. That directory is declared `body`, so the sync plugin copies it to other machines. A token there would be synced. The search plugin's answer is to store the name of an environment variable (`--key-env`). That works for the CLI, but the viewer server takes the environment of whatever shell started `view`.
- Would remove it: a per-machine secret store on the context (`ctx.secrets.get(name)`, kept under `$PNEUMA_BASE_HOME`, never synced). Or a documented rule that credentials go in environment variables, with the viewer passing them through.

**C10. Small contract gaps.**
- `PluginName` is branded, and only the kernel's `pluginName()` builds it. I write `'space' as PluginName`.
- `ViewDecl.filters` and the item-panel section have no way to say "this section is slow; load it on demand".
- `ctx.dir` exists, but I only learned that the kernel creates it from `kernel/src/library.ts:59` (see D11).
- Would remove it: export the constructors with the types package. Add an optional `lazy` flag on item sections.

## kit

These are pieces every deploy plugin needs again, whatever the target. Together they are the reason the plugin is a fork of `plugin-deploy`.

**K1. The decision, the plan and the states.**
- Needed: what should be online (`want`), the steps to get there with publish before take-down (`plan`), and the six states (`statusOf`), with the state × operation table from `plugin-deploy/README.md`.
- Did instead: copied and adapted `src/model.ts`. The only real change is the content identity: PneumaSpace's bundle id (the sha256 of the tar) in place of the kernel fingerprint. That change lets me compare against what PneumaSpace really serves.
- Would remove it: a deploy kit exporting `want`/`plan`/`statusOf`, generic over the content id and the site name, with the README's table as its test.

**K2. The append-only fact store.**
- Needed: records of declare, switch, move, remove, publish and unpublish, written so that concurrent writers and sync never lose a fact.
- Did instead: copied `writeFacts` (temporary name, `link`, retry on `EEXIST`), `readFacts` (skip broken lines), the id scheme (time, writer, sequence) and `fold` with `alias` for a path declared on two machines. That is 77 lines of `src/store.ts`.
- Would remove it: `ctx.records.append(facts)` and `ctx.records.read()` from the kernel, or a kit `factStore(dir)`. Every plugin with records needs this, not only deploy plugins.

**K3. The declaration lifecycle.**
- Needed: validate `say deployable` (not archived, not absent, inside a bundle means the bundle), follow a move on `onPut`, follow archive and unarchive on `onArchive`, drop a declaration on purge, and find a declared thing by its archived path.
- Did instead: copied about 60 lines of `src/index.ts` and `declaredAt` from deploy.
- Would remove it: a kit `declarations({ kind: 'deployable' })` that owns those hooks and calls the plugin's `settle(thing)`.

**K4. The run scope and the reconcile loop.**
- Needed: read records and target once per hook, collect facts, write them in `finally`, settle one thing with stop at the first failure, check name collisions within the library, and re-read after acting.
- Did instead: adapted `withRun`, `record`, `look`, `looks` and `settle` (`src/reconcile.ts`). Mine reads PneumaSpace's live state instead of trusting the records. So `space sync` converges after a crash or after someone removed an app from the console. The deploy plugin's records-only `held` cannot see either case.
- Would remove it: a kit reconciler that takes a target adapter `{ key, publish(name, content), remove(name), serving(names) → Map<name, contentId> }`. A target that can report what it serves should get the live comparison.

**K5. The wording agents and owners read.**
- Needed: the same messages the built-in plugin gives, so that an agent's habits carry over. Examples: "这不是你的放入出了问题，你不用重做", the refusal reasons `publish-failed` / `unpublish-failed` / `no-target` / `not-declared`, and the sync summary.
- Did instead: copied them, with `deploy sync` replaced by `space sync`.
- Would remove it: kit message builders and a documented list of refusal reasons for deploy-like plugins.

**K6. The four owner commands.**
- Needed: `<name> on`, `<name> off`, `<name> sync` and `<name> target set`, with the same gates (`ownerOnly` for on, off and target; sync open to anyone; target is `setup`).
- Did instead: rewrote them from deploy's `commands.ts`. Only `target set` differs per target.
- Would remove it: the kit generates on, off and sync from the reconciler. The plugin supplies `target set`'s schema (see C4).

**K7. The sites page and the item section.**
- Needed: status tags, the meaning of each state, the switch actions (an archived thing offers no "turn on"), the table and the item fields.
- Did instead: copied `STATUS`, the meanings, `switchActions` and the page skeleton (`src/views.ts`), then added the PneumaSpace columns.
- Would remove it: a kit `sitesPage(looks, { extraColumns })` and `siteSection(look, { extraFields })`.

**K8. Target configuration storage.**
- Needed: read the target at the boundary and replace it whole.
- Did instead: copied the temporary-name-plus-rename writer and the parse-or-throw reader from deploy's `targets.ts`.
- Would remove it: `ctx.config.read(schema)` and `ctx.config.write(value)`, or one kit helper.

## build and install

**B1. No scaffold.**
- Needed: a starting layout: package, tsconfig, entry file, cognition text, tests.
- Did instead: started from an empty directory. I looked at `packages/plugin-deploy/package.json`, which depends on `"@pneuma-base/kernel": "workspace:*"`. That cannot be used outside the workspace.
- Would remove it: `npm create pneuma-base-plugin <name>` (or `pneuma-base plugin new <name>`), producing the layout below with a passing test.

**B2. A toolchain without network.**
- Needed: TypeScript and `@types/node`.
- Did instead: `npm install --offline` worked only because npm's local cache happened to hold `typescript@5.9.3` and `@types/node@26.6.10`. The plugin needs no runtime dependencies. I did not try to vendor one, because nothing says a plugin directory may hold `node_modules` (B3).
- Would remove it: a scaffold whose only dev dependency is the types package. Runtime dependencies would be either forbidden in writing or bundled by a provided build step.

**B3. What a loadable plugin directory may contain is undefined.**
- Needed: to know whether `plugins/space/` may hold more than `index.js`: sibling modules, a `package.json`, `node_modules`, a cognition `.md` file.
- Did instead: `scripts/install.sh` builds with `tsc`, then copies `dist/*.js` and writes `package.json` with `{ "type": "module" }`. It writes to a temporary name and renames it into place. The siblings load because `import()` resolves relative to `index.js` (run). I add the `package.json` so that module-type detection does not depend on whatever `package.json` happens to sit above `$PNEUMA_BASE_HOME` (inferred from Node's rules; I did not see it fail). The cognition text is inlined in `index.ts`, because the deploy plugin's `readFileSync(new URL('../cognition/…'))` would need a file layout I would have to invent.
- Would remove it: a specified layout (`index.js` plus anything beside it; `package.json` optional; dependencies bundled), and `pneuma-base plugin install <dir|tgz>` that validates and copies it.

**B4. Installing is a file copy, with no version and no reload.**
- Needed: to see which build of `space` a library runs, and to replace it safely.
- Did instead: copied files into the home. `plugin add` only edits the library configuration. `pneuma-base` shows no plugin version. A long-running `pneuma-base view` keeps the module it imported first, so after a reinstall the viewer runs the old code until restarted (inferred from `import()` caching, which `plugin-table.ts:37` relies on; not run).
- Would remove it: `plugin install`/`plugin list` showing the version from the plugin's manifest, and the viewer re-importing when the file changes, or saying that it needs a restart.

**B5. Running TypeScript sources without a build.**
- Needed: tests that import the sources directly.
- Did instead: invented a setup. Relative imports end in `.ts`, `tsconfig.json` sets `rewriteRelativeImportExtensions` and `erasableSyntaxOnly`, and Node 26 strips the types natively, so `node --test test/*.test.ts` runs with no build step while `tsc` still emits `.js` for installation. `erasableSyntaxOnly` caught a parameter property that would have broken type stripping.
- Would remove it: the scaffold ships this setup.

**B6. No harness to test against a real library.**
- Needed: a temporary home and library, owner calls and agent calls, timeouts, and a client for the viewer's HTTP API.
- Did instead: wrote `scripts/proof.sh` and `scripts/view-page.mjs`. To run owner commands as the owner, I unset six environment variables. I found their names in `kernel/src/session.ts:10-17`: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `PNEUMA_BASE_SESSION`, `ANTIGRAVITY_CONVERSATION_ID` and `ANTIGRAVITY_AGENT`. Every CLI call is wrapped in a `perl` alarm, because macOS has no `timeout`. To read a page, the viewer helper starts `view --no-open --port 0`, parses the URL and token from stdout, calls `/api/state` and `/api/view`, and kills the process. The repository's own harness (`packages/cli/test/helpers.ts`, `sandbox()`) is internal.
- Would remove it: `@pneuma-base/testkit` with `sandbox({ plugins: [dir] })`, `owner(args)`, `agent(name, session, args)`, and `viewer().view(id, params)` that starts and stops the server.

**B7. No installed command to test against.**
- Needed: `pneuma-base` on the PATH, or a package to depend on.
- Did instead: the proof defaults to `<pneuma-base 仓库>/packages/cli/dist/bin.js`, overridable with `PNEUMA_BASE_CLI`.
- Would remove it: a published CLI package that the testkit depends on.

## presentation

The page and the item section use only the existing blocks (table, fields, text, actions, section). I opened the page twice. Through the viewer's HTTP API (`scripts/view-page.mjs`), the page answers `shown` with no problems and one row per declared thing. In headless Chrome at 1280 and 760 px, it renders as expected; that screenshot was a one-off and is not in the repository. These are the things I wanted and could not express. I did not work around the viewer.

**P1. The address cannot be a link.**
The site's full URL is the most useful cell on the page, but it is plain text. `Link` can only open a view (`kernel/src/types.ts:263`), and `packages/viewer/web/src/blocks.tsx` renders no `<a href>` at all. Wanted:
```ts
address: { text: 'http://127.0.0.1:18080/apps/pbs-sites-demo/', mono: true, href: 'http://127.0.0.1:18080/apps/pbs-sites-demo/' }   // opens in a new tab, rel=noopener
```

**P2. At a narrow width the URL itself is cut.**
At 760 px the address shows as `http://127.0.0.1:18080/apps/p…`. Only the start survives, so the cell no longer tells two sites apart, and it cannot be copied whole. Wanted: a URL cell that truncates the middle (`http://127.0.0.1:18080/…/pbs-sites-demo/`) and copies on click:
```ts
{ text: url, mono: true, href: url, copy: true, truncate: 'middle' }
```

**P3. No live preview of the site.**
The `preview` block takes only a `LibraryPath`, and the viewer shows HTML as text under a sandbox CSP (by design, for library files). For a published site, I wanted the served page itself in the item panel:
```ts
{ kind: 'embed'; url: 'http://127.0.0.1:18080/apps/pbs-sites-demo/'; height: 320; sandbox: 'allow-scripts' }
```

**P4. No release history with "put this release back".**
PneumaSpace keeps every release (`GET /api/apps/<name>` → `releases[]`). A timeline block exists, but its entries cannot carry actions (`types.ts:294`: `at`, `title`, `lines`, `tag` only). So I did not build the history. Wanted:
```ts
{ kind: 'timeline', entries: [
  { at, title: { text: '第 2 版' }, lines: ['bundle 48eb8ddd…'], tag: { text: '线上', tone: 'good' }, actions: [] },
  { at, title: { text: '第 1 版' }, lines: ['bundle ec8fab9c…'], tag: null,
    actions: [{ label: '放回这一版', call: { face: 'owner', command: 'space restore', args: { positional: ['sites/demo'], flags: { release: ['1'] } } }, confirm: '把线上换回第 1 版？', … }] },
] }
```

**P5. No sparkline of requests.**
I can show only the 24-hour count as text (`requests` from `GET /api/apps`). PneumaSpace has request history (`/api/requests`, `/api/usage/apps`). Wanted, as a cell:
```ts
requests: { text: '3', spark: [0, 0, 1, 0, 2, 0, 0, …] }   // 24 hourly buckets
```

**P6. A cell holds one tag.**
I wanted my state ("在线") and PneumaSpace's own status ("registered" / "removed") side by side. `Cell.tag` is a single tag (`types.ts:269`), so PneumaSpace's status went into its own optional column. At 1280 px that column had already stepped aside, so the owner never sees it unless the window is wide. Wanted: `tags: Tag[]`, or column priorities beyond `optional`.

**P7. No deep link to a view.**
The UI keeps no route in the URL. It opens the first navigation view, which is the first installed plugin's. A CLI answer cannot say "open the PneumaSpace page", and to screenshot my page I had to make a library where `space` was the first plugin installed. Wanted: `…/?token=…#view=space.sites`, plus a way for an owner command's answer to carry a link to a view.

**P8. A network-backed page is polled every two seconds.**
The UI re-requests the page every two seconds (ARCHITECTURE.md「什么时候重取」). Each request makes my page call `GET /api/apps`, then `GET /api/apps/<name>` for each site, and rebuild every switched-on site's tar to get its bundle id. A view cannot say "refresh every 30 s" or "this is as of 12:03". Wanted:
```ts
{ title, subtitle, blocks, refresh: 30, asOf: '2026-11-26T03:12:00Z' }
```
or a kernel-provided cache keyed by the library's revision.

**P9. Form inputs cannot validate.**
The "设 PneumaSpace 目标" form takes a prefix that must match `^[a-z][a-z0-9]{0,11}$`. The input can only carry a placeholder, so a wrong value comes back as a refusal after the click. Wanted: `ActionInput.pattern` and `ActionInput.hint`, ideally generated from the command schema in C4.

**P10. An action's progress and outcome stay vague for slow calls.**
`space on` uploads a tar and waits for PneumaSpace. The action declares nothing about duration. When it is refused, the text is the owner command's whole paragraph. Wanted: actions can say `slow: true` (show progress), and refusals can carry a short title plus detail. I have not checked how the UI renders a slow call; this entry is about what an action can declare.

## docs

These are things I could learn only from kernel or built-in plugin source. Each ends with the question a specification should answer.

**D1. Placeholders in cognition text.** The deploy section writes `pneuma-base @{{授权的名字}} …`. The kernel replaces `{{授权的名字}}` with `<你的授权名>` in the description and with the grant name in a skill (`kernel/src/cognition.ts:8,29,50`). Question: *Which placeholders may a cognition section use, and what does each become in the description and in a skill?*

**D2. Owner-event payloads.** `archive purge` answers `data.paths`, a list of `_archive/…` paths (`kernel/src/owner-commands.ts:188`). Question: *Which owner commands' events carry data plugins may rely on, and in what shape?*

**D3. Which hook follows moves and archives.** ARCHITECTURE.md「插件机制」 says in passing that the deploy plugin uses `onPut`/`onArchive`, not `observe`, because only they get resolved paths. I confirmed it in `plugin-deploy/src/index.ts`. Question: *For each agent verb, which hook sees resolved paths, and in which order are `onPut`, `onArchive` and `observe` called?*

**D4. Exit codes.** A plugin's problem turns a successful verb into exit 3 (`cli/src/main.ts:126`). A refusal is 2, and a refusal with reason `usage` is 1 (deploy's `commands.ts` comment). Question: *Which outcomes map to which exit codes, and how does a plugin choose one?*

**D5. Statement routing.** First installed wins (`kernel/src/agent.ts:183`). Question: *What happens when two plugins claim the same `say` kind?* (see C5)

**D6. Who counts as an agent.** I needed the list of environment variables to run owner commands at all from a shell that an agent product started (`kernel/src/session.ts:10-17`). Question: *Exactly which signals make a call an agent's, so tests and owners can run as the owner?*

**D7. Validation of view answers.** The kernel checks only that an answer has a string `title` and an array `blocks` (`kernel/src/viewer.ts:288`). A malformed block reaches the web page unchecked. Question: *Which block fields are required, and what does the viewer do with a block it cannot render?*

**D8. What a view may do.** "视图不是操作，不改东西" (ARCHITECTURE.md「视图是只读的命令」) forbids writes. Nothing says whether a view may call the network, how long it may take, or how often it runs. Question: *May a view do I/O beyond the library, under what time limit, and at what call rate?* (see P8)

**D9. Plugin directory and module loading.** The loader imports `index.js` (`kernel/src/plugin-table.ts:31-43`). Nothing says what else may be in the directory, or when a changed file is picked up. Question: *What is the layout of `plugins/<name>/`, and when is a changed plugin reloaded?* (see B3, B4)

**D10. What makes a default export a plugin.** The exact checks are in `parsePlugin` (`kernel/src/plugin-table.ts:46-56`): the name equals the directory name, three lists, and the cognition shape. Question: *What does the loader check, and what does it leave to call time?*

**D11. Whether the kernel creates `ctx.dir`.** ARCHITECTURE.md「库外的插件与缓存」 says the kernel does not create `cacheDir`. It says nothing about `dir`. The kernel creates `.pneuma-base/<name>/` whenever the configuration is saved (`kernel/src/library.ts:59`). Question: *Does `ctx.dir` exist when a hook runs, also in a library that arrived by sync before this machine added the plugin?*

## conventions

These are rules the built-in plugins follow and nothing told me in one place. I followed every one.

**V1. Where to write.** Only under `.pneuma-base/<name>/`, each directory declared `body` or `cache`, temporary name then rename. Never touch the content or another plugin's directory. Source: ARCHITECTURE.md「库外的插件与缓存」, plus deploy's code for the temporary-name pattern.

**V2. Records are append-only.** One new file per write. It is published with `link` so that it never replaces an existing file. Ids sort by time, then writer, then sequence. Configuration is replaced whole. Source: ledger and deploy code. ARCHITECTURE.md「存放和行」 states this for the ledger alone.

**V3. Views and item sections write nothing.** My `withRun` writes facts in `finally`. A view records no facts, so the write is a no-op, but nothing enforces that. Source: ARCHITECTURE.md「视图是只读的命令」.

**V4. How to word a cognition section.** The title says what the plugin brings. The first sentence is "这个库装了**X**插件。". Do not repeat kernel rules (archive, `--include-archived`, "write outside, then put"). Use `pneuma-base @{{授权的名字}} …` in examples. Promise nothing the plugin does not do (K6). `cognition.title` (shown in the configuration list) and the section's `##` heading are different strings in deploy (`部署` against `上线：主人开关`). Source: ARCHITECTURE.md「说明和技能」 and `deploy-section.md`.

**V5. Language.** The description, every message, the view labels and the cognition text are in Chinese. Refusal reasons are English slugs. Nothing states this. I followed it: owner and agent texts are Chinese, and code and records are English.

**V6. Outward actions are owner-only.** Publishing faces outward, so `on`, `off` and `target set` are `ownerOnly`, and `sync` is open to agents because it only follows the owner's switches. Source: ARCHITECTURE.md「主人和 agent 的门」 and the deploy README.

**V7. Agent-facing failures say whose problem it is.** "It is not your put that failed; do not redo it; tell the owner." Source: deploy `index.ts`.

**V8. Anything a plugin does on the agent face must be undoable by the owner.** Source: ARCHITECTURE.md「库外的插件与缓存」. This decided a design point: the plugin only ever *removes* an app on PneumaSpace (the address answers 404, releases stay, publishing again restores it). It never *purges*. Purging stays the owner's call on PneumaSpace.

**V9. Command names start with the plugin name.** View ids must start with `<name>.`; the kernel enforces it (`viewer.ts:389-398`). Command names are not checked, but every built-in follows `<name> …`, and the kernel drops a command whose name is already taken. I named mine `space on`, `space off`, `space sync` and `space target set`.

## What was easy

**E1.** Loading worked the first time. I copied `dist/*.js` to `$PNEUMA_BASE_HOME/plugins/space/` and ran `plugin add space`, and `PNEUMA-BASE.md` was rewritten with my section. `--help --library` listed my commands with their `usage`.

**E2.** The owner gate needed no code. `space on` from an agent is refused with a clear sentence naming why (`调用者是 agent claude-code`), exit 2.

**E3.** K8 isolation. A throwing `onItemView` becomes an error section, so I deleted my own catch.

**E4.** The blocks covered the core page: a status table with a tag per row, per-row on/off buttons, a target form with inputs, a sync button and fields in the item panel. Nothing in the minimal brief needed a workaround. The list under presentation is about what comes after.

**E5.** `at` cells render the last access in the viewer's local time, with the full time on hover.

**E6.** The `Plugin` shape is small: a name plus three lists is valid, and every hook is optional.

**E7.** The behaviour was fully specified by ARCHITECTURE.md「部署」 and the state × operation table in `plugin-deploy/README.md`. I never had to guess what on, off, put, move and archive should do. That same clarity is why copying was the cheapest path (see the kit group).

**E8.** `onPut` and `onArchive` receive resolved library paths and a `moved` flag, so following a move or an archive is a lookup.

**E9.** On the PneumaSpace side, the tar is deterministic and the bundle id is its sha256. The plugin computes the id locally, compares it with what PneumaSpace serves, and uploads only when the content changed. Remove and restore are idempotent, so `space sync` is idempotent against the real stack, not only against its own records.

## PneumaSpace interface notes (for a future adapter, not Pneuma Base friction)

- The full URL is not in the API. In path mode, I combine the admin host with `ingressPort` from `/api/health`. That is a guess whenever the public host differs from the admin host.
- `GET /api/apps` lists every app on the stack. A manager cannot ask for only its own apps, so I filter by name.
- A removed app keeps its owner. I set the owner to `service:pneuma-base.<library id>` on first publish, and refuse to publish over a name whose owner differs, in any state. Without that check, publishing to a removed app that someone else owns would restore their app with my content (checked once against the stack: the foreign app stayed `removed`, with its owner and its one release).
- I did not port appctl's 30-second retry on a `503` with `Retry-After`. A failed step is a problem, and the owner reruns `space sync`.
