// One change to the ledger's rows: reads go to storage once and are kept, writes are kept until the
// commit, which saves them with the fact cursor they were derived up to, in one put (STORAGE.md section
// 5: the owner of a record place reads the facts after its cursor, folds them into its rows, and saves
// the rows and the new cursor together). A read after a write in the same change sees the write. A
// rebuild's change, too large for one put, is saved in parts (`commitInParts`).
import type { RecordPlace, Row } from '@pneuma-base/kernel'

export type Records = Pick<RecordPlace, 'get' | 'under' | 'where' | 'count' | 'put'>

type Kept = { value: unknown; fields?: Record<string, string> } | null

/** How many keys one read of storage asks for. */
const GET_PAGE = 1000
/** How many rows one page of a range read brings. */
export const RANGE_PAGE = 1000

/** The rows of a range read page by page, `limit` at a time. */
export async function* pagesOf<V>(records: Pick<RecordPlace, 'under'>, table: string, prefix: string, limit = RANGE_PAGE, after?: string): AsyncGenerator<Row<V>[]> {
  let next = after
  for (;;) {
    const page = await records.under<V>(table, prefix, { limit, ...(next === undefined ? {} : { after: next }) })
    if (page.rows.length > 0) yield page.rows
    if (page.more === null) return
    next = page.more.after
  }
}

/** The rows where a field has a value, page by page. */
export async function* wherePages<V>(records: Pick<RecordPlace, 'where'>, table: string, field: string, value: string, limit = RANGE_PAGE): AsyncGenerator<Row<V>[]> {
  let after: string | undefined
  for (;;) {
    const page = await records.where<V>(table, field, value, { limit, ...(after === undefined ? {} : { after }) })
    if (page.rows.length > 0) yield page.rows
    if (page.more === null) return
    after = page.more.after
  }
}

/** How many rows one put of a large change carries. */
export const PUT_ROWS = 25_000

