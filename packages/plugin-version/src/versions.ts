// What the hooks and the owner commands share: the rows brought up to the facts, finding a thing,
// recording a version, and what is at a thing's path against its latest version. Content is read only
// where storage says a thing's token changed, or when a command asks.
import { isDescribed, isFailure, type Fingerprint, type LibraryPath, type Place, type PluginContext } from '@pneuma-base/kernel'
import { appendFacts, fact, type Fact, type FactBody, type ThingId, type Via } from './facts.js'
import { latest, step, type Thing, type Version } from './model.js'
import { syncRows, thingWhere, tokenAt, type Seen } from './rows.js'
import { discard, keep, snapshot } from './store.js'

/** The rows brought up to the facts, for a reader. */
export const load = (ctx: PluginContext) => syncRows(ctx.tools.storage.records)

/**
 * One hook's or command's writing: the things it touched as it has them, the facts it adds, appended
 * as one write, and the tokens it saw, saved with the rows.
 */
export type Writing = { ctx: PluginContext; things: Map<ThingId, Thing>; facts: Fact[]; seen: Map<Place, Seen> }

export async function writing(ctx: PluginContext): Promise<Writing> {
  await load(ctx)
  return { ctx, things: new Map(), facts: [], seen: new Map() }
}

/** A thing read from the rows, as this writing has it. */
export function adopt(w: Writing, thing: Thing): Thing {
  const known = w.things.get(thing.id)
  if (known) return known
  w.things.set(thing.id, thing)
  return thing
}

/** The thing declared at exactly this library path: what a put, a move or an archive there acts on. */
export async function declaredExactly(w: Writing, path: LibraryPath): Promise<Thing | undefined> {
  const here = [...w.things.values()].find((t) => !t.gone && t.path === path)
  if (here) return here
  const row = await thingWhere(w.ctx.tools.storage.records, 'path', path)
  const thing = row && adopt(w, row)
  return thing && !thing.gone && thing.path === path ? thing : undefined
}

/** The thing a reader names by a library path: declared there, or at its archived copy. */
export async function declaredAt(ctx: PluginContext, path: LibraryPath): Promise<Thing | undefined> {
  const records = ctx.tools.storage.records
  return (await thingWhere(records, 'path', path)) ?? (ctx.tools.regionOf(path) === 'content' ? await thingWhere(records, 'path', ctx.tools.archivedPath(path)) : undefined)
}

export function apply(w: Writing, body: FactBody): Fact {
  const f = fact(w.ctx, body)
  w.facts.push(f)
  const thing = step(w.things.get(f.thing), f)
  if (thing) w.things.set(f.thing, thing)
  return f
}

export async function commit(w: Writing): Promise<void> {
  if (w.facts.length === 0 && w.seen.size === 0) return
  await appendFacts(w.ctx, w.facts)
  await syncRows(w.ctx.tools.storage.records, w.seen)
  w.facts = []
  w.seen = new Map()
}

/** What the kernel says of a place it holds for a put: the state there, and its content's fingerprint when it read it. */
export type Held = { token: string; fingerprint: Fingerprint | null }

/** What storage says a thing's path holds against the token on record: the same state, another, or nothing. */
type Look = 'same' | 'changed' | 'gone'

/** What is at the thing's path against the token on record; with none on record, `changed` when anything is there. `token`: the state now, when storage said it. */
async function lookAt(ctx: PluginContext, thing: Thing): Promise<{ look: Look; token?: string }> {
  const store = ctx.tools.storage
  const recorded = await tokenAt(store.records, thing.path)
  if (recorded !== null) {
    const looked = await store.look([{ place: thing.path, token: recorded }])
    if (looked.gone.length > 0) return { look: 'gone' }
    const changed = looked.changed[0]
    if (changed) return { look: 'changed', ...(changed.entry.token === undefined ? {} : { token: changed.entry.token }) }
    return looked.failed.length > 0 ? { look: 'changed' } : { look: 'same' }
  }
  const [g] = await store.glance([thing.path])
  if (!g || !isDescribed(g) || g.kind === 'none') return { look: 'gone' }
  return { look: 'changed', ...(g.token === undefined ? {} : { token: g.token }) }
}

/** `version`: the latest version, which the content now is, or the one just recorded (`added`). */
export type Recorded = { version: Version; added: boolean }

