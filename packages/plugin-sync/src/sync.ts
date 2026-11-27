// One sync: pull the facts, so the other libraries' things are known; compare each key on the two
// sides and against the baseline; plan; execute; push the facts written here; save the baseline.
import { regionOf, type Fingerprint, type LibraryPath, type PluginContext } from '@pneuma-base/kernel'
import { emptyBaseline, readBaseline, writeBaseline, type BaseEntry, type Baseline } from './baseline.js'
import { pullFacts, pushFacts, unpulledSyncFacts } from './carry.js'
import { baselineAfter, execute, settledBy, unrun, type Execution, type Sides } from './execute.js'
import { countsOf, envelope, parseFact, writeFacts, type Counts, type DeletedFact, type RunFact, type SyncFact, type TargetFact } from './facts.js'
import { goneKeys, localMap, localOwn, localSide, localThings, type LocalMap } from './local.js'
import { Change, COPIES, currentTarget, deletionFacts, fold, foldAll, lastRun } from './rows.js'
import { conflictName, machineSlug, moment, plan, type Files, type Plan } from './rules.js'
import { cacheDirsOf, ownOf, type Key } from './scope.js'
import { targetMap, targetOwn, targetSide, targetThings, type TargetMap } from './target-side.js'
import { isDirectory, TargetDir } from './target.js'

export type Ready = {
  kind: 'ready'
  record: TargetFact
  target: TargetDir
  base: Baseline
  local: LocalMap
  remote: TargetMap
  out: Change
  /** The deletion records the baseline has not settled, which the plan applies. */
  deletions: DeletedFact[]
  plan: Plan
}

/** A plan ready to run, or why there is none. */
export type Prepared =
  | Ready
  | { kind: 'no-target' }
  | { kind: 'target-missing' | 'target-overlaps'; record: TargetFact }
  | { kind: 'target-failed'; record: TargetFact; message: string }

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Whether the target and the library would hold each other. */
export const overlaps = (root: string, target: string) => within(target, root) || within(root, target)

/** The sync's rows brought up to its facts, and the target this machine uses. */
export async function targetOf(ctx: PluginContext): Promise<{ rows: Change; record: TargetFact | null }> {
  await foldAll(ctx)
  const rows = new Change(ctx.tools.storage.records)
  return { rows, record: await currentTarget(rows, ctx.session.machine) }
}

const only = (m: ReadonlyMap<Key, Fingerprint>, skip: ReadonlySet<Key>): Files => new Map([...m].filter(([k]) => !skip.has(k)))

/**
 * The plan a sync would run now. `run`: the target gets its id if it has none, the facts other
 * libraries wrote are pulled into their record places first, and what was read is kept; otherwise
 * (a status) nothing is written to the library or the target, and the sync's own facts not pulled
 * yet are folded on top of its rows for this plan only.
 */
