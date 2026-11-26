// reconcile: the ledger against a snapshot of the files. Pure apart from the fingerprint function
// it is handed. ledger-design.md section 4.
import type { Fingerprint, LibraryPath } from '@pneuma-base/kernel'
import type { ItemId } from './facts.js'
import type { ItemRecord, Ledger } from './fold.js'

export type ItemState =
  | { kind: 'consistent' }
  | { kind: 'changed'; now: Fingerprint }
  | { kind: 'moved'; to: LibraryPath }
  | { kind: 'missing' }
  | { kind: 'removed' }
  | { kind: 'absorbed'; into: ItemId; now: Fingerprint | null } // its file is part of a bundle now; `now` is that file's content

export type Mark = { kind: 'stale'; source: ItemId; recorded: Fingerprint; now: Fingerprint } | { kind: 'source-gone'; source: ItemId }

/**
 * The one place an item's state is decided. `disk` is the fingerprint of the thing at the item's
 * recorded path, null when nothing is there; `movedTo` is the one unowned thing that holds its content.
 */
export function classify(item: ItemRecord, disk: Fingerprint | null, movedTo: LibraryPath | null): ItemState {
  if (item.removed) return { kind: 'removed' }
  if (item.absorbedInto !== null) return { kind: 'absorbed', into: item.absorbedInto, now: disk }
  if (disk !== null) return disk === item.fingerprint ? { kind: 'consistent' } : { kind: 'changed', now: disk }
  return movedTo !== null ? { kind: 'moved', to: movedTo } : { kind: 'missing' }
}

/** The content an item has on disk now; null when it has no file. */
function contentNow(item: ItemRecord, state: ItemState): Fingerprint | null {
  if (state.kind === 'changed' || state.kind === 'absorbed') return state.now
  return state.kind === 'consistent' || state.kind === 'moved' ? item.fingerprint : null
}

/**
 * A snapshot of the library's things outside the kernel's own (its files outside bundles, and its
 * bundles): each one's size, and on demand the fingerprint of the thing at any path, null when none.
 */
export type Files = { sizes: ReadonlyMap<LibraryPath, number>; fingerprint(path: LibraryPath): Promise<Fingerprint | null> }

export type Standing = {
  states: Map<ItemId, ItemState>
  unowned: LibraryPath[] // files no item holds, moved items' new files left out
  marks: Map<ItemId, Mark[]> // items with a stale or gone source in their direct basis
  upstream: Map<ItemId, ItemId[]> // items with marked things further up their basis: those things
}

/**
 * The things no item holds, and which of them are items that moved there: exactly one of them holds
 * a missing item's content, and no other missing item has that content. Takes the fingerprint of only
 * those whose size matches an item that has no file at its path.
 */
async function strays(ledger: Ledger, files: Files): Promise<{ missing: ItemRecord[]; movedTo: Map<ItemId, LibraryPath>; unowned: LibraryPath[] }> {
  // An absorbed item's file lies inside a bundle, which the snapshot lists as one thing.
  const missing = [...ledger.items.values()].filter((item) => !item.removed && item.absorbedInto === null && !files.sizes.has(item.path))
  const unowned = [...files.sizes.keys()].filter((path) => !ledger.pathIndex.has(path))
  const sizes = new Set(missing.map((item) => item.size))
  const holders = new Map<Fingerprint, LibraryPath[]>()
  for (const path of unowned) {
    if (!sizes.has(files.sizes.get(path) ?? -1)) continue
    const print = await files.fingerprint(path)
    if (print !== null) holders.set(print, [...(holders.get(print) ?? []), path])
  }
  const sharing = (print: Fingerprint) => missing.filter((item) => item.fingerprint === print).length
  const movedTo = new Map<ItemId, LibraryPath>()
  for (const item of missing) {
    const found = holders.get(item.fingerprint) ?? []
    const to = found.length === 1 && sharing(item.fingerprint) === 1 ? found[0] : undefined
    if (to !== undefined) movedTo.set(item.id, to)
  }
  const taken = new Set(movedTo.values())
  return { missing, movedTo, unowned: unowned.filter((path) => !taken.has(path)) }
}

/** The things nobody registered, as full reconciliation finds them, without the fingerprint of every item. */
export const unownedOf = async (ledger: Ledger, files: Files): Promise<LibraryPath[]> => (await strays(ledger, files)).unowned

