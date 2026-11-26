// check's reconciliation on the sparse rules (tmp/run-7 architecture.md section 5): compare the tokens of
// the registered places; list one level of an open directory only when the directory's own token
// changed; a closed directory is one entry of the level above, never opened; noise is never mentioned,
// since storage leaves it out. What it saw is kept as rows that may be thrown away: each registered
// place's token as last accepted, and each open directory's last listing.
import { isDescribed, isFailure, KERNEL_ENTRIES, placeIn, type Description, type Glanced, type LibraryPath, type Place, type PlaceKind, type PluginContext, type Row } from '@pneuma-base/kernel'
import type { ItemId } from './facts.js'
import { withMarks, type ItemState, type Standing } from './reconcile.js'
import { stateOf, type LedgerState, type Slim } from './state.js'

/** How many entries of a directory one look lists. */
export const OVERVIEW = 200

/** A registered place as last accepted: its token, and for a directory registered as one thing, its first level's. */
export type Baseline = { kind: PlaceKind; token: string; size: number | null; modified: string | null; entries?: { name: string; token: string }[] }
/** One entry of an open directory's listing. */
export type Entry = { name: string; kind: PlaceKind; size: number | null; modified: string | null; token: string | null }
/** An open directory as last listed: its token then, its first entries by name, and at least how many more it had. */
export type Seen = { token: string; entries: Entry[]; more: number; unreadable?: true }

export type Stray = Entry & { place: Place }
export type Sparse = { standing: Standing; moved: Map<ItemId, Stray>; state: LedgerState }

const nameOf = (place: Place) => place.slice(place.lastIndexOf('/') + 1)
const described = (g: Glanced | undefined): Description | null => (g === undefined || !isDescribed(g) || g.kind === 'none' ? null : g)
const entryOf = (d: Description): Entry => ({ name: nameOf(d.place), kind: d.kind, size: d.size ?? null, modified: d.modified ?? null, token: d.token ?? null })

async function allRows<V>(ctx: PluginContext, table: string): Promise<Row<V>[]> {
  const out: Row<V>[] = []
  let after: string | undefined
  for (;;) {
    const page = await ctx.tools.storage.records.under<V>(table, '', { limit: 10000, ...(after === undefined ? {} : { after }) })
    out.push(...page.rows)
    if (page.more === null) return out
    after = page.more.after
  }
}

/** A registered place's baseline from what storage says it is now; a directory's first level comes with it. */
async function baselineOf(ctx: PluginContext, d: Description): Promise<Baseline> {
  const base: Baseline = { kind: d.kind, token: d.token ?? '', size: d.size ?? null, modified: d.modified ?? null }
  if (d.kind !== 'dir') return base
  const page = await ctx.tools.storage.overview(d.place, { limit: OVERVIEW })
  return { ...base, entries: isFailure(page) ? [] : page.entries.map((e) => ({ name: nameOf(e.place), token: e.token ?? '' })) }
}

/**
 * Takes what is at these places now as what was recorded there: after the ledger recorded a put, a
 * claimed change or a move, so the next check compares against the content the record speaks of.
 */
export async function rebase(ctx: PluginContext, paths: readonly LibraryPath[]): Promise<void> {
  if (paths.length === 0) return
  const rows: Row[] = []
  for (const g of await ctx.tools.storage.glance(paths)) {
    const d = described(g)
    rows.push({ key: g.place, value: d === null ? null : await baselineOf(ctx, d) })
  }
  await ctx.tools.storage.records.put({ tokens: rows })
}

/** The standing of the operation under way, by library and moment: check and its asks, or the home page and its asks, look once. */
let lastLook: { key: string; answer: Promise<Sparse> } | null = null

/**
 * How the library stands: each item's state, the strays of the open directories, the closed
 * directories in them. Confirmed against puts, which land their files before their records: what a
 * put in progress or a fact folded after the look names is judged by its record. One operation looks once.
 */
export function sparseStanding(ctx: PluginContext): Promise<Sparse> {
  const key = `${ctx.dir}\0${ctx.now}\0${ctx.session.id}`
  if (lastLook?.key === key) return lastLook.answer
  const answer = lookNow(ctx)
  lastLook = { key, answer }
  answer.catch(() => {
    if (lastLook?.answer === answer) lastLook = null
  })
  return answer
}

