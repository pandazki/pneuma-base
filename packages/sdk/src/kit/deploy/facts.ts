// The deploy kit's records, in the plugin's `facts/`, and the pure fold that turns them into what is
// declared and what each target holds. The format is the built-in deploy plugin's, unchanged.
import { randomBytes } from 'node:crypto'
import type { Instant, LibraryPath } from '../../types.js'
import type { Envelope } from '../records.js'
import type { ContentId, SiteName } from './model.js'

export type ThingId = string & { readonly __brand: 'DeployThingId' }
/** Which target a publish went to (`Target.key`), so records of another target do not count. */
export type TargetKey = string & { readonly __brand: 'TargetKey' }

/** `fingerprint` is the content id the target was given: the kernel fingerprint unless the target has its own. */
export type FactBody =
  | { kind: 'declare'; thing: ThingId; path: LibraryPath; note: string | null }
  | { kind: 'switch'; thing: ThingId; on: boolean }
  | { kind: 'move'; thing: ThingId; from: LibraryPath; to: LibraryPath }
  | { kind: 'remove'; thing: ThingId }
  | { kind: 'publish'; thing: ThingId; target: TargetKey; site: SiteName; fingerprint: ContentId; url: string | null }
  | { kind: 'unpublish'; thing: ThingId; target: TargetKey; site: SiteName }

export type Fact = Envelope & FactBody

/** `decided`: the owner has set its switch, on or off, at least once; until then whether it goes online waits on the owner. */
export type Declared = { id: ThingId; path: LibraryPath; on: boolean; decided: boolean; declaredAt: Instant; declaredBy: string; note: string | null }
export type OnTarget = { thing: ThingId; content: ContentId; url: string | null; at: Instant }

export type Deployments = {
  things: Map<ThingId, Declared>
  byPath: Map<LibraryPath, ThingId>
  sites: Map<TargetKey, Map<SiteName, OnTarget>>
  /** A path declared twice, as two machines may before they sync, is one thing: the later id points at the first. */
  alias: Map<ThingId, ThingId>
}

export const newThingId = () => `d_${randomBytes(5).toString('hex')}` as ThingId

/** A line's body, or why it is not a deploy record. Kinds this version does not know are kept and ignored by the fold. */
export function parseFact(raw: Record<string, unknown>): FactBody | string {
  return typeof raw.kind === 'string' && typeof raw.thing === 'string' ? (raw as unknown as FactBody) : '缺 kind 或 thing'
}

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
      d.things.set(f.thing, { id: f.thing, path: f.path, on: false, decided: false, declaredAt: f.at, declaredBy: f.actor.name, note: f.note })
      d.byPath.set(f.path, f.thing)
      return
    }
    case 'switch':
      if (thing) Object.assign(thing, { on: f.on, decided: true })
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
      sitesOn(d, f.target).set(f.site, { thing: id, content: f.fingerprint, url: f.url, at: f.at })
      return
    case 'unpublish':
      sitesOn(d, f.target).delete(f.site)
  }
}

/** Applies the facts in the order given, which is the store's id order: by time, then by writer and order within it. */
export function fold(facts: readonly Fact[]): Deployments {
  const d: Deployments = { things: new Map(), byPath: new Map(), sites: new Map(), alias: new Map() }
  for (const f of facts) apply(d, f)
  return d
}
