// The reconciler: for a declared thing, read what the library has, decide what the target should
// hold (model.ts), and do the difference. Every hook and command runs it for the things it touched.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import {
  abs,
  archivedPath,
  bundleFiles,
  bundleManifest,
  enclosingBundle,
  fingerprintOf,
  fingerprintOfFile,
  fingerprintOfManifest,
  parseLibraryPath,
  regionOf,
  thingAt,
  type Fingerprint,
  type LibraryPath,
  type PluginContext,
} from '@pneuma-base/kernel'
import { apply, fact, readFacts, fold, writeFacts, type Declared, type Deployments, type Fact, type FactBody, type ThingId } from './facts.js'
import { plan, siteName, statusOf, want, type Held, type SiteName, type Standing, type Status } from './model.js'
import { readTargetConfig, targetOf, type Target } from './targets.js'

/** One hook's or command's work: the records as read, the target, and the facts it adds, written as one file at the end. */
export type Run = { ctx: PluginContext; d: Deployments; target: Target | null; facts: Fact[] }

/** Loads the records and the target, runs `body`, and writes the facts it added, also when it throws. */
export async function withRun<T>(ctx: PluginContext, body: (run: Run) => Promise<T>): Promise<T> {
  const config = await readTargetConfig(ctx.dir)
  const run: Run = { ctx, d: fold(await readFacts(ctx.dir)), target: config && targetOf(config, { cwd: ctx.library.root, scratch: stageRoot(ctx) }), facts: [] }
  try {
    return await body(run)
  } finally {
    await writeFacts(ctx.dir, run.facts)
  }
}

/** Adds a fact to the run and to its view of the records. */
export function record(run: Run, body: FactBody): void {
  const f = fact(run.ctx, body)
  apply(run.d, f)
  run.facts.push(f)
}

/**
 * A declared thing as it stands: the decision's inputs, what the target holds for it, and the state
 * they make. `site` is the name it has or would have, null while archived; `url` is where the target
 * serves it, preferring that name.
 */
export type Look = { thing: Declared; standing: Standing; held: Held; status: Status; site: SiteName | null; url: string | null }

/** Reads without changing anything. The content is fingerprinted only when it can matter: switched on and not archived. */
export async function look(run: Run, id: ThingId): Promise<Look> {
  const thing = run.d.things.get(id) as Declared
  const archived = regionOf(thing.path) === 'archive'
  const file = abs(run.ctx.library.root, thing.path)
  const content = thing.on && !archived && (await thingAt(file)) ? await fingerprintOf(file) : null
  const standing = { on: thing.on, archived, content }
  const sites = [...(run.target ? (run.d.sites.get(run.target.key) ?? new Map()) : new Map())].filter(([, s]) => s.thing === id)
  const held: Held = new Map(sites.map(([site, s]) => [site, s.fingerprint]))
  const site = archived ? null : siteName(thing.path)
  const shown = sites.find(([s]) => s === site) ?? sites[0]
  return { thing, standing, held, status: statusOf(thing.path, standing, held), site, url: shown?.[1].url ?? null }
}

/** Every declared thing as it stands, by path, the archived ones last. */
export async function looks(run: Run): Promise<Look[]> {
  const key = (path: LibraryPath) => `${regionOf(path) === 'archive' ? 1 : 0}${path}`
  const out: Look[] = []
  for (const thing of [...run.d.things.values()].sort((a, b) => (key(a.path) < key(b.path) ? -1 : 1))) out.push(await look(run, thing.id))
  return out
}

/** The library path an input names: the thing itself, or the bundle it lies in. Null outside the content and the archive. */
export async function thingPath(root: string, input: string): Promise<LibraryPath | null> {
  const path = parseLibraryPath(root, input)
  if (path === null || regionOf(path) === 'kernel') return null
  return (await enclosingBundle(root, path)) ?? path
}

