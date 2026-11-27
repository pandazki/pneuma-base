// Storage as the kernel and the plugins see it: the words of the storage contract (STORAGE.md, contract
// version 1), typed. The kernel speaks the contract to its one implementation through a single door; a
// plugin reaches storage only through `PluginContext.tools.storage`, bound to its own record place.
import type { Fingerprint } from './types.js'

/**
 * A place: a relative path with `/` separators, `''` for the root. Not branded: a place comes back from
 * storage as storage wrote it, and every library path is a place.
 */
export type Place = string

export type PlaceKind = 'file' | 'dir' | 'other' | 'none'

/** The fixed reasons of a failed or refused answer (STORAGE.md section 8). */
export type StorageReason =
  | 'no_such_place'
  | 'not_a_dir'
  | 'not_a_file'
  | 'noise'
  | 'outside'
  | 'refused'
  | 'too_many'
  | 'elsewhere'
  | 'held'
  | 'cannot_say'
  | 'unreadable'
  | 'bad_request'
  | 'cancelled'
  | 'busy'

/**
 * A failed or refused answer. `actual`: what a write found instead of what it expected. `at_least`: how
 * many files a directory has at least, past the limit. `side`: `from` when a copy's source failed.
 */
export type StorageFailure = { outcome: 'failed' | 'refused'; reason: StorageReason; detail?: string; actual?: unknown; at_least?: number; size?: number; until?: string; side?: 'from'; cursor?: string }

/**
 * What storage says a place is. Only `kind`, `token`, `size` and `modified` may decide anything; the
 * token is opaque, kept and handed back, never read. A dir's `size` is how many entries its level
 * has, null where storage cannot say that without listing. `held`: a write under way holds it.
 */
export type Description = {
  place: Place
  kind: PlaceKind
  token?: string
  size?: number | null
  modified?: string
  facets?: Record<string, unknown>
  held?: true
}

/** One answer of `glance`: a description, or why this one place has none. */
export type Glanced = Description | { place: Place; outcome: 'failed'; reason: StorageReason; detail?: string }

/** One level of a directory, a page of it: sorted by name, noise left out and named. */
export type Overview = { entries: Description[]; more: { at_least: number; after: string } | null; total: number | null; noise: string[] }

export type Probe = { files: number; dirs: number; bytes: number; exceeded: boolean; markers: string[] }

/**
 * Places not named in `changed`, `gone`, `failed` or `held` are as expected. `deep`: in a deep look, a
 * directory's deep token now, to keep and hand back as the next expectation. `at_least`: with
 * `too_many`, how many files a deep-looked directory has at least.
 */
export type Looked = { same: number; changed: { place: Place; entry: Description; deep?: string }[]; gone: Place[]; failed: { place: Place; reason: StorageReason; at_least?: number }[]; held: Place[] }

/** A page of a look whose expectations a table holds: what differs among `compared` rows, and the key the next page starts after. */
export type LookedPage = Looked & { compared: number; more: { after: string } | null }

/** A page of a directory's manifest: each file its content rule counts, by the bytes of its path relative to the directory. */
export type Manifest = { entries: { path: string; fingerprint: Fingerprint; size: number }[]; more: { after: string } | null }

/** The fingerprint of a file, or of a directory by the content rule, with the token of the version read; a directory's manifest page when asked for. */
export type ContentAnswer =
  | { kind: 'file'; fingerprint: Fingerprint; token: string; size: number }
  | { kind: 'dir'; fingerprint: Fingerprint; token: string; files: number; bytes: number; manifest?: Manifest }

/** Bytes of a file and the token of the version they are of. With `to`, the bytes went to that file instead. */
export type ReadAnswer = { token: string; size: number; offset: number; length: number; data: Uint8Array | null }

/**
 * Where a write's content comes from: a file or directory outside the library, bytes, or a place in
 * the store (copying): in the content, or with `own` in the writer's own record place.
 */
export type WriteSource = { path: string } | { data: Uint8Array | string } | { place: Place; own?: true }

/** What a write expects where it writes: nothing there, or the state of this token. */
export type Expect = 'empty' | string

/** What a write placed, described, and the fingerprint taken in the same pass. */
export type Written = { entry: Description; fingerprint: Fingerprint; files?: number; bytes: number }

/**
 * What changed in the content since a mark kept by the asker: the places (a place may stand for its
 * directory), or `null` when storage could not say, and then every registered place is to be compared.
 * `within`: the directory things a changed place lies inside, at any depth: each one changed, though
 * its own token and its first level's may not show it.
 */
export type Changes = { places: Place[] | null; mark: string; within: Place[] }

export type StoredFact = { order: string; fact: unknown }
export type FactsSince = { facts: StoredFact[]; cursor: string; more: boolean }

/** A row of a table in a record place: up to 4 fields one can ask by, all strings, and any value; a null value deletes it in `put`. */
export type Row<V = unknown> = { key: string; fields?: Record<string, string>; value: V }
export type RowsPage<V = unknown> = { rows: Row<V>[]; more: { after: string } | null }

