// An append-only store of a plugin's own facts, in its record place (`ctx.tools.storage.records`):
// each `append` is one write of facts, and the facts are read back page by page, in storage's order.
// A plugin may keep several stores in its one record place: each fact carries its store's name.
// Concurrent writers and a sync that brings another machine's facts lose nothing: storage never
// changes or replaces a fact once written.
import { randomBytes } from 'node:crypto'
import { isFailure, type Place, type PlaceStore } from '../storage.js'
import type { Instant, PluginContext } from '../types.js'

/** Who wrote a record, from the context's actor. */
export type RecordActor = { kind: 'agent' | 'owner' | 'plugin'; name: string }

/** What every record carries besides its body. Ids sort by time, then by writer, then by order within the writer. */
export type Envelope = { id: string; at: Instant; actor: RecordActor; session: string }

/**
 * A fact the reader left out, and why. `at`: storage's order of the fact, or `<directory>/<file>#<line>`
 * for a line of a file an earlier version wrote under the plugin's own directory.
 */
export type Skipped = { at: string; reason: string }

/** A page of records in storage's order, and the cursor to read on from; `more` when the next page is there already. */
export type RecordPage<B extends object> = { records: (Envelope & B)[]; skipped: Skipped[]; cursor: string; more: boolean }

export interface RecordStore<B extends object> {
  /** A record of `body` by the context's actor and session, at the context's time. Nothing is written yet. */
  stamp(ctx: PluginContext, body: B): Envelope & B
  /** Writes the records as one write of facts, each with the store's name. Nothing to write writes nothing. */
  append(records: readonly (Envelope & B)[]): Promise<void>
  /**
   * The records after `cursor`, at most `limit` facts of the record place read (1000), and the cursor to
   * read on from. The page from `cursor` null also gives, first and in id order, what an earlier version
   * of the kit wrote under the plugin's own directory for this store. Null when the cursor no longer
   * fits the facts there: read again from null.
   */
  since(cursor: string | null, limit?: number): Promise<RecordPage<B> | null>
  /**
   * Every record, in id order, and the facts that are not records, which stay as they are. Its cost
   * follows every fact of the plugin's record place, of every store: it reads them all, a page at a time.
   */
  read(): Promise<{ records: (Envelope & B)[]; skipped: Skipped[] }>
}

/** A plugin's parser: a stored object, envelope included, as a record's body, or why it is not one. */
type Parse<B> = (raw: Record<string, unknown>) => B | string

/** The field of a fact that names its store. A fact without it is the `facts` store's, as every fact was before stores had names. */
export const STORE_FIELD = 'store'
const DEFAULT_STORE = 'facts'
const PAGE = 1000

const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
/** This process, among the writers of a library: ids of records written in the same millisecond still differ. */
const writer = randomBytes(3).toString('hex')
let sequence = 0

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const byId = (a: Envelope, b: Envelope) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function stampOf<B extends object>(ctx: PluginContext, body: B): Envelope & B {
  const actor: RecordActor = ctx.actor.kind === 'owner' ? { kind: 'owner', name: 'owner' } : { kind: ctx.actor.kind, name: ctx.actor.name }
  return { id: `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}`, at: ctx.now, actor, session: ctx.session.id, ...body }
}

/** A stored object as a record, through the plugin's parser; or why it is not one. */
function recordOf<B extends object>(raw: unknown, parse: Parse<B>): (Envelope & B) | string {
  const actor = isObject(raw) ? raw.actor : null
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.session !== 'string' || !isObject(actor) || typeof actor.kind !== 'string' || typeof actor.name !== 'string') {
    return '缺 id、at、actor 或 session'
  }
  const body = parse(raw)
  return typeof body === 'string' ? body : { ...body, id: raw.id, at: raw.at as Instant, actor: actor as RecordActor, session: raw.session }
}

/** A stored object and where it is; `bad` when its line is not JSON. */
type Stored = { at: string; raw: unknown; bad?: string }
type Collected<B extends object> = { records: (Envelope & B)[]; skipped: Skipped[] }

