// The plugin's rows, derived from its facts and saved with the fact cursor they reached (STORAGE.md
// section 5). `things`: each declared thing with its versions, by id; field `path` is its current path,
// `gone` the path it had when the owner deleted it. `tokens`: one row per thing in the library, keyed by
// its current path, so storage can compare them all (`lookRows`); field `token` is what storage said was
// there when its latest version was recorded or checked, absent until then and after the fold changed
// its path or its versions.
import type { Place, PluginContext, RecordPlace, Row } from '@pneuma-base/kernel'
import { parseFact, type Fact, type ThingId } from './facts.js'
import { fold, type Thing } from './model.js'

type Records = PluginContext['tools']['storage']['records']
export type TokenRow = { thing: ThingId }
/** A token observed at a thing's path. */
export type Seen = TokenRow & { token: string }

/** Rows of an earlier shape are derived again. */
const ROWS_VERSION = 1
const FACT_PAGE = 1000
/** How many keys one read asks for, and how many rows one page of a listing brings. */
const PAGE = 1000

const thingRow = (t: Thing): Row => ({ key: t.id, fields: t.gone ? { gone: t.path } : { path: t.path }, value: t })
/** Facts after which the token on record no longer says the content is the latest version. */
const UNSEEN: ReadonlySet<Fact['kind']> = new Set(['declare', 'version', 'move', 'gone'])

async function getAll<V>(records: Pick<RecordPlace, 'get'>, table: string, keys: readonly string[]): Promise<Row<V>[]> {
  const out: Row<V>[] = []
  for (let i = 0; i < keys.length; i += PAGE) out.push(...(await records.get<V>(table, keys.slice(i, i + PAGE))).rows)
  return out
}

/** The rows a page of facts changes: the things they are about, and their token rows where a thing moved, was deleted, or got a version. */
async function folded(records: Records, facts: readonly Fact[]): Promise<{ things: Row[]; tokens: Map<Place, Row> }> {
  const ids = [...new Set(facts.map((f) => f.thing))]
  const before = new Map((await getAll<Thing>(records, 'things', ids)).map((r) => [r.value.id, r.value]))
  const things = new Map([...before].map(([id, t]) => [id, structuredClone(t)]))
  fold(things, facts)
  const dropped = new Set<Place>()
  const unseen = new Map<Place, Row>()
  for (const id of new Set(facts.filter((f) => UNSEEN.has(f.kind)).map((f) => f.thing))) {
    const was = before.get(id)
    const now = things.get(id)
    if (!now) continue
    if (was && !was.gone && (was.path !== now.path || now.gone)) dropped.add(was.path)
    if (!now.gone) unseen.set(now.path, { key: now.path, value: { thing: id } satisfies TokenRow })
  }
  const tokens = new Map<Place, Row>([...dropped].map((key) => [key, { key, value: null }]))
  for (const [key, row] of unseen) tokens.set(key, row)
  return { things: ids.flatMap((id) => (things.has(id) ? [thingRow(things.get(id) as Thing)] : [])), tokens }
}

/**
 * Brings the rows up to the facts, a page at a time, each page saved with the cursor it reached while
 * the saved one is still the one it started from. `seen`: tokens observed at things' paths, saved with
 * the last page.
 */
export async function syncRows(records: Records, seen: ReadonlyMap<Place, Seen> = new Map()): Promise<void> {
  for (let tries = 0; ; tries++) {
    const { rows, cursor } = await records.get<number>('meta', ['version'])
    if (cursor !== null && rows[0]?.value !== ROWS_VERSION) {
      await records.reset()
      continue
    }
    const page = await records.since(cursor, FACT_PAGE)
    if (page === null) {
      // The facts the rows came from are not there any more: derive everything again.
      await records.reset()
      continue
    }
    const facts = page.facts.flatMap(({ fact }) => parseFact(fact) ?? [])
    if (facts.length === 0 && page.cursor === cursor && !page.more && seen.size === 0) return
    const { things, tokens } = await folded(records, facts)
    if (!page.more) for (const [key, { thing, token }] of seen) tokens.set(key, { key, fields: { token }, value: { thing } satisfies TokenRow })
    const tables: Record<string, Row[]> = { things, tokens: [...tokens.values()] }
    if (cursor === null) tables.meta = [{ key: 'version', value: ROWS_VERSION }]
    const put = await records.put(tables, { cursor: page.cursor, expect: cursor })
    if (put.written) {
      if (!page.more) return
    } else if (tries > 20) throw new Error('版本插件的行一直在被别的进程改写，没能读到一致的状态')
  }
}

/** The token on record at a thing's path; null when none is. */
export async function tokenAt(records: Records, path: Place): Promise<string | null> {
  return (await records.get('tokens', [path])).rows[0]?.fields?.token ?? null
}

/** The thing whose current path is `path`, of those in the library (`path`) or deleted from it (`gone`). */
export async function thingWhere(records: Records, field: 'path' | 'gone', path: Place): Promise<Thing | undefined> {
  return (await records.where<Thing>('things', field, path, { limit: 1 })).rows[0]?.value
}

/** The things with these ids. */
export async function thingsOf(records: Records, ids: readonly ThingId[]): Promise<Thing[]> {
  return (await getAll<Thing>(records, 'things', ids)).map((r) => r.value)
}

/** The things of the token rows at these paths: each one in the library at its path. */
export async function thingsAt(records: Records, paths: readonly Place[]): Promise<Thing[]> {
  const ids = (await getAll<TokenRow>(records, 'tokens', paths)).map((r) => r.value.thing)
  const at = new Set(paths)
  return (await thingsOf(records, ids)).filter((t) => !t.gone && at.has(t.path))
}

/** Every declared thing, a page of rows at a time. */
export async function* thingPages(records: Records): AsyncGenerator<Thing[]> {
  for (let after: string | undefined; ; ) {
    const page = await records.under<Thing>('things', '', { limit: PAGE, ...(after === undefined ? {} : { after }) })
    if (page.rows.length > 0) yield page.rows.map((r) => r.value)
    if (page.more === null) return
    after = page.more.after
  }
}
