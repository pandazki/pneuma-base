// What the views and commands ask of the rows, each a few asks bounded by what it shows: a thing by
// its id or path, the items and scenes a page names, one kind of what needs looking at, the news since
// an actor was last here. Nothing here folds or looks; the caller brought the rows up first.
import type { Instant, LibraryPath, PluginContext, Row } from '@pneuma-base/kernel'
import { actorKey, inOrder, type Fact, type FactActor, type ItemId, type SceneId } from './facts.js'
import { archived, stateOfRow, type ActorRow, type HeldRow, type HistoryRow, type ItemRow, type MarkRow, type SceneRow, type SeenRow } from './model.js'
import { pagesOf, wherePages, type Records } from './rows.js'
import { basisMarks } from './settle.js'
import { doingAt, itemsOf, LIST_LIMIT, SINCE_LIMIT, STANDING_ORDER, type BasisView, type ItemView, type LastLook, type Lookup, type StandingKind, type StandingList, type Version } from './views.js'

type Read = Pick<Records, 'get' | 'under' | 'where' | 'count'>

const GET = 1000

/** The rows of a table with these keys, by key, in asks of at most GET keys. */
export async function getAll<V>(records: Pick<Records, 'get'>, table: string, keys: Iterable<string>): Promise<Map<string, V>> {
  const list = [...new Set(keys)]
  const out = new Map<string, V>()
  for (let i = 0; i < list.length; i += GET) for (const r of (await records.get<V>(table, list.slice(i, i + GET))).rows) out.set(r.key, r.value)
  return out
}

export const counters = async (records: Pick<Records, 'get'>): Promise<Record<string, number>> => (await records.get<Record<string, number>>('meta', ['counts'])).rows[0]?.value ?? {}

/** The items and the scenes these facts name, and these scenes besides. */
export async function lookupOf(records: Pick<Records, 'get'>, facts: readonly Fact[], more: { items?: Iterable<ItemId>; scenes?: Iterable<SceneId> } = {}): Promise<Lookup> {
  const items = await getAll<ItemRow>(records, 'items', [...facts.flatMap(itemsOf), ...(more.items ?? [])])
  const scenes = await getAll<SceneRow>(records, 'scenes', [...facts.map((f) => f.scene), ...(more.scenes ?? [])])
  return { items: items as Map<ItemId, ItemRow>, scenes: scenes as Map<SceneId, SceneRow> }
}

/** The item a path names now: the one recorded there, else, for a content path, the one archived from it. */
export async function itemAtPath(records: Pick<Records, 'get'>, ctx: PluginContext, path: LibraryPath): Promise<ItemRow | undefined> {
  const keys = [path, ...(ctx.tools.regionOf(path) === 'content' ? [ctx.tools.archivedPath(path)] : [])]
  const held = await getAll<{ id: ItemId }>(records, 'paths', keys)
  const id = keys.map((k) => held.get(k)?.id).find((x) => x !== undefined)
  return id === undefined ? undefined : (await getAll<ItemRow>(records, 'items', [id])).get(id)
}

/** The item an input names: its id, its path, or the path it had before it was archived. */
export async function itemNamed(ctx: PluginContext, input: string): Promise<ItemRow | undefined> {
  const records = ctx.tools.storage.records
  if (input.startsWith('i_')) {
    const byId = (await getAll<ItemRow>(records, 'items', [input])).get(input)
    if (byId) return byId
  }
  const resolved = await ctx.tools.resolve(input)
  if (resolved === null || resolved.region === 'kernel') return undefined
  return itemAtPath(records, ctx, resolved.path)
}

const SCENE_PREFIX_MIN = 6

/** The scenes an input names: the one with that id, else those whose id starts with it when it has at least 6 characters; at most `limit`, and whether there are more. */
export async function scenesNamed(records: Read, input: string, limit = 10): Promise<{ scenes: SceneRow[]; more: boolean }> {
  if (input === '') return { scenes: [], more: false }
  const exact = (await records.get<SceneRow>('scenes', [input])).rows[0]?.value
  if (exact) return { scenes: [exact], more: false }
  if (input.length < SCENE_PREFIX_MIN) return { scenes: [], more: false }
  const page = await records.under<SceneRow>('scenes', input, { limit })
  return { scenes: page.rows.map((r) => r.value), more: page.more !== null }
}

