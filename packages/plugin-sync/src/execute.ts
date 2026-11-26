// Applies a plan to two sides. Each step first checks that what it copies, replaces or removes is what
// the plan saw, so a thing changed during the sync is skipped, never overwritten.
import type { Fingerprint } from '@pneuma-base/kernel'
import { stepPath, type Deletion, type Files, type Plan, type Side, type Step } from './rules.js'
import type { Key } from './scope.js'
import type { Staged } from './target.js'

/**
 * One side of a sync as a plan's steps use it. `stage` takes a copy of what `key` holds out to the
 * target's temporary folder while it is still `fingerprint`; `place` puts a staged copy at `key` while
 * what is there is what the plan saw, holding `fingerprint` already counting as done; `remove` takes
 * `key` away while it is what the plan saw. Each answers false, changing nothing, when it is not.
 */
export interface SideIO {
  stage(key: Key, fingerprint: Fingerprint): Promise<Staged | null>
  place(key: Key, staged: Staged, fingerprint: Fingerprint): Promise<boolean>
  remove(key: Key, fingerprint: Fingerprint): Promise<boolean>
}

/** The two sides, and how a staged copy left over after a step goes. */
export type Sides = Record<Side, SideIO> & { discard(staged: Staged): void }

/** `failure`: why the run stopped; the steps after it did not run. */
export type Execution = { done: Step[]; skipped: Step[]; failure: string | null }

const other = (side: Side): Side => (side === 'local' ? 'target' : 'local')

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

/** False when something is not what the plan saw. The local side is placed before the target, which takes the staged copy. */
async function apply(step: Step, sides: Sides): Promise<boolean> {
  if (step.kind === 'remove') return sides[step.side].remove(step.path, step.fingerprint)
  const staged = await sides[step.from].stage(step.path, step.fingerprint)
  if (staged === null) return false
  try {
    if (step.kind === 'copy') return await sides[other(step.from)].place(step.path, staged, step.fingerprint)
    return (await sides.local.place(step.to, staged, step.fingerprint)) && (await sides.target.place(step.to, staged, step.fingerprint))
  } finally {
    sides.discard(staged)
  }
}

/** The paths of the plan's steps that are not in `done`. */
export function unrun(plan: Plan, done: readonly Step[]): Set<Key> {
  const ran = new Set(done.map(stepPath))
  return new Set(plan.steps.map(stepPath).filter((path) => !ran.has(path)))
}

/** What both sides hold after `done`: the plan's end state, except the paths whose step did not run, which keep their base. */
export function baselineAfter(plan: Plan, base: Files, done: readonly Step[]): Map<Key, Fingerprint> {
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
