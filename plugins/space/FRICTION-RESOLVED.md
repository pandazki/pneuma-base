# Friction, resolved: the space plugin rebuilt on the kit

I rebuilt the `space` plugin as a third party can now build it. I used the two package files of Pneuma Base 0.9.0 (`pneuma-base-0.9.0.tgz` and `pneuma-base-sdk-0.9.0.tgz`), the project that `plugin new --kind deploy --name space` generated, the generated README, and the types and comments in `@pneuma-base/sdk`. `PLUGINS.md` did not exist when I started. I did not read Pneuma Base's source, ARCHITECTURE.md or its built-in plugins, with one counted exception (L1 below).

The plugin is the kit's `deployPlugin` with one target adapter (`src/target.ts`) and a page of its own (`src/ui/board.html`). `sh scripts/proof.sh` walks the lifecycle against the PneumaSpace acceptance stack and then runs the tests: conformance, the lifecycle with a publish cut halfway, and the viewer.

**Second round (2026-11-26).** Pneuma Base then removed the causes of N1–N11 in its kit, test kit, packages and scaffold (branch `run4/f2-refine`). I rebuilt the two package files from that branch, pointed this project at them, and deleted every workaround those changes made unnecessary: the closure that carried `serving`'s data to the views, the wrapped `onView`, the re-declared state tags and hand-built switch, reading the token around `env.secret`, and the conformance test's skip. The board is now a page of its own. Conformance runs against a PneumaSpace in memory (`test/fake-space.ts`) through the test kit's `sandbox.serve`; the lifecycle and viewer tests still run against the acceptance stack. The tests and `scripts/proof.sh` pass (run). The N entries below say what is left of each.

"Run" means I saw it happen. "Documented" means the package says so and I did not run it.

| Of the 55 entries in FRICTION.md | Count |
| --- | --- |
| gone | 42 |
| smaller | 9 (C10, B2, P5, D1, D3, D6, D8, V5, V8) |
| still there | 4 (P6, P7, P10, D4) |
| new friction | 13 (N1–N13): after the second round, 10 gone, N8 smaller, N12 by design, N13 new |
| looks into Pneuma Base's source | 1 (L1) |

## The 55 entries

### contract

