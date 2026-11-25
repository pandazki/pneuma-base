// The reconciler: for a declared thing, read what the library has and what the target holds, decide
// (model.ts), and do the difference. Every hook and command runs it for the things it touched. What
// the library has comes through the context's tools, so the kit runs the running kernel's own code.
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { LibraryPath, PluginContext, PluginName, PluginTools } from '../../types.js'
import { configFile } from '../config-file.js'
import { recordStore, type RecordStore, type Skipped } from '../records.js'
import { apply, fold, parseFact, type Declared, type Deployments, type Fact, type FactBody, type OnTarget, type TargetKey, type ThingId } from './facts.js'
import { plan, siteName, statusOf, want, type ContentId, type SiteName } from './model.js'
import type { Look, Served, SiteFile, Target, TargetAdapter, TargetConfig } from './target.js'

/** What the kit was made with: the plugin's name, its title for people, and the kinds of target it can publish to. */
export type Kit = { readonly name: PluginName; readonly title: string; readonly targets: readonly TargetAdapter[] }

/** The kit's one kind of target, when it has only one: then `--kind` may be left out. */
export const onlyTarget = (kit: Kit): TargetAdapter | null => (kit.targets.length === 1 ? (kit.targets[0] ?? null) : null)

/** One hook's or command's work: the records as read, the target, and the facts it adds, written as one file at the end. */
export type Run = { kit: Kit; ctx: PluginContext; store: RecordStore<FactBody>; d: Deployments; skipped: Skipped[]; target: Target | null; facts: Fact[] }

/** The configuration file as stored: the target's own configuration, with the kind of target it is. */
type StoredTarget = { format: 1; target: TargetConfig & { kind: string } }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseStored(raw: unknown): StoredTarget {
  if (!isObject(raw) || !isObject(raw.target) || typeof raw.target.kind !== 'string') throw new Error('not a target configuration')
  return { format: 1, target: raw.target as StoredTarget['target'] }
}

export const targetFile = (ctx: PluginContext) => configFile(join(ctx.dir, 'config.json'), parseStored)
const stageRoot = (ctx: PluginContext) => join(ctx.cacheDir, 'stage')

/** The target a stored configuration opens: by its kind, through that adapter's own parser. */
export function openTarget(kit: Kit, stored: StoredTarget['target'], ctx: PluginContext): Target {
  const adapter = kit.targets.find((t) => t.kind === stored.kind)
  if (!adapter) throw new Error(`unknown kind of target: ${stored.kind}`)
  return adapter.open(stored, { ctx, scratch: stageRoot(ctx) })
}

async function configured(kit: Kit, ctx: PluginContext): Promise<Target | null> {
  try {
    const stored = await targetFile(ctx).read()
    return stored && openTarget(kit, stored.target, ctx)
  } catch {
    throw new Error(`部署目标的配置读不懂：.pneuma-base/${kit.name}/config.json`)
  }
}

