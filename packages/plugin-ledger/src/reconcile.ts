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
 * Full reconciliation, for check and start. Takes the fingerprint of every item's file, and of the
 * unowned files whose size matches an item that has no file at its path.
 */
export async function reconcile(ledger: Ledger, files: Files): Promise<Standing> {
  const states = new Map<ItemId, ItemState>()
  const missing: ItemRecord[] = []
  for (const item of ledger.items.values()) {
    // An absorbed item's file lies inside a bundle, which the snapshot lists as one thing.
    if (!item.removed && item.absorbedInto === null && !files.sizes.has(item.path)) missing.push(item)
    else states.set(item.id, classify(item, item.removed ? null : await files.fingerprint(item.path), null))
  }
  const unowned = [...files.sizes.keys()].filter((path) => !ledger.pathIndex.has(path))

  // Moved: exactly one unowned file holds the content, and no other missing item has that content.
  const sizes = new Set(missing.map((item) => item.size))
  const holders = new Map<Fingerprint, LibraryPath[]>()
  for (const path of unowned) {
    if (!sizes.has(files.sizes.get(path) ?? -1)) continue
    const print = await files.fingerprint(path)
    if (print !== null) holders.set(print, [...(holders.get(print) ?? []), path])
  }
  const sharing = (print: Fingerprint) => missing.filter((item) => item.fingerprint === print).length
  const taken = new Set<LibraryPath>()
  for (const item of missing) {
    const found = holders.get(item.fingerprint) ?? []
    const to = found.length === 1 && sharing(item.fingerprint) === 1 ? (found[0] ?? null) : null
    if (to !== null) taken.add(to)
    states.set(item.id, classify(item, null, to))
  }

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
  return { states, unowned: unowned.filter((path) => !taken.has(path)), marks, upstream }
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
