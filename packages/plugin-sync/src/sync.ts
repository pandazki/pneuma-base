// One sync, from the records to the two sides and back: what the target is, the plan, the run.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { regionOf, type Fingerprint, type LibraryPath, type PluginContext } from '@pneuma-base/kernel'
import { baselineAfter, execute, type Execution, type Sides } from './execute.js'
import { countsOf, currentTarget, envelope, lastRun, readBaseline, readFacts, SCRATCH, writeBaseline, writeFact, type Counts, type RunFact, type TargetFact } from './facts.js'
import { conflictName, conflictOrigin, machineSlug, moment, plan, type Files, type Plan } from './rules.js'
import { scopeOf, TARGET_DIR } from './scope.js'
import { dirSide, filesUnder, giveTargetId, targetId } from './sides.js'

/** A plan ready to run, or why there is none. */
export type Prepared =
  | { kind: 'ready'; record: TargetFact; sides: Sides; id: string | null; base: Files; plan: Plan }
  | { kind: 'no-target' }
  | { kind: 'target-missing' | 'target-overlaps'; record: TargetFact }
  | { kind: 'target-failed'; record: TargetFact; message: string }

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`)

/** Whether the target and the library would hold each other. */
export const overlaps = (root: string, target: string) => within(target, root) || within(root, target)

export async function prepare(ctx: PluginContext, record: TargetFact | null): Promise<Prepared> {
  if (record === null) return { kind: 'no-target' }
  const { root } = ctx.library
  const path = record.target.path
  if (overlaps(root, path)) return { kind: 'target-overlaps', record }
  if (!(await stat(path).catch(() => null))?.isDirectory()) return { kind: 'target-missing', record }
  const keep = scopeOf(ctx.library.plugins)
  const sides: Sides = { local: dirSide(root, join(ctx.dir, SCRATCH), keep), target: dirSide(path, join(path, TARGET_DIR, 'tmp'), keep) }
  try {
    const id = await targetId(sides.target)
    const [local, target, base] = await Promise.all([sides.local.list(), sides.target.list(), readBaseline(ctx.cacheDir, id)])
    const name = (p: LibraryPath, n: number) => conflictName(p, machineSlug(ctx.session.machine), moment(ctx.now), n)
    return { kind: 'ready', record, sides, id, base, plan: plan({ local, target, base }, name) }
  } catch (error) {
    return { kind: 'target-failed', record, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs the plan, records the run, and saves the baseline. The run's own record goes to the target
 * in the same run, so a sync that changed nothing leaves nothing to sync.
 */
export async function run(ctx: PluginContext, ready: Extract<Prepared, { kind: 'ready' }>): Promise<RunFact> {
  const { plan: p, sides, record, base } = ready
  let id = ready.id
  let done: Execution = { done: [], skipped: [], failure: null }
  try {
    id ??= await giveTargetId(sides.target)
    done = await execute(p, sides)
  } catch (error) {
    done = { ...done, failure: error instanceof Error ? error.message : String(error) }
  }
  const failure = done.failure
  const fact: RunFact = {
    ...envelope(ctx),
    kind: 'run',
    target: record.target,
    outcome: failure === null ? 'done' : 'failed',
    counts: countsOf(done.done, p.conflicts.length, done.skipped.length),
    conflicts: p.conflicts,
    kept: done.done.flatMap((s) => (s.kind === 'keep' && s.as !== 'conflict' ? [{ path: s.path, to: s.to }] : [])),
    message: failure,
  }
  const written = await writeFact(ctx, fact)
  if (id === null) return fact
  const after = baselineAfter(p, base, done.done)
  if (failure === null) {
    try {
      await sides.target.write(written.path, written.bytes)
      after.set(written.path, createHash('sha256').update(written.bytes).digest('hex') as Fingerprint)
    } catch {
      // The record stays here; the next run pushes it.
    }
  }
  await writeBaseline(ctx.cacheDir, id, after)
  return fact
}

/** Conflict copies outside the archive, each with the path it was made for. Names only; nothing is read. */
export async function conflictCopies(ctx: PluginContext): Promise<{ copy: LibraryPath; original: LibraryPath }[]> {
  const files = await filesUnder(ctx.library.root, scopeOf(ctx.library.plugins))
  return files.flatMap((copy) => {
    const original = regionOf(copy) === 'archive' ? null : conflictOrigin(copy)
    return original === null ? [] : [{ copy, original }]
  })
}

/** The target, this machine's last run, the plan a sync now would run, and the conflict copies still around. */
export async function status(ctx: PluginContext) {
  const facts = await readFacts(ctx)
  const machine = ctx.session.machine
  const prepared = await prepare(ctx, currentTarget(facts, machine))
  return { prepared, record: prepared.kind === 'no-target' ? null : prepared.record, last: lastRun(facts, machine), copies: await conflictCopies(ctx) }
}

/** What a plan would do, by kind, and how many steps in all. */
export const pendingOf = (p: Plan) => ({ ...countsOf(p.steps, p.conflicts.length, 0), steps: p.steps.length })

export function countsText(c: Omit<Counts, 'skipped'>): string {
  return `推上去 ${c.pushed} · 拉下来 ${c.pulled} · 删掉 ${c.removed}（内容别处还有） · 留下 ${c.kept} · 冲突 ${c.conflicts}`
}

export const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`

/** Why a plan is not ready, for a person or an agent. */
export function notReadyText(prepared: Exclude<Prepared, { kind: 'ready' }>, machine: string): string {
  if (prepared.kind === 'no-target') return '还没设同步目标。主人用 sync target set --kind dir --to <目录> 设一个。'
  const { record } = prepared
  if (prepared.kind === 'target-overlaps') return `同步目标 ${record.target.path} 和库的目录互相包含，不能同步。用 sync target set 换一个库外的目录。`
  if (prepared.kind === 'target-failed') return `读同步目标 ${record.target.path} 时出错：${prepared.message}`
  const elsewhere = record.machine === machine ? '接上那个目录，或用 sync target set 换一个。' : `它是在机器 ${record.machine} 上设的；用 sync target set --kind dir --to <目录> 设这台机器上的路径。`
  return `同步目标 ${record.target.path} 在这台机器上不存在。${elsewhere}`
}