/** Loads the records and the target, runs `body`, and writes the facts it added, also when it throws. */
export async function withRun<T>(kit: Kit, ctx: PluginContext, body: (run: Run) => Promise<T>): Promise<T> {
  const target = await configured(kit, ctx)
  const store = recordStore(join(ctx.dir, 'facts'), parseFact)
  const { records, skipped } = await store.read()
  const run: Run = { kit, ctx, store, d: fold(records), skipped, target, facts: [] }
  try {
    return await body(run)
  } finally {
    await store.append(run.facts)
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

/** The thing's files as its site serves them, sorted by the UTF-8 bytes of their paths; null when nothing is at the path. */
async function siteFiles(tools: PluginTools, path: LibraryPath): Promise<SiteFile[] | null> {
  const files = await tools.files(path)
  if (files !== null) return files.map((f) => ({ path: f.path, abs: join(tools.abs(path), f.path) }))
  return (await tools.thing(path)) ? [{ path: posix.basename(path), abs: tools.abs(path) }] : null
}

/** The content id of what is at a path: the target's own when it has one, else the kernel fingerprint. */
async function contentAt(run: Run, path: LibraryPath): Promise<ContentId | null> {
  const { target } = run
  if (!target?.identify) return (await run.ctx.tools.fingerprint(path)) as ContentId | null
  const files = await siteFiles(run.ctx.tools, path)
  return files && target.identify(files)
}

/** What the records say the current target holds for a thing. */
function recorded(run: Run, id: ThingId): Map<SiteName, OnTarget> {
  const sites = run.target ? run.d.sites.get(run.target.key as TargetKey) : undefined
  return new Map([...(sites ?? [])].filter(([, s]) => s.thing === id))
}

/**
 * What a target that reports serves for a thing: of the name its path has and the names the records
 * give it, those the target serves, leaving out a name the records give another declared thing.
 */
async function served(run: Run, serving: NonNullable<Target['serving']>, id: ThingId, path: LibraryPath, mine: Map<SiteName, OnTarget>): Promise<Map<SiteName, Served>> {
  const { tools } = run.ctx
  const original = tools.regionOf(path) === 'archive' ? tools.originalPath(path) : path
  const names = [...new Set([...(original === null ? [] : [nameOf(run, original)]), ...mine.keys()])]
  const answer = await serving(names)
  const holders = run.target ? run.d.sites.get(run.target.key as TargetKey) : undefined
  const out = new Map<SiteName, Served>()
  for (const name of names) {
    const s = answer.get(name)
    const holder = holders?.get(name)?.thing
    if (s !== undefined && (holder === undefined || holder === id || !run.d.things.has(holder))) out.set(name, s)
  }
  return out
}

/** A look and the address of each site it holds, which a target that reports may tell apart from the records. */
type Seen = Look & { sites: ReadonlyMap<SiteName, Served> }

/** Reads without changing anything. The content is identified only when it can matter: switched on and not archived. */
export async function look(run: Run, id: ThingId): Promise<Seen> {
  const thing = run.d.things.get(id) as Declared
  const archived = run.ctx.tools.regionOf(thing.path) === 'archive'
  const standing = { on: thing.on, archived, content: thing.on && !archived ? await contentAt(run, thing.path) : null }
  const mine = recorded(run, id)
  let sites: ReadonlyMap<SiteName, Served> = new Map([...mine].map(([site, s]) => [site, { content: s.content, url: s.url }]))
  let unreachable: string | null = null
  const { target } = run
  const serving = target?.serving
  if (target && serving) {
    try {
      sites = await served(run, (names) => serving.call(target, names), id, thing.path, mine)
    } catch (error) {
      unreachable = messageOf(error)
    }
  }
  const held = new Map([...sites].map(([site, s]) => [site, s.content]))
  const site = archived ? null : nameOf(run, thing.path)
  const shown = (site === null ? undefined : sites.get(site)) ?? [...sites.values()][0]
  const status = unreachable === null ? statusOf(site, standing, held) : 'unknown'
  return { thing, standing, held, status, site, url: shown?.url ?? null, unreachable, sites }
}

/** Every declared thing as it stands, by path, the archived ones last. */
export async function looks(run: Run): Promise<Seen[]> {
  const key = (path: LibraryPath) => `${run.ctx.tools.regionOf(path) === 'archive' ? 1 : 0}${path}`
  const out: Seen[] = []
  for (const thing of [...run.d.things.values()].sort((a, b) => (key(a.path) < key(b.path) ? -1 : 1))) out.push(await look(run, thing.id))
  return out
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
  if (before.unreachable !== null) return { ...before, done: [], problem: { kind: 'failed', message: before.unreachable } }
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
        if (other) throw new Error(`站点名 ${step.site} 已被 ${other.path} 用着`)
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
    serving = target.serving ? await target.serving(orphans.map(([site]) => site)) : null
  } catch (error) {
    return { done: [], failed: orphans.map(([site]) => ({ site, message: messageOf(error) })) }
  }
  for (const [site, s] of orphans) {
    try {
      if (serving === null || serving.has(site)) {
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

/** The files under a directory, relative and '/'-separated, sorted by the UTF-8 bytes of their paths. */
async function filesUnder(dir: string): Promise<SiteFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const abs = join(e.parentPath, e.name)
      return { path: abs.slice(dir.length + 1).split(/[\\/]/).join('/'), abs }
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
}

/**
 * Copies the files the thing's content counts to a fresh directory in the cache (a single file keeps
 * its name; a bundle leaves its marker out), checks they are the content decided on, and hands that
 * directory to the target.
 */
async function publish(run: Run, target: Target, path: LibraryPath, site: SiteName, content: ContentId): Promise<{ url: string | null }> {
  const stage = join(stageRoot(run.ctx), randomUUID())
  try {
    const copied = await run.ctx.tools.copyOut(path, stage)
    const files = copied === null ? [] : await filesUnder(stage)
    const staged = copied === null ? null : target.identify ? await target.identify(files) : copied
    if (staged !== content) throw new Error(`${path} 正在被改动，没有发布；之后运行 ${run.kit.name} sync`)
    return await target.publish(site, stage, { content, path, at: run.ctx.now, files })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