const rowOf = ([key, kept]: [string, Kept]): Row => (kept === null ? { key, value: null } : { key, value: kept.value, ...(kept.fields ? { fields: kept.fields } : {}) })
const byKey = (a: Row, b: Row) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export class Tx {
  private readonly read = new Map<string, Map<string, Kept>>()
  private readonly writes = new Map<string, Map<string, Kept>>()
  private counts: Record<string, number> | null = null
  private countsChanged = false
  /** Tables whose writes were taken out to be saved early (`takeOut`): this change no longer knows their rows. */
  private readonly taken = new Set<string>()

  /**
   * `alone`: storage holds none of the rows this change can reach (a rebuild from nothing that holds
   * the claim to it), so a row this change has not written is not there, and nothing is read.
   */
  constructor(
    readonly records: Records,
    private readonly alone = false,
  ) {}

  /** How many rows this change keeps in memory. */
  get size(): number {
    let n = 0
    for (const map of [this.read, this.writes]) for (const t of map.values()) n += t.size
    return n
  }

  private knows(table: string): void {
    if (this.taken.has(table)) throw new Error(`记账插件的行表 ${table} 已经先存下了，这次改动不再读它`)
  }

  private kept(map: Map<string, Map<string, Kept>>, table: string): Map<string, Kept> {
    let t = map.get(table)
    if (!t) map.set(table, (t = new Map()))
    return t
  }

  /** Reads these keys of a table from storage, those not read or written yet, in as few asks as it can. */
  async prefetch(table: string, keys: Iterable<string>): Promise<void> {
    this.knows(table)
    if (this.alone) return
    const read = this.kept(this.read, table)
    const written = this.writes.get(table)
    const missing = [...new Set(keys)].filter((k) => !read.has(k) && !written?.has(k))
    for (let i = 0; i < missing.length; i += GET_PAGE) {
      const chunk = missing.slice(i, i + GET_PAGE)
      const { rows } = await this.records.get(table, chunk)
      for (const k of chunk) read.set(k, null)
      for (const r of rows) read.set(r.key, { value: r.value, ...(r.fields ? { fields: r.fields } : {}) })
    }
  }

  private now(table: string, key: string): Kept | undefined {
    this.knows(table)
    const w = this.writes.get(table)?.get(key)
    return w !== undefined ? w : this.read.get(table)?.get(key)
  }

  async get<V>(table: string, key: string): Promise<V | undefined> {
    if (this.now(table, key) === undefined) await this.prefetch(table, [key])
    const kept = this.now(table, key)
    return kept ? (kept.value as V) : undefined
  }

  async getMany<V>(table: string, keys: Iterable<string>): Promise<Map<string, V>> {
    const list = [...keys]
    await this.prefetch(table, list)
    const out = new Map<string, V>()
    for (const k of list) {
      const kept = this.now(table, k)
      if (kept) out.set(k, kept.value as V)
    }
    return out
  }

  /** Writes a row, its queryable fields with it; null deletes it. */
  set(table: string, key: string, value: unknown, fields?: Record<string, string>): void {
    this.kept(this.writes, table).set(key, value === null ? null : { value, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) })
  }

  /** Every row whose key starts with `prefix`, this change's writes included, by key. For the fold's few range reads, each over what one fact touches. */
  async under<V>(table: string, prefix: string): Promise<Row<V>[]> {
    this.knows(table)
    const out = new Map<string, Row<V>>()
    if (!this.alone) for await (const page of pagesOf<V>(this.records, table, prefix)) for (const r of page) out.set(r.key, r)
    for (const [key, kept] of this.writes.get(table) ?? []) {
      if (!key.startsWith(prefix)) continue
      if (kept === null) out.delete(key)
      else out.set(key, { key, value: kept.value as V, ...(kept.fields ? { fields: kept.fields } : {}) })
    }
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Every row where a field has a value, this change's writes included. */
  async where<V>(table: string, field: string, value: string): Promise<Row<V>[]> {
    this.knows(table)
    const out = new Map<string, Row<V>>()
    if (!this.alone) for await (const page of wherePages<V>(this.records, table, field, value)) for (const r of page) out.set(r.key, r)
    for (const [key, kept] of this.writes.get(table) ?? []) {
      if (kept === null || kept.fields?.[field] !== value) out.delete(key)
      else out.set(key, { key, value: kept.value as V, fields: kept.fields })
    }
    return [...out.values()]
  }

  /** A counter the rows keep, as this change has it. */
  async counter(name: string): Promise<number> {
    this.counts ??= (await this.get<Record<string, number>>('meta', 'counts')) ?? {}
    return this.counts[name] ?? 0
  }

  async bump(name: string, by: number): Promise<void> {
    if (by === 0) return
    const was = await this.counter(name)
    ;(this.counts as Record<string, number>)[name] = was + by
    this.countsChanged = true
  }

  /** The counters as this change has them, for a reader that needs several. */
  async counters(): Promise<Readonly<Record<string, number>>> {
    await this.counter('')
    return this.counts as Record<string, number>
  }

  /** How many rows this change has written to these tables. */
  writtenTo(tables: readonly string[]): number {
    return tables.reduce((n, table) => n + (this.writes.get(table)?.size ?? 0), 0)
  }

  /**
   * Takes this change's writes to tables it only writes, never reads, to be saved before the rest
   * (each table's rows by key); asking this change about those tables afterwards is an error.
   */
  takeOut(tables: readonly string[]): Record<string, Row[]> {
    const out: Record<string, Row[]> = {}
    for (const table of tables) {
      this.taken.add(table)
      const rows = this.writes.get(table)
      if (!rows || rows.size === 0) continue
      out[table] = [...rows].map(rowOf).sort(byKey)
      this.writes.delete(table)
    }
    return out
  }

  /** The rows to put, by table. */
  changes(): Record<string, Row[]> {
    if (this.countsChanged) this.set('meta', 'counts', this.counts)
    this.countsChanged = false
    const out: Record<string, Row[]> = {}
    for (const [table, rows] of this.writes) {
      if (rows.size === 0) continue
      out[table] = [...rows].map(rowOf)
    }
    return out
  }

  /** Saves the writes and, with `cursor`, the fact cursor, while the saved cursor is still `expect`. */
  async commit(cursor: string, expect: string | null): Promise<boolean> {
    const put = await this.records.put(this.changes(), { cursor, expect })
    return put.written
  }

  /**
   * Saves a change too large for one put: a put at a time, each only while the saved cursor is still
   * `expect`, rows in key order so storage writes neighbours together; the last carries `meta` and
   * saves `cursor`. Readers that find a rebuild under way do not read the rows in between.
   */
  async commitInParts(cursor: string, expect: string): Promise<boolean> {
    const { meta = [], ...rest } = this.changes()
    const rows = Object.keys(rest)
      .sort()
      .flatMap((table) => (rest[table] as Row[]).sort(byKey).map((row) => [table, row] as const))
    // Each part is sent while storage writes the one before.
    let before = Promise.resolve(true)
    for (let i = 0; i < rows.length; i += PUT_ROWS) {
      const part: Record<string, Row[]> = {}
      for (const [table, row] of rows.slice(i, i + PUT_ROWS)) (part[table] ??= []).push(row)
      const put = this.records.put(part, { expect }).then((a) => a.written)
      if (!(await before)) return (await put) && false
      before = put
    }
    if (!(await before)) return false
    return (await this.records.put({ meta }, { cursor, expect })).written
  }
}
