// The sync's facts, appended to its record place through storage and carried like every record
// place's facts: which target each machine set, each run, the owner's deliberate deletions, and the
// registered things it heard of, so a library learns from the pulled facts what the others registered.
import { randomBytes } from 'node:crypto'
import type { Instant, LibraryPath, PluginContext } from '@pneuma-base/kernel'
import { moment, type Conflict, type Deletion, type Step } from './rules.js'

export type TargetSpec = { kind: 'dir'; path: string }

/**
 * What one run did. `removed`: copies whose content stays elsewhere; `deleted`: what the owner
 * deleted on purpose (absent from records written before it existed); `kept`: contents that
 * would have vanished, archived or restored.
 */
export type Counts = { pushed: number; pulled: number; removed: number; deleted: number; kept: number; conflicts: number; skipped: number }

type Envelope = { id: string; at: Instant; machine: string; by: string }
export type TargetFact = Envelope & { kind: 'target.set'; target: TargetSpec }
export type RunFact = Envelope & {
  kind: 'run'
  target: TargetSpec
  outcome: 'done' | 'failed'
  counts: Counts
  conflicts: Conflict[]
  kept: { path: LibraryPath; to: LibraryPath }[]
  message: string | null
}
/**
 * The owner deleted these contents on purpose: right after the destructive owner command
 * `command` was done, they were in this machine's baseline and gone from the library.
 */
export type DeletedFact = Envelope & { kind: 'deleted'; command: string; deleted: Deletion[] }
/** Things registered or placed here, or made on both sides by a sync (archived and restored copies). */
export type ThingsFact = Envelope & { kind: 'things'; paths: LibraryPath[] }
/** A thing moved, by a put or into or out of the archive. */
export type MovedFact = Envelope & { kind: 'moved'; from: LibraryPath; to: LibraryPath }
/** Things `archive purge` deleted. */
export type GoneFact = Envelope & { kind: 'gone'; paths: LibraryPath[] }
/** A conflict copy a sync made: the target's version of `original`, kept on both sides at `copy`. */
export type ConflictFact = Envelope & { kind: 'conflict'; copy: LibraryPath; original: LibraryPath }
export type SyncFact = TargetFact | RunFact | DeletedFact | ThingsFact | MovedFact | GoneFact | ConflictFact

export function envelope(ctx: PluginContext): Envelope {
  const by = ctx.actor.kind === 'owner' ? 'owner' : ctx.actor.name
  return { id: `${moment(ctx.now)}-${randomBytes(4).toString('hex')}`, at: ctx.now, machine: ctx.session.machine, by }
}

/** Appends the facts as one write; they are never rewritten. */
export async function writeFacts(ctx: PluginContext, facts: readonly SyncFact[]): Promise<void> {
  if (facts.length > 0) await ctx.tools.storage.records.append(facts)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPaths = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string')
const isDeletion = (value: unknown): boolean => isObject(value) && typeof value.path === 'string' && typeof value.fingerprint === 'string'

/** A stored object as one of the sync's facts; null for anything else, which the sync leaves as it is. */
export function parseFact(raw: unknown): SyncFact | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.machine !== 'string') return null
  const targeted = isObject(raw.target) && raw.target.kind === 'dir' && typeof raw.target.path === 'string'
  const ok =
    raw.kind === 'deleted' ? Array.isArray(raw.deleted) && raw.deleted.every(isDeletion)
    : raw.kind === 'run' ? targeted && isObject(raw.counts)
    : raw.kind === 'target.set' ? targeted
    : raw.kind === 'things' || raw.kind === 'gone' ? isPaths(raw.paths)
    : raw.kind === 'moved' ? typeof raw.from === 'string' && typeof raw.to === 'string'
    : raw.kind === 'conflict' && typeof raw.copy === 'string' && typeof raw.original === 'string'
  return ok ? (raw as SyncFact) : null
}

export function countsOf(steps: readonly Step[], conflicts: number, skipped: number): Counts {
  const count = (test: (s: Step) => boolean) => steps.filter(test).length
  return {
    pushed: count((s) => s.kind === 'copy' && s.from === 'local'),
    pulled: count((s) => s.kind === 'copy' && s.from === 'target'),
    removed: count((s) => s.kind === 'remove' && s.as === 'elsewhere'),
    deleted: count((s) => s.kind === 'remove' && s.as === 'deleted'),
    kept: count((s) => s.kind === 'keep' && s.as !== 'conflict'),
    conflicts,
    skipped,
  }
}