/** Adds a stored object to the records, or to what was left out, saying why. */
function take<B extends object>(into: Collected<B>, stored: Stored, parse: Parse<B>): void {
  const r = stored.bad ?? recordOf(stored.raw, parse)
  if (typeof r === 'string') into.skipped.push({ at: stored.at, reason: r })
  else into.records.push(r)
}

/** The lines of a file as objects, each with where it is; a line that is not JSON says so. */
function linesOf(text: string, at: string): Stored[] {
  return text.split('\n').flatMap((line, i) => {
    if (line.trim() === '') return []
    try {
      return [{ at: `${at}#${i + 1}`, raw: JSON.parse(line) as unknown }]
    } catch {
      return [{ at: `${at}#${i + 1}`, raw: null, bad: '不是一行 JSON' }]
    }
  })
}

const isRecordFile = (name: string) => !name.startsWith('.') && name.endsWith('.jsonl')

/** The bytes of a file in a place store, every range of it. Null when it cannot be read. */
async function bytesOf(store: PlaceStore, place: Place): Promise<Buffer | null> {
  const chunks: Uint8Array[] = []
  for (let offset = 0; ; ) {
    const read = await store.read(place, { offset })
    if (isFailure(read) || read.data === null) return null
    chunks.push(read.data)
    offset += read.length
    if (read.length === 0 || offset >= read.size) return Buffer.concat(chunks)
  }
}

/**
 * The files an earlier version of the kit wrote for the store `name`, in `.pneuma-base/<plugin>/<name>/`,
 * read through the plugin's own content. The `facts` store has none here: the files it wrote lie in the
 * record place's facts, which storage gives with the others.
 */
async function legacyLines(ctx: PluginContext, name: string): Promise<Stored[]> {
  if (name === DEFAULT_STORE) return []
  const own = ctx.tools.storage.own
  const out: Stored[] = []
  let after: string | undefined
  for (;;) {
    const page = await own.overview(name, { limit: PAGE, ...(after === undefined ? {} : { after }) })
    if (isFailure(page)) return out
    for (const e of page.entries) {
      const file = e.place.slice(e.place.lastIndexOf('/') + 1)
      if (e.kind !== 'file' || !isRecordFile(file)) continue
      const bytes = await bytesOf(own, e.place)
      if (bytes !== null) out.push(...linesOf(bytes.toString('utf8'), e.place))
    }
    if (page.more === null) return out
    after = page.more.after
  }
}


/**
 * The store `name` in the plugin's record place. `parse` takes a fact, envelope included, and answers
 * its body, or a reason it is not one of this plugin's records. What the earlier kit wrote in
 * `.pneuma-base/<plugin>/<name>/` is read with it.
 */
export function recordStore<B extends object>(ctx: PluginContext, name: string, parse: Parse<B>): RecordStore<B> {
  const { records } = ctx.tools.storage
  const mine = (raw: unknown) => isObject(raw) && (raw[STORE_FIELD] ?? DEFAULT_STORE) === name
  const store: RecordStore<B> = {
    stamp: stampOf,

    async append(written) {
      if (written.length === 0) return
      await records.append(written.map((r) => ({ ...r, [STORE_FIELD]: name })))
    },

    async since(cursor, limit = PAGE) {
      const answer = await records.since(cursor, limit)
      if (answer === null) return null
      const page: Collected<B> = { records: [], skipped: [] }
      if (cursor === null) {
        for (const line of await legacyLines(ctx, name)) take(page, line, parse)
        page.records.sort(byId)
      }
      for (const f of answer.facts) if (mine(f.fact)) take(page, { at: f.order, raw: f.fact }, parse)
      return { ...page, cursor: answer.cursor, more: answer.more }
    },

    async read() {
      const all: Collected<B> = { records: [], skipped: [] }
      let cursor: string | null = null
      for (;;) {
        const page: RecordPage<B> | null = await store.since(cursor)
        if (page === null) {
          // The facts were rewritten under the cursor while reading: read them all again.
          if (cursor === null) throw new Error(`${name} 的记录读不出来`)
          all.records.length = 0
          all.skipped.length = 0
          cursor = null
          continue
        }
        all.records.push(...page.records)
        all.skipped.push(...page.skipped)
        if (!page.more) break
        cursor = page.cursor
      }
      return { records: all.records.sort(byId), skipped: all.skipped }
    },
  }
  return store
}
