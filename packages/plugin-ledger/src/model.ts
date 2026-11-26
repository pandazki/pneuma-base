// The ledger's rows: what each table keeps, the fields it is asked by, and the small rules the fold,
// the look and the views share. Rows are a cache derived from the facts and from what storage said;
// deleting them costs a fold and one full look. tmp/run-7 architecture.md sections 4 and 7.
import { createHash } from 'node:crypto'
import { regionOf, type Fingerprint, type Instant, type LibraryPath, type Place, type Transcript } from '@pneuma-base/kernel'
import type { Basis, Envelope, FactActor, How, ItemId, LedgerOrigin, SceneId } from './facts.js'
import type { Tx } from './rows.js'

/** The shape of the rows; rows of another shape are derived again from the facts. */
export const ROWS_VERSION = 2

/** An origin as a row keeps it: a made one's sources are the item's `basis`. */
export type OriginLike = Exclude<LedgerOrigin, { kind: 'made' }> | { kind: 'made' }
export const lean = (origin: LedgerOrigin): OriginLike => (origin.kind === 'made' ? { kind: 'made' } : origin)

/** How it became known where a thing came from: who said or saw which origin, when, in which scene. */
export type OriginLine = { origin: OriginLike; how: How; at: Instant; scene: SceneId; actor: FactActor; where: Envelope['where'] | null }

/** What a look found a thing to be against its record. */
export type LookState = 'consistent' | 'changed' | 'missing' | 'moved'

export type ItemState =
  | { kind: 'consistent' }
  | { kind: 'changed'; now: Fingerprint | null } // now: the content's fingerprint, null while only its token says it changed
  | { kind: 'moved'; to: LibraryPath }
  | { kind: 'missing' }
  | { kind: 'removed' }
  | { kind: 'absorbed'; into: ItemId; now: Fingerprint | 'unknown' | null } // its file is part of a bundle now; `now` is its recorded content while the bundle is as recorded, unknown once the bundle changed, null when the bundle is gone

/** What needs looking at in the things not archived, as recorded, and whether it is archived: one thing's part of the statistics' 「库收拾得怎么样」. */
export type OpenFlags = { stale: boolean; changed: boolean; unknown: boolean; archived: boolean }

/** A made thing's part of 「以前的东西被接着用了吗」, as last counted into the hour it was made in. */
export type Reuse = { hour: string; actor: string; fromLibrary: boolean; otherSession: boolean; otherAgent: boolean; uses: ItemId[] }

/** A thing as the rows keep it. */
export type ItemRow = {
  id: ItemId
  path: LibraryPath
  holds: boolean // its path names it; false only when another item took the path since
  bundle: boolean
  removed: boolean
  absorbedInto: ItemId | null
  absorbed: ItemId[] // a bundle's: the items it absorbed
  dependents: ItemId[] // the items whose basis names it
  // The version on record: what storage said when it was recorded or last taken as recorded, and its content's fingerprint when known.
  token: string | null
  fingerprint: Fingerprint | null
  size: number
  modified: string | null
  entries: { name: string; token: string }[] | null // a directory-thing's first level as last taken as recorded
  origin: OriginLike
  basis: Basis
  entered: OriginLine
  earlier: OriginLine[]
  unknownOrigin: boolean
  last: { how: How; claimed: boolean; token: string | null; fingerprint: Fingerprint | null; key: string | null; at: Instant } // the latest version, its history row and when
  versions: number
  texts: string[] // what find matches besides the path: what was said about it, the notes of its puts, where it came from
  // What the last look found.
  state: LookState
  now: { token: string | null; fingerprint: Fingerprint | null } | null // when changed: what is there now
  to: LibraryPath | null // when moved
  // Its rows in `marks`, and whether a source of its own carries a mark.
  marks: string[]
  marked: boolean
  open: OpenFlags | null // as last counted; null for a thing removed or absorbed
  reuse: Reuse | null
  find: string | null // its key in `find`
  cls: ItemClass | null // what the library page counts it as, as last counted
  time: string | null // its key in `bytime`
}

