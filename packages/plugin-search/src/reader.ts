// Reading registered things into the index, through storage and bounded: a file up to its first
// TEXT_LIMIT bytes; a directory thing by the manifest its content rule gives, reading only the files
// whose fingerprint the index does not have; at most READS files per hook call, the rest left pending
// for the next. After a thing is read, its places' tokens go into `tokens`, so storage can say when it
// changes.
import { isDescribed, isFailure, type LibraryPath, type Manifest, type Place, type PluginContext, type ReadAnswer, type StorageFailure } from '@pneuma-base/kernel'
import { PENDING, pagesUnder, putToken, rowsOf, TOKENS, Writes, type Observed, type Outcome, type Thing } from './registry.js'
import type { Doc, SearchIndex } from './store.js'
import { chunksOf, decodeHead, indexTerms, TEXT_LIMIT, visibleText } from './text.js'

/** How many files one hook call reads at most. */
export const READS = 200
/** How many files of a directory thing's manifest one page lists: more than one thing takes, so one page lists them all. */
const MANIFEST_PAGE = 10_000
const PENDING_PAGE = 100
const GLANCE_PAGE = 1000

/** What a hook call may still read; `Infinity` for the named whole action. */
export type Budget = { files: number }

type Store = PluginContext['tools']['storage']

function docOf(inner: string, name: string, read: ReadAnswer, fingerprint: string | null): Doc {
  const decoded = decodeHead(read.data ?? new Uint8Array(), read.size)
  if (decoded === null) return { inner, fingerprint, text: false, truncated: false, chunks: [] }
  const chunks = chunksOf(visibleText(name, decoded.text)).map((body) => ({ body, terms: indexTerms(body) }))
  return { inner, fingerprint, text: true, truncated: decoded.truncated, chunks }
}

/** A failure storage may not answer the same way a moment later: the thing stays pending. */
const passing = (f: StorageFailure) => f.reason === 'busy' || f.reason === 'held' || f.reason === 'cancelled'

/** Every file the content rule counts in the directory thing at `path`, and the token of the version read. */
async function manifestOf(store: Store, path: LibraryPath): Promise<{ token: string; entries: Manifest['entries'] } | StorageFailure> {
  const entries: Manifest['entries'] = []
  let token: string | null = null
  for (let after: string | undefined; ; ) {
    const answer = await store.content(path, { manifest: { limit: MANIFEST_PAGE, ...(after === undefined ? {} : { after }) } })
    if (isFailure(answer)) return answer
    if (answer.kind !== 'dir') return { outcome: 'failed', reason: 'not_a_dir' }
    token ??= answer.token
    entries.push(...(answer.manifest?.entries ?? []))
    if (!answer.manifest?.more) return { token, entries }
    after = answer.manifest.more.after
  }
}

/** The tokens storage gives these places now, each that is there. */
async function tokensOf(store: Store, places: readonly Place[]): Promise<Map<Place, string>> {
  const out = new Map<Place, string>()
  for (let i = 0; i < places.length; i += GLANCE_PAGE) {
    for (const g of await store.glance(places.slice(i, i + GLANCE_PAGE))) if (isDescribed(g) && g.kind !== 'none' && g.token !== undefined && !g.held) out.set(g.place, g.token)
  }
  return out
}

/** Every directory inside a directory thing that holds a file it counts, relative to it. */
function dirsOf(entries: Manifest['entries']): string[] {
  const dirs = new Set<string>()
  for (const { path } of entries) for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) dirs.add(path.slice(0, i))
  return [...dirs]
}

class Reader {
  readonly writes = new Writes()

  constructor(
    private readonly store: Store,
    private readonly index: SearchIndex,
    readonly budget: Budget,
  ) {}

  /** The rows of the places inside a directory thing: all of them are written again or dropped. */
  private async dropInside(path: LibraryPath, keep: ReadonlySet<Place>): Promise<void> {
    for await (const page of pagesUnder<Observed>(this.store.records, TOKENS, `${path}/`, MANIFEST_PAGE)) for (const r of page) if (!keep.has(r.key)) this.writes.set(TOKENS, r.key, null)
  }

