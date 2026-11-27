// Facts built by hand for the fold's tests, and a record place kept in memory with the same contract
// as storage's (STORAGE.md section 5), to fold them into rows without a library.
import type { Fingerprint, Instant, LibraryPath, PluginContext, RecordPlace, Row } from '@pneuma-base/kernel'
import type { Basis, Fact, FactActor, FactBody, ItemId, SceneId } from '../src/facts.js'
import { foldAll } from '../src/look.js'
import type { HistoryRow, ItemRow, SceneRow } from '../src/model.js'

export const claude: FactActor = { kind: 'agent', name: 'claude-code', grant: null }
export const codex: FactActor = { kind: 'agent', name: 'codex', grant: null }

export const at = (second: number) => `2026-11-25T00:00:${String(second).padStart(2, '0')}.000Z` as Instant
export const fp = (s: string) => s.padEnd(64, '0') as Fingerprint
export const p = (s: string) => s as LibraryPath
export const id = (s: string) => s as ItemId

/** A fact at second `second` of the test day, in scene `scene`. */
export function f(second: number, body: FactBody, opts: { scene?: string; actor?: FactActor } = {}): Fact {
  return {
    id: `f_${String(second).padStart(4, '0')}`,
    at: at(second),
    scene: (opts.scene ?? 's1') as SceneId,
    actor: opts.actor ?? claude,
    where: { cwd: '/work', machine: 'm', sessionSource: 'flag', transcript: null },
    how: 'tool',
    ...body,
  }
}

export const basis = (rows: [string, string][], outside: string[] = []): Basis => ({ items: rows.map(([item, print]) => ({ item: id(item), fingerprint: fp(print) })), outside })

type Enter = Extract<FactBody, { kind: 'item.enter' }>

export const enter = (item: string, path: string, print: string, origin: Enter['origin'] = { kind: 'brought', source: null, by: null }): Enter => ({
  kind: 'item.enter',
  item: id(item),
  path: p(path),
  fingerprint: fp(print),
  size: 1,
  origin,
})

const byKey = (a: Row, b: Row) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** A record place in memory: facts appended in order, rows by table and key, the cursor saved with them. */
export function memoryRecords(): RecordPlace & { tables: Map<string, Map<string, Row>>; puts: number } {
  const facts: unknown[] = []
  // Each append is one facts file, as in storage.
  let files = 0
  const tables = new Map<string, Map<string, Row>>()
  let saved: string | null = null
  const table = (name: string) => tables.get(name) ?? tables.set(name, new Map()).get(name)!
  const page = <V>(rows: Row[], opts: { limit?: number; after?: string }) => {
    const sorted = rows.filter((r) => opts.after === undefined || r.key > opts.after).sort(byKey)
    const limit = opts.limit ?? 100
    const shown = sorted.slice(0, limit)
    return { rows: shown as Row<V>[], more: sorted.length > limit ? { after: (shown.at(-1) as Row).key } : null }
  }
  const place = {
    tables,
    puts: 0,
    async append(list: readonly unknown[]) {
      facts.push(...list)
      files++
      return list.map((_, i) => String(facts.length - list.length + i))
    },
    async since(cursor: string | null, limit = 2000) {
      const from = cursor === null ? 0 : Number(cursor)
      if (from > facts.length) return null
      const shown = facts.slice(from, from + limit)
      return { facts: shown.map((fact, i) => ({ order: String(from + i), fact })), cursor: String(from + shown.length), more: from + shown.length < facts.length, ...(cursor === null ? { files } : {}) }
    },
    async put(tablesIn: Readonly<Record<string, readonly Row[]>>, opts: { cursor?: string; expect?: string | null } = {}) {
      if ('expect' in opts && opts.expect !== saved) return { written: false as const, actual: saved }
      place.puts++
      for (const [name, rows] of Object.entries(tablesIn)) {
        for (const r of rows) {
          if (r.value === null) table(name).delete(r.key)
          else table(name).set(r.key, structuredClone(r))
        }
      }
      if (opts.cursor !== undefined) saved = opts.cursor
      return { written: true as const }
    },
    async get<V>(name: string, keys: readonly string[]) {
      return { rows: keys.flatMap((k) => (table(name).has(k) ? [structuredClone(table(name).get(k) as Row<V>)] : [])), cursor: saved }
    },
    async under<V>(name: string, prefix: string, opts: { limit?: number; after?: string } = {}) {
      return structuredClone(page<V>([...table(name).values()].filter((r) => r.key.startsWith(prefix)), opts))
    },
    async where<V>(name: string, field: string, value: string, opts: { limit?: number; after?: string } = {}) {
      return structuredClone(page<V>([...table(name).values()].filter((r) => r.fields?.[field] === value), opts))
    },
    async count(name: string, field: string, value: string) {
      return Math.min(10_000, [...table(name).values()].filter((r) => r.fields?.[field] === value).length)
    },
    async reset() {
      tables.clear()
      saved = null
    },
  }
  return place
}

/** A context with nothing but a record place: what the fold needs. */
export const recordsContext = (records: RecordPlace) => ({ tools: { storage: { records } } }) as unknown as PluginContext

/** The rows of a record place, read back by table. */
export function rowsOf(records: ReturnType<typeof memoryRecords>) {
  const all = <V>(name: string) => new Map([...(records.tables.get(name)?.values() ?? [])].sort(byKey).map((r) => [r.key, r.value as V]))
  return {
    records,
    all,
    item: (key: string) => all<ItemRow>('items').get(key),
    items: () => [...all<ItemRow>('items').values()],
    path: (key: string) => all<{ id: ItemId }>('paths').get(key)?.id,
    scene: (key: string) => all<SceneRow>('scenes').get(key),
    history: (item: string) => [...all<HistoryRow>('history')].filter(([k]) => k.startsWith(`${item}|`)).map(([, v]) => v),
    versions: (item: string) => [...all<HistoryRow>('history')].filter(([k, v]) => k.startsWith(`${item}|`) && v.kind === 'version').map(([, v]) => v as Extract<HistoryRow, { kind: 'version' }>),
    counts: () => all<Record<string, number>>('meta').get('counts') ?? {},
  }
}

/** The facts folded into fresh rows, appended and folded a batch at a time. */
export async function folded(facts: readonly Fact[], batch = facts.length || 1) {
  const records = memoryRecords()
  const ctx = recordsContext(records)
  for (let i = 0; i < facts.length; i += batch) {
    await records.append(facts.slice(i, i + batch))
    await foldAll(ctx)
  }
  if (facts.length === 0) await foldAll(ctx)
  return rowsOf(records)
}
