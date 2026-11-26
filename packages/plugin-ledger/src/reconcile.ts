// reconcile: the ledger against a snapshot of the files. Pure apart from the fingerprint function
// it is handed. ledger-design.md section 4.
import type { Fingerprint, LibraryPath } from '@pneuma-base/kernel'
import type { ItemId } from './facts.js'
import type { ItemRecord, Ledger } from './fold.js'

export type ItemState =
  | { kind: 'consistent' }
  | { kind: 'changed'; now: Fingerprint | null } // now: the content's fingerprint, null while only its token says it changed
  | { kind: 'moved'; to: LibraryPath }
  | { kind: 'missing' }
  | { kind: 'removed' }
  | { kind: 'absorbed'; into: ItemId; now: Fingerprint | 'unknown' | null } // its file is part of a bundle now; `now` is that file's content, unknown while only the bundle's token says it changed

export type Mark = { kind: 'stale'; source: ItemId; recorded: Fingerprint; now: Fingerprint | null } | { kind: 'source-gone'; source: ItemId }

/** What the marks need of an item, which both a folded item and a row of the ledger's state give. */
export type Marked = Pick<ItemRecord, 'id' | 'removed' | 'fingerprint' | 'basis'>
type Items<I extends Marked> = { items: ReadonlyMap<ItemId, I> }

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

/** The content an item has now: its fingerprint, `unknown` while only its token says it changed, null when it has no file. */
function contentNow(item: Marked, state: ItemState): Fingerprint | 'unknown' | null {
  if (state.kind === 'changed') return state.now ?? 'unknown'
  if (state.kind === 'absorbed') return state.now
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
  closed?: LibraryPath[] // directories nobody registered anything in, each one entry of an open directory, not looked into
  more?: { dir: LibraryPath | ''; atLeast: number }[] // open directories with more entries than one look lists: at least this many more
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

/** Full reconciliation, for the item panel, which must tell a move. Takes the fingerprint of every item's file besides what `strays` takes. */
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

/** The standing of these states and strays, with the marks they put on the items made from them. */
export function withMarks<I extends Marked>(ledger: Items<I>, states: Map<ItemId, ItemState>, unowned: LibraryPath[]): Standing {
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
function markedAncestors<I extends Marked>(ledger: Items<I>, item: I, marks: ReadonlyMap<ItemId, Mark[]>): ItemId[] {
  const seen = new Set<ItemId>([item.id])
  const found: ItemId[] = []
  const climb = (from: I) => {
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
export function marksOf<I extends Marked>(item: Marked, ledger: Items<I>, stateOf: (id: ItemId) => ItemState | undefined): Mark[] {
  return item.basis.items.flatMap((row): Mark[] => {
    const source = ledger.items.get(row.item)
    const state = stateOf(row.item)
    const now = source && state ? contentNow(source, state) : null
    if (now === null) return [{ kind: 'source-gone', source: row.item }]
    if (now === 'unknown') return [{ kind: 'stale', source: row.item, recorded: row.fingerprint, now: null }]
    return now === row.fingerprint ? [] : [{ kind: 'stale', source: row.item, recorded: row.fingerprint, now }]
  })
}
