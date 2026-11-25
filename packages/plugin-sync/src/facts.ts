// The sync's records in the library: one write-once file per fact under facts/, synced like any
// record. The baseline, what this machine saw at the end of its last sync, lives in the cache
// directory outside the library, one per machine, never synced.
import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Fingerprint, Instant, LibraryPath, PluginContext } from '@pneuma-base/kernel'
import type { SyncTarget } from './execute.js'
import { moment, type Conflict, type Deletion, type Files, type Step } from './rules.js'

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
export type SyncFact = TargetFact | RunFact | DeletedFact

const FACTS = 'facts'
/** The plugin's temporary folder, declared as a cache so it is never synced. */
export const SCRATCH = 'tmp'

export function envelope(ctx: PluginContext): Envelope {
  const by = ctx.actor.kind === 'owner' ? 'owner' : ctx.actor.name
  return { id: `${moment(ctx.now)}-${randomBytes(4).toString('hex')}`, at: ctx.now, machine: ctx.session.machine, by }
}

/** Writes one fact as a new file: a temporary name first, then linked to a final name that must not exist. Returns its library path and bytes. */
export async function writeFact(ctx: PluginContext, fact: SyncFact): Promise<{ path: LibraryPath; bytes: Buffer }> {
  const folder = join(ctx.dir, FACTS)
  await mkdir(folder, { recursive: true })
  await mkdir(join(ctx.dir, SCRATCH), { recursive: true })
  const bytes = Buffer.from(`${JSON.stringify(fact)}\n`)
  const tmp = join(ctx.dir, SCRATCH, `fact-${randomBytes(6).toString('hex')}`)
  await writeFile(tmp, bytes, { flag: 'wx' })
  try {
    for (;;) {
      const file = join(folder, `${fact.id}-${randomBytes(2).toString('hex')}.jsonl`)
      try {
        await link(tmp, file)
        return { path: relative(ctx.library.root, file).split(sep).join('/') as LibraryPath, bytes }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  } finally {
    await unlink(tmp)
  }
}

/** Every fact on disk, oldest first; lines that are not facts are skipped. */
export async function readFacts(ctx: PluginContext): Promise<SyncFact[]> {
  const folder = join(ctx.dir, FACTS)
  const out: SyncFact[] = []
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (name.startsWith('.') || !name.endsWith('.jsonl')) continue
    out.push(...parseFacts(await readFile(join(folder, name), 'utf8')))
  }
  return out.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
}

/**
 * The deletion records here and those in the target's facts that have not arrived yet: a record
 * made on another machine counts in the very sync that brings it.
 */
export async function deletionRecords(ctx: PluginContext, target: SyncTarget, here: Files, there: Files): Promise<DeletedFact[]> {
  const folder = `${relative(ctx.library.root, join(ctx.dir, FACTS)).split(sep).join('/')}/`
  const arriving = [...there.keys()].filter((path) => path.startsWith(folder) && path.endsWith('.jsonl') && !here.has(path))
  const out = await readFacts(ctx)
  for (const path of arriving) out.push(...parseFacts(Buffer.from(await target.read(path)).toString('utf8')))
  return out.filter((f): f is DeletedFact => f.kind === 'deleted')
}

type Raw = { id?: unknown; at?: unknown; machine?: unknown; kind?: unknown; target?: { kind?: unknown; path?: unknown }; counts?: unknown; deleted?: unknown }

const isDeletion = (value: unknown): boolean => {
  const { path, fingerprint } = (value ?? {}) as { path?: unknown; fingerprint?: unknown }
  return typeof path === 'string' && typeof fingerprint === 'string'
}

function parseFacts(text: string): SyncFact[] {
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      const raw = (value ?? {}) as Raw
      if (typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.machine !== 'string') return []
      const targeted = raw.target?.kind === 'dir' && typeof raw.target.path === 'string'
      const ok =
        raw.kind === 'deleted' ? Array.isArray(raw.deleted) && raw.deleted.every(isDeletion)
        : raw.kind === 'run' ? targeted && typeof raw.counts === 'object'
        : raw.kind === 'target.set' && targeted
      return ok ? [value as SyncFact] : []
    } catch {
      return []
    }
  })
}

/** The target this machine set last; a machine that set none uses the one set last on any machine. */
export function currentTarget(facts: readonly SyncFact[], machine: string): TargetFact | null {
  const sets = facts.filter((f): f is TargetFact => f.kind === 'target.set')
  return sets.filter((f) => f.machine === machine).at(-1) ?? sets.at(-1) ?? null
}

export function lastRun(facts: readonly SyncFact[], machine: string): RunFact | null {
  return facts.filter((f): f is RunFact => f.kind === 'run' && f.machine === machine).at(-1) ?? null
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

// ---- the baseline ----

/**
 * The files this machine saw at the end of its last sync with the target whose id is `target`,
 * and the ids of the deletion records already settled against it.
 */
export type Baseline = { target: string; files: Files; settled: ReadonlySet<string> }

type BaselineFile = { format: 1; target: string; files: Record<string, string>; settled?: string[] }
const BASELINE = 'baseline.json'

/** This machine's baseline, whatever its target; null when there is none or it cannot be read. */
export async function readBaseline(cacheDir: string): Promise<Baseline | null> {
  try {
    const raw = JSON.parse(await readFile(join(cacheDir, BASELINE), 'utf8')) as Partial<BaselineFile>
    if (raw.format !== 1 || typeof raw.target !== 'string' || typeof raw.files !== 'object' || raw.files === null) return null
    const files = new Map(Object.entries(raw.files).flatMap(([path, print]) => (typeof print === 'string' ? [[path as LibraryPath, print as Fingerprint]] : [])))
    const settled = new Set(Array.isArray(raw.settled) ? raw.settled.filter((id) => typeof id === 'string') : [])
    return { target: raw.target, files, settled }
  } catch {
    return null
  }
}

export async function writeBaseline(cacheDir: string, baseline: Baseline): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const tmp = join(cacheDir, `.${BASELINE}.${randomBytes(4).toString('hex')}`)
  const file: BaselineFile = { format: 1, target: baseline.target, files: Object.fromEntries(baseline.files), settled: [...baseline.settled] }
  await writeFile(tmp, JSON.stringify(file))
  await rename(tmp, join(cacheDir, BASELINE))
}
