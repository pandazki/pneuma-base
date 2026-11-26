// One change to the ledger's rows: reads go to storage once and are kept, writes are kept until the
// commit, which saves them with the fact cursor they were derived up to, in one put (STORAGE.md section
// 5: the owner of a record place reads the facts after its cursor, folds them into its rows, and saves
// the rows and the new cursor together). A read after a write in the same change sees the write.
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

export class Tx {
  private readonly read = new Map<string, Map<string, Kept>>()
  private readonly writes = new Map<string, Map<string, Kept>>()
  private counts: Record<string, number> | null = null
  private countsChanged = false

  constructor(readonly records: Records) {}

  private kept(map: Map<string, Map<string, Kept>>, table: string): Map<string, Kept> {
    let t = map.get(table)
    if (!t) map.set(table, (t = new Map()))
    return t
  }

  /** Reads these keys of a table from storage, those not read or written yet, in as few asks as it can. */
  async prefetch(table: string, keys: Iterable<string>): Promise<void> {
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
    const out = new Map<string, Row<V>>()
    for await (const page of pagesOf<V>(this.records, table, prefix)) for (const r of page) out.set(r.key, r)
    for (const [key, kept] of this.writes.get(table) ?? []) {
      if (!key.startsWith(prefix)) continue
      if (kept === null) out.delete(key)
      else out.set(key, { key, value: kept.value as V, ...(kept.fields ? { fields: kept.fields } : {}) })
    }
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Every row where a field has a value, this change's writes included. */
  async where<V>(table: string, field: string, value: string): Promise<Row<V>[]> {
    const out = new Map<string, Row<V>>()
    for await (const page of wherePages<V>(this.records, table, field, value)) for (const r of page) out.set(r.key, r)
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

  /** The rows to put, by table. */
  changes(): Record<string, Row[]> {
    if (this.countsChanged) this.set('meta', 'counts', this.counts)
    this.countsChanged = false
    const out: Record<string, Row[]> = {}
    for (const [table, rows] of this.writes) {
      if (rows.size === 0) continue
      out[table] = [...rows].map(([key, kept]) => (kept === null ? { key, value: null } : { key, value: kept.value, ...(kept.fields ? { fields: kept.fields } : {}) }))
    }
    return out
  }

  /** Saves the writes and, with `cursor`, the fact cursor, while the saved cursor is still `expect`. */
  async commit(cursor: string, expect: string | null): Promise<boolean> {
    const put = await this.records.put(this.changes(), { cursor, expect })
    return put.written
  }
}
