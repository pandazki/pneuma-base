// What the search plugin knows of the library: the things it heard registered, from facts in its record
// place, and what it read of each, in rows derived from them. The facts are the body; the rows are a
// cache storage keeps, derived from the facts after a cursor and saved with it in one commit (STORAGE.md
// section 5). A thing registered before the plugin was added is unknown to it until it is put again.
//
//   things   each registered thing by its path: a file, or a directory thing (`bundle`)
//   pending  the things to read: heard of, or changed, and not read since
//   tokens   what the index read: a row per place, its key the place and its field `token` the state
//            storage gave when it was read (`empty` where nothing was), the value the thing it belongs
//            to. A directory thing has a row for itself, each directory inside and each file. Storage
//            compares them (`look`, `lookRows`); the plugin never reads a token.
//   meta     `index`: the index the rows describe; `mark`: storage's change mark, kept from its last answer
import { type AcceptedPut, type LibraryPath, type Looked, type Place, type PluginContext, type RecordPlace, type Row } from '@pneuma-base/kernel'
import type { IndexOp, SearchIndex } from './store.js'

export type Fact =
  | { kind: 'seen'; things: { path: LibraryPath; bundle: boolean }[] }
  | { kind: 'moved'; from: LibraryPath; to: LibraryPath; bundle: boolean }
  | { kind: 'gone'; paths: LibraryPath[] }

export type Thing = { bundle: boolean }
/** How a read of a thing ended, kept on its own place's row. */
export type Outcome = { state: 'read' } | { state: 'gone' } | { state: 'too_many'; atLeast: number } | { state: 'unreadable'; reason: string }
/** A row of `tokens`: the thing the place belongs to, and on the thing's own place how its read ended. */
export type Observed = { thing: LibraryPath; outcome?: Outcome }

export const THINGS = 'things'
export const PENDING = 'pending'
export const TOKENS = 'tokens'
const META = 'meta'
/** The shape of the rows: rows of another shape are derived anew. */
const ROWS = 1
const FACT_PAGE = 1000
const GET_PAGE = 1000
/** More changed places than this are not followed one by one: storage compares every row of `tokens`. */
const PLACES_MAX = 200

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPath = (v: unknown): v is LibraryPath => typeof v === 'string' && v !== ''

/** A stored fact as one of this plugin's, or null. */
function factOf(raw: unknown): Fact | null {
  if (!isObject(raw)) return null
  if (raw.kind === 'seen' && Array.isArray(raw.things)) {
    const things = raw.things.flatMap((t) => (isObject(t) && isPath(t.path) && typeof t.bundle === 'boolean' ? [{ path: t.path, bundle: t.bundle }] : []))
    return { kind: 'seen', things }
  }
  if (raw.kind === 'moved' && isPath(raw.from) && isPath(raw.to) && typeof raw.bundle === 'boolean') return { kind: 'moved', from: raw.from, to: raw.to, bundle: raw.bundle }
  if (raw.kind === 'gone' && Array.isArray(raw.paths)) return { kind: 'gone', paths: raw.paths.filter(isPath) }
  return null
}

/** The fact a put makes: what it registered or placed, or where it moved a thing. `known`: the paths of a register-files already registered. */
export function factOfPut(req: AcceptedPut, known: ReadonlySet<string> = new Set()): Fact | null {
  switch (req.kind) {
    case 'register':
    case 'place':
      return { kind: 'seen', things: [{ path: req.path, bundle: req.now.kind === 'bundle' }] }
    case 'register-files': {
      const things = req.files.filter((f) => !known.has(f.path)).map((f) => ({ path: f.path, bundle: f.now.kind === 'bundle' }))
      return things.length === 0 ? null : { kind: 'seen', things }
    }
    case 'move':
      return { kind: 'moved', from: req.from, to: req.path, bundle: req.now.kind === 'bundle' }
  }
}

export async function append(ctx: PluginContext, facts: readonly Fact[]): Promise<void> {
  if (facts.length > 0) await ctx.tools.storage.records.append(facts)
}

/** The rows of `keys` in `table`, a page of keys at a time. */
export async function rowsOf<V>(records: RecordPlace, table: string, keys: Iterable<string>): Promise<Map<string, Row<V>>> {
  const all = [...new Set(keys)]
  const out = new Map<string, Row<V>>()
  for (let i = 0; i < all.length; i += GET_PAGE) for (const r of (await records.get<V>(table, all.slice(i, i + GET_PAGE))).rows) out.set(r.key, r)
  return out
}