/** What the library page shows a thing under: how it came, or archived. */
export type ItemClass = 'brought' | 'made' | 'adopted' | 'archived'
export const classOf = (item: ItemRow): ItemClass | null => (!live(item) ? null : archived(item) ? 'archived' : item.origin.kind)

export type SaidRow = { id: string; flavor: 'doing' | 'decided' | 'note'; text: string; at: Instant; actor: FactActor; about: ItemId | null }

export type SceneRow = {
  id: SceneId
  first: Instant
  last: Instant
  actors: FactActor[]
  cwds: string[]
  transcript: (Transcript & { machine: string }) | null // the last pointer the scene's facts carry
  said: SaidRow[] // at most SAID_KEPT of each flavour
  ops: { command: string; actor: FactActor }[]
  items: ItemId[] // the first ones entered, revised, moved or given a basis here
  touched: number // how many items it touched in all
  put: ItemId[] // the first ones entered here
  puts: number
  brought: number
  sources: ItemId[] // what the things entered here were made from, each once
  outside: string[]
  decided: number
  lastDecided: string | null
  started: boolean // an agent acted in it: one session in the statistics
}

export type ActorRow = { actor: FactActor; first: Instant; checked: Instant | null; last: { scene: SceneId; at: Instant }; other: { scene: SceneId; at: Instant } | null; scenes: number; put: number }

/** One entry of an open directory's listing. */
export type Entry = { name: string; kind: 'file' | 'dir' | 'other' | 'none'; size: number | null; modified: string | null; token: string | null; held?: true }
/** An open directory as last listed: its token then, its first entries by name, at least how many more, its strays' mark keys, and its loose files nobody registered or left. */
export type SeenRow = { token: string; entries: Entry[]; more: number; unreadable?: true; strays: string[]; loose: LibraryPath[] }

export type MarkKind = 'stale' | 'gone' | 'upstream' | 'unowned' | 'closed' | 'changed' | 'missing' | 'moved'
export type Ref = { item: ItemId; path: LibraryPath | ItemId }
/** One row of what needs looking at: a thing with a mark or a state, or a stray of an open directory. */
export type MarkRow = { kind: MarkKind; item: ItemId | null; path: LibraryPath; sources?: Ref[]; to?: LibraryPath; adopted?: true; token?: string | null; size?: number | null; modified?: string | null }

export type HistoryRow =
  | {
      kind: 'version'
      fingerprint: Fingerprint | null
      token: string | null
      at: Instant
      scene: SceneId
      actor: FactActor
      how: How
      held: string | null
      claimed: boolean
      by: 'owner' | null
      note: string | null
      seen: { at: Instant; actor: FactActor } | null
    }
  | { kind: 'said'; id: string; flavor: 'doing' | 'decided' | 'note'; text: string; at: Instant; scene: SceneId; actor: FactActor; about: ItemId | null }

/** A held copy: content a new version replaced, kept in the ledger's own place under `held/`. */
export type HeldRow = { item: ItemId; key: string; place: Place; path: string; fingerprint: Fingerprint | null; at: Instant }

export type FindRow = { item: ItemId; path: LibraryPath; shown: string; texts: string; scene: SceneId; origin: OriginLike; how: How; bundle: boolean } | { scene: SceneId; texts: string }

/** The directory a held copy of a version lies in: the version's fingerprint, else the first 16 hex of the sha256 of its token. */
export const heldKey = (fingerprint: Fingerprint | null, token: string | null): string => fingerprint ?? createHash('sha256').update(token ?? '').digest('hex').slice(0, 16)

export const archived = (item: { path: LibraryPath }) => regionOf(item.path) === 'archive'
/** A thing that counts as registered now: not removed, not part of a bundle. */
export const live = (item: ItemRow) => !item.removed && item.absorbedInto === null
export const parentOf = (path: LibraryPath | Place): Place => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const nameOf = (place: Place) => place.slice(place.lastIndexOf('/') + 1)

/** The directories above a path, nearest first; the root is not one of them. */
export function ancestors(path: LibraryPath | Place): Place[] {
  const out: Place[] = []
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) out.push(path.slice(0, i))
  return out
}

/**
 * Whether two versions are the same: by fingerprint when both have one, else by token when both have
 * one; otherwise it cannot be told, and they are taken as different.
 */