/**
 * Keeps the content at the thing's path as a version when it is not the latest one. Null when nothing
 * is there; `moved` when it changed while it was copied, or could not be copied now. `held`: the kernel
 * holds the place for a put, so it does not change while it is copied.
 */
export async function record(w: Writing, thing: Thing, via: Via, held: Held | null = null): Promise<Recorded | null | 'moved'> {
  const { ctx } = w
  const last = latest(thing)
  const seen = (token: string | undefined) => {
    if (token !== undefined) w.seen.set(thing.path, { thing: thing.id, token })
  }
  if (last && held?.fingerprint === last.fingerprint) {
    seen(held.token)
    return { version: last, added: false }
  }
  let before = held?.token
  // A directory thing's token speaks for its own level only: before a put replaces one, its content is compared.
  if (last && (held === null || (held.fingerprint === null && last.kept.kind === 'file'))) {
    const at = await lookAt(ctx, thing)
    if (at.look === 'same') return { version: last, added: false }
    if (at.look === 'gone') return null
    before ??= at.token
  }
  if (before === undefined) {
    const [g] = await ctx.tools.storage.glance([thing.path])
    if (!g || !isDescribed(g) || g.kind === 'none') return null
    before = g.token ?? ''
  }
  const shot = await snapshot(ctx, thing.path)
  if (shot === null) return null
  if ('failed' in shot) return 'moved'
  if (held === null) {
    const after = await ctx.tools.storage.look([{ place: thing.path, token: before }])
    if (after.same !== 1) {
      await discard(ctx, shot)
      return 'moved'
    }
  }
  seen(before)
  if (last?.fingerprint === shot.fingerprint) {
    await discard(ctx, shot)
    return { version: last, added: false }
  }
  await keep(ctx, shot)
  const { fingerprint, kind, bytes, files } = shot
  const content = kind === 'tree' ? { tree: { files, bytes } } : { manifest: { kind: 'file' as const, rows: [{ path: '', fingerprint, size: bytes }] } }
  apply(w, { kind: 'version', thing: thing.id, path: thing.path, fingerprint, via, ...content })
  return { version: thing.versions.at(-1) as Version, added: true }
}

/** The library path of the thing an input names: itself, or the bundle it lies in. Null outside the content and the archive. */
export async function thingPath(ctx: PluginContext, input: string): Promise<LibraryPath | null> {
  const r = await ctx.tools.resolve(input)
  return r === null || r.region === 'kernel' ? null : (r.bundle ?? r.path)
}

/**
 * The fingerprint of what is at the thing's path: its latest version's while the token on record holds,
 * else read. Null when nothing is there; undefined when it could not be read.
 */
export async function fingerprintNow(ctx: PluginContext, thing: Thing, look?: Look): Promise<Fingerprint | null | undefined> {
  const at = look ?? (await lookAt(ctx, thing)).look
  if (at === 'gone') return null
  if (at === 'same') return latest(thing)?.fingerprint
  const content = await ctx.tools.storage.content(thing.path)
  if (!isFailure(content)) return content.fingerprint
  return content.reason === 'no_such_place' ? null : undefined
}

/** What is at the thing's path against its latest version. */
export type DiskState = 'current' | 'changed' | 'missing'

export async function diskState(ctx: PluginContext, thing: Thing, look?: Look): Promise<DiskState> {
  const now = await fingerprintNow(ctx, thing, look)
  return now === null ? 'missing' : now === latest(thing)?.fingerprint ? 'current' : 'changed'
}

/**
 * The things' paths whose state is not the one on record, every token row compared inside storage, a
 * page at a time. A place a write holds is left out: the put under way records what it writes.
 */
export async function differing(ctx: PluginContext): Promise<Map<Place, Exclude<Look, 'same'>>> {
  const out = new Map<Place, Exclude<Look, 'same'>>()
  for (let after: string | undefined; ; ) {
    const page = await ctx.tools.storage.lookRows('tokens', 'token', after === undefined ? {} : { after })
    for (const c of page.changed) out.set(c.place, 'changed')
    for (const f of page.failed) out.set(f.place, 'changed')
    for (const g of page.gone) out.set(g, 'gone')
    for (const h of page.held) out.delete(h)
    if (page.more === null) return out
    after = page.more.after
  }
}