// ---- one thing ----

/** How many rows of an item's history inspect and the panel read at most. */
const HISTORY = 1000

/** An item as inspect and the item panel show it, from its rows: its sources with their marks, what was made from it, its versions and what was said, its held copies. */
export async function itemViewOf(records: Read, item: ItemRow): Promise<ItemView> {
  const tx = { get: async <V>(table: string, key: string) => (await getAll<V>(records, table, [key])).get(key) }
  const bundle = item.absorbedInto === null ? undefined : await tx.get<ItemRow>('items', item.absorbedInto)
  const marks = await basisMarks(tx, item)
  const basis: BasisView[] = await Promise.all(
    marks.map(async (m, i) => {
      const source = m.source
      const sb = source?.absorbedInto ? await tx.get<ItemRow>('items', source.absorbedInto) : undefined
      return {
        item: m.item,
        path: source?.path ?? m.item,
        fingerprint: item.basis.items[i]?.fingerprint ?? null,
        state: source ? stateOfRow(source, sb).kind : 'removed',
        mark: m.mark === 'gone' ? ('source-gone' as const) : m.mark,
      }
    }),
  )
  const dependents = [...(await getAll<ItemRow>(records, 'items', item.dependents)).values()].map((d) => ({ item: d.id, path: d.path }))
  const history: HistoryRow[] = []
  for await (const page of pagesOf<HistoryRow>(records, 'history', `${item.id}|`)) {
    history.push(...page.map((r) => r.value))
    if (history.length >= HISTORY) break
  }
  const held = await heldOf(records, item.id)
  const absorbedInto = bundle?.path ?? null
  const scene = await tx.get<SceneRow>('scenes', item.entered.scene)
  const looked = item.bundle ? ((await tx.get<LastLook>('meta', 'looked')) ?? null) : null
  return {
    kind: 'item',
    item: item.id,
    path: item.path,
    origin: item.origin,
    entered: item.entered,
    earlier: item.earlier,
    doing: doingAt(scene, item.entered.at),
    basis,
    outside: item.basis.outside,
    dependents,
    said: saidOf(item, history, scene),
    state: stateOfRow(item, bundle),
    fingerprint: item.fingerprint,
    versions: history.filter((h): h is Version => h.kind === 'version'),
    held: held.map((h) => h.path),
    archived: archived(item),
    absorbedInto,
    unknownOrigin: item.unknownOrigin,
    bundle: item.bundle,
    looked,
  }
}

