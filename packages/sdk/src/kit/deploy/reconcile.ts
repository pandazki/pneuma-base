// The reconciler: for a declared thing, read what the library has and what the target holds, decide
// (model.ts), and do the difference. Every hook and command runs it for the things it touched. What
// the library has comes through the context's tools, in storage's words (content.ts).
import { join } from 'node:path'
import type { LibraryPath, PluginContext, PluginName, PluginTools } from '../../types.js'
import { configFile } from '../config-file.js'
import { recordStore, type RecordStore, type Skipped } from '../records.js'
import { changing, fingerprintOf, NotStaged, withStaged, type ThingKind } from './content.js'
import { foldedRecords } from './folded.js'
import { apply, parseFact, type Declared, type Deployments, type Fact, type FactBody, type OnTarget, type TargetKey, type ThingId } from './facts.js'
import { plan, siteName, statusOf, want, type ContentId, type SiteName } from './model.js'
import type { Look, Served, Target, TargetAdapter, TargetConfig, TargetEnv } from './target.js'

/** What the kit was made with: the plugin's name, its title for people, and the kinds of target it can publish to. */
export type Kit = { readonly name: PluginName; readonly title: string; readonly targets: readonly TargetAdapter[] }

/** The kit's one kind of target, when it has only one: then `--kind` may be left out. */
export const onlyTarget = (kit: Kit): TargetAdapter | null => (kit.targets.length === 1 ? (kit.targets[0] ?? null) : null)

/**
 * One hook's, command's or view's work: the records as read, the target and how it was set, and the
 * facts it adds, written as one file at the end. `view`: it draws a page or the item panel, so looks
 * carry the target's details.
 */
export type Run = { kit: Kit; ctx: PluginContext; store: RecordStore<FactBody>; d: Deployments; skipped: Skipped[]; target: Target | null; set: SetAs | null; facts: Fact[]; view: boolean }

/** The flags `target set` was given, `--kind` and the secret aside: what changing one of them sends again. */
export type Given = Readonly<Record<string, string | readonly string[] | true>>
/** How the target was set: its kind, and the flags it was given (none for a file an earlier version wrote). */
export type SetAs = { readonly kind: string; readonly given: Given }

/** The configuration file as stored: the target's own configuration with the kind of target it is, and the flags it was set with. */
export type StoredTarget = { format: 1; target: TargetConfig & { kind: string }; given?: Given }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isGivenValue = (v: unknown) => typeof v === 'string' || v === true || (Array.isArray(v) && v.every((w) => typeof w === 'string'))

function parseStored(raw: unknown): StoredTarget {
  if (!isObject(raw) || !isObject(raw.target) || typeof raw.target.kind !== 'string') throw new Error('not a target configuration')
  const given = isObject(raw.given) && Object.values(raw.given).every(isGivenValue) ? { given: raw.given as Given } : {}
  return { format: 1, target: raw.target as StoredTarget['target'], ...given }
}

export const targetFile = (ctx: PluginContext) => configFile(ctx, 'config.json', parseStored)
const stageRoot = (ctx: PluginContext) => join(ctx.cacheDir, 'stage')

/** The adapter for a stored kind: the one of that kind, else the one that had it before a rename. */
export const adapterOf = (kit: Kit, kind: string): TargetAdapter | undefined => kit.targets.find((t) => t.kind === kind) ?? kit.targets.find((t) => t.formerly?.includes(kind))

/** The target a stored configuration opens: by its kind, through that adapter's own parser. */
export function openTarget(kit: Kit, stored: StoredTarget['target'], ctx: PluginContext): Target {
  const adapter = adapterOf(kit, stored.kind)
  if (!adapter) throw new Error(`unknown kind of target: ${stored.kind}`)
  // `secretOf` gives null only for an optional secret, as `TargetEnv['secret']` types it per name.
  const secret = ((name: string) => secretOf(kit, adapter, ctx, name)) as TargetEnv['secret']
  return adapter.open({ ...stored, kind: adapter.kind }, { ctx, scratch: stageRoot(ctx), plugin: kit.name, secret })
}

