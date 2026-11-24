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

export type Mark = { kind: 'stale'; source: ItemId; recorded: Fingerprint; now: Fingerprint } | { kind: 'source-gone'; source: ItemId }

/**
 * The one place an item's state is decided. `disk` is the fingerprint of the file at the item's
 * recorded path, null when no file is there; `movedTo` is the one unowned file that holds its content.
 */
export function classify(item: ItemRecord, disk: Fingerprint | null, movedTo: LibraryPath | null): ItemState {
  if (item.removed) return { kind: 'removed' }
  if (disk !== null) return disk === item.fingerprint ? { kind: 'consistent' } : { kind: 'changed', now: disk }
  return movedTo !== null ? { kind: 'moved', to: movedTo } : { kind: 'missing' }
}

/** The content an item has on disk now; null when it has no file. */
export function contentNow(item: ItemRecord, state: ItemState): Fingerprint | null {
  if (state.kind === 'changed') return state.now
  return state.kind === 'consistent' || state.kind === 'moved' ? item.fingerprint : null
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