- **C1** gone: `@pneuma-base/sdk` holds the types, and `Plugin`'s hooks are function-typed properties, so they are checked strictly. `src/contract.ts` and the contract check are deleted.
- **C2** gone: `contract: number` is required (`CONTRACT = 1`). `plugin install` and `plugin list` show the version and the contract (run).
- **C3** gone: `ctx.tools` has `resolve`, `thing`, `files`, `copyOut`, `fingerprint` and more, bound to the library. The kit uses them, and I wrote none of `library.ts`.
- **C4** gone: `FlagParam` with `kind`, `required` and `pattern`. The target's params make the CLI, the help line, the form and the check before `configure`. `--prefix BAD` is a usage error, exit 1, before my code runs (run).
- **C5** gone: `plugin add space` in a library with `deploy` is refused: "「说」的种类「deployable」已归插件 deploy" (run). The consequence is N12.
- **C6** gone: `onPut` and `onArchive` may answer `{ note, problems }`. A put whose publish failed answers `accepted` with the problem, exit 3 (run).
- **C7** gone: `onPurged(paths)`. The kit uses it.
- **C8** gone: `onAdd` and `onRemove`. `plugin remove space` with a site online is refused with the site and its address, and `--anyway` is offered (run).
- **C9** gone: `secrets` plus `secret set`, kept under `$PNEUMA_BASE_HOME` and never synced. The token goes out as `Authorization: Bearer` (run, through the test's proxy). The token is now declared optional (N7).
- **C10** smaller: `pluginName()` is exported, and `ctx.dir` is documented to exist. Item sections still have no `lazy` flag. Refetching only on change makes that matter less.

### kit

- **K1** gone: `want`, `plan` and `statusOf` are generic over `ContentId`. The target's `identify` gives the content id, here the bundle's sha256.
- **K2** gone: `recordStore` in the kit. The deploy kit keeps its records with it.
- **K3** gone: the kit owns `say deployable`, moves, archives and purges.
- **K4** gone: `TargetAdapter` and `Target` with `publish`, `remove` and `serving`, the shape the entry asked for. `serving` gives the live comparison, so sync repairs a cut publish and an app removed behind the plugin's back (run).
- **K5** gone: the kit words every note, refusal and sync summary (`space sync` appears in them), and exports its state tags and switch (N6).
- **K6** gone: the kit makes `space on`, `off`, `sync`, `list` and `target set`. Only the adapter's three flags are mine.
- **K7** gone: the kit's page and item section, with `TargetView` `columns`, `cells`, `fields`, `item` and `page`.
- **K8** gone: the kit stores the target in `config.json`, and `configFile` is exported.

### build and install

- **B1** gone: `plugin new --kind deploy`. It builds and passes its own tests unchanged (run). What is left of it is N8.
- **B2** smaller: esbuild bundles runtime dependencies into `dist/index.js`. The project still needs the npm registry for `esbuild`, `typescript` and `@types/node`.
- **B3** gone: `dist/` is `index.js` with `cognition.md` and `ui/` beside it, and `plugin install dist` copies it into place (run).
- **B4** gone: `plugin install` and `plugin list` show `space 0.2.0` (run). The README says an open viewer uses the new code at its next request (documented).
- **B5** gone: the scaffold ships the type-stripping setup, with a comment in `tsconfig.json`.
- **B6** gone: the test kit's `sandbox`, `owner`, `agent`, `viewer().view/item/act/get`, with clean environments and timeouts.
- **B7** gone: the command line is a package (`node_modules/.bin/pneuma-base`), and `findCli` finds it.

### presentation

- **P1** gone: `Cell.href`. The kit's address cell is a link with a copy button.
- **P2** gone: `copy: true`, and the table cuts the middle of a long address (`http://127.0.0.1:…hots-sites-notes/` in `space-item.png`).
- **P3** gone: the `embed` block. The item panel shows the served page.
- **P4** gone: timeline entries may carry actions. I drew the release history read-only on purpose, because putting an old release back is the version plugin's business.
- **P5** smaller: cells still have no sparkline. The board (`custom`) draws one per card from `GET /api/usage?app=`, which gives hourly buckets.
- **P6** still there: a cell holds one tag. It matters little now: PneumaSpace's own status is a field in the item panel, and a name owned by someone else is a tag in the release column.
- **P7** still there: I found no documented route to open a view by URL, and an owner command's answer cannot link to one. `scripts/shots.mjs` clicks the navigation entry.
- **P8** gone: a view is refetched only on change, after an action, or after its `refresh`. The kit's pages refresh every 30 seconds for a target with `serving` (N4).
- **P9** gone: `ActionInput.pattern` and `hint`, made from the params. The form carries the prefix pattern (run).
- **P10** still there: actions cannot say they are slow. It matters little here, because `space on` takes about 0.3 s on loopback.

### docs

- **D1** smaller: `RULES.cognition` says `{{授权的名字}}` is the only placeholder. What it becomes in the description and in a skill is still unwritten. I needed neither, because the kit writes the section.
- **D2** gone: `onPurged` replaces reading `archive purge`'s payload.
- **D3** smaller: the kit follows moves and archives. The order of `onPut`, `onArchive` and `observe` is still unwritten, and I needed none of them.
- **D4** still there: neither package states the exit codes. I saw usage 1, refusal 2 and problem 3. The tests read `outcome`, so it did not matter.
- **D5** gone: a claimed kind is refused at `plugin add`, naming the holder (C5).
- **D6** smaller: the sandbox's environment is the owner's. The list of agent signals is still unwritten, so `proof.sh` unsets the first version's six names.
- **D7** gone: the conformance check `blocks` holds every answer to valid blocks.
- **D8** smaller: `refresh` is documented as "for a view showing state from outside the library", so reading the network is expected. No time limit is stated.
- **D9** gone: the generated README states the layout and when a change is picked up.
- **D10** gone: the conformance checks `loads` and `names` state what the loader checks.
- **D11** gone: "The own directory exists whenever a hook runs" (`PluginContext`).

### conventions

- **V1** gone: `RULES.writes` and `RULES.cache`, checked by conformance.
- **V2** gone: `recordStore` writes one file per append. The kit uses it.
- **V3** gone: `RULES.writes` says views and item sections write nothing, and conformance checks it.
- **V4** gone: the kit writes the section. `RULES.cognition` and the reminders state the rest.
- **V5** smaller: the types say "Chinese" for hints, summaries and refusal sentences, one place at a time. No single rule covers messages and refusal slugs.
- **V6** gone: the kit makes `on`, `off` and `target set` `ownerOnly`.
- **V7** gone: the kit's agent-facing failure says whose problem it is and names `space sync` (run; the lifecycle test checks it).
- **V8** smaller: my `remove` removes and never purges. The rule that an agent-face action must be undoable by the owner is still not in the package.
- **V9** gone: `RULES.names`, enforced, and `KERNEL_COMMAND_NAMES` is exported.

### what was easy (still)

- **E1** still easy: `plugin install dist`, then `plugin add space`.
- **E2** still easy: the owner gate needs no code. An agent's `space on` exits 2.
- **E3** still documented: a hook's failure is listed as the plugin's problem (K8), not a crash.
- **E4** now the kit's: the whole core page comes from the kit.
- **E5** still easy: `at` cells show local time.
- **E6** still small: a plugin is a contract, a name and three lists.
- **E7** now the kit's: the behaviour comes with the kit, so I never needed the state table.
- **E8** now the kit's: resolved paths and moves.
- **E9** still easy: PneumaSpace's tar is deterministic, so the bundle id is known before upload, and remove and restore are idempotent.

## New friction

**N1. A target's view functions see only `Look`, synchronously.**
- **Now gone.** `serving(sites, { detail })` answers each site's content (null when not served), address and a `detail` of the target's own type, here `Seen`. `open(config, env): Target<Seen>` types every view function's `l.detail`. The types say, and the kit guarantees, that a page asks once and then draws, so the closure is deleted. The request series is fetched only when `detail` is true, so agent hooks no longer fetch it.
- Needed: release, requests, last access, the owner, the release history and the request series in the columns, the fields, the item panel and the board.
- Did instead: `serving` fetches all of it and keeps it in the opened target's closure (`seen`). The view functions read it from there. Nothing says that `serving` runs before the view functions in the same run, or that one opened `Target` lives for the whole run. I relied on both after I saw them work. `serving` also fetches the request series inside every agent hook that settles a thing, where nothing draws it.
- Would remove it: `serving` may return per-site `detail: unknown`, which the kit passes to `cells`, `fields`, `item` and `page`. Or those functions may be async and get the run's target.

**N2. A target's own page can only follow the kit's sections.**
- **Now gone.** The adapter declares `views: [{ name: 'board', … }]` and the opened target draws it in `view.pages.board`. The board is the navigation entry 看板 (`space.board`), drawn from the same looks as the kit's page (run: the viewer test and the screenshots). The kit's page could also take blocks before its sections (`view.before`); I did not need that.
- Needed: the board as its own view in the navigation, above or instead of the table.
- Did instead: the board is a `custom` block that `view.page` appends after the kit's sections. `withRun`, `looks` and `sitesPage` are declared in `kit/deploy/reconcile.d.ts`, but the exports map has only `./kit`, so no other view can get the looks.
- Would remove it: `TargetView.views: { id, title, icon, page(all) }[]`, or an exported `looks(ctx)`.

**N3. Conformance needs a reachable target.**
- **Now gone.** The test kit's `sandbox.serve(handler)` starts a local server and stops it with the sandbox. Conformance sets the target to a PneumaSpace in memory and switches a site on, so the views are checked with an app online. It passes with `SPACE_ADMIN` pointed at a dead port, while the lifecycle and viewer tests skip (run). No `pbs-` prefix to purge.
- Needed: the conformance check in a run where PneumaSpace is down.
- Did instead: with the target unreachable, `examples` fails (`space sync` exits 2) and `hooks` fails (an archive's problem). The test kit offers `bin` stand-ins for commands but nothing for an HTTP service. The conformance test skips, saying why, when the stack does not answer. With the stack up it passes. Its scripted run reaches the target, so the test gives it a fresh `pbs-` prefix and purges it after.
- Would remove it: a deploy-kit stand-in target for conformance, or a way to declare which problems are the outside service's.

**N4. The kit's page cannot declare `refresh`.**
- **Now gone.** The kit's pages declare `refresh: 30` for a target with `serving`, and `view.refresh` overrides it. The wrapped `onView` is deleted; the viewer test still asserts 30 on both pages.
- Needed: the page to ask again every 30 seconds, as the note on the new refetch rule says.
- Did instead: `src/index.ts` spreads the kit's plugin and wraps `onView` to add `refresh: 30`.
- Would remove it: `DeployOptions.refresh`, or a default `refresh` from the kit when the target has `serving`.

**N5. The frame kit's API is not in the package.**
- **Now gone.** `@pneuma-base/sdk/frame` declares `window.pneuma` (`onData` and what it receives, `run`, `open`) and lists the classes and tokens in its comments. The generated panels use all three calls.
- Needed: how a custom page runs one of its block's actions, how it opens a link, how its height is set, and which classes match the UI.
- Did instead: read the served `/plugin-kit/frame.js` and `frame.css` (L1). Both point to "ARCHITECTURE section 6", which no package contains.
- Would remove it: a `frame.d.ts` in the sdk (`window.pneuma.onData`, `run`, `open`) and the list of component classes in the generated README.

**N6. The kit's state words and switch action are not exported.**
- **Now gone.** `STATUS` and `switchAction(plugin, look)` come from `@pneuma-base/sdk/kit`; `env.plugin` names the plugin. The 16 re-declared lines are deleted. The viewer test still asserts that the board's switch equals the table's.
- Needed: the same state tags and the same switch as the kit's table, on the board.
- Did instead: re-declared the seven tags (the only copied lines in `src/`) and built the switch `Action` by hand. The viewer test asserts that it equals the table row's action.
- Would remove it: export `STATUS` and a `switchAction(look)`, or pass the kit's actions per thing to `page`.

**N7. An optional secret is announced as required.**
- **Now gone.** The secret is declared `optional: true`. `target set` answers "可选的密钥 token 没设（…）；要用时：pneuma-base secret set space token。" (run), `secret list` lists it as optional, and `env.secret('token')` reads null while it is unset and is typed `string | null`.
- Needed: `token` only for a PneumaSpace that is not in local mode.
- Did instead: `target set` answers "这个目标要用密钥 token，还没设". `TargetEnv.secret` rejects when it is unset, so I read the token through `env.ctx.secrets.get`.
- Would remove it: `SecretDecl.optional`, with the wording following it.

**N8. The generated project assumes it stays where it was made.**
- **Now smaller.** `plugin new` writes absolute `file:` paths, and the scaffold's slow test moves the project before installing it. `plugin new --help` prints the scaffold's usage (run). The generated README points to `node_modules/pneuma-base/PLUGINS.md`, which another change ships. Still there: npm 11 warns that esbuild's postinstall is not allowed, and this project's paths now name the worktree the package files were built in.
- Needed: to move the generated project into this repository.
- Did instead: rewrote the `file:../../../../…` dependency paths in `package.json` to absolute ones. The generated README names ARCHITECTURE.md §5 as the standard. `plugin new --help` prints the general help. npm 11 warns that esbuild's postinstall is not allowed, and the build works anyway.
- Would remove it: absolute `file:` paths or a `--packages` copy into the project, and the README pointing to a standard that ships in a package.

**N9. A bare sandbox refuses a put over existing content.**
- **Now gone** (documented): `SandboxOptions.bare` says that a bare library refuses a put over different content (`would-overwrite`), and what else it lacks.
- Needed: to republish a demo site in the screenshot script.
- Did instead: found by running that `bare: true` has no plugin with `revise`, so the second put is `would-overwrite`. The script uses the default library and clicks to the page instead.
- Would remove it: one sentence on `SandboxOptions.bare`.

**N10. `viewer.item(path)` answers the whole panel.**
- **Now gone.** `viewer.item(path, { plugin: 'space' })` gives only this plugin's section and problems. The kernel stamps each plugin's section with its name. The title filter is deleted.
- Needed: my section's blocks.
- Did instead: the viewer test filters by the section title. The ledger's timeline came first and failed a check once.
- Would remove it: `item(path, { plugin })`, or sections stamped with their plugin.

**N11. Per-site data is keyed by site, and `Look.site` is null while archived.**
- **Now gone.** A look's `detail` is the one for the site it is served under, else for the name its path has or had, so an archived or retiring thing has its data. The fallback to `held` is deleted.
- Needed: the data of an archived or retiring thing.
- Did instead: fell back to the first site in `held`.
- Would remove it: N1's `detail` passed per thing.

**N12. A library holds one deploy plugin.**
- **Still there, by design.** ARCHITECTURE.md section 13 now says so: one deploy plugin per library, and several kinds of target in one plugin when sites go to several places.
- Needed: nothing yet, but `space` and the built-in `deploy` both claim `deployable`, so a library cannot use both (C5).
- Did instead: nothing. The kit's way is one plugin with several adapters, and a third party cannot add an adapter to the built-in `deploy`.
- Would remove it: say this in the standard, or let a library choose the deploy plugin that hears `deployable`.

**N13. A view's icon is one of a list nobody gives.** (Second round.)
- Needed: an icon for the board's navigation entry.
- Did instead: `layout-dashboard` showed a puzzle piece in the screenshot. The viewer knows a fixed set of lucide names, and `ViewDecl.icon` says only "a lucide icon name". I picked `layout-grid`, which is in the set.
- Would remove it: the set listed in the sdk, or any lucide name accepted.

## Looks into Pneuma Base's source

**L1. `/plugin-kit/frame.js` and `/plugin-kit/frame.css`, as the viewer serves them.** I needed to know how a custom page asks to run one of its block's actions, whether it can open a link, whether its height is fixed, how it follows light and dark, and which classes it may use. The package says only "sent `data` and the names of `actions`, which it may ask to run", and the generated `panel.html` shows only `pneuma.onData`. The files answer all of it: `pneuma.onData(cb(data, { scheme, actions }))`, `pneuma.run(name, values)`, `pneuma.open(link | url)`, a height reported on every resize, the UI's tokens set on the root, and `.card .btn .tag .tone-* .muted .faint .mono .link .field .segmented .select`.

In the second round this look is no longer needed: `@pneuma-base/sdk/frame` gives the same answers in the package.

What I found by running rather than reading, each a question for the standard: whether `serving` runs before the view functions (N1); whether the kit's page sets `refresh` (no); the shape of the kit's switch action (`confirm: null`); the exit codes (D4); that a bare library refuses a put over content (N9); that a claimed kind is refused (C5).

## The numbers

Lines are non-blank lines.

| | First version | Rebuilt on the kit | After the second round |
| --- | --- | --- | --- |
| TypeScript source | 979 in 9 files | 421 in 4 files | 397 in 4 files |
| About the target | about 190 (`space.ts` 146, the live reading, the columns) | 376: `space.ts` 164, `target.ts` 98, `views.ts` 114 | 376: `space.ts` 164, `target.ts` 93, `views.ts` 119 |
| The rest | about 790, a fork of `plugin-deploy` | 45: `index.ts` 29, the re-declared tags and switch in `views.ts` 16 | 21: `index.ts`, the `deployPlugin` call and reading `cognition.md` |
| Also | | `ui/board.html` 248 (the board, new), `cognition.md` 6 | `ui/board.html` 249, `cognition.md` 6 |
| Copied from Pneuma Base, verbatim / after renames | 322 / 362 of 979 | 18 / 19 of 675 | 12 / 13 of 652 |
| Tests and scripts | `model.test.ts`, `proof.sh`, `view-page.mjs`, a contract check | conformance 28, lifecycle 144, viewer 92, stack 29; `proof.sh` 91, `shots.mjs` 138 | conformance 33, fake-space 47, lifecycle 144, viewer 89, stack 29; `proof.sh` 91, `shots.mjs` 141 |
| Looks into Pneuma Base's source | many (every "read" in FRICTION.md) | 1 (L1) | 1 (L1, no longer needed) |

The copied counts come from `PNEUMA_BASE_REPO=… node scripts/count-copied.mjs`. It compares every file of `src/` with the eleven sources the first version copied from, read as they were at `e864a12`, the commit that version was built against. The first version gives 322 here against 316 in FRICTION.md, because every file is now compared with every source. Of the 18 lines in the first rebuild, six were the re-declared state tags (N6). The 12 now are generic lines such as imports, `return {`, `kind: 'section',` and `} catch {`.

In the second round `target.ts` lost the closure and the fallback and gained the `detail` and the board's declaration; `views.ts` lost the tags and the switch and gained the board's typed looks; `index.ts` lost the wrapper. The lines beyond the target are now the 21 of `index.ts`, which `plugin new` writes nearly as they are.