async function lookNow(ctx: PluginContext): Promise<Sparse> {
  const store = ctx.tools.storage
  const { state } = await stateOf(ctx)
  const open = new Set<Place>(['', ...state.dirs.keys()])
  const [baselines, seenRows] = await Promise.all([allRows<Baseline>(ctx, 'tokens'), store.records.get<Seen>('seen', [...open])])
  const base = new Map(baselines.map((r) => [r.key, r.value]))
  const seen = new Map(seenRows.rows.map((r) => [r.key, r.value]))
  const live = [...state.items.values()].filter((item) => !item.removed && item.absorbedInto === null)

  const looks: { place: Place; token: string }[] = []
  const glances: Place[] = []
  for (const item of live) {
    const b = base.get(item.path)
    if (b === undefined) glances.push(item.path)
    else looks.push({ place: item.path, token: b.token }, ...(b.entries ?? []).map((e) => ({ place: `${item.path}/${e.name}`, token: e.token })))
  }
  for (const dir of open) {
    const s = seen.get(dir)
    if (s === undefined) glances.push(dir)
    else looks.push({ place: dir, token: s.token })
  }
  const [looked, glanced] = await Promise.all([looks.length > 0 ? store.look(looks) : { same: 0, changed: [], gone: [], failed: [] }, glances.length > 0 ? store.glance(glances) : []])
  const changed = new Map(looked.changed.map((c) => [c.place, c.entry]))
  const gone = new Set([...looked.gone, ...looked.failed.map((f) => f.place)])
  const glance = new Map(glanced.map((g) => [g.place, g]))
  const seenRowsOut: Row[] = []
  const tokenRows: Row[] = []

  // An open directory is listed again only when its own token changed.
  for (const dir of open) {
    const fresh = seen.has(dir) ? changed.get(dir) : (described(glance.get(dir)) ?? undefined)
    if (gone.has(dir) || (fresh !== undefined && fresh.kind !== 'dir') || (!seen.has(dir) && fresh === undefined)) {
      if (seen.delete(dir)) seenRowsOut.push({ key: dir, value: null })
      continue
    }
    if (fresh === undefined) continue
    const page = await store.overview(dir, { limit: OVERVIEW })
    const s: Seen = isFailure(page) ? { token: fresh.token ?? '', entries: [], more: 0, unreadable: true } : { token: fresh.token ?? '', entries: page.entries.map(entryOf), more: page.more?.at_least ?? 0 }
    seen.set(dir, s)
    seenRowsOut.push({ key: dir, value: s })
  }

  const states = new Map<ItemId, ItemState>()
  const missing: Slim[] = []
  for (const item of state.items.values()) {
    if (item.removed) states.set(item.id, { kind: 'removed' })
    else if (item.absorbedInto !== null) states.set(item.id, { kind: 'absorbed', into: item.absorbedInto, now: null })
    else {
      const b = base.get(item.path)
      if (b !== undefined) {
        const inner = (b.entries ?? []).some((e) => changed.has(`${item.path}/${e.name}`) || gone.has(`${item.path}/${e.name}`))
        if (gone.has(item.path)) missing.push(item)
        else states.set(item.id, changed.has(item.path) || inner ? { kind: 'changed', now: null } : { kind: 'consistent' })
        continue
      }
      // First sight of a place: what is there is taken as what was recorded when its kind fits, and a file's size too.
      const d = described(glance.get(item.path))
      if (d === null) missing.push(item)
      else if (d.kind !== (item.bundle ? 'dir' : 'file') || (!item.bundle && d.size !== item.size)) states.set(item.id, { kind: 'changed', now: null })
      else {
        const accepted = await baselineOf(ctx, d)
        base.set(item.path, accepted)
        tokenRows.push({ key: item.path, value: accepted })
        states.set(item.id, { kind: 'consistent' })
      }
    }
  }

  // The entries of the open directories that nothing registered holds: loose files, and closed directories.
  const strays: Stray[] = []
  for (const [dir, s] of seen) {
    for (const e of s.entries) {
      const place = placeIn(dir, e.name)
      if ((dir === '' && KERNEL_ENTRIES.has(e.name)) || state.paths.has(place as LibraryPath) || open.has(place) || (e.kind !== 'file' && e.kind !== 'dir')) continue
      strays.push({ ...e, place })
    }
  }
  // A missing thing moved where exactly one stray of its kind, size and moment is, which no other missing thing could be.
  const key = (kind: PlaceKind, size: number | null, modified: string | null) => (size === null || modified === null ? null : `${kind}|${size}|${modified}`)
  const holders = new Map<string, Stray[]>()
  for (const s of strays) {
    const k = key(s.kind, s.size, s.modified)
    if (k !== null) holders.set(k, [...(holders.get(k) ?? []), s])
  }
  const wanted = new Map<string, number>()
  const keyOfItem = (item: Slim) => {
    const b = base.get(item.path)
    return b === undefined ? null : key(b.kind, b.size, b.modified)
  }
  for (const item of missing) {
    const k = keyOfItem(item)
    if (k !== null) wanted.set(k, (wanted.get(k) ?? 0) + 1)
  }
  const moved = new Map<ItemId, Stray>()
  for (const item of missing) {
    const k = keyOfItem(item)
    const found = k === null ? [] : (holders.get(k) ?? [])
    const to = found.length === 1 && wanted.get(k as string) === 1 ? found[0] : undefined
    if (to !== undefined) {
      moved.set(item.id, to)
      states.set(item.id, { kind: 'moved', to: to.place as LibraryPath })
    } else states.set(item.id, { kind: 'missing' })
  }
  const taken = new Set([...moved.values()].map((s) => s.place))

  const rows: Record<string, Row[]> = {}
  if (seenRowsOut.length > 0) rows.seen = seenRowsOut
  if (tokenRows.length > 0) rows.tokens = tokenRows
  if (Object.keys(rows).length > 0) await store.records.put(rows)

  // Confirm against puts: the paths being put now, and what the facts folded after the look name.
  const putting = await ctx.tools.putting()
  const after = await stateOf(ctx)
  const paths = new Set<string>([...putting, ...after.named.paths])
  for (const id of after.state.items.keys()) if (!states.has(id)) states.set(id, { kind: 'consistent' })
  for (const [id, s] of states) {
    if (s.kind !== 'changed' && s.kind !== 'moved' && s.kind !== 'missing') continue
    const item = after.state.items.get(id)
    if (item && (after.named.items.has(id) || paths.has(item.path) || (s.kind === 'moved' && paths.has(s.to)))) {
      states.set(id, { kind: 'consistent' })
      moved.delete(id)
    }
  }
  // A file absorbed into a directory-thing holds what was recorded while the directory does; gone with it; unknown once it changed.
  for (const [id, s] of states) {
    if (s.kind !== 'absorbed') continue
    const bundle = states.get(s.into)?.kind
    const recorded = after.state.items.get(id)?.fingerprint ?? null
    states.set(id, { ...s, now: bundle === 'consistent' || bundle === 'moved' ? recorded : bundle === 'changed' ? 'unknown' : null })
  }
  const stray = (s: Stray) => !taken.has(s.place) && !paths.has(s.place) && !after.state.paths.has(s.place as LibraryPath)
  const unowned = strays.filter((s) => s.kind === 'file' && stray(s)).map((s) => s.place as LibraryPath)
  const closed = strays.filter((s) => s.kind === 'dir' && stray(s)).map((s) => s.place as LibraryPath)
  const more = [...seen].filter(([, s]) => s.more > 0).map(([dir, s]) => ({ dir: dir as LibraryPath | '', atLeast: s.more }))
  return { standing: { ...withMarks(after.state, states, unowned), closed, more }, moved, state: after.state }
}

/** A moved thing's new place, as the look saw it, kept as its baseline. */
export async function rebaseMoved(ctx: PluginContext, moved: ReadonlyMap<ItemId, Stray>): Promise<void> {
  const rows: Row[] = []
  for (const s of moved.values()) if (s.token !== null) rows.push({ key: s.place, value: { kind: s.kind, token: s.token, size: s.size, modified: s.modified } satisfies Baseline })
  if (rows.length > 0) await ctx.tools.storage.records.put({ tokens: rows })
}
