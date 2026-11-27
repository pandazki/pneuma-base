// The sync's rows, derived from its facts the way the ledger's are: read the facts after the saved
// cursor, fold them in, save the rows and the new cursor in one put. Besides, a run keeps in them what
// it last read of each thing and of each record place's own content (the token, the fingerprint),
// which no fact says: rows are a cache, and losing them costs only reading the content again.
import type { Fingerprint, Instant, LibraryPath, PluginContext, RecordPlace, Row } from '@pneuma-base/kernel'
import { parseFact, type DeletedFact, type RunFact, type SyncFact, type TargetFact } from './facts.js'

/**
 * Registered things, by library path. Field `token`: the state sync last read, of a directory thing every
 * file's (its deep token); `fp` its fingerprint (null: nothing there); `level` a directory thing's own
 * token then, which a write expects.
 */
export const THINGS = 'things'
/** Conflict copies a sync made, by the copy's path. Field `original`. */
export const COPIES = 'copies'
/** The owner's deliberate deletions, by the fact's id. */
const DELETED = 'deleted'
const META = 'meta'
/** A record place's own content as sync last read it, by own place: files and directories, field `token`. */
export const ownTable = (place: string) => `own:${place}`

const ROWS_VERSION = 1
/** How many facts one fold takes, and how many rows one page reads. */
const PAGE = 1000
const ROWS_PAGE = 10000

export type ThingRow = { fp: Fingerprint | null; level?: string }
/** A file of own content and its fingerprint, or a directory, whose token says whether its level changed. */
export type OwnRow = { fp: Fingerprint } | { dir: true }

type Kept = { fields?: Record<string, string>; value: unknown } | null

/** One change to the rows: reads go to storage once and are kept, writes are kept until `save`. */
export class Change {
  private readonly read = new Map<string, Map<string, Kept>>()
  private readonly writes = new Map<string, Map<string, Kept>>()

  constructor(private readonly records: RecordPlace) {}

  private table(map: Map<string, Map<string, Kept>>, table: string) {
    let t = map.get(table)
    if (!t) map.set(table, (t = new Map()))
    return t
  }

  private now(table: string, key: string): Kept | undefined {
    const w = this.writes.get(table)?.get(key)
    return w !== undefined ? w : this.read.get(table)?.get(key)
  }

  async getMany<V>(table: string, keys: Iterable<string>): Promise<Map<string, Row<V>>> {
    const list = [...new Set(keys)]
    const missing = list.filter((k) => this.now(table, k) === undefined)
    const read = this.table(this.read, table)
    for (let i = 0; i < missing.length; i += PAGE) {
      const chunk = missing.slice(i, i + PAGE)
      const { rows } = await this.records.get(table, chunk)
      for (const k of chunk) read.set(k, null)
      for (const r of rows) read.set(r.key, { value: r.value, ...(r.fields ? { fields: r.fields } : {}) })
    }
    const out = new Map<string, Row<V>>()
    for (const k of list) {
      const kept = this.now(table, k)
      if (kept) out.set(k, { key: k, value: kept.value as V, ...(kept.fields ? { fields: kept.fields } : {}) })
    }
    return out
  }

  async get<V>(table: string, key: string): Promise<Row<V> | undefined> {
    return (await this.getMany<V>(table, [key])).get(key)
  }

  /** Writes a row, its fields with it; null deletes it. */
  set(table: string, key: string, row: { fields?: Record<string, string>; value: unknown } | null): void {
    this.table(this.writes, table).set(key, row === null ? null : { value: row.value, ...(row.fields && Object.keys(row.fields).length > 0 ? { fields: row.fields } : {}) })
  }

  /** The rows of `table` this change wrote, null for a deleted one. */
  written(table: string): ReadonlyMap<string, Kept> {
    return this.writes.get(table) ?? new Map()
  }

  /** Every row of `table`, a page of storage at a time, with this change's writes on top. */
  async *all<V>(table: string, prefix = ''): AsyncGenerator<Row<V>> {
    const mine = this.writes.get(table) ?? new Map<string, Kept>()
    let after: string | undefined
    for (;;) {
      const page = await this.records.under<V>(table, prefix, { limit: ROWS_PAGE, ...(after === undefined ? {} : { after }) })
      for (const r of page.rows) {
        if (mine.has(r.key)) continue
        yield r
      }
      if (page.more === null) break
      after = page.more.after
    }
    for (const [key, kept] of mine) if (kept !== null && key.startsWith(prefix)) yield { key, value: kept.value as V, ...(kept.fields ? { fields: kept.fields } : {}) }
  }