/** Every row under `prefix`, a page at a time. */
export async function* pagesUnder<V>(records: RecordPlace, table: string, prefix: string, limit = GET_PAGE): AsyncGenerator<Row<V>[]> {
  for (let after: string | undefined; ; ) {
    const page = await records.under<V>(table, prefix, { limit, ...(after === undefined ? {} : { after }) })
    if (page.rows.length > 0) yield page.rows
    if (page.more === null) return
    after = page.more.after
  }
}

/** Row writes by table and key, the last write of a key counting; null deletes. */
export class Writes {
  private readonly tables = new Map<string, Map<string, Row>>()

  set(table: string, key: string, value: unknown, fields?: Record<string, string>): void {
    let t = this.tables.get(table)
    if (!t) this.tables.set(table, (t = new Map()))
    t.set(key, { key, value, ...(fields ? { fields } : {}) })
  }

  /** The keys of `table` this change writes a row for under `prefix`, not those it deletes. */
  keysUnder(table: string, prefix: string): string[] {
    return [...(this.tables.get(table)?.values() ?? [])].filter((r) => r.value !== null && r.key.startsWith(prefix)).map((r) => r.key)
  }

  get size(): number {
    let n = 0
    for (const t of this.tables.values()) n += t.size
    return n
  }

  rows(): Record<string, Row[]> {
    return Object.fromEntries([...this.tables].map(([table, rows]) => [table, [...rows.values()]]))
  }
}

export const putPending = (w: Writes, path: LibraryPath, thing: Thing) => w.set(PENDING, path, thing, { kind: thing.bundle ? 'bundle' : 'file' })
/** A row of `tokens`; the thing's own place carries how the read ended, which `state` lets be counted. */
export const putToken = (w: Writes, place: Place, token: string, value: Observed) =>
  w.set(TOKENS, place, value, { token, ...(value.outcome ? { state: value.outcome.state } : {}) })

const identityOf = (index: SearchIndex) => `${ROWS}:${index.id}`

/** Folds one page of facts: the row writes and what the index is to do, in order. A directory thing registered swallows the things inside it. */
async function folded(records: RecordPlace, facts: readonly Fact[]): Promise<{ writes: Writes; ops: IndexOp[] }> {
  const writes = new Writes()
  const ops: IndexOp[] = []
  const forget = (path: LibraryPath) => {
    for (const table of [THINGS, PENDING, TOKENS]) writes.set(table, path, null)
    ops.push({ op: 'forget', path })
  }
  const learn = (path: LibraryPath, thing: Thing) => {
    writes.set(THINGS, path, thing)
    putPending(writes, path, thing)
  }
  for (const f of facts) {
    if (f.kind === 'gone') for (const p of f.paths) forget(p)
    else if (f.kind === 'moved') {
      for (const table of [THINGS, PENDING, TOKENS]) for (const p of [f.from, f.to]) writes.set(table, p, null)
      ops.push({ op: 'move', from: f.from, to: f.to })
      learn(f.to, { bundle: f.bundle })
    } else
      for (const t of f.things) {
        if (t.bundle) {
          for await (const page of pagesUnder<Thing>(records, THINGS, `${t.path}/`)) for (const r of page) forget(r.key as LibraryPath)
          for (const key of writes.keysUnder(THINGS, `${t.path}/`)) forget(key as LibraryPath)
        }
        learn(t.path, { bundle: t.bundle })
      }
  }
  return { writes, ops }
}

/**
 * Brings the rows up to the facts, a page at a time, each saved with its cursor while nobody saved
 * first; the index moves and forgets with them, before the rows say so. Rows of another index or of an
 * older shape are dropped first, and every registered thing is read again.
 */
export async function fold(ctx: PluginContext, index: SearchIndex): Promise<void> {
  const records = ctx.tools.storage.records
  const identity = identityOf(index)
  for (let tries = 0; ; tries++) {
    const { rows, cursor } = await records.get<string>(META, ['index'])
    if (rows[0]?.value !== identity && cursor !== null) {
      await records.reset()
      continue
    }
    const page = await records.since(cursor, FACT_PAGE)
    if (page === null) {
      // The facts the rows came from are not there any more: derive everything again.
      await records.reset()
      continue
    }
    const facts = page.facts.flatMap(({ fact }) => {
      const f = factOf(fact)
      return f === null ? [] : [f]
    })
    if (facts.length === 0 && page.cursor === cursor) return
    const { writes, ops } = await folded(records, facts)
    if (cursor === null) writes.set(META, 'index', identity)
    index.apply(ops)
    const put = await records.put(writes.rows(), { cursor: page.cursor, expect: cursor })
    if (put.written) {
      if (!page.more) return
    } else if (tries > 20) throw new Error('查找插件的行一直在被别的进程改写，没能读到一致的状态')
  }
}

