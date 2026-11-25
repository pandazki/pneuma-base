// The index: one sqlite file in the plugin's cache directory outside the library. Rebuildable from
// the library's files and the embedder; deleting it loses nothing.
//
//   docs     every file the index has seen, text or not, with the stamp it was read at
//   chunks   the pieces of each text file, with the sha256 of the piece
//   fts      FTS5 over each piece's terms, rowid = chunks.id
//   vectors  one vector per piece content and embedder, so a moved or copied piece is not embedded again
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { regionOf, type Instant, type LibraryPath } from '@pneuma-base/kernel'
import type { FileKey, Stamp } from './fresh.js'

/**
 * `node:sqlite`, loaded when an index is first opened. Node versions that still mark it experimental
 * warn on stderr at load; an agent that sees stderr noise on every command starts discarding stderr,
 * and with it the refusals it needs to read. Only that one warning is dropped.
 */
function sqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (!text.includes('SQLite is an experimental feature')) (emit as (...a: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return process.getBuiltinModule('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

const SCHEMA = '1'
const FILE = 'index.sqlite'

const TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE docs (path TEXT NOT NULL, inner TEXT NOT NULL, size INTEGER NOT NULL, modified TEXT NOT NULL,
  text INTEGER NOT NULL, truncated INTEGER NOT NULL, PRIMARY KEY (path, inner));
CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, inner TEXT NOT NULL, seq INTEGER NOT NULL,
  body TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX chunks_doc ON chunks (path, inner);
CREATE INDEX chunks_hash ON chunks (hash);
CREATE VIRTUAL TABLE fts USING fts5 (terms);
CREATE TABLE vectors (embedder TEXT NOT NULL, hash TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (embedder, hash));
`

/** A file as read: whether it is text, whether only its first part was, and its pieces with their terms. */
export type Doc = { stamp: Stamp; text: boolean; truncated: boolean; chunks: { body: string; terms: string }[] }
/** A thing's best piece for a query, best first. */
export type Ranked = { path: LibraryPath; chunk: number }
export type ChunkRow = { id: number; path: LibraryPath; inner: string; body: string; truncated: boolean }
export type DocState = { inner: string; size: number; modifiedAt: string; text: boolean; truncated: boolean; chunks: number; vectors: number }
export type IndexStats = { files: number; textFiles: number; chunks: number; vectors: number; builtAt: Instant }

const pieceHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 32)

/** FTS5 query text: each term a quoted string, any of them. */
const anyOf = (terms: readonly string[]) => terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')

/** A hit by meaning must be at least this share as near as the nearest one. */
const NEAR_ENOUGH = 0.5

/** sqlite's SQLITE_CORRUPT and SQLITE_NOTADB: the file is no index at all. */
const UNUSABLE = new Set<unknown>([11, 26])

/** A file with tables, but not this version's. */
class ForeignIndex extends Error {
  constructor() {
    super('an index of another schema')
  }
}

function vectorOf(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

export class SearchIndex {
  private constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA busy_timeout = 30000')
    db.function('archived', { deterministic: true }, (path) => (regionOf(String(path) as LibraryPath) === 'archive' ? 1 : 0))
  }

  /**
   * Opens the index in `cacheDir`, made anew when it is missing, of another schema, or not a sqlite
   * file. A busy one is waited for, never made anew: another find may be using it.
   */
  static open(cacheDir: string, now: Instant): SearchIndex {
    mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, FILE)
    try {
      return SearchIndex.ready(file, now)
    } catch (error) {
      if (!(error instanceof ForeignIndex) && !UNUSABLE.has((error as { errcode?: unknown }).errcode)) throw error
      for (const f of [file, `${file}-journal`]) rmSync(f, { force: true })
      return SearchIndex.ready(file, now)
    }
  }

  /** The index as it is, without building one; null when there is none this version can read. */
  static peek(cacheDir: string): SearchIndex | null {
    const file = join(cacheDir, FILE)
    if (!existsSync(file)) return null
    try {
      const index = new SearchIndex(new (sqlite().DatabaseSync)(file))
      if (index.schema() === SCHEMA) return index
      index.close()
    } catch {
      // unreadable: as if there were none
    }
    return null
  }

  /** The index in `file` with this schema, its tables made when the file is empty. Throws for anything else. */
  private static ready(file: string, now: Instant): SearchIndex {
    const index = new SearchIndex(new (sqlite().DatabaseSync)(file))
    try {
      if (index.schema() !== SCHEMA) {
        index.transaction(() => {
          if (index.schema() === SCHEMA) return // another process made it meanwhile
          if ((index.db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n > 0) throw new ForeignIndex()
          index.db.exec(TABLES)
          index.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)').run('schema', SCHEMA, 'builtAt', now)
        })
      }
      return index
    } catch (error) {
      index.close()
      throw error
    }
  }

  private schema(): string | null {
    try {
      return (this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined)?.value ?? null
    } catch {
      return null
    }
  }

  private transaction(body: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      body()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Runs reads that see one state of the index, whatever another process writes meanwhile. */
  snapshot<T>(read: () => T): T {
    this.db.exec('BEGIN')
    try {
      return read()
    } finally {
      this.db.exec('COMMIT')
    }
  }

  close(): void {
    this.db.close()
  }

  stamps(): Stamp[] {
    return (this.db.prepare('SELECT path, inner, size, modified FROM docs').all() as { path: LibraryPath; inner: string; size: number; modified: string }[]).map((r) => ({
      path: r.path,
      inner: r.inner,
      size: r.size,
      modifiedAt: r.modified,
    }))
  }

  /** Forgets the dropped files and replaces what it had of the read ones. Running it twice leaves the same index. */
  apply(drop: readonly FileKey[], docs: readonly Doc[]): void {
    const forgetTerms = this.db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ? AND inner = ?)')
    const forgetChunks = this.db.prepare('DELETE FROM chunks WHERE path = ? AND inner = ?')
    const forgetDoc = this.db.prepare('DELETE FROM docs WHERE path = ? AND inner = ?')
    const addDoc = this.db.prepare('INSERT INTO docs (path, inner, size, modified, text, truncated) VALUES (?, ?, ?, ?, ?, ?)')
    const addChunk = this.db.prepare('INSERT INTO chunks (path, inner, seq, body, hash) VALUES (?, ?, ?, ?, ?)')
    const addTerms = this.db.prepare('INSERT INTO fts (rowid, terms) VALUES (?, ?)')
    const forget = ({ path, inner }: FileKey) => {
      forgetTerms.run(path, inner)
      forgetChunks.run(path, inner)
      forgetDoc.run(path, inner)
    }
    this.transaction(() => {
      for (const key of drop) forget(key)
      for (const { stamp, text, truncated, chunks } of docs) {
        forget(stamp)
        addDoc.run(stamp.path, stamp.inner, stamp.size, stamp.modifiedAt, text ? 1 : 0, truncated ? 1 : 0)
        for (const [seq, chunk] of chunks.entries()) {
          const { lastInsertRowid } = addChunk.run(stamp.path, stamp.inner, seq, chunk.body, pieceHash(chunk.body))
          addTerms.run(lastInsertRowid, chunk.terms)
        }
      }
    })
  }

  /** Each thing whose pieces hold any of the terms, by its best piece's bm25, best first. */
  matchWords(terms: readonly string[], includeArchived: boolean): Ranked[] {
    if (terms.length === 0) return []
    // bm25() cannot sit under an aggregate, so the pieces come best first and each thing keeps its first.
    const rows = this.db
      .prepare('SELECT c.path AS path, c.id AS id FROM fts JOIN chunks c ON c.id = fts.rowid WHERE fts MATCH ? AND (? OR archived(c.path) = 0) ORDER BY bm25(fts), c.path, c.id')
      .all(anyOf(terms), includeArchived ? 1 : 0) as { path: LibraryPath; id: number }[]
    const seen = new Set<LibraryPath>()
    return rows.flatMap((r) => (seen.has(r.path) ? [] : (seen.add(r.path), [{ path: r.path, chunk: r.id }])))
  }

  /** The pieces no vector of this embedder covers yet, one per content. */
  unembedded(embedder: string): { hash: string; body: string }[] {
    return this.db
      .prepare('SELECT hash, body FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.embedder = ? AND v.hash = c.hash) GROUP BY hash ORDER BY min(id)')
      .all(embedder) as { hash: string; body: string }[]
  }

  addVectors(embedder: string, rows: readonly { hash: string; vector: Float32Array }[]): void {
    const add = this.db.prepare('INSERT OR IGNORE INTO vectors (embedder, hash, v) VALUES (?, ?, ?)')
    this.transaction(() => {
      for (const { hash, vector } of rows) add.run(embedder, hash, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
    })
  }

  /** Keeps only the vectors of this embedder (none for null) and of pieces the index still has. */
  keepVectorsOf(embedder: string | null): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM vectors WHERE ? IS NULL OR embedder <> ?').run(embedder, embedder)
      this.db.exec('DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)')
    })
  }

  /**
   * The `limit` things nearest to the unit vector `query`, by the cosine of their best piece, nearest
   * first. A thing less than half as near as the nearest is left out: next to it, it is noise.
   */
  nearest(embedder: string, query: Float32Array, includeArchived: boolean, limit: number): Ranked[] {
    const best = new Map<LibraryPath, { chunk: number; similarity: number }>()
    const rows = this.db
      .prepare('SELECT c.id AS id, c.path AS path, v.v AS v FROM chunks c JOIN vectors v ON v.hash = c.hash AND v.embedder = ? WHERE ? OR archived(c.path) = 0')
      .iterate(embedder, includeArchived ? 1 : 0) as Iterable<{ id: number; path: LibraryPath; v: Uint8Array }>
    for (const row of rows) {
      const v = vectorOf(row.v)
      if (v.length !== query.length) continue
      let similarity = 0
      for (let i = 0; i < v.length; i++) similarity += (v[i] as number) * (query[i] as number)
      const known = best.get(row.path)
      if (similarity > 0 && (!known || similarity > known.similarity)) best.set(row.path, { chunk: row.id, similarity })
    }
    const nearestFirst = [...best.entries()].sort(([pa, a], [pb, b]) => b.similarity - a.similarity || (pa < pb ? -1 : pa > pb ? 1 : 0))
    const floor = (nearestFirst[0]?.[1].similarity ?? 0) * NEAR_ENOUGH
    return nearestFirst
      .filter(([, s]) => s.similarity >= floor)
      .slice(0, limit)
      .map(([path, { chunk }]) => ({ path, chunk }))
  }

  chunkRows(ids: readonly number[]): Map<number, ChunkRow> {
    const get = this.db.prepare('SELECT c.id AS id, c.path AS path, c.inner AS inner, c.body AS body, d.truncated AS truncated FROM chunks c JOIN docs d ON d.path = c.path AND d.inner = c.inner WHERE c.id = ?')
    const out = new Map<number, ChunkRow>()
    for (const id of ids) {
      const row = get.get(id) as { id: number; path: LibraryPath; inner: string; body: string; truncated: number } | undefined
      if (row) out.set(id, { ...row, truncated: row.truncated === 1 })
    }
    return out
  }

  /** What the index has of each file of one thing: the file itself, or every file inside the bundle. */
  docsAt(path: LibraryPath, embedder: string | null): DocState[] {
    const rows = this.db
      .prepare(
        `SELECT d.inner AS inner, d.size AS size, d.modified AS modified, d.text AS text, d.truncated AS truncated,
           (SELECT count(*) FROM chunks c WHERE c.path = d.path AND c.inner = d.inner) AS chunks,
           (SELECT count(*) FROM chunks c WHERE c.path = d.path AND c.inner = d.inner
              AND EXISTS (SELECT 1 FROM vectors v WHERE v.embedder = ? AND v.hash = c.hash)) AS vectors
         FROM docs d WHERE d.path = ? ORDER BY d.inner`,
      )
      .all(embedder, path) as { inner: string; size: number; modified: string; text: number; truncated: number; chunks: number; vectors: number }[]
    return rows.map((r) => ({ inner: r.inner, size: r.size, modifiedAt: r.modified, text: r.text === 1, truncated: r.truncated === 1, chunks: r.chunks, vectors: r.vectors }))
  }

  stats(embedder: string | null): IndexStats {
    const one = (sql: string, ...params: (string | null)[]) => (this.db.prepare(sql).get(...params) as { n: number }).n
    return {
      files: one('SELECT count(*) AS n FROM docs'),
      textFiles: one('SELECT count(*) AS n FROM docs WHERE text = 1'),
      chunks: one('SELECT count(*) AS n FROM chunks'),
      vectors: one('SELECT count(*) AS n FROM chunks c WHERE EXISTS (SELECT 1 FROM vectors v WHERE v.embedder = ? AND v.hash = c.hash)', embedder),
      builtAt: (this.db.prepare(`SELECT value FROM meta WHERE key = 'builtAt'`).get() as { value: Instant }).value,
    }
  }
}