export async function prepare(ctx: PluginContext, record: TargetFact | null, mode: 'run' | 'status'): Promise<Prepared> {
  if (record === null) return { kind: 'no-target' }
  const path = record.target.path
  if (overlaps(ctx.library.root, path)) return { kind: 'target-overlaps', record }
  if (!isDirectory(path)) return { kind: 'target-missing', record }
  try {
    const noise = await ctx.tools.storage.noise()
    const target = new TargetDir(path, { names: new Set(noise.names), paths: noise.paths })
    const me = ctx.library.config.id
    const records = ctx.tools.storage.records
    let id = target.id()
    if (id === null && mode === 'run') id = target.giveId()
    const saved = id === null ? null : readBaseline(ctx.cacheDir, id)
    const base = saved ?? emptyBaseline(id ?? '')
    const rows = new Change(records)
    if (mode === 'run') {
      await pullFacts(ctx, target, base, me)
      writeBaseline(ctx.cacheDir, base)
      await foldAll(ctx)
    } else {
      const unpulled = await unpulledSyncFacts(ctx, target, saved, me)
      await foldAll(ctx)
      await fold(rows, unpulled.flatMap((f) => parseFact(f) ?? []))
    }

    const out = new Change(records)
    const local = localMap()
    const remote = targetMap()
    await localThings(ctx, rows, base.files.keys(), out, local)
    for (const place of new Set([...(await ctx.tools.storage.recordPlaces()), ...target.ownPlaces()])) {
      const caches = cacheDirsOf(ctx.library.plugins, place)
      await localOwn(ctx, place, caches, out, local)
      targetOwn(target, place, caches, base.files, remote)
    }
    targetThings(target, [...local.expects.keys()].filter((k) => ownOf(k) === null), base.files, remote)
    await out.save()

    const skip = local.skip
    const baseFiles = new Map([...base.files].filter(([k]) => !skip.has(k)).map(([k, e]) => [k, e.fp] as const))
    const deletions = (await deletionFacts(rows)).filter((f) => !base.settled.has(f.id))
    const name = (p: LibraryPath, n: number) => conflictName(p, machineSlug(ctx.session.machine), moment(ctx.now), n)
    const planned = plan({ local: only(local.files, skip), target: only(remote.files, skip), base: baseFiles, deleted: deletions.flatMap((f) => f.deleted) }, name)
    return { kind: 'ready', record, target, base, local, remote, out, deletions, plan: planned }
  } catch (error) {
    return { kind: 'target-failed', record, message: error instanceof Error ? error.message : String(error) }
  }
}

/** What both sides hold after `done`, each key with the target's state then; a key whose step did not run, or that was left out, keeps its entry. */
function baseAfter(ready: Ready, done: Execution): Map<Key, BaseEntry> {
  const { plan: p, base, remote, local } = ready
  const fps = baselineAfter(p, new Map([...base.files].map(([k, e]) => [k, e.fp])), done.done)
  const open = unrun(p, done.done)
  const after = new Map<Key, BaseEntry>()
  for (const [key, fp] of fps) {
    const seen = remote.seen.get(key)
    if (open.has(key)) {
      const old = base.files.get(key)
      if (old !== undefined) after.set(key, old)
    } else if (seen) after.set(key, { fp, at: seen.at })
  }
  for (const key of local.skip) {
    const old = base.files.get(key)
    if (old !== undefined) after.set(key, old)
  }
  return after
}

/**
 * Runs the plan, records the run and what the run made on both sides, pushes the facts written here
 * (the run's own among them, so a sync that changed nothing leaves nothing to sync), and saves the
 * baseline.
 */
export async function run(ctx: PluginContext, ready: Ready): Promise<RunFact> {
  const { plan: p, target, record, base, local, remote, out } = ready
  const sides: Sides = { local: localSide(ctx, target, local, out), target: targetSide(target, remote), discard: (s) => target.discard(s) }
  let done: Execution = { done: [], skipped: [], failure: null }
  try {
    done = await execute(p, sides)
  } catch (error) {
    done = { ...done, failure: error instanceof Error ? error.message : String(error) }
  }
  const made: SyncFact[] = done.done.flatMap((s): SyncFact[] => {
    if (s.kind !== 'keep' || ownOf(s.to) !== null) return []
    return [s.as === 'conflict' ? { ...envelope(ctx), kind: 'conflict', copy: s.to, original: s.path } : { ...envelope(ctx), kind: 'things', paths: [s.to] }]
  })
  const fact: RunFact = {
    ...envelope(ctx),
    kind: 'run',
    target: record.target,
    outcome: done.failure === null ? 'done' : 'failed',
    counts: countsOf(done.done, p.conflicts.length, done.skipped.length),
    conflicts: p.conflicts,
    kept: done.done.flatMap((s) => (s.kind === 'keep' && s.as !== 'conflict' ? [{ path: s.path, to: s.to }] : [])),
    message: done.failure,
  }
  await writeFacts(ctx, [...made, fact])
  await out.save()
  try {
    await pushFacts(ctx, target, base, ctx.library.config.id)
  } catch {
    // The facts stay here, and the cursors where they were: the next run pushes them.
  }
  base.files = baseAfter(ready, done)
  base.settled = new Set([...base.settled, ...settledBy(p, done.done, ready.deletions)])
  writeBaseline(ctx.cacheDir, base)
  return fact
}