/** The command that sets a secret of the plugin, for the owner to type. */
export const setSecret = (kit: Kit, name: string) => `pneuma-base secret set ${kit.name} ${name}`

/** A secret the adapter declares, as the owner set it on this machine; a target cannot go on without a required one that is not set. */
async function secretOf(kit: Kit, adapter: TargetAdapter, ctx: PluginContext, name: string): Promise<string | null> {
  const declared = adapter.secrets?.find((s) => s.name === name)
  if (declared === undefined) throw new Error(`the ${adapter.kind} target reads a secret it does not declare: ${name}`)
  const value = await ctx.secrets.get(name)
  if (value === null && declared.optional !== true) throw new Error(`未设置密钥 ${name}：用 ${setSecret(kit, name)} 设置，值从标准输入读取`)
  return value
}

async function configured(kit: Kit, ctx: PluginContext): Promise<{ target: Target; set: SetAs } | null> {
  try {
    const stored = await targetFile(ctx).read()
    return stored && { target: openTarget(kit, stored.target, ctx), set: { kind: adapterOf(kit, stored.target.kind)?.kind ?? stored.target.kind, given: stored.given ?? {} } }
  } catch {
    throw new Error(`无法解析部署目标的配置：.pneuma-base/${kit.name}/config.json`)
  }
}

/** Ends an opened target's run. What its `close` throws is ignored: a failed sign-out does not change an answer. */
export async function closeTarget(target: Target | null): Promise<void> {
  try {
    await target?.close?.()
  } catch {
    return
  }
}

/** The plugin's records: the store `facts` of its record place, where the kit always kept them, folded into rows (folded.ts). */
export const factsOf = (ctx: PluginContext): RecordStore<FactBody> => recordStore(ctx, 'facts', parseFact)

/** Loads the records and the target, runs `body`, writes the facts it added and closes the target, also when it throws. `view`: it draws a page or the item panel. */
export async function withRun<T>(kit: Kit, ctx: PluginContext, body: (run: Run) => Promise<T>, view = false): Promise<T> {
  const set = await configured(kit, ctx)
  const target = set?.target ?? null
  try {
    const store = factsOf(ctx)
    const { d, skipped } = await foldedRecords(ctx, store)
    const run: Run = { kit, ctx, store, d, skipped, target, set: set?.set ?? null, facts: [], view }
    try {
      return await body(run)
    } finally {
      await store.append(run.facts)
    }
  } finally {
    await closeTarget(target)
  }
}

