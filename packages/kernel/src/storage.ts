// The only door to storage. Nothing else in the kernel, and nothing above it, reads or writes the
// library's folder or its record area: they ask storage, the program of the provider that answers the
// library's address on this machine (providers.ts), which this module starts once per library and
// process (`serve`) and speaks to one JSON line at a time. STORAGE.md is the contract; core/README.md
// is the wire form, and PROVIDERS.md how a provider is run.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { providerOf, type Runnable } from './providers.js'
import {
  isFailure,
  type ContentAnswer,
  type Description,
  type Expect,
  type FactsSince,
  type Glanced,
  type Looked,
  type LookedPage,
  type Overview,
  type Place,
  type Probe,
  type ReadAnswer,
  type RecordPlace,
  type Row,
  type RowsPage,
  type StorageFailure,
  type Written,
} from '@pneuma-base/sdk'

type Answer = { outcome: 'done' | 'failed' | 'refused'; [field: string]: unknown }
/** How far a long operation is: files and bytes done, of how many (core/README.md, progress lines). */
export type StorageProgress = { files: number; bytes: number; total_files: number | null; total_bytes: number | null }
type Waiting = { resolve(answer: Answer): void; reject(error: Error): void; progress?: (p: StorageProgress) => void }

/**
 * One `serve` process for one library. It holds this process open only while a request is waiting;
 * a subscription (`listen`) never does, and is made again whenever the program is started again.
 */
class Served {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly waiting = new Map<number, Waiting>()
  private next = 0
  private chunks: Buffer[] = []
  private stderr = ''
  /** Whether this process subscribes to the library's changes, and the id of the subscription on the running program. */
  private listening = false
  private subscription: number | null = null

  /** The provider's program, chosen once: on the first start, unless bound before. */
  constructor(
    private readonly root: string,
    private provider: Runnable | null = null,
  ) {}

  /** Makes `provider` the one this library is spoken to through, when nothing chose one yet; whether it is. */
  boundTo(provider: Runnable): boolean {
    this.provider ??= provider
    return this.provider.executable === provider.executable
  }

  /** `progress` hears the progress lines storage sends for this request before its answer. */
  request(op: string, body: Record<string, unknown>, progress?: (p: StorageProgress) => void): Promise<Answer> {
    const child = this.child ?? this.start()
    const id = this.next++
    const line = `${JSON.stringify({ ...body, id, op })}\n`
    return new Promise<Answer>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, ...(progress === undefined ? {} : { progress }) })
      this.hold(true)
      child.stdin.write(line)
    })
  }

  listen(): void {
    this.listening = true
    if (this.subscription !== null) return
    if (this.child) this.subscribe(this.child)
    else this.start()
  }

  unlisten(): void {
    this.listening = false
    if (this.subscription !== null && this.child) this.child.stdin.write(`${JSON.stringify({ id: this.next++, op: 'cancel', target: this.subscription })}\n`)
    this.subscription = null
  }

  private subscribe(child: ChildProcessWithoutNullStreams): void {
    this.subscription = this.next++
    child.stdin.write(`${JSON.stringify({ id: this.subscription, op: 'subscribe' })}\n`)
  }

  private start(): ChildProcessWithoutNullStreams {
    this.provider ??= providerOf(this.root)
    const child = spawn(this.provider.executable, ['serve', '--root', this.root], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    const fail = (why: string) => {
      if (this.child !== child) return
      this.child = null
      this.subscription = null
      const error = new Error(`存储的程序停了（${why}）${this.stderr ? `：${this.stderr.trim()}` : ''}`)
      for (const w of this.waiting.values()) w.reject(error)
      this.waiting.clear()
    }
    child.on('error', (error) => fail(error.message))
    child.on('exit', (code, signal) => fail(signal ?? `退出码 ${code}`))
    child.stdin.on('error', () => undefined)
    this.hold(false)
    if (this.listening) this.subscribe(child)
    return child
  }

  /** An answer line may come in many chunks, and one chunk may hold many lines. */
  private read(chunk: Buffer): void {
    let start = 0
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      this.chunks.push(chunk.subarray(start, i))
      const line = Buffer.concat(this.chunks).toString('utf8')
      this.chunks = []
      start = i + 1
      this.answer(line)
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start))
  }

  private answer(line: string): void {
    const answer = JSON.parse(line) as Answer & { id: number | null; progress?: StorageProgress }
    if (answer.id === null) return
    if (answer.progress !== undefined) {
      this.waiting.get(answer.id)?.progress?.(answer.progress)
      return
    }
    // The subscription ended: storage has nothing to listen to here, or it was cancelled.
    if (answer.id === this.subscription) {
      this.subscription = null
      this.listening = false
      return
    }
    const w = this.waiting.get(answer.id)
    if (!w) return
    this.waiting.delete(answer.id)
    w.resolve(answer)
    this.hold(this.waiting.size > 0)
  }

  /** While nothing waits, the program must not keep this process alive; it ends when our side of its input closes. */
  private hold(busy: boolean): void {
    const child = this.child
    if (!child) return
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as unknown as { ref(): void; unref(): void }[]) {
      if (busy) handle.ref()
      else handle.unref()
    }
  }
}