export function sameVersion(a: { token?: string | null; fingerprint: Fingerprint | null }, b: { token?: string | null; fingerprint: Fingerprint | null }): boolean {
  if (a.fingerprint && b.fingerprint) return a.fingerprint === b.fingerprint
  if (a.token && b.token) return a.token === b.token
  return false
}

/** An item's state from its row. An absorbed one follows its bundle. */
export function stateOfRow(item: ItemRow, bundle?: ItemRow): ItemState {
  if (item.removed) return { kind: 'removed' }
  if (item.absorbedInto !== null) {
    const b = bundle?.removed ? 'missing' : bundle?.state
    return { kind: 'absorbed', into: item.absorbedInto, now: b === undefined || b === 'missing' ? null : b === 'changed' ? 'unknown' : item.fingerprint }
  }
  if (item.state === 'changed') return { kind: 'changed', now: item.now?.fingerprint ?? null }
  if (item.state === 'moved' && item.to !== null) return { kind: 'moved', to: item.to }
  return item.state === 'missing' ? { kind: 'missing' } : { kind: 'consistent' }
}

/** What a source holds now, as its row says: its version, unknown, or nothing. */
export function versionNow(item: ItemRow | undefined, bundle?: ItemRow): { token: string | null; fingerprint: Fingerprint | null } | 'unknown' | null {
  if (!item || item.removed) return null
  const holder = item.absorbedInto === null ? item : bundle
  if (!holder || holder.removed || holder.state === 'missing') return null
  if (holder.state === 'changed') return item.absorbedInto === null ? (item.now ?? 'unknown') : 'unknown'
  return { token: item.token, fingerprint: item.fingerprint }
}

/** What a thing as recorded counts toward 「库收拾得怎么样」; null for a thing removed or part of a bundle. */
export function openOf(item: ItemRow, stale: boolean): OpenFlags | null {
  if (!live(item)) return null
  if (archived(item)) return { stale: false, changed: false, unknown: false, archived: true }
  return { stale, changed: item.last.claimed && item.last.how === 'observed', unknown: item.unknownOrigin, archived: false }
}

/** Whether a source, as recorded, holds other content than a made thing's basis row recorded of it, or is gone. */
export function staleAsRecorded(row: Basis['items'][number], source: ItemRow | undefined): boolean {
  if (!source || source.removed) return true
  if (row.fingerprint && source.fingerprint) return row.fingerprint !== source.fingerprint
  if (row.token && source.token) return row.token !== source.token
  return false
}

// ---- writing the tables, each with the fields it is asked by ----

export const putItem = (tx: Tx, item: ItemRow) => tx.set('items', item.id, item)
export const putPath = (tx: Tx, path: LibraryPath, id: ItemId | null) => tx.set('paths', path, id === null ? null : { id }, { parent: parentOf(path) })
export const putDir = (tx: Tx, dir: Place, n: number) => tx.set('dirs', dir, n > 0 ? n : null, { parent: parentOf(dir) })
export const putSeen = (tx: Tx, dir: Place, seen: SeenRow | null) =>
  tx.set('seen', dir, seen, seen === null ? undefined : { ...(seen.loose.length > 0 ? { loose: 'y' } : {}), ...(seen.more > 0 ? { more: 'y' } : {}) })
export const markKey = (kind: MarkKind, path: LibraryPath | Place) => `${kind}:${regionOf(path as LibraryPath) === 'archive' ? 'a' : '-'}:${path}`
export const sigOf = (kind: 'file' | 'dir', size: number | null, modified: string | null) => (size === null || modified === null ? null : `${kind}|${size}|${modified}`)
export function putMark(tx: Tx, key: string, mark: MarkRow | null, sig: string | null = null): void {
  tx.set('marks', key, mark, mark === null ? undefined : { kind: key.slice(0, key.indexOf(':', key.indexOf(':') + 1)), ...(sig === null ? {} : { sig }) })
}
export const putActor = (tx: Tx, key: string, row: ActorRow) => tx.set('actors', key, row, { kind: row.actor.kind, ...(row.actor.grant ? { grant: row.actor.grant } : {}) })