  /** Saves the writes; with `cursor`, the fact cursor they were derived up to, while the saved one is still `expect`. */
  async save(opts: { cursor?: string; expect?: string | null } = {}): Promise<boolean> {
    const tables: Record<string, Row[]> = {}
    for (const [table, rows] of this.writes) {
      if (rows.size === 0) continue
      tables[table] = [...rows].map(([key, kept]) => (kept === null ? { key, value: null } : { key, value: kept.value, ...(kept.fields ? { fields: kept.fields } : {}) }))
    }
    if (Object.keys(tables).length === 0 && opts.cursor === undefined) return true
    const put = await this.records.put(tables, opts)
    if (put.written) this.writes.clear()
    return put.written
  }
}

const newer = (row: Row<{ at: Instant }> | undefined, at: Instant) => row === undefined || row.value.at <= at

/** A thing heard of again keeps what sync last read of it: if it changed, its token says so. */
async function enter(change: Change, paths: readonly LibraryPath[]): Promise<void> {
  const known = await change.getMany<ThingRow>(THINGS, paths)
  for (const path of paths) if (!known.has(path)) change.set(THINGS, path, { value: { fp: null } })
}

/** Folds facts into the rows, in the order they came. Every fact is taken again without harm. */
export async function fold(change: Change, facts: readonly SyncFact[]): Promise<void> {
  for (const f of facts) {
    switch (f.kind) {
      case 'things':
        await enter(change, f.paths)
        break
      case 'moved':
        change.set(THINGS, f.from, null)
        await enter(change, [f.to])
        break
      case 'gone':
        for (const path of f.paths) change.set(THINGS, path, null)
        break
      case 'conflict':
        change.set(COPIES, f.copy, { fields: { original: f.original }, value: { original: f.original } })
        await enter(change, [f.copy])
        break
      case 'target.set':
        if (newer(await change.get(META, `target:${f.machine}`), f.at)) change.set(META, `target:${f.machine}`, { value: f })
        if (newer(await change.get(META, 'target'), f.at)) change.set(META, 'target', { value: f })
        break
      case 'run':
        if (newer(await change.get(META, `run:${f.machine}`), f.at)) change.set(META, `run:${f.machine}`, { value: f })
        break
      case 'deleted':
        change.set(DELETED, f.id, { value: f })
    }
  }
}

/** The rows brought up to the facts, a page at a time, each page saved with its cursor. */
export async function foldAll(ctx: PluginContext): Promise<void> {
  const records = ctx.tools.storage.records
  for (let tries = 0; ; tries++) {
    const { rows, cursor } = await records.get<number>(META, ['version'])
    if (cursor !== null && rows[0]?.value !== ROWS_VERSION) {
      await records.reset()
      continue
    }
    const page = await records.since(cursor, PAGE)
    if (page === null) {
      // The facts the rows came from are not there any more: derive everything again.
      await records.reset()
      continue
    }
    if (page.facts.length === 0 && page.cursor === cursor) return
    const change = new Change(records)
    if (cursor === null) change.set(META, 'version', { value: ROWS_VERSION })
    await fold(change, page.facts.flatMap(({ fact }) => parseFact(fact) ?? []))
    if (await change.save({ cursor: page.cursor, expect: cursor })) {
      if (!page.more) return
    } else if (tries > 20) throw new Error('同步插件的行一直在被别的进程改写，没能读到一致的状态')
  }
}

/** The target this machine set last; a machine that set none uses the one set last on any machine. */
export async function currentTarget(change: Change, machine: string): Promise<TargetFact | null> {
  const rows = await change.getMany<TargetFact>(META, [`target:${machine}`, 'target'])
  return rows.get(`target:${machine}`)?.value ?? rows.get('target')?.value ?? null
}

/** The target this machine set last, if it set one. */
export async function machineTarget(change: Change, machine: string): Promise<TargetFact | null> {
  return (await change.get<TargetFact>(META, `target:${machine}`))?.value ?? null
}

export async function lastRun(change: Change, machine: string): Promise<RunFact | null> {
  return (await change.get<RunFact>(META, `run:${machine}`))?.value ?? null
}

export async function deletionFacts(change: Change): Promise<DeletedFact[]> {
  const out: DeletedFact[] = []
  for await (const row of change.all<DeletedFact>(DELETED)) out.push(row.value)
  return out
}
