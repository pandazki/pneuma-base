// Storage as the kernel and the plugins see it: the words of the storage contract (tmp/run-7 STORAGE.md,
// contract version 1), typed. The kernel speaks the contract to its one implementation through a single
// door; a plugin reaches storage only through `PluginContext.tools.storage`, bound to its own record place.

/**
 * A place in the content: a relative path with `/` separators, `''` for the root. Not branded: a place
 * comes back from storage as storage wrote it, and every library path is a place.
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

export type StorageFailure = { outcome: 'failed' | 'refused'; reason: StorageReason; detail?: string; actual?: unknown; at_least?: number }

/**
 * What storage says a place is. Only `kind`, `token`, `size` and `modified` may decide anything; the
 * token is opaque, kept and handed back, never read. A dir's `size` is how many entries its level
 * has, null where storage cannot say that without listing.
 */
export type Description = {
  place: Place
  kind: PlaceKind
  token?: string
  size?: number | null
  modified?: string
  facets?: Record<string, unknown>
}

/** One answer of `glance`: a description, or why this one place has none. */
export type Glanced = Description | { place: Place; outcome: 'failed'; reason: StorageReason; detail?: string }

/** One level of a directory, a page of it: sorted by name, noise left out and named. */
export type Overview = { entries: Description[]; more: { at_least: number; after: string } | null; total: number | null; noise: string[] }

export type Probe = { files: number; dirs: number; bytes: number; exceeded: boolean; markers: string[] }

/** Places not named in `changed`, `gone` or `failed` are as the token said. */
export type Looked = { same: number; changed: { place: Place; entry: Description }[]; gone: Place[]; failed: { place: Place; reason: StorageReason }[] }

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

/** What a plugin may ask of storage: to look at the content where its records point, and its own record place. */
export interface PluginStorage {
  glance(places: readonly Place[]): Promise<Glanced[]>
  overview(place: Place, opts?: { limit?: number; after?: string }): Promise<Overview | StorageFailure>
  look(places: readonly { place: Place; token: string }[]): Promise<Looked>
  /** How large a directory is at least, counted up to `budget` entries, and what well-known files are at its top. */
  probe(place: Place, budget?: number): Promise<Probe | StorageFailure>
  /** The noise names and paths declared at the library's root. */
  noise(): Promise<{ names: string[]; paths: Place[] }>
  readonly records: RecordPlace
}

/** Whether a glance found the place described, of whatever kind, rather than failing on it. */
export const isDescribed = (g: Glanced): g is Description => !('outcome' in g)

export const isFailure = (answer: unknown): answer is StorageFailure =>
  typeof answer === 'object' && answer !== null && ((answer as { outcome?: unknown }).outcome === 'failed' || (answer as { outcome?: unknown }).outcome === 'refused')