/** Whether the rows describe this index: when not, what they say was read is not in it. */
export async function rowsDescribe(ctx: PluginContext, index: SearchIndex): Promise<boolean> {
  return (await ctx.tools.storage.records.get<string>(META, ['index'])).rows[0]?.value === identityOf(index)
}

const ancestors = (place: Place): Place[] => {
  const out: Place[] = []
  for (let i = place.lastIndexOf('/'); i > 0; i = place.lastIndexOf('/', i - 1)) out.push(place.slice(0, i))
  return out
}

/** The places among `looked` that are not as the rows expected: changed, gone, or not readable. One being written is looked at next time. */
const differing = (looked: Looked): Place[] => [...looked.changed.map((c) => c.place), ...looked.gone, ...looked.failed.map((f) => f.place)]

type Store = PluginContext['tools']['storage']

/** Every row of `tokens` compared by storage with what is there, a page at a time inside storage: the places that differ. */
async function differingEverywhere(store: Store): Promise<Place[]> {
  const out: Place[] = []
  for (let after: string | undefined; ; ) {
    const page = await store.lookRows(TOKENS, 'token', after === undefined ? {} : { after })
    out.push(...differing(page))
    if (page.more === null) return out
    after = page.more.after
  }
}

/**
 * The places storage named as changed, compared with the rows that expect something at them: the row
 * at each place and above it (a file new in a directory thing changes its directory), and the things
 * below a place that stands for its directory.
 */
async function differingAt(store: Store, places: readonly Place[]): Promise<Place[]> {
  const keys = new Set<Place>()
  for (const p of places) for (const k of [p, ...ancestors(p)]) keys.add(k)
  const rows = await rowsOf<Observed>(store.records, TOKENS, keys)
  const below = new Set<Place>()
  for (const p of places.filter((p) => !rows.has(p))) for await (const page of pagesUnder<Thing>(store.records, THINGS, `${p}/`)) for (const r of page) below.add(r.key)
  for (const [key, row] of await rowsOf<Observed>(store.records, TOKENS, below)) rows.set(key, row)
  const expected = [...rows.values()].flatMap((r) => (r.fields?.token === undefined ? [] : [{ place: r.key, token: r.fields.token }]))
  const out: Place[] = []
  for (let i = 0; i < expected.length; i += GET_PAGE) out.push(...differing(await store.look(expected.slice(i, i + GET_PAGE))))
  return out
}

/**
 * Learns what changed since the kept mark and makes the things there pending: from the places storage
 * names, or, when it cannot say, from every row of `tokens` compared inside storage. A row of a place
 * no registered thing expects any more is dropped.
 */
export async function noticeChanges(ctx: PluginContext): Promise<void> {
  const store = ctx.tools.storage
  const mark = (await store.records.get<string>(META, ['mark'])).rows[0]?.value ?? null
  const changes = await store.changed(mark)
  const places = changes.places !== null && changes.places.length <= PLACES_MAX ? await differingAt(store, changes.places) : await differingEverywhere(store)
  const writes = new Writes()
  const rows = await rowsOf<Observed>(store.records, TOKENS, places)
  const things = await rowsOf<Thing>(store.records, THINGS, [...rows.values()].map((r) => r.value.thing))
  for (const [place, row] of rows) {
    const thing = things.get(row.value.thing)?.value
    if (thing === undefined || (!thing.bundle && place !== row.value.thing)) writes.set(TOKENS, place, null)
    else putPending(writes, row.value.thing, thing)
  }
  if (writes.size === 0 && changes.mark === mark) return
  writes.set(META, 'mark', changes.mark)
  await store.records.put(writes.rows())
}

/** How many things are to be read, and how many directory things have more files than one thing takes. */
export async function counts(ctx: PluginContext): Promise<{ pending: number; tooMany: number }> {
  const records = ctx.tools.storage.records
  const [files, bundles, tooMany] = await Promise.all([records.count(PENDING, 'kind', 'file'), records.count(PENDING, 'kind', 'bundle'), records.count(TOKENS, 'state', 'too_many')])
  return { pending: files + bundles, tooMany }
}