  private done(path: LibraryPath, token: string, outcome: Outcome): void {
    putToken(this.writes, path, token, { thing: path, outcome })
    this.writes.set(PENDING, path, null)
  }

  /** A thing storage would not give: forgotten by the index, with what is there now as what it read, so a change there brings it back. */
  private async failed(path: LibraryPath, thing: Thing, failure: StorageFailure): Promise<void> {
    if (passing(failure)) return
    this.index.put(path, [])
    if (thing.bundle) await this.dropInside(path, new Set())
    if (failure.reason === 'no_such_place') return this.done(path, 'empty', { state: 'gone' })
    const token = (await tokensOf(this.store, [path])).get(path) ?? 'empty'
    this.done(path, token, failure.reason === 'too_many' ? { state: 'too_many', atLeast: failure.at_least ?? 0 } : { state: 'unreadable', reason: failure.reason })
  }

  private async readFile(path: LibraryPath): Promise<void> {
    this.budget.files--
    const read = await this.store.read(path, { length: TEXT_LIMIT })
    if (isFailure(read)) return this.failed(path, { bundle: false }, read)
    this.index.put(path, [docOf('', path, read, null)])
    this.done(path, read.token, { state: 'read' })
  }

  /** Reads the files of a directory thing the index does not have as they are; finished when it read them all. */
  private async readBundle(path: LibraryPath): Promise<void> {
    const listed = await manifestOf(this.store, path)
    if (isFailure(listed)) return this.failed(path, { bundle: true }, listed)
    const known = this.index.fingerprints(path)
    const unread = listed.entries.filter((e) => known.get(e.path) !== e.fingerprint)
    const now = unread.slice(0, Math.max(0, this.budget.files))
    const docs: Doc[] = []
    const read = new Map<Place, string>()
    for (const e of now) {
      this.budget.files--
      const answer = await this.store.read(`${path}/${e.path}`, { length: TEXT_LIMIT })
      if (isFailure(answer)) continue
      docs.push(docOf(e.path, e.path, answer, e.fingerprint))
      read.set(`${path}/${e.path}`, answer.token)
    }
    this.index.put(path, docs, new Set(listed.entries.map((e) => e.path)))
    if (now.length < unread.length) return
    const inside = [...dirsOf(listed.entries), ...listed.entries.map((e) => e.path)].map((p) => `${path}/${p}`)
    const tokens = await tokensOf(this.store, inside.filter((p) => !read.has(p)))
    for (const [place, token] of read) tokens.set(place, token)
    for (const [place, token] of tokens) putToken(this.writes, place, token, { thing: path })
    await this.dropInside(path, new Set(tokens.keys()))
    this.done(path, listed.token, { state: 'read' })
  }

  async read(path: LibraryPath, thing: Thing): Promise<void> {
    await (thing.bundle ? this.readBundle(path) : this.readFile(path))
  }
}

/**
 * Reads pending things while the budget lasts: those of `only` when given (the things of a put), else
 * every pending thing a page at a time. What it read is saved in the rows after the index has it.
 */
export async function readPending(ctx: PluginContext, index: SearchIndex, budget: Budget, only?: readonly LibraryPath[]): Promise<void> {
  const store = ctx.tools.storage
  const pages = async function* () {
    if (only !== undefined) yield [...(await rowsOf<Thing>(store.records, PENDING, only)).values()]
    else yield* pagesUnder<Thing>(store.records, PENDING, '', PENDING_PAGE)
  }
  for await (const page of pages()) {
    const reader = new Reader(store, index, budget)
    for (const { key, value } of page) {
      if (budget.files <= 0) break
      await reader.read(key as LibraryPath, value)
    }
    if (reader.writes.size > 0) await store.records.put(reader.writes.rows())
    if (budget.files <= 0) return
  }
}