/** Full reconciliation, for check and start. Takes the fingerprint of every item's file besides what `strays` takes. */
export async function reconcile(ledger: Ledger, files: Files): Promise<Standing> {
  const { missing, movedTo, unowned } = await strays(ledger, files)
  const absent = new Set(missing.map((item) => item.id))
  const states = new Map<ItemId, ItemState>()
  for (const item of ledger.items.values()) {
    if (absent.has(item.id)) states.set(item.id, classify(item, null, movedTo.get(item.id) ?? null))
    else states.set(item.id, classify(item, item.removed ? null : await files.fingerprint(item.path), null))
  }
  return withMarks(ledger, states, unowned)
}

/** Whether a standing reports anything about the files: a stray, or an item changed, moved or gone. */
export const findsAnything = (standing: Standing) =>
  standing.unowned.length > 0 || [...standing.states.values()].some((s) => s.kind === 'changed' || s.kind === 'moved' || s.kind === 'missing')

/**
 * A standing confirmed against puts. A put lands its file before its record, so what `reconcile`
 * found about a path or an item stays only when no put is at the path now (`putting`, read after the
 * files were looked at) and no fact read after that (`later`) and missing from `ledger` names the
 * path or the item: such a fact is a put that finished meanwhile, perhaps followed by another, and
 * what was seen may be its doing. What is dropped is judged by its record.
 */
export function confirm(ledger: Ledger, standing: Standing, later: Ledger, putting: ReadonlySet<LibraryPath>): Standing {
  const known = new Set(ledger.facts.map((f) => f.id))
  const since = later.facts.filter((f) => !known.has(f.id))
  const paths = new Set<LibraryPath>([...putting, ...since.flatMap((f) => (f.kind === 'item.enter' ? [f.path] : f.kind === 'item.move' ? [f.from, f.to] : []))])
  const items = new Set(since.flatMap((f) => (f.kind === 'item.enter' || f.kind === 'item.revise' || f.kind === 'item.move' || f.kind === 'item.remove' ? [f.item] : [])))
  const states = new Map(standing.states)
  for (const [id, state] of standing.states) {
    const item = ledger.items.get(id)
    if (!item || !(state.kind === 'changed' || state.kind === 'moved' || state.kind === 'missing')) continue
    if (items.has(id) || paths.has(item.path) || (state.kind === 'moved' && paths.has(state.to))) states.set(id, classify(item, item.fingerprint, null))
  }
  return withMarks(ledger, states, standing.unowned.filter((path) => !paths.has(path)))
}

/** The standing of these states and strays, with the marks they put on the items made from them. */
function withMarks(ledger: Ledger, states: Map<ItemId, ItemState>, unowned: LibraryPath[]): Standing {
  const marks = new Map<ItemId, Mark[]>()
  for (const item of ledger.items.values()) {
    const found = item.removed ? [] : marksOf(item, ledger, (id) => states.get(id))
    if (found.length > 0) marks.set(item.id, found)
  }
  const upstream = new Map<ItemId, ItemId[]>()
  for (const item of ledger.items.values()) {
    const flagged = item.removed ? [] : markedAncestors(ledger, item, marks)
    if (flagged.length > 0) upstream.set(item.id, flagged)
  }
  return { states, unowned, marks, upstream }
}

/** The things at any level above `item` in its basis that carry a mark. */
function markedAncestors(ledger: Ledger, item: ItemRecord, marks: ReadonlyMap<ItemId, Mark[]>): ItemId[] {
  const seen = new Set<ItemId>([item.id])
  const found: ItemId[] = []
  const climb = (from: ItemRecord) => {
    for (const { item: id } of from.basis.items) {
      if (seen.has(id)) continue
      seen.add(id)
      if (marks.has(id)) found.push(id)
      const source = ledger.items.get(id)
      if (source) climb(source)
    }
  }
  climb(item)
  return found
}

/** The marks on an item's direct basis, judged by what each source holds on disk now. */
export function marksOf(item: ItemRecord, ledger: Ledger, stateOf: (id: ItemId) => ItemState | undefined): Mark[] {
  return item.basis.items.flatMap((row): Mark[] => {
    const source = ledger.items.get(row.item)
    const state = stateOf(row.item)
    const now = source && state ? contentNow(source, state) : null
    if (now === null) return [{ kind: 'source-gone', source: row.item }]
    return now === row.fingerprint ? [] : [{ kind: 'stale', source: row.item, recorded: row.fingerprint, now }]
  })
}