const served = new Map<string, Served>()

const servedFor = (root: string): Served => {
  const known = served.get(root)
  if (known) return known
  const fresh = new Served(root)
  served.set(root, fresh)
  return fresh
}

/** Makes this process speak to the library at `root` through `provider`: init, which chooses it before machine state records it. */
export function bindProvider(root: string, provider: Runnable): void {
  if (!served.get(root)?.boundTo(provider)) served.set(root, new Served(root, provider))
}

/** A storage answer that is not `done` where only `done` makes sense: a fault of the caller or of storage, not of the library. */
export class StorageError extends Error {
  constructor(
    op: string,
    readonly answer: StorageFailure,
  ) {
    super(`存储答 ${op}：${answer.reason}${answer.detail ? `（${answer.detail}）` : ''}`)
  }
}

const done = async <T>(op: string, answer: Promise<Answer>): Promise<T> => {
  const a = await answer
  if (isFailure(a)) throw new StorageError(op, a)
  return a as unknown as T
}

const doneOrFailure = async <T>(answer: Promise<Answer>): Promise<T | StorageFailure> => {
  const a = await answer
  return isFailure(a) ? a : (a as unknown as T)
}

/** Which of a directory's files are its content, as the caller decides and storage applies: names left out at any depth, and an ignore file read in each directory. */
export type ContentRule = { noise?: readonly string[]; ignore_file?: string }

/** A deep look: which files of a directory count, and how many it may have before the look answers `too_many`. */
export type Deep = { rule?: ContentRule; limit?: number }

/**
 * Where a write's content comes from, as the door takes it: a path outside the library, bytes, or a
 * place in the content or in a record place's own area (copying).
 */
export type Source = { path: string } | { data: Uint8Array | string } | { place: Place; records?: string }

const wireSource = (from: Source): unknown => {
  if ('path' in from) return from.path
  if ('data' in from) return { data: Buffer.from(typeof from.data === 'string' ? Buffer.from(from.data, 'utf8') : from.data).toString('base64') }
  return { place: from.place, ...(from.records === undefined ? {} : { records: from.records }) }
}

/** The content operations on one area: the library's content (`records` undefined), or a record place's own content. */
function areaOf(s: Served, records: string | undefined) {
  const where = records === undefined ? {} : { records }
  return {
    glance: async (places: readonly Place[], facets?: readonly string[]) =>
      places.length === 0 ? [] : (await done<{ entries: Glanced[] }>('glance', s.request('glance', { ...where, places, ...(facets ? { facets } : {}) }))).entries,
    overview: (place: Place, opts: { limit?: number; after?: string } = {}) => doneOrFailure<Overview>(s.request('overview', { ...where, place, ...opts })),
    /** `deep`: each directory among the places is compared by its deep token, its files counted by `rule` up to `limit`. */
    look: async (places: readonly { place: Place; token: Expect }[], opts: { deep?: Deep } = {}): Promise<Looked> => {
      if (places.length === 0) return { same: 0, changed: [], gone: [], failed: [], held: [] }
      const a = await done<Looked>('look', s.request('look', { ...where, places, ...opts }))
      return { ...a, held: a.held ?? [] }
    },
    /** A look whose expectations are the rows of a table of the record place `rows.place`: a page of them, compared inside storage. */
    lookRows: (rows: { place: string; table: string; field: string }, opts: { limit?: number; after?: string; deep?: Deep } = {}) =>
      done<LookedPage>('look', s.request('look', { ...where, rows, ...opts })),
    content: (
      place: Place,
      { progress, ...opts }: { rule?: ContentRule; limit?: number; fetch?: boolean; manifest?: true | { limit?: number; after?: string }; progress?: (p: StorageProgress) => void } = {},
    ) => doneOrFailure<ContentAnswer>(s.request('content', { ...where, place, ...opts }, progress)),
    async read(place: Place, opts: { offset?: number; length?: number; to?: string; fetch?: boolean } = {}): Promise<ReadAnswer | StorageFailure> {
      const a = await doneOrFailure<Omit<ReadAnswer, 'data'> & { data?: string }>(s.request('read', { ...where, place, ...opts }))
      if (isFailure(a)) return a
      return { token: a.token, size: a.size, offset: a.offset, length: a.length, data: a.data === undefined ? null : new Uint8Array(Buffer.from(a.data, 'base64')) }
    },
    write: (place: Place, from: Source, expect: Expect, { progress, ...opts }: { hold?: string; rule?: ContentRule; limit?: number; progress?: (p: StorageProgress) => void } = {}) =>
      doneOrFailure<Written>(s.request('write', { ...where, place, from: wireSource(from), expect, ...opts }, progress)),
    move: (from: Place, to: Place, expect: { from: string; to: Expect }, opts: { hold?: string } = {}) => doneOrFailure<{ entry: Description }>(s.request('move', { ...where, from, to, expect, ...opts })),
    remove: (place: Place, expect: string, opts: { hold?: string } = {}) => doneOrFailure<{ removed: true }>(s.request('remove', { ...where, place, expect, ...opts })),
  }
}

