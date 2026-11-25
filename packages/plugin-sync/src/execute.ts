// Applies a plan to two sides. Each write and removal first checks that the file is what the plan
// saw, so a file changed during the sync is skipped, never overwritten.
import { createHash } from 'node:crypto'
import type { Fingerprint, LibraryPath } from '@pneuma-base/kernel'
import { stepPath, type Deletion, type Files, type Plan, type Side, type Step } from './rules.js'

/**
 * Where a library is synced to, and the library itself seen the same way. Paths are library
 * paths. `read` of a missing file rejects with an error whose `code` is `ENOENT`; `write` puts the
 * whole file in place at once.
 */
export interface SyncTarget {
  list(): Promise<Map<LibraryPath, Fingerprint>>
  read(path: LibraryPath): Promise<Uint8Array>
  write(path: LibraryPath, bytes: Uint8Array): Promise<void>
  remove(path: LibraryPath): Promise<void>
}

export type Sides = Record<Side, SyncTarget>

/** `failure`: why the run stopped; the steps after it did not run. */
export type Execution = { done: Step[]; skipped: Step[]; failure: string | null }

const other = (side: Side): Side => (side === 'local' ? 'target' : 'local')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') as Fingerprint

export async function execute(plan: Plan, sides: Sides): Promise<Execution> {
  const out: Execution = { done: [], skipped: [], failure: null }
  for (const step of plan.steps) {
    try {
      if (await apply(step, sides)) out.done.push(step)
      else out.skipped.push(step)
    } catch (error) {
      out.failure = error instanceof Error ? error.message : String(error)
      break
    }
  }
  return out
}

/** False when a file is not what the plan saw. */
async function apply(step: Step, sides: Sides): Promise<boolean> {
  if (step.kind === 'remove') {
    if ((await current(sides[step.side], step.path)) !== step.fingerprint) return false
    await sides[step.side].remove(step.path)
    return true
  }
  const bytes = await sides[step.from].read(step.path)
  if (sha256(bytes) !== step.fingerprint) return false
  if (step.kind === 'copy') return place(sides[other(step.from)], step.path, bytes, step.fingerprint, step.over)
  return (await place(sides.local, step.to, bytes, step.fingerprint, null)) && (await place(sides.target, step.to, bytes, step.fingerprint, null))
}

/** Writes `bytes` at `path` when the file there is `expected`; already holding them counts as done. */
async function place(side: SyncTarget, path: LibraryPath, bytes: Uint8Array, fingerprint: Fingerprint, expected: Fingerprint | null): Promise<boolean> {
  const now = await current(side, path)
  if (now === fingerprint) return true
  if (now !== expected) return false
  await side.write(path, bytes)
  return true
}

async function current(side: SyncTarget, path: LibraryPath): Promise<Fingerprint | null> {
  try {
    return sha256(await side.read(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** The paths of the plan's steps that are not in `done`. */
function unrun(plan: Plan, done: readonly Step[]): Set<LibraryPath> {
  const ran = new Set(done.map(stepPath))
  return new Set(plan.steps.map(stepPath).filter((path) => !ran.has(path)))
}

/** What both sides hold after `done`: the plan's end state, except the paths whose step did not run, which keep their base. */
export function baselineAfter(plan: Plan, base: Files, done: readonly Step[]): Map<LibraryPath, Fingerprint> {
  const after = new Map(plan.end)
  for (const path of unrun(plan, done)) {
    const before = base.get(path)
    if (before === undefined) after.delete(path)
    else after.set(path, before)
  }
  return after
}

/**
 * The ids of the deletion records a run settled: each whose every path had its step run, or had no
 * step. A settled record no longer applies, so content put back at its paths later follows the
 * ordinary rules; one with a step left undone applies again on the next run.
 */
export function settledBy(plan: Plan, done: readonly Step[], records: readonly { id: string; deleted: readonly Deletion[] }[]): string[] {
  const open = unrun(plan, done)
  return records.filter((r) => r.deleted.every((d) => !open.has(d.path))).map((r) => r.id)
}
