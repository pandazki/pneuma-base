// The deploy plugin's records: immutable facts, one JSON object per line, one new file per write,
// and the pure fold that turns them into what is declared and what each target holds.
import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fingerprint, Instant, LibraryPath, PluginContext } from '@pneuma-base/kernel'
import type { SiteName } from './model.js'

export type ThingId = string & { readonly __brand: 'DeployThingId' }
/** Which target a publish went to: its kind and where, so records of another target do not count. */
export type TargetKey = string & { readonly __brand: 'TargetKey' }

export type FactBody =
  | { kind: 'declare'; thing: ThingId; path: LibraryPath; note: string | null }
  | { kind: 'switch'; thing: ThingId; on: boolean }
  | { kind: 'move'; thing: ThingId; from: LibraryPath; to: LibraryPath }
  | { kind: 'remove'; thing: ThingId }
  | { kind: 'publish'; thing: ThingId; target: TargetKey; site: SiteName; fingerprint: Fingerprint; url: string | null }
  | { kind: 'unpublish'; thing: ThingId; target: TargetKey; site: SiteName }

export type Fact = { id: string; at: Instant; actor: { kind: 'agent' | 'owner' | 'plugin'; name: string }; session: string } & FactBody

export type Declared = { id: ThingId; path: LibraryPath; on: boolean; declaredAt: Instant; declaredBy: string; note: string | null }
type OnTarget = { thing: ThingId; fingerprint: Fingerprint; url: string | null; at: Instant }

export type Deployments = {
  things: Map<ThingId, Declared>
  byPath: Map<LibraryPath, ThingId>
  sites: Map<TargetKey, Map<SiteName, OnTarget>>
  /** A path declared twice, as two machines may before they sync, is one thing: the later id points at the first. */
  alias: Map<ThingId, ThingId>
}

const emptyDeployments = (): Deployments => ({ things: new Map(), byPath: new Map(), sites: new Map(), alias: new Map() })

function sitesOn(d: Deployments, target: TargetKey): Map<SiteName, OnTarget> {
  const sites = d.sites.get(target) ?? new Map<SiteName, OnTarget>()
  d.sites.set(target, sites)
  return sites
}

/** Applies one fact. A path names at most one declared thing: a thing moved onto a declared path replaces that declaration. */
export function apply(d: Deployments, f: Fact): void {
  const id = d.alias.get(f.thing) ?? f.thing
  const thing = d.things.get(id)
  switch (f.kind) {
    case 'declare': {
      const there = d.byPath.get(f.path)
      if (there !== undefined) {
        if (there !== f.thing) d.alias.set(f.thing, there)
        return
      }
      d.things.set(f.thing, { id: f.thing, path: f.path, on: false, declaredAt: f.at, declaredBy: f.actor.name, note: f.note })
      d.byPath.set(f.path, f.thing)
      return
    }
    case 'switch':
      if (thing) thing.on = f.on
      return
    case 'move': {
      if (!thing) return
      const displaced = d.byPath.get(f.to)
      if (displaced !== undefined && displaced !== id) d.things.delete(displaced)
      if (d.byPath.get(thing.path) === id) d.byPath.delete(thing.path)
      thing.path = f.to
      d.byPath.set(f.to, id)
      return
    }
    case 'remove':
      if (!thing) return
      d.things.delete(id)
      if (d.byPath.get(thing.path) === id) d.byPath.delete(thing.path)
      return
    case 'publish':
      sitesOn(d, f.target).set(f.site, { thing: id, fingerprint: f.fingerprint, url: f.url, at: f.at })
      return
    case 'unpublish':
      sitesOn(d, f.target).delete(f.site)
  }
}

/** Facts in id order: by time, then by writer and order within it. */
export function fold(facts: readonly Fact[]): Deployments {
  const d = emptyDeployments()
  for (const f of [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) apply(d, f)
  return d
}

const FACTS_DIR = 'facts'
const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
const writer = randomBytes(3).toString('hex')
let sequence = 0

export const newThingId = () => `d_${randomBytes(5).toString('hex')}` as ThingId

/** One fact by the context's actor and session. Ids sort by time, then by order within this process. */
export function fact(ctx: PluginContext, body: FactBody): Fact {
  const actor = ctx.actor.kind === 'owner' ? { kind: 'owner' as const, name: 'owner' } : { kind: ctx.actor.kind, name: ctx.actor.name }
  return { id: `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}`, at: ctx.now, actor, session: ctx.session.id, ...body }
}

/** Writes the facts as one new file: a temporary name first, then linked to a final name that fails rather than replace one. */
export async function writeFacts(dir: string, facts: readonly Fact[]): Promise<void> {
  const first = facts[0]
  if (!first) return
  const folder = join(dir, FACTS_DIR)
  await mkdir(folder, { recursive: true })
  const bytes = facts.map((f) => `${JSON.stringify(f)}\n`).join('')
  for (;;) {
    const name = `${compact(first.at)}-${randomBytes(4).toString('hex')}.jsonl`
    const tmp = join(folder, `.tmp-${name}`)
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(tmp, join(folder, name))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await unlink(tmp)
    }
  }
}

/** Every fact on disk, skipping temporary files and lines that are not facts. */
export async function readFacts(dir: string): Promise<Fact[]> {
  const folder = join(dir, FACTS_DIR)
  const out: Fact[] = []
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (name.startsWith('.') || !name.endsWith('.jsonl')) continue
    for (const line of (await readFile(join(folder, name), 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      try {
        const raw = JSON.parse(line) as Partial<Fact>
        if (typeof raw.id === 'string' && typeof raw.at === 'string' && typeof raw.kind === 'string' && typeof raw.thing === 'string') out.push(raw as Fact)
      } catch {
        // A line that is not a fact is left as it is.
      }
    }
  }
  return out
}