export type Area = ReturnType<typeof areaOf>

/** The library at `root` as storage: every operation of the contract. */
export function storageOf(root: string) {
  const s = servedFor(root)
  const records = (place: string): RecordPlace => ({
    append: async (facts) => (await done<{ orders: string[] }>('facts.append', s.request('facts.append', { place, facts }))).orders,
    async since(cursor, limit) {
      const a = await s.request('facts.since', { place, cursor, ...(limit === undefined ? {} : { limit }) })
      if (a.outcome === 'refused' && a.reason === 'refused') return null
      if (isFailure(a)) throw new StorageError('facts.since', a)
      return a as unknown as FactsSince
    },
    async put(tables, opts = {}) {
      const a = await s.request('rows.put', { place, tables, ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }), ...('expect' in opts ? { expect: opts.expect } : {}) })
      if (a.outcome === 'refused' && a.reason === 'refused') return { written: false, actual: (a.actual as string | null | undefined) ?? null }
      if (isFailure(a)) throw new StorageError('rows.put', a)
      return { written: true }
    },
    get: <V>(table: string, keys: readonly string[]) => done<{ rows: Row<V>[]; cursor: string | null }>('rows.get', s.request('rows.get', { place, table, keys })),
    under: <V>(table: string, prefix: string, opts: { limit?: number; after?: string } = {}) => done<RowsPage<V>>('rows.under', s.request('rows.under', { place, table, prefix, ...opts })),
    where: <V>(table: string, field: string, value: string, opts: { limit?: number; after?: string } = {}) => done<RowsPage<V>>('rows.where', s.request('rows.where', { place, table, field, value, ...opts })),
    count: async (table, field, value) => (await done<{ count: number }>('rows.where', s.request('rows.where', { place, table, field, value, count: true }))).count,
    reset: async () => void (await done('rows.reset', s.request('rows.reset', { place }))),
  })
  return {
    ...areaOf(s, undefined),
    /** A record place's own content: places under `.pneuma-base/<name>/`, its facts aside. */
    own: (name: string) => areaOf(s, name),
    probe: (place: Place, budget?: number) => doneOrFailure<Probe>(s.request('probe', { place, ...(budget === undefined ? {} : { budget }) })),
    /**
     * The places changed since `cursor`, or `cannot_say` (places null); without a cursor only the
     * current one. Each answer carries the cursor to keep. `budget`: how many milliseconds storage
     * may take before it says it cannot say.
     */
    async changed(cursor: string | null, opts: { limit?: number; budget?: number } = {}): Promise<{ places: Place[]; cursor: string; more: boolean } | { places: null; cursor: string }> {
      const a = await s.request('changed', { ...(cursor === null ? {} : { cursor }), ...opts })
      if (isFailure(a)) {
        if (a.reason === 'cannot_say' && typeof a.cursor === 'string') return { places: null, cursor: a.cursor }
        throw new StorageError('changed', a)
      }
      return a as unknown as { places: Place[]; cursor: string; more: boolean }
    },
    /** Subscribes this process to the library's changes, so storage keeps a log any process's `changed` is answered from. Lasts until `unlisten` or the process ends. */
    listen: () => s.listen(),
    unlisten: () => s.unlisten(),
    hold: (places: readonly Place[], ttl?: number) => doneOrFailure<{ hold: string; until: string }>(s.request('hold', { places, ...(ttl === undefined ? {} : { ttl }) })),
    release: async (hold: string) => void (await done('release', s.request('release', { hold }))),
    records,
    /** A facts file written elsewhere, put in whole under its name (`<YYYY-MM-DD>/<name>.jsonl`) from a file outside the library. */
    carryFacts: (place: string, file: string, from: string) => doneOrFailure<{ carried: boolean }>(s.request('facts.carry', { place, file, from })),
    noise: {
      list: () => done<{ names: string[]; paths: Place[]; declared: boolean }>('noise.list', s.request('noise.list', {})),
      add: (add: { names?: string[]; paths?: Place[] }) => done<{ names: string[]; paths: Place[] }>('noise.add', s.request('noise.add', add)),
      remove: (drop: { names?: string[]; paths?: Place[] }) => done<{ names: string[]; paths: Place[] }>('noise.remove', s.request('noise.remove', drop)),
    },
    /** The library's declaration at its root: what the kernel keeps there, which storage does not read. */
    declaration: {
      read: () => done<{ declaration: Record<string, unknown> | null; token: string | null }>('declaration.read', s.request('declaration.read', {})),
      async write(declaration: Record<string, unknown>, expect: Expect): Promise<{ token: string } | { refused: string | null }> {
        const a = await s.request('declaration.write', { declaration, expect })
        if (a.outcome === 'refused' && a.reason === 'refused') return { refused: (a.actual as string | null | undefined) ?? null }
        if (isFailure(a)) throw new StorageError('declaration.write', a)
        return { token: a.token as string }
      },
    },
    init: () => done<{ created: boolean }>('init', s.request('init', {})),
    describe: () => done<Record<string, unknown>>('describe', s.request('describe', {})),
  }
}

export type Storage = ReturnType<typeof storageOf>
