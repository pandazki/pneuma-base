// PneumaSpace through its admin HTTP API, and the bundle tar it takes. The tar layout is
// pneuma-space cli/appctl.ts's (ustar, sorted paths, mode 0644, uid, gid and mtime 0), so equal
// content gives equal bytes and so an equal bundle id, computed here before any upload.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { SiteFile } from '@pneuma-base/sdk/kit'

/** Every write names the manager; PneumaSpace answers 409 to a write without it on an app it manages. */
export const MANAGER = 'pneuma-base'
const MANAGER_HEADER = 'x-pneuma-space-manager'
const MANIFEST = { contract: 1, capabilities: { static: { dir: 'site' } } }
const TIMEOUT_MS = 15_000
const HOUR = 3_600_000

/** sha256 hex of a bundle tar: PneumaSpace's id for the content. */
export type BundleId = string & { readonly __brand: 'BundleId' }

export type Release = { number: number; publishedAt: number; bundle: BundleId }
/** What PneumaSpace says about one app, from `GET /api/apps/<name>`. */
export type AppDetail = { status: 'registered' | 'removed' | 'purging'; owner: string; current: number | null; releases: Release[] }
/** One row of `GET /api/apps`. Times are epoch ms; `requests` and `errors` count the last 24 hours. */
export type AppSummary = { name: string; address: string; release: number | null; status: string; requests: number | null; errors: number | null; lastAccessAt: number | null }

export class SpaceError extends Error {}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown) => (typeof v === 'number' ? v : null)
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const APP_STATUS = ['registered', 'removed', 'purging'] as const

export class Space {
  readonly admin: string
  readonly #token: () => Promise<string | null>
  #health: Promise<number> | null = null

  /** `token`: the bearer token, read only when a call is made; null in local mode. */
  constructor(admin: string, token: () => Promise<string | null>) {
    this.admin = admin.replace(/\/+$/, '')
    this.#token = token
  }

  async #call(method: string, path: string, body?: { json: unknown } | { tar: Buffer }): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { [MANAGER_HEADER]: MANAGER }
    const token = await this.#token()
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (body && 'json' in body) headers['content-type'] = 'application/json'
    if (body && 'tar' in body) headers['content-type'] = 'application/x-tar'
    const payload = body === undefined ? undefined : 'json' in body ? JSON.stringify(body.json) : new Uint8Array(body.tar)
    let response: Response
    try {
      response = await fetch(this.admin + path, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
      throw new SpaceError(`连不上 PneumaSpace ${this.admin}：${cause}`)
    }
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { error: text }
    }
    if (!response.ok && response.status !== 404) throw new SpaceError(`PneumaSpace 拒绝了 ${method} ${path}：${response.status} ${str(obj(data).error) ?? text}`)
    return { status: response.status, data }
  }

  async app(name: string): Promise<AppDetail | null> {
    const answer = await this.#call('GET', `/api/apps/${name}`)
    if (answer.status === 404) return null
    const detail = obj(answer.data)
    const app = obj(detail.app)
    const status = APP_STATUS.find((s) => s === app.status)
    if (status === undefined) throw new SpaceError(`PneumaSpace 答复的 ${name} 没有认得的状态：${JSON.stringify(app.status)}`)
    const releases = (Array.isArray(detail.releases) ? detail.releases.map(obj) : []).flatMap((r): Release[] => {
      const number = num(r.number)
      const bundle = str(r.bundle)
      return number === null || bundle === null ? [] : [{ number, publishedAt: num(r.publishedAt) ?? 0, bundle: bundle as BundleId }]
    })
    return { status, owner: str(app.owner) ?? '', current: num(app.current), releases: releases.sort((a, b) => b.number - a.number) }
  }

  async apps(): Promise<Map<string, AppSummary>> {
    const { data } = await this.#call('GET', '/api/apps')
    const rows: AppSummary[] = (Array.isArray(data) ? data : []).map(obj).map((a) => ({
      name: str(a.name) ?? '',
      address: str(a.address) ?? '',
      release: num(a.release),
      status: str(a.status) ?? '',
      requests: num(a.requests),
      errors: num(a.errors),
      lastAccessAt: num(a.lastAccessAt),
    }))
    return new Map(rows.map((r) => [r.name, r]))
  }

  /** Requests per hour over the last `hours` hours, oldest first, from `GET /api/usage?app=`; an hour with none is 0. */
  async requestsByHour(name: string, hours: number): Promise<number[]> {
    const to = Math.floor(Date.now() / HOUR) * HOUR + HOUR
    const from = to - hours * HOUR
    const { status, data } = await this.#call('GET', `/api/usage?app=${name}&from=${from}&to=${to}`)
    const series = Array.from({ length: hours }, () => 0)
    if (status === 404) return series
    for (const b of (Array.isArray(obj(data).buckets) ? (obj(data).buckets as unknown[]) : []).map(obj)) {
      const start = num(b.start)
      const i = start === null ? -1 : Math.floor((start - from) / HOUR)
      if (i >= 0 && i < hours) series[i]! += num(b.requests) ?? 0
    }
    return series
  }

  /** Uploads the bundle, then makes it the app's release: a new release when the content changed, the current one again when not. */
  async publish(name: string, tar: Buffer, bundle: BundleId, owner: string): Promise<number> {
    const uploaded = str(obj((await this.#call('POST', '/api/bundles', { tar })).data).bundle)
    if (uploaded !== bundle) throw new SpaceError(`PneumaSpace 给这份内容的编号 ${String(uploaded)} 和本地算的 ${bundle} 不同`)
    const { status, data } = await this.#call('PUT', `/api/apps/${name}/release`, { json: { image: null, manifest: MANIFEST, bundle, owner, manager: { name: MANAGER } } })
    const number = num(obj(data).number)
    if (status === 404 || number === null) throw new SpaceError(`PneumaSpace 没有给出 ${name} 的发布：${JSON.stringify(data)}`)
    return number
  }

  /** Takes the address down; releases and bundles stay, so publishing again restores it. */
  async remove(name: string): Promise<void> {
    await this.#call('POST', `/api/apps/${name}/remove`)
  }

  /** The origin of the ingress in path mode: the admin's host on the port `/api/health` names. */
  async ingress(): Promise<string> {
    this.#health ??= this.#call('GET', '/api/health').then(({ data }) => {
      const port = num(obj(data).ingressPort)
      if (port === null) throw new SpaceError('PneumaSpace 的 /api/health 没有给出 ingressPort')
      return port
    })
    const admin = new URL(this.admin)
    return `${admin.protocol}//${admin.hostname}:${await this.#health}`
  }
}