/** What was said about an item, and what its scene said that was about nothing in particular, by time, each once. */
function saidOf(item: ItemRow, history: readonly HistoryRow[], scene: SceneRow | undefined): ItemView['said'] {
  const about = history.flatMap((h) => (h.kind === 'said' ? [{ ...h, scene: h.scene }] : []))
  const ownScene = (scene?.said ?? []).filter((x) => x.about === null && x.flavor !== 'doing').map((x) => ({ ...x, scene: scene?.id as SceneRow['id'] }))
  const merged = [...new Map([...about, ...ownScene].map((x) => [x.id, x])).values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return merged.map((x) => ({ flavor: x.flavor, text: x.text, at: x.at, scene: x.scene, actor: x.actor, about: x.about === null ? null : x.about === item.id ? item.path : x.about }))
}

/** The held copies of one item, from their rows. */
export async function heldOf(records: Pick<Records, 'under'>, item: ItemId): Promise<HeldRow[]> {
  const out: HeldRow[] = []
  for await (const page of pagesOf<HeldRow>(records, 'held', `${item}|`)) out.push(...page.map((r) => r.value))
  return out
}


// ---- what needs looking at ----

/** What storage counts at most; a count that reaches it says 「至少」. */
const COUNT_CAP = 10_000

/**
 * One kind of what needs looking at: `limit` rows by key after `after` (from an earlier answer), how
 * many there are in all, and where the next ones start; archived ones only when asked.
 */
export async function standingList(records: Read, kind: StandingKind, includeArchived: boolean, limit = LIST_LIMIT, after?: string): Promise<StandingList & { after: string | null }> {
  const fields = (includeArchived ? ['-', 'a'] : ['-']).map((flag) => `${kind}:${flag}`)
  const rows: MarkRow[] = []
  let count = 0
  let next: string | null = null
  // A key carries the field it was read under: `<kind>:<flag>:<path>`.
  const from = after === undefined ? 0 : Math.max(0, fields.findIndex((f) => after.startsWith(`${f}:`)))
  for (const [i, field] of fields.entries()) {
    count += await records.count('marks', 'kind', field)
    if (i < from || rows.length >= limit) continue
    const page = await records.where<MarkRow>('marks', 'kind', field, { limit: limit - rows.length, ...(after !== undefined && i === from ? { after } : {}) })
    rows.push(...page.rows.map((r) => r.value))
    next = page.more?.after ?? (rows.length >= limit && i + 1 < fields.length ? `${fields[i + 1]}:` : null)
  }
  return { kind, count, atLeast: count >= COUNT_CAP, rows, after: next }
}

/** Every kind of what needs looking at, each with its first rows and how many. */
export async function standingLists(records: Read, includeArchived: boolean, limit = LIST_LIMIT, kinds: readonly StandingKind[] = STANDING_ORDER): Promise<(StandingList & { after: string | null })[]> {
  return Promise.all(kinds.map((k) => standingList(records, k, includeArchived, limit)))
}

/** The open directories with more entries than one look lists, and at least how many more. */
export async function partialDirs(records: Read): Promise<{ dir: string; atLeast: number }[]> {
  const page = await records.where<SeenRow>('seen', 'more', 'y', { limit: 50 })
  return page.rows.map((r) => ({ dir: r.key, atLeast: r.value.more }))
}

/** The open directories with loose files nobody registered or left, page by page. */
export async function* looseDirs(records: Read): AsyncGenerator<Row<SeenRow>[]> {
  yield* wherePages<SeenRow>(records, 'seen', 'loose', 'y', 200)
}

// ---- since last time ----

/** How many rows of the log one question reads at most: past them it says what it found. */
const SCAN_LIMIT = 2000
const NEWS_PAGE = 200

/**
 * When this actor was last here: its latest look (a check, or the owner's 都看过了), else, before it
 * ever looked, its latest fact in another scene; null when it never was.
 */
export function lastHereOf(row: ActorRow | undefined, current: SceneId): Instant | null {
  if (row === undefined) return null
  if (row.checked !== null) return row.checked
  if (row.last.scene !== current) return row.last.at
  return row.other?.at ?? null
}

/**
 * The latest facts that are news to `me` since it was last here (or since the moment given), in the
 * order they happened. Setup commands are already in PNEUMA-BASE.md when an agent first comes, so
 * they are news only after its earliest visit, unless a moment is given.
 */
export async function newsSince(records: Read, me: FactActor, current: SceneId, since: Instant | 'last' | null): Promise<{ since: Instant | null; facts: Fact[] }> {
  const mine = actorKey(me)
  const row = (await records.get<ActorRow>('actors', [mine])).rows[0]?.value
  const explicit = since !== null && since !== 'last'
  const start = explicit ? since : lastHereOf(row, current)
  const firstSeen = row?.first ?? null
  const found: Fact[] = []
  let read = 0
  scan: for await (const page of wherePages<Fact>(records, 'log', 'news', 'y', NEWS_PAGE)) {
    for (const { value: f } of page) {
      read++
      if (start !== null && f.at <= start) break scan
      if (actorKey(f.actor) === mine || f.scene === current) continue
      if (!explicit && f.kind === 'owner.op' && f.setup && (firstSeen === null || f.at <= firstSeen)) continue
      found.push(f)
      if (found.length >= SINCE_LIMIT) break scan
    }
    if (read >= SCAN_LIMIT) break
  }
  return { since: start, facts: inOrder(found) }
}

/** The agents that ever left a fact here, at most `limit`. */
export async function agentsOf(records: Read, limit = 50): Promise<FactActor[]> {
  const page = await records.where<ActorRow>('actors', 'kind', 'agent', { limit })
  return page.rows.map((r) => r.value.actor)
}