/** A record place: facts only ever appended, rows derived from them that may be thrown away. */
export interface RecordPlace {
  /** Appends the facts as one write; answers each one's order. */
  append(facts: readonly unknown[]): Promise<string[]>
  /**
   * The facts after `cursor` (null: from the first), at most `limit` (0: none, only where the facts end
   * now). Null when the cursor no longer fits the facts there, such as after they were deleted: start again from null.
   */
  since(cursor: string | null, limit?: number): Promise<FactsSince | null>
  /**
   * Writes rows of several tables and, with `cursor`, the fact cursor they were derived up to, in one
   * commit. With `expect`, only while the saved cursor is still that one; else nothing is written and
   * the answer is the saved cursor.
   */
  put(tables: Readonly<Record<string, readonly Row[]>>, opts?: { cursor?: string; expect?: string | null }): Promise<{ written: true } | { written: false; actual: string | null }>
  /** The rows with these keys, and the saved fact cursor. */
  get<V = unknown>(table: string, keys: readonly string[]): Promise<{ rows: Row<V>[]; cursor: string | null }>
  under<V = unknown>(table: string, prefix: string, opts?: { limit?: number; after?: string }): Promise<RowsPage<V>>
  where<V = unknown>(table: string, field: string, value: string, opts?: { limit?: number; after?: string }): Promise<RowsPage<V>>
  count(table: string, field: string, value: string): Promise<number>
  /** Drops every row and the saved cursor. */
  reset(): Promise<void>
}

/**
 * One area of places: the library's content, or a plugin's own record place, which keeps content too
 * (held copies, versions). A directory's content is counted by the rule things follow: noise, the
 * marker and what its `.gitignore` excludes are not content.
 */
export interface PlaceStore {
  /** What these places are now, one each. */
  glance(places: readonly Place[]): Promise<Glanced[]>
  /** One level of a directory, one page of at most `limit` (200, at most 1000) after `after`. */
  overview(place: Place, opts?: { limit?: number; after?: string }): Promise<Overview | StorageFailure>
  /**
   * Which of these places are not as expected any more: a token, or `empty` for nothing there.
   * `deep`: a directory is compared by its deep token, the states of every file the rule things follow
   * counts, taken without reading content; past 5000 files it answers `too_many`. Only a deep token
   * matches a deep token.
   */
  look(places: readonly { place: Place; token: Expect }[], opts?: { deep?: true }): Promise<Looked>
  /**
   * Which places are not as the rows of a table of the plugin's own record place expect: each row's key
   * is a place and its field `field` a token or `empty` (a row without it expects nothing in particular,
   * and whatever is there differs). A page of at most `limit` rows (10000, at most 100000) after `after`,
   * compared inside storage; only the differences come back.
   */
  lookRows(table: string, field: string, opts?: { limit?: number; after?: string; deep?: true }): Promise<LookedPage>
  /**
   * The fingerprint of the content: read only now, because asked. A directory over `limit` files (5000)
   * answers `too_many`. `manifest`: a directory's answer also lists the files the rule counts, a page of
   * `limit` (1000, at most 10000) after `after`, each with its fingerprint and size.
   */
  content(place: Place, opts?: { limit?: number; manifest?: true | { limit?: number; after?: string } }): Promise<ContentAnswer | StorageFailure>
  /** The bytes of a file, or a range of them; with `to`, written to that absolute path outside the library. */
  read(place: Place, opts?: { offset?: number; length?: number; to?: string }): Promise<ReadAnswer | StorageFailure>
  /** Puts content at a place where the expectation holds, all of it or none; refused with what is there. */
  write(place: Place, from: WriteSource, expect: Expect, opts?: { hold?: string; limit?: number }): Promise<Written | StorageFailure>
  move(from: Place, to: Place, expect: { from: string; to: Expect }, opts?: { hold?: string }): Promise<{ entry: Description } | StorageFailure>
  remove(place: Place, expect: string, opts?: { hold?: string }): Promise<{ removed: true } | StorageFailure>
}

/**
 * Another record place of the library: its facts, read in storage's order and appended to, and its own
 * content. Only a plugin whose work is to carry the whole library elsewhere (sync) reaches one; any
 * other keeps to its own record place (the conformance check `writes`).
 */
export interface OtherRecordPlace {
  readonly own: PlaceStore
  readonly facts: Pick<RecordPlace, 'append' | 'since'>
}

/** What a plugin may ask of storage: the content where its records point, its own record place, and its own content beside it. */
export interface PluginStorage extends PlaceStore {
  /** How large a directory is at least, counted up to `budget` entries (500), and what well-known files are at its top. */
  probe(place: Place, budget?: number): Promise<Probe | StorageFailure>
  /** The noise names and paths declared at the library's root. */
  noise(): Promise<{ names: string[]; paths: Place[] }>
  /** Says these places are being written and their records follow, for `ttl` ms (30000); looks mark them held. */
  hold(places: readonly Place[], ttl?: number): Promise<{ hold: string; until: string } | StorageFailure>
  release(hold: string): Promise<void>
  /**
   * What changed in the content since `mark`, a mark this plugin kept from an earlier answer (null:
   * none yet, and then the places are null). Storage can say while a long-lived process listens to
   * the library (the management UI's server does), at a cost that follows what changed; otherwise
   * the places are null and the plugin compares what it recorded. A mark costs nothing to keep and is
   * only good for this library.
   */
  changed(mark: string | null): Promise<Changes>
  /** The plugin's own record place's content: places under `.pneuma-base/<plugin>/`, `facts` aside. */
  readonly own: PlaceStore
  readonly records: RecordPlace
  /** The record places the kernel knows in this library, by name: its own (`requests`) and each installed plugin's. */
  recordPlaces(): Promise<string[]>
  /** The record place `name`, which need not be one `recordPlaces` names: one a plugin of another machine wrote. */
  recordPlace(name: string): OtherRecordPlace
}

/** Whether a glance found the place described, of whatever kind, rather than failing on it. */
export const isDescribed = (g: Glanced): g is Description => !('outcome' in g)

export const isFailure = (answer: unknown): answer is StorageFailure =>
  typeof answer === 'object' && answer !== null && ((answer as { outcome?: unknown }).outcome === 'failed' || (answer as { outcome?: unknown }).outcome === 'refused')