/** The declared thing an input names: by its path, or for an archived thing also by the path it had. */
export async function declaredAt(run: Run, input: string): Promise<ThingId | null> {
  const path = await thingPath(run.ctx.library.root, input)
  if (path === null) return null
  return run.d.byPath.get(path) ?? (regionOf(path) === 'content' ? run.d.byPath.get(archivedPath(path)) : undefined) ?? null
}

export type Done = { kind: 'publish'; site: SiteName; url: string | null } | { kind: 'unpublish'; site: SiteName }
/** `no-target`: something had to change and no target is set. `failed`: the target refused a step; later steps were not tried. */
type Problem = { kind: 'no-target' } | { kind: 'failed'; message: string }
export type Settled = Look & { done: Done[]; problem: Problem | null }

/** Makes the target hold what is wanted for one thing, recording each step the target did. */
export async function settle(run: Run, id: ThingId): Promise<Settled> {
  const before = await look(run, id)
  const steps = plan(want(before.thing.path, before.standing), before.held)
  if (steps.length === 0) return { ...before, done: [], problem: null }
  const { target } = run
  if (target === null) return { ...before, done: [], problem: { kind: 'no-target' } }
  const done: Done[] = []
  let problem: Problem | null = null
  for (const step of steps) {
    try {
      if (step.kind === 'publish') {
        const holder = run.d.sites.get(target.key)?.get(step.site)?.thing
        const other = holder === undefined || holder === id ? undefined : run.d.things.get(holder)
        if (other) throw new Error(`站点名 ${step.site} 已被 ${other.path} 用着`)
        const { url } = await publish(run, target, before.thing.path, step.site, step.fingerprint)
        record(run, { kind: 'publish', thing: id, target: target.key, site: step.site, fingerprint: step.fingerprint, url })
        done.push({ kind: 'publish', site: step.site, url })
      } else {
        await target.unpublish(step.site)
        record(run, { kind: 'unpublish', thing: id, target: target.key, site: step.site })
        done.push({ kind: 'unpublish', site: step.site })
      }
    } catch (error) {
      problem = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      break
    }
  }
  return { ...(await look(run, id)), done, problem }
}

/** Takes down the sites on the current target that no declared thing owns, such as those of a declaration purged with the archive. */
export async function sweep(run: Run): Promise<{ done: Done[]; failed: { site: SiteName; message: string }[] }> {
  const { target } = run
  const out: Awaited<ReturnType<typeof sweep>> = { done: [], failed: [] }
  if (target === null) return out
  for (const [site, s] of [...(run.d.sites.get(target.key) ?? [])].filter(([, s]) => !run.d.things.has(s.thing))) {
    try {
      await target.unpublish(site)
      record(run, { kind: 'unpublish', thing: s.thing, target: target.key, site })
      out.done.push({ kind: 'unpublish', site })
    } catch (error) {
      out.failed.push({ site, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}

const stageRoot = (ctx: PluginContext) => join(ctx.cacheDir, 'stage')

/**
 * Copies the files the thing's fingerprint counts to a fresh directory in the cache (a single file
 * keeps its name; a bundle leaves its marker out), checks they are the content decided on, and
 * hands that directory to the target.
 */
async function publish(run: Run, target: Target, path: LibraryPath, site: SiteName, fingerprint: Fingerprint): Promise<{ url: string | null }> {
  const stage = join(stageRoot(run.ctx), randomUUID())
  const source = abs(run.ctx.library.root, path)
  try {
    await mkdir(stage, { recursive: true })
    let staged: Fingerprint
    if ((await thingAt(source))?.kind === 'bundle') {
      for (const f of await bundleFiles(source)) {
        await mkdir(dirname(join(stage, f.path)), { recursive: true })
        await copyFile(join(source, f.path), join(stage, f.path))
      }
      staged = fingerprintOfManifest(await bundleManifest(stage))
    } else {
      const name = posix.basename(path)
      await copyFile(source, join(stage, name))
      staged = await fingerprintOfFile(join(stage, name))
    }
    if (staged !== fingerprint) throw new Error(`${path} 正在被改动，没有发布；之后运行 deploy sync`)
    return await target.publish(site, stage, { fingerprint, path, at: run.ctx.now })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