/** Adds a fact to the run and to its view of the records. */
export function record(run: Run, body: FactBody): void {
  const f = run.store.stamp(run.ctx, body)
  apply(run.d, f)
  run.facts.push(f)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The site name a library path has on the configured target; the default rule without one. */
const nameOf = (run: Run, path: LibraryPath): SiteName => run.target?.siteName?.(path) ?? siteName(path)

/** What each path holds as a thing, from one glance: a file or a bundle, or null. */
export async function thingsAt(tools: PluginTools, paths: readonly LibraryPath[]): Promise<(ThingKind | null)[]> {
  if (paths.length === 0) return []
  return (await tools.what(paths)).map((at) => (at.kind === 'file' || at.kind === 'bundle' ? at.kind : null))
}

/**
 * The content id of the thing at a path: the target's own when it has one, from a copy of the files
 * (every byte read and copied, each time); else the fingerprint storage gives (read now, unless storage
 * knows it already). Throws `NotStaged` when the content cannot be told now.
 */
async function contentAt(run: Run, path: LibraryPath, kind: ThingKind | null): Promise<ContentId | null> {
  const { target, ctx } = run
  if (kind === null) return null
  const { identify } = target ?? {}
  if (!identify) return (await fingerprintOf(ctx.tools.storage, path)) as ContentId | null
  return withStaged(ctx.tools.storage, path, kind, stageRoot(ctx), (staged) => identify(staged.files))
}

/**
 * Rows of the bundles' content as last identified, by path: the deep token storage gave just before
 * (every file's state), the content id, and what identified it (the target's key, or `fingerprint`).
 * A cache: without a row, the content is read.
 */
const IDENTIFIED = 'identified'
type IdentifiedRow = { deep: string; content: ContentId; by: string }
const LOOK_PAGE = 1000

/**
 * The bundles whose every file storage says is as it was when their content was last identified, with
 * that content id; and the deep token now of each of the others, taken before their content is read.
 */
async function identifiedBefore(run: Run, paths: readonly LibraryPath[]): Promise<{ same: Map<LibraryPath, ContentId>; deep: Map<LibraryPath, string>; by: string }> {
  const { storage } = run.ctx.tools
  const by = run.target?.identify ? `target:${run.target.key}` : 'fingerprint'
  const same = new Map<LibraryPath, ContentId>()
  const deep = new Map<LibraryPath, string>()
  for (let i = 0; i < paths.length; i += LOOK_PAGE) {
    const page = paths.slice(i, i + LOOK_PAGE)
    const rows = new Map((await storage.records.get<IdentifiedRow>(IDENTIFIED, page)).rows.filter((r) => r.value.by === by).map((r) => [r.key, r.value]))
    const looked = await storage.look(page.map((place) => ({ place, token: rows.get(place)?.deep ?? 'empty' })), { deep: true })
    const differ = new Set<string>([...looked.changed.map((c) => c.place), ...looked.gone, ...looked.failed.map((f) => f.place), ...looked.held])
    for (const c of looked.changed) if (c.deep !== undefined) deep.set(c.place as LibraryPath, c.deep)
    for (const place of page) {
      const row = rows.get(place)
      if (row !== undefined && !differ.has(place)) same.set(place, row.content)
    }
  }
  return { same, deep, by }
}

/** What the records say the current target holds for a thing. */
function recorded(run: Run, id: ThingId): Map<SiteName, OnTarget> {
  const sites = run.target ? run.d.sites.get(run.target.key as TargetKey) : undefined
  return new Map([...(sites ?? [])].filter(([, s]) => s.thing === id))
}

/** A site a thing holds on the target: the content served there and where. */
type OnSite = { readonly content: ContentId; readonly url: string | null }
/**
 * A look and the address of each site it holds, which a target that reports may tell apart from the
 * records; `refused`, why its content could not be told now, so nothing is published or taken down for it.
 */
type Seen = Look & { sites: ReadonlyMap<SiteName, OnSite>; refused: string | null }

/** Reads without changing anything. */
export async function look(run: Run, id: ThingId): Promise<Seen> {
  return (await lookAll(run, [id]))[0] as Seen
}

/** Every declared thing as it stands, by path, the archived ones last. */
export async function looks(run: Run): Promise<Seen[]> {
  const key = (path: LibraryPath) => `${run.ctx.tools.regionOf(path) === 'archive' ? 1 : 0}${path}`
  return lookAll(run, [...run.d.things.values()].sort((a, b) => (key(a.path) < key(b.path) ? -1 : 1)).map((t) => t.id))
}

/**
 * The things as they stand. The content is identified only when it can matter: switched on and not
 * archived. A target that reports is asked once, about the name each thing's path has (for an
 * archived thing, the path it had) and the names the records give it; of those, a thing holds the
 * ones the target serves, leaving out a name the records give another declared thing.
 */
async function lookAll(run: Run, ids: readonly ThingId[]): Promise<Seen[]> {
  const { tools } = run.ctx
  const { target } = run
  const holders = target ? run.d.sites.get(target.key as TargetKey) : undefined
  const things = ids.map((id) => run.d.things.get(id) as Declared)
  // The content matters only for what is switched on and not archived; one glance says what those paths hold.
  const counted = things.filter((t) => t.on && tools.regionOf(t.path) !== 'archive')
  const kinds = new Map((await thingsAt(tools, counted.map((t) => t.path))).map((kind, i) => [(counted[i] as Declared).id, kind]))
  // A bundle's content is read only when a file in it is not as it was when it was last identified.
  const bundles = await identifiedBefore(run, counted.filter((t) => kinds.get(t.id) === 'bundle').map((t) => t.path))
  const identified: { key: string; value: IdentifiedRow }[] = []
  const parts = []
  for (const thing of things) {
    const id = thing.id
    const archived = tools.regionOf(thing.path) === 'archive'
    let content: ContentId | null = null
    let refused: string | null = null
    try {
      if (kinds.has(id)) content = bundles.same.get(thing.path) ?? (await contentAt(run, thing.path, kinds.get(id) ?? null))
      const deep = bundles.deep.get(thing.path)
      if (content !== null && deep !== undefined) identified.push({ key: thing.path, value: { deep, content, by: bundles.by } })
    } catch (error) {
      if (!(error instanceof NotStaged)) throw error
      refused = error.message
    }
    const standing = { on: thing.on, archived, content }
    const original = archived ? tools.originalPath(thing.path) : thing.path
    const named = original === null ? null : nameOf(run, original)
    const mine = recorded(run, id)
    const ours = (name: SiteName) => {
      const holder = holders?.get(name)?.thing
      return holder === undefined || holder === id || !run.d.things.has(holder)
    }
    const names = [...new Set([...(named === null ? [] : [named]), ...mine.keys()])].filter(ours)
    parts.push({ thing, standing, archived, named, mine, names, refused })
  }
  if (identified.length > 0) await tools.storage.records.put({ [IDENTIFIED]: identified })
  let answer: ReadonlyMap<SiteName, Served> | null = null
  let unreachable: string | null = null
  const asked = [...new Set(parts.flatMap((p) => p.names))]
  // Nothing to ask about is no reason to reach the target.
  if (target?.serving && asked.length > 0) {
    try {
      answer = await target.serving(asked, { detail: run.view })
    } catch (error) {
      unreachable = messageOf(error)
    }
  }
  return parts.map(({ thing, standing, archived, named, mine, names, refused }) => {
    const told = (name: SiteName | null | undefined) => (name != null && names.includes(name) ? answer?.get(name) : undefined)
    const sites = new Map<SiteName, OnSite>(
      answer === null
        ? [...mine].map(([site, s]) => [site, { content: s.content, url: s.url }])
        : names.flatMap((name) => {
            const s = told(name)
            return s?.content == null ? [] : [[name, { content: s.content, url: s.url }]]
          }),
    )
    const held = new Map([...sites].map(([site, s]) => [site, s.content]))
    const site = archived ? null : named
    const shown = site !== null && sites.has(site) ? site : [...sites.keys()][0]
    // Content that cannot be told now is wanted online and is not: pending.
    const status = unreachable !== null ? 'unknown' : refused !== null ? 'pending' : statusOf(site, standing, held)
    const detail = run.view ? (told(shown)?.detail ?? told(named)?.detail ?? null) : null
    return { thing, standing, held, status, site, url: (shown === undefined ? undefined : sites.get(shown))?.url ?? null, unreachable, detail, sites, refused }
  })
}

/** The library path an input names: the thing itself, or the bundle it lies in. Null outside the content and the archive. */
export async function thingPath(tools: PluginTools, input: string): Promise<LibraryPath | null> {
  const r = await tools.resolve(input)
  return r === null || r.region === 'kernel' ? null : (r.bundle ?? r.path)
}

/** The declared thing an input names: by its path, or for an archived thing also by the path it had. */
export async function declaredAt(run: Run, input: string): Promise<ThingId | null> {
  const { tools } = run.ctx
  const path = await thingPath(tools, input)
  if (path === null) return null
  return run.d.byPath.get(path) ?? (tools.regionOf(path) === 'content' ? run.d.byPath.get(tools.archivedPath(path)) : undefined) ?? null
}

export type Done = { kind: 'publish'; site: SiteName; url: string | null } | { kind: 'unpublish'; site: SiteName }
/** `no-target`: something had to change and no target is set. `failed`: the target refused a step, or could not say what it serves; later steps were not tried. */
type Problem = { kind: 'no-target' } | { kind: 'failed'; message: string }
export type Settled = Look & { done: Done[]; problem: Problem | null }

/**
 * Brings the records in line with what a target that reports serves for a thing: a publish that
 * reached the target before the fact was written, or a site taken down behind the plugin's back.
 */
function adopt(run: Run, id: ThingId, seen: Seen): void {
  const { target } = run
  if (!target?.serving) return
  const key = target.key as TargetKey
  const mine = recorded(run, id)
  for (const [site, s] of seen.sites) if (mine.get(site)?.content !== s.content) record(run, { kind: 'publish', thing: id, target: key, site, fingerprint: s.content, url: s.url })
  for (const site of mine.keys()) if (!seen.sites.has(site)) record(run, { kind: 'unpublish', thing: id, target: key, site })
}

/** Makes the target hold what is wanted for one thing, recording each step the target did. */
export async function settle(run: Run, id: ThingId): Promise<Settled> {
  const before = await look(run, id)
  const stop = before.unreachable ?? before.refused
  if (stop !== null) return { ...before, done: [], problem: { kind: 'failed', message: stop } }
  adopt(run, id, before)
  const steps = plan(want(before.site, before.standing), before.held)
  if (steps.length === 0) return { ...before, done: [], problem: null }
  const { target } = run
  if (target === null) return { ...before, done: [], problem: { kind: 'no-target' } }
  const key = target.key as TargetKey
  const done: Done[] = []
  let problem: Problem | null = null
  for (const step of steps) {
    try {
      if (step.kind === 'publish') {
        const holder = run.d.sites.get(key)?.get(step.site)?.thing
        const other = holder === undefined || holder === id ? undefined : run.d.things.get(holder)
        if (other) throw new Error(`站点名称 ${step.site} 已被 ${other.path} 占用`)
        const { url } = await publish(run, target, before.thing.path, step.site, step.content)
        record(run, { kind: 'publish', thing: id, target: key, site: step.site, fingerprint: step.content, url })
        done.push({ kind: 'publish', site: step.site, url })
      } else {
        await target.remove(step.site)
        record(run, { kind: 'unpublish', thing: id, target: key, site: step.site })
        done.push({ kind: 'unpublish', site: step.site })
      }
    } catch (error) {
      problem = { kind: 'failed', message: messageOf(error) }
      break
    }
  }
  return { ...(await look(run, id)), done, problem }
}

/**
 * Takes down the sites on the current target that no declared thing owns, such as those of a
 * declaration purged with the archive. A target that reports is asked first; a site it does not
 * serve is only recorded as down.
 */
export async function sweep(run: Run): Promise<{ done: Done[]; failed: { site: SiteName; message: string }[] }> {
  const { target } = run
  const out: Awaited<ReturnType<typeof sweep>> = { done: [], failed: [] }
  if (target === null) return out
  const key = target.key as TargetKey
  const orphans = [...(run.d.sites.get(key) ?? [])].filter(([, s]) => !run.d.things.has(s.thing))
  if (orphans.length === 0) return out
  let serving: ReadonlyMap<SiteName, Served> | null
  try {
    serving = target.serving ? await target.serving(orphans.map(([site]) => site), { detail: false }) : null
  } catch (error) {
    return { done: [], failed: orphans.map(([site]) => ({ site, message: messageOf(error) })) }
  }
  for (const [site, s] of orphans) {
    try {
      if (serving === null || serving.get(site)?.content != null) {
        await target.remove(site)
        out.done.push({ kind: 'unpublish', site })
      }
      record(run, { kind: 'unpublish', thing: s.thing, target: key, site })
    } catch (error) {
      out.failed.push({ site, message: messageOf(error) })
    }
  }
  return out
}

/**
 * Copies the files the thing's content counts to a fresh directory in the cache (a single file keeps
 * its name; a bundle's are its manifest's), checks they are the content decided on, and hands that
 * directory to the target.
 */
async function publish(run: Run, target: Target, path: LibraryPath, site: SiteName, content: ContentId): Promise<{ url: string | null }> {
  const [kind] = await thingsAt(run.ctx.tools, [path])
  if (kind === null || kind === undefined) throw changing(path)
  return withStaged(run.ctx.tools.storage, path, kind, stageRoot(run.ctx), async (staged) => {
    if ((target.identify ? await target.identify(staged.files) : staged.fingerprint) !== content) throw changing(path)
    return target.publish(site, staged.dir, { content, path, at: run.ctx.now, files: staged.files })
  })
}