/**
 * After a destructive owner command was done: records the keys of this machine's baseline that the
 * rows say are gone from the library now, with the content each held, so sync now deletes them on the
 * other side instead of bringing them back. Without a baseline nothing is recorded, and the ordinary
 * rules apply.
 */
export async function recordDeletions(ctx: PluginContext, command: string): Promise<void> {
  const base = readBaseline(ctx.cacheDir, null)
  if (base === null) return
  const places = new Set([...base.files.keys()].flatMap((k) => ownOf(k)?.place ?? []))
  const gone = await goneKeys(ctx, places)
  const deleted = [...base.files].filter(([key]) => gone.has(key)).map(([path, e]) => ({ path, fingerprint: e.fp }))
  if (deleted.length > 0) await writeFacts(ctx, [{ ...envelope(ctx), kind: 'deleted', command, deleted }])
}

/** The conflict copies the syncs made that are still where they were made, each with the path it was made for. */
export async function conflictCopies(ctx: PluginContext): Promise<{ copy: LibraryPath; original: LibraryPath }[]> {
  const { rows } = await targetOf(ctx)
  const copies: { copy: LibraryPath; original: LibraryPath }[] = []
  for await (const r of rows.all<{ original: LibraryPath }>(COPIES)) if (regionOf(r.key as LibraryPath) !== 'archive') copies.push({ copy: r.key as LibraryPath, original: r.value.original })
  if (copies.length === 0) return []
  const glanced = await ctx.tools.storage.glance(copies.map((c) => c.copy))
  return copies.filter((_, i) => {
    const g = glanced[i]
    return g !== undefined && !('outcome' in g) && g.kind !== 'none'
  })
}

/** The target, this machine's last run, the plan a sync now would run, and the conflict copies still around. */
export async function status(ctx: PluginContext) {
  const { rows, record } = await targetOf(ctx)
  const prepared = await prepare(ctx, record, 'status')
  return { prepared, record: prepared.kind === 'no-target' ? null : prepared.record, last: await lastRun(rows, ctx.session.machine), copies: await conflictCopies(ctx) }
}

/** What a plan would do, by kind, and how many steps in all. */
export const pendingOf = (p: Plan) => ({ ...countsOf(p.steps, p.conflicts.length, 0), steps: p.steps.length })

/** Deletions the owner made on purpose show only when there are some; a run recorded before they existed has none. */
export function countsText(c: Omit<Counts, 'skipped'>): string {
  const deleted = c.deleted > 0 ? ` · 删掉 ${c.deleted}（主人用会丢数据的命令删的）` : ''
  return `推上去 ${c.pushed} · 拉下来 ${c.pulled} · 删掉 ${c.removed}（内容别处还有）${deleted} · 留下 ${c.kept} · 冲突 ${c.conflicts}`
}

export const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`

/** Why a plan is not ready, for a person or an agent. */
export function notReadyText(prepared: Exclude<Prepared, Ready>, machine: string): string {
  if (prepared.kind === 'no-target') return '还没设同步目标。主人用 sync target set --kind dir --to <目录> 设一个。'
  const { record } = prepared
  if (prepared.kind === 'target-overlaps') return `同步目标 ${record.target.path} 和库的目录互相包含，不能同步。用 sync target set 换一个库外的目录。`
  if (prepared.kind === 'target-failed') return `读同步目标 ${record.target.path} 时出错：${prepared.message}`
  const elsewhere = record.machine === machine ? '接上那个目录，或用 sync target set 换一个。' : `它是在机器 ${record.machine} 上设的；用 sync target set --kind dir --to <目录> 设这台机器上的路径。`
  return `同步目标 ${record.target.path} 在这台机器上不存在。${elsewhere}`
}
