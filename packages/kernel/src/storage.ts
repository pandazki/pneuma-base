// The only door to storage. Nothing else in the kernel, and nothing above it, reads or writes the
// library's folder or its record area for the paths that go through here: they ask storage, the
// `pneuma-base-core` program, which this module starts once per library and process (`serve`) and
// speaks to one JSON line at a time. tmp/run-7 STORAGE.md; the wire form is core/README.md.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isFailure,
  type FactsSince,
  type Glanced,
  type Looked,
  type Overview,
  type Place,
  type PluginStorage,
  type Probe,
  type RecordPlace,
  type Row,
  type RowsPage,
  type StorageFailure,
} from '@pneuma-base/sdk'

/**
 * Where the program is: `PNEUMA_BASE_CORE`; else the one a package file carries beside the kernel
 * (scripts/pack-dist.mjs); else the one built in this repository, release before debug.
 */
export function corePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PNEUMA_BASE_CORE) return env.PNEUMA_BASE_CORE
  for (const at of ['../bin/pneuma-base-core', '../../../core/target/release/pneuma-base-core', '../../../core/target/debug/pneuma-base-core']) {
    const path = fileURLToPath(new URL(at, import.meta.url))
    if (existsSync(path)) return path
  }
  throw new Error('存储的程序 pneuma-base-core 不在：在 pneuma-base 的仓库里运行 pnpm build，或用 PNEUMA_BASE_CORE 指明它在哪')
}

type Answer = { outcome: 'done' | 'failed' | 'refused'; [field: string]: unknown }
type Waiting = { resolve(answer: Answer): void; reject(error: Error): void }

/** One `serve` process for one library. It holds this process open only while a request is waiting. */
class Served {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly waiting = new Map<number, Waiting>()
  private next = 0
  private chunks: Buffer[] = []
  private stderr = ''

  constructor(private readonly root: string) {}

  request(op: string, body: Record<string, unknown>): Promise<Answer> {
    const child = this.child ?? this.start()
    const id = this.next++
    const line = `${JSON.stringify({ ...body, id, op })}\n`
    return new Promise<Answer>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.hold(true)
      child.stdin.write(line)
    })
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(corePath(), ['serve', '--root', this.root], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    const fail = (why: string) => {
      if (this.child !== child) return
      this.child = null
      const error = new Error(`存储的程序停了（${why}）${this.stderr ? `：${this.stderr.trim()}` : ''}`)
      for (const w of this.waiting.values()) w.reject(error)
      this.waiting.clear()
    }
    child.on('error', (error) => fail(error.message))
    child.on('exit', (code, signal) => fail(signal ?? `退出码 ${code}`))
    child.stdin.on('error', () => undefined)
    this.hold(false)
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
    const answer = JSON.parse(line) as Answer & { id: number | null; progress?: unknown }
    if (answer.progress !== undefined || answer.id === null) return
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

/** A storage answer that is not `done` where only `done` makes sense: a fault of the caller or of storage, not of the library. */
class StorageError extends Error {
  constructor(op: string, readonly answer: StorageFailure) {
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

/** The library at `root` as storage: every operation this step built. */
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
    glance: async (places: readonly Place[]) => (await done<{ entries: Glanced[] }>('glance', s.request('glance', { places }))).entries,
    overview: (place: Place, opts: { limit?: number; after?: string } = {}) => doneOrFailure<Overview>(s.request('overview', { place, ...opts })),
    probe: (place: Place, budget?: number) => doneOrFailure<Probe>(s.request('probe', { place, ...(budget === undefined ? {} : { budget }) })),
    look: (places: readonly { place: Place; token: string }[]) => done<Looked>('look', s.request('look', { places })),
    records,
    noise: {
      list: () => done<{ names: string[]; paths: Place[]; declared: boolean }>('noise.list', s.request('noise.list', {})),
      add: (add: { names?: string[]; paths?: Place[] }) => done<{ names: string[]; paths: Place[] }>('noise.add', s.request('noise.add', add)),
      remove: (drop: { names?: string[]; paths?: Place[] }) => done<{ names: string[]; paths: Place[] }>('noise.remove', s.request('noise.remove', drop)),
    },
    init: () => done<{ created: boolean }>('init', s.request('init', {})),
    describe: () => done<Record<string, unknown>>('describe', s.request('describe', {})),
  }
}

export type Storage = ReturnType<typeof storageOf>

/** What a plugin gets: the looks, and its own record place under its name. Its records are only a name to storage. */
export function pluginStorage(root: string, place: string): PluginStorage {
  const s = storageOf(root)
  return {
    glance: s.glance,
    overview: s.overview,
    look: s.look,
    probe: s.probe,
    noise: async () => {
      const { names, paths } = await s.noise.list()
      return { names, paths }
    },
    records: s.records(place),
  }
}
