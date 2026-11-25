// The sync's records in the library: one write-once file per fact under facts/, synced like any
// record. The baseline, what this machine saw at the end of its last sync, lives in the cache
// directory outside the library, one per machine, never synced.
import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Fingerprint, Instant, LibraryPath, PluginContext } from '@pneuma-base/kernel'
import { moment, type Conflict, type Files, type Step } from './rules.js'

export type TargetSpec = { kind: 'dir'; path: string }

/** What one run did. `kept`: contents that would have vanished, archived or restored. */
export type Counts = { pushed: number; pulled: number; removed: number; kept: number; conflicts: number; skipped: number }

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
export type SyncFact = TargetFact | RunFact

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
    for (const line of (await readFile(join(folder, name), 'utf8')).split('\n')) {
      const fact = parseFact(line)
      if (fact) out.push(fact)
    }
  }
  return out.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
}

function parseFact(line: string): SyncFact | null {
  try {
    const raw = JSON.parse(line) as Partial<SyncFact>
    const ok = typeof raw.id === 'string' && typeof raw.at === 'string' && typeof raw.machine === 'string' && raw.target?.kind === 'dir' && typeof raw.target.path === 'string'
    return ok && (raw.kind === 'target.set' || (raw.kind === 'run' && typeof raw.counts === 'object')) ? (raw as SyncFact) : null
  } catch {
    return null
  }
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
    removed: count((s) => s.kind === 'remove'),
    kept: count((s) => s.kind === 'keep' && s.as !== 'conflict'),
    conflicts,
    skipped,
  }
}

// ---- the baseline ----

type Baseline = { format: 1; target: string; files: Record<string, string> }
const BASELINE = 'baseline.json'

/** The files this machine saw at the end of its last sync with the target `id`; empty for another target or none. */
export async function readBaseline(cacheDir: string, id: string | null): Promise<Files> {
  if (id === null) return new Map()
  try {
    const raw = JSON.parse(await readFile(join(cacheDir, BASELINE), 'utf8')) as Partial<Baseline>
    if (raw.format !== 1 || raw.target !== id || typeof raw.files !== 'object' || raw.files === null) return new Map()
    return new Map(Object.entries(raw.files).flatMap(([path, print]) => (typeof print === 'string' ? [[path as LibraryPath, print as Fingerprint]] : [])))
  } catch {
    return new Map()
  }
}

export async function writeBaseline(cacheDir: string, id: string, files: ReadonlyMap<LibraryPath, Fingerprint>): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const tmp = join(cacheDir, `.${BASELINE}.${randomBytes(4).toString('hex')}`)
  const baseline: Baseline = { format: 1, target: id, files: Object.fromEntries(files) }
  await writeFile(tmp, JSON.stringify(baseline))
  await rename(tmp, join(cacheDir, BASELINE))
}
