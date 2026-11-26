// What the hooks and the owner commands share: reading the model, recording a version, naming a thing.
import { parseLibraryPath, regionOf, type LibraryPath, type PluginContext } from '@pneuma-base/kernel'
import { fact, readFacts, writeFacts, type Fact, type FactBody, type Via } from './facts.js'
import { fold, latest, step, type Model, type Thing, type Version } from './model.js'
import { snapshot, store } from './store.js'

export async function load(ctx: PluginContext): Promise<Model> {
  return fold(await readFacts(ctx.dir))
}

/** One hook's or command's writing: the model as read, kept current as facts are added, and written as one file. */
export type Writing = { ctx: PluginContext; model: Model; facts: Fact[] }

export async function writing(ctx: PluginContext): Promise<Writing> {
  return { ctx, model: await load(ctx), facts: [] }
}

export function apply(w: Writing, body: FactBody): Fact {
  const f = fact(w.ctx, body)
  w.facts.push(f)
  step(w.model, f)
  return f
}

export const commit = (w: Writing) => writeFacts(w.ctx.dir, w.facts)

/**
 * Keeps the content at the thing's path in the store and, when it is not the latest version,
 * records it as a new one. `added` says whether it did. Null when nothing is at the path.
 */
export async function record(w: Writing, thing: Thing, via: Via): Promise<{ version: Version; added: boolean } | null> {
  const file = w.ctx.tools.abs(thing.path)
  const shot = await snapshot(w.ctx, thing.path)
  if (shot === null) return null
  await store(w.ctx, file, shot.manifest)
  const last = latest(thing)
  if (last?.fingerprint === shot.fingerprint) return { version: last, added: false }
  apply(w, { kind: 'version', thing: thing.id, path: thing.path, fingerprint: shot.fingerprint, manifest: shot.manifest, via })
  return { version: thing.versions.at(-1) as Version, added: true }
}

/** The library path of the thing an input names: itself, or the bundle it lies in. Null outside the content and the archive. */
export async function thingPath(ctx: PluginContext, input: string): Promise<LibraryPath | null> {
  const path = parseLibraryPath(ctx.library.root, input)
  if (path === null || regionOf(path) === 'kernel') return null
  return (await ctx.tools.resolve(path))?.bundle ?? path
}

/** What is at the thing's path against its latest version. */
export type DiskState = 'current' | 'changed' | 'missing'

export async function diskState(ctx: PluginContext, thing: Thing): Promise<DiskState> {
  if ((await ctx.tools.thing(thing.path)) === null) return 'missing'
  return (await ctx.tools.fingerprint(thing.path)) === latest(thing)?.fingerprint ? 'current' : 'changed'
}
