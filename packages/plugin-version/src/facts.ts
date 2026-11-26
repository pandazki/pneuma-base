// The version plugin's records: immutable facts, appended through storage to its record place, one
// write per hook. Facts the plugin wrote before storage, under facts/<scene>/, are read with the rest.
import { randomBytes } from 'node:crypto'
import type { Actor, Context, Fingerprint, Instant, LibraryPath, ManifestEntry, PluginContext, ThingKind } from '@pneuma-base/kernel'

export type ThingId = string & { readonly __brand: 'ThingId' }
export type FactId = string & { readonly __brand: 'FactId' }

/**
 * A version's content as a file, or as a directory version recorded before storage: each file's path
 * in the thing and its sha256, each file kept as its own object. A single file has one row, whose path is ''.
 */
export type Manifest = { kind: ThingKind; rows: ManifestEntry[] }

/** A directory version kept whole, as one tree: how many files and bytes it has. */
export type Tree = { files: number; bytes: number }

/** How a version came to be recorded: when it was declared, after a put, or seen changed outside the tool. */
export type Via = 'declare' | 'put' | 'outside'

export type VersionFact = { kind: 'version'; thing: ThingId; path: LibraryPath; fingerprint: Fingerprint; via: Via } & ({ manifest: Manifest } | { tree: Tree })

export type FactBody =
  | { kind: 'declare'; thing: ThingId; path: LibraryPath }
  | VersionFact
  | { kind: 'note'; thing: ThingId; version: FactId; text: string }
  | { kind: 'move'; thing: ThingId; from: LibraryPath; to: LibraryPath }
  | { kind: 'gone'; thing: ThingId } // the owner deleted it from the library (archive purge); its versions stay
  | { kind: 'prune'; thing: ThingId; versions: FactId[] } // the owner dropped these versions' content

export type Who = { kind: Actor['kind']; name: string }
export type Fact = { id: FactId; at: Instant; scene: string; by: Who } & FactBody

const KINDS: ReadonlySet<string> = new Set(['declare', 'version', 'note', 'move', 'gone', 'prune'] satisfies FactBody['kind'][])

const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '')
const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
const writer = randomBytes(3).toString('hex')
let sequence = 0

export function who(actor: Actor): Who {
  return actor.kind === 'owner' ? { kind: 'owner', name: 'owner' } : { kind: actor.kind, name: actor.name }
}

/** The session id made safe; for a session minted for this one call, the actor's ad hoc scene of the day. */
function sceneOf(ctx: Context): string {
  if (ctx.session.source !== 'minted') return safe(ctx.session.id) || 'session'
  return `adhoc-${safe(who(ctx.actor).name)}-${ctx.now.slice(0, 10)}`
}

export function newThingId(): ThingId {
  return `t_${randomBytes(5).toString('hex')}` as ThingId
}

/** One fact of this call. Ids sort by time, then by order within this process. */
export function fact(ctx: Context, body: FactBody): Fact {
  const id = `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}` as FactId
  return { id, at: ctx.now, scene: sceneOf(ctx), by: who(ctx.actor), ...body }
}

/** Appends the facts as one write; they are never rewritten. */
export async function appendFacts(ctx: PluginContext, facts: readonly Fact[]): Promise<void> {
  if (facts.length > 0) await ctx.tools.storage.records.append(facts)
}

/** A stored object as a fact, or null when it is not one. */
export function parseFact(raw: unknown): Fact | null {
  const f = raw as Partial<Record<keyof Fact, unknown>> | null
  if (typeof f !== 'object' || f === null) return null
  const strings = [f.id, f.at, f.scene, f.kind, f.thing].every((v) => typeof v === 'string')
  return strings && KINDS.has(f.kind as string) ? (f as Fact) : null
}
