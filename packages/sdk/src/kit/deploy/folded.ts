// The deploy kit's records as rows: what is declared, the aliases of a path declared twice, and what
// each target holds, folded from the facts and kept with the cursor they reach. A hook reads the rows
// and folds only the facts after that cursor. The fold is in id order, so a fact that comes in behind
// the last one folded (from another machine, by sync) means folding every fact again.
import type { RecordPlace, Row } from '../../storage.js'
import type { PluginContext } from '../../types.js'
import type { RecordStore, Skipped } from '../records.js'
import { apply, fold, type Declared, type Deployments, type Fact, type FactBody, type OnTarget, type TargetKey, type ThingId } from './facts.js'
import type { SiteName } from './model.js'

const THINGS = 'things'
const ALIAS = 'alias'
const SITES = 'sites'
/** The last fact id folded, and the facts that are not records. */
const FOLD = 'fold'
const TABLES = [THINGS, ALIAS, SITES] as const
const PAGE = 10_000

type SiteRow = OnTarget & { target: TargetKey; site: SiteName }
type Tables = Record<(typeof TABLES)[number], Map<string, unknown>>

const siteKey = (target: string, site: string) => `${target}\n${site}`

async function allRows<V>(records: RecordPlace, table: string): Promise<Row<V>[]> {
  const out: Row<V>[] = []
  for (let after: string | undefined; ; ) {
    const page = await records.under<V>(table, '', { limit: PAGE, ...(after === undefined ? {} : { after }) })
    out.push(...page.rows)
    if (page.more === null) return out
    after = page.more.after
  }
}

async function loaded(records: RecordPlace): Promise<Deployments> {
  const [things, alias, sites] = await Promise.all([allRows<Declared>(records, THINGS), allRows<ThingId>(records, ALIAS), allRows<SiteRow>(records, SITES)])
  const d: Deployments = { things: new Map(), byPath: new Map(), sites: new Map(), alias: new Map() }
  for (const { value } of things) {
    d.things.set(value.id, value)
    d.byPath.set(value.path, value.id)
  }
  for (const { key, value } of alias) d.alias.set(key as ThingId, value)
  for (const { value } of sites) {
    const { target, site, ...on } = value
    const held = d.sites.get(target) ?? new Map<SiteName, OnTarget>()
    d.sites.set(target, held.set(site, on))
  }
  return d
}

/** The rows a fold is kept as, by table and key, each a copy. */
function tablesOf(d: Deployments): Tables {
  const sites = new Map<string, unknown>()
  for (const [target, held] of d.sites) for (const [site, on] of held) sites.set(siteKey(target, site), { ...on, target, site })
  return { [THINGS]: new Map([...d.things].map(([id, t]) => [id, { ...t }])), [ALIAS]: new Map(d.alias), [SITES]: sites }
}

/** The rows that differ between two folds; a row gone is written as null. */
function changes(before: Tables, after: Tables): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  for (const table of TABLES) {
    const rows: Row[] = []
    for (const [key, value] of after[table]) if (JSON.stringify(before[table].get(key)) !== JSON.stringify(value)) rows.push({ key, value })
    for (const key of before[table].keys()) if (!after[table].has(key)) rows.push({ key, value: null })
    if (rows.length > 0) out[table] = rows
  }
  return out
}

const byId = (a: Fact, b: Fact) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const lastOf = (facts: readonly Fact[], last: string | null) => facts.reduce((m, f) => (m === null || f.id > m ? f.id : m), last)

/**
 * The records folded, and the facts that are not records: the rows, with the facts after their cursor
 * folded in, or every fact folded again when one came in behind the last folded. The rows are saved
 * when they moved; when another process saved first, what this one folded is still right for it.
 */
export async function foldedRecords(ctx: PluginContext, store: RecordStore<FactBody>): Promise<{ d: Deployments; skipped: Skipped[] }> {
  const { records } = ctx.tools.storage
  for (;;) {
    const { rows: meta, cursor } = await records.get<unknown>(FOLD, ['last', 'skipped'])
    const last = (meta.find((r) => r.key === 'last')?.value as string | undefined) ?? null
    const known = (meta.find((r) => r.key === 'skipped')?.value as Skipped[] | undefined) ?? []
    const fresh: Fact[] = []
    const skipped: Skipped[] = []
    let at = cursor
    let fits = true
    for (;;) {
      const page = await store.since(at)
      if (page === null) {
        fits = false
        break
      }
      fresh.push(...page.records)
      skipped.push(...page.skipped)
      at = page.cursor
      if (!page.more) break
    }
    if (!fits) {
      // The facts no longer fit the cursor: derive every row again.
      await records.reset()
      continue
    }
    if (at === cursor) return { d: await loaded(records), skipped: known }
    const d = await loaded(records)
    const before = tablesOf(d)
    fresh.sort(byId)
    let folded: { d: Deployments; skipped: Skipped[]; last: string | null }
    if (last === null || fresh.every((f) => f.id > last)) {
      for (const f of fresh) apply(d, f)
      folded = { d, skipped: [...known, ...skipped], last: lastOf(fresh, last) }
    } else {
      const all = await store.read()
      folded = { d: fold(all.records), skipped: all.skipped, last: lastOf(all.records, null) }
    }
    const rows = { ...changes(before, tablesOf(folded.d)), [FOLD]: [{ key: 'last', value: folded.last }, { key: 'skipped', value: folded.skipped }] }
    await records.put(rows, { cursor: at as string, expect: cursor })
    return { d: folded.d, skipped: folded.skipped }
  }
}