/** The owner a first publish gives an app: this library, so a name another library or a person holds is told apart. */
export function ownerOf(libraryId: string): string {
  const id = libraryId.length <= 52 ? libraryId : createHash('sha256').update(libraryId).digest('hex').slice(0, 52)
  return `service:pneuma-base.${id}`
}

/** The site's files as a bundle tar, in the order given (the kit's: sorted by the UTF-8 bytes of their paths), and its id. */
export async function bundleOf(files: readonly SiteFile[]): Promise<{ tar: Buffer; bundle: BundleId }> {
  const entries = await Promise.all(files.map(async (f) => ({ path: f.path, bytes: await readFile(f.abs) })))
  const tar = Buffer.concat([...entries.flatMap((e) => [header(e.path, e.bytes.length), e.bytes, Buffer.alloc((BLOCK - (e.bytes.length % BLOCK)) % BLOCK)]), Buffer.alloc(BLOCK * 2)])
  return { tar, bundle: createHash('sha256').update(tar).digest('hex') as BundleId }
}

const BLOCK = 512

function splitPath(path: string): [prefix: string, name: string] {
  if (Buffer.byteLength(path) <= 100) return ['', path]
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name]
  }
  throw new SpaceError(`文件路径太长，放不进 PneumaSpace 的包：${path}`)
}

function header(path: string, size: number): Buffer {
  const [prefix, name] = splitPath(path)
  const block = Buffer.alloc(BLOCK)
  const field = (offset: number, length: number, value: string) => block.write(value, offset, length, 'utf8')
  const octal = (offset: number, length: number, value: number) => field(offset, length, value.toString(8).padStart(length - 1, '0'))
  field(0, 100, name)
  octal(100, 8, 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0)
  field(148, 8, ' '.repeat(8))
  field(156, 1, '0')
  field(257, 6, 'ustar\0')
  field(263, 2, '00')
  field(345, 155, prefix)
  const sum = block.reduce((total, byte) => total + byte, 0)
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return block
}
