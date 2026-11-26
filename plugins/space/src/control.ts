// PneumaSpace on Cloudflare through its control API (/api/v1), as the owner's account, the way its own
// command line calls it: sign in with the account and its key, then every call carries the session
// cookie, the CSRF token, the exact control origin, an Idempotency-Key and the manager's name. A
// session is opened at the first call and signed out by `close`, once per run of the plugin. The key
// and the cookie stay in this module: no message, record or answer carries them.
import { randomUUID } from 'node:crypto'
import { MANAGER } from './name.ts'
import { MANIFEST, type Digest, type Package } from './package.ts'

const TIMEOUT_MS = 120_000

export class ControlError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}

export type Manager = { name: string; url: string | null }
/** A row of `GET /tenants/<tenant>/apps`. Times are epoch ms. */
export type AppSummary = { id: string; name: string; url: string; status: string; ownerId: string; manager: Manager | null; observedAt: number | null }
export type Release = { number: number; digest: Digest; createdAt: number }
/** What `GET /apps/<id>` adds: the release online, the history, and the counts of the app's requests since it was made. */
export type AppDetail = AppSummary & { current: Release | null; releases: Release[]; requests: number | null; errors: number | null; lastAccessAt: number | null }
/** The app's upload allowance, from `GET /apps/<id>/state`: tickets used of 200, and the package bytes reserved of its storage. */
export type Uploads = { used: number; max: number; bytes: number; limit: number }
export type Action = { type: 'remove' } | { type: 'resume' } | { type: 'rollback'; release: number }

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown) => (typeof v === 'number' ? v : null)
const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** What the owner is told for the refusals they can act on, by the control API's error code. */
const WORDS: Record<string, string> = {
  login_failed: '账户或密钥不对',
  login_limit: '这台机器十分钟里登录超过 40 次，PneumaSpace 暂时不让再登录；过几分钟再试',
  app_quota: '这个空间的应用数或存储到了上限：撤下的应用也占着位置，只有在 PneumaSpace 上清除不用的应用才空得出来',
  app_exists: '这个名字已被这个 PneumaSpace 上别的空间的应用占用',
  artifact_quota: '这个应用的上传额度用完了：每个应用一生最多上传 200 次，包的字节合计也不能超过它分到的存储；只有在 PneumaSpace 上清除这个应用才能重来，发布记录会一起清掉',
  upload_limit: '没完成的上传太多，等十分钟再试',
  purging: '这个应用正在清除',
  managed: '这个应用归别的管理方',
  unauthorized: '登录失效了',
}

const manager = (v: unknown): Manager | null => {
  const m = obj(v)
  return str(m.name) === null ? null : { name: str(m.name) as string, url: str(m.url) }
}
const summary = (a: Json): AppSummary => ({
  id: str(a.id) ?? '',
  name: str(a.name) ?? '',
  url: str(a.url) ?? '',
  status: str(a.status) ?? '',
  ownerId: str(a.ownerId) ?? '',
  manager: manager(a.manager),
  observedAt: num(a.observedAt),
})
const release = (r: Json): Release | null => {
  const number = num(r.number)
  const digest = str(r.digest)
  return number === null || digest === null ? null : { number, digest: digest as Digest, createdAt: num(r.createdAt) ?? 0 }
}

type Session = { cookie: string; csrf: string; user: string; tenant: string }

export class Control {
  readonly origin: string
  readonly #account: string
  readonly #key: () => Promise<string>
  readonly #tenant: string | null
  #session: Promise<Session> | null = null

  /** `key`: the account key, read only when signing in. `tenant`: the space to use; the account's first when null. */
  constructor(origin: string, account: string, key: () => Promise<string>, tenant: string | null) {
    this.origin = origin
    this.#account = account
    this.#key = key
    this.#tenant = tenant
  }

  async #fetch(what: string, method: string, path: string, body: unknown, session: Session | null): Promise<{ response: Response; data: unknown }> {
    const headers: Record<string, string> = { origin: this.origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-pneuma-space-manager': MANAGER }
    if (session !== null) Object.assign(headers, { cookie: session.cookie, 'x-pneuma-space-csrf': session.csrf })
    let response: Response
    try {
      response = await fetch(`${this.origin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
      throw new ControlError(`连不上 Cloudflare 上的 PneumaSpace ${this.origin}（${what}）：${cause}`)
    }
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const error = obj(obj(data).error)
      const code = str(error.code)
      const words = code === null ? null : WORDS[code]
      throw new ControlError(`Cloudflare 上的 PneumaSpace 拒绝了${what}：${words ?? `${response.status} ${code ?? ''} ${str(error.message) ?? ''}`.trim()}`, code)
    }
    return { response, data }
  }

  async #signIn(): Promise<Session> {
    const key = await this.#key()
    const { response, data } = await this.#fetch(`账户 ${this.#account} 的登录`, 'POST', '/auth/login', { account: this.#account, key }, null)
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    const me = obj(data)
    const csrf = str(me.csrf)
    const user = str(obj(me.user).id)
    const tenants = (Array.isArray(me.tenants) ? me.tenants : []).map((t) => str(obj(t).id)).filter((t) => t !== null)
    const tenant = this.#tenant !== null && tenants.includes(this.#tenant) ? this.#tenant : tenants[0]
    if (!cookie.includes('=') || csrf === null || user === null) throw new ControlError(`Cloudflare 上的 PneumaSpace ${this.origin} 的登录没有给出会话`)
    if (tenant === undefined) throw new ControlError(`账户 ${this.#account} 在 Cloudflare 上的 PneumaSpace ${this.origin} 没有空间`)
    return { cookie, csrf, user, tenant }
  }

  #signedIn(): Promise<Session> {
    this.#session ??= this.#signIn()
    return this.#session
  }

  async #call(what: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return (await this.#fetch(what, method, path, body, await this.#signedIn())).data
  }

  /** The id of the account signed in. */
  async user(): Promise<string> {
    return (await this.#signedIn()).user
  }

  async apps(): Promise<Map<string, AppSummary>> {
    const { tenant } = await this.#signedIn()
    const items = obj(await this.#call('列出应用', 'GET', `/tenants/${tenant}/apps`)).items
    const rows = (Array.isArray(items) ? items : []).map((a) => summary(obj(a)))
    return new Map(rows.map((r) => [r.name, r]))
  }

  async app(id: string, name: string): Promise<AppDetail> {
    return this.#detail(await this.#call(`读应用 ${name}`, 'GET', `/apps/${id}`))
  }

  #detail(data: unknown): AppDetail {
    const d = obj(data)
    const usage = obj(d.usage)
    const releases = (Array.isArray(d.releases) ? d.releases : []).flatMap((r) => release(obj(r)) ?? [])
    return {
      ...summary(d),
      current: d.current ? release(obj(d.current)) : null,
      releases: releases.sort((a, b) => b.number - a.number),
      requests: num(usage.requests),
      errors: num(usage.errors),
      lastAccessAt: num(d.lastAccessAt),
    }
  }

  /** A durable app named `name`, managed by `pneuma-base` with the library's address. */
  async create(name: string, by: Manager): Promise<AppSummary> {
    const { tenant } = await this.#signedIn()
    return summary(obj(await this.#call(`建应用 ${name}`, 'POST', `/tenants/${tenant}/apps`, { name, manager: by })))
  }

  async act(app: AppSummary, action: Action): Promise<AppDetail> {
    const what = action.type === 'remove' ? `撤下 ${app.name}` : action.type === 'resume' ? `恢复 ${app.name}` : `把 ${app.name} 放回第 ${action.release} 版的内容`
    return this.#detail(await this.#call(what, 'POST', `/apps/${app.id}/actions`, action))
  }

  /** Uploads the package and makes it the app's new release: an upload ticket, the bytes PUT where it says, then the release. */
  async upload(app: AppSummary, pkg: Package): Promise<void> {
    const ticket = obj(await this.#call(`给 ${app.name} 领上传票据`, 'POST', `/apps/${app.id}/uploads`, { manifest: MANIFEST, digest: pkg.digest, bytes: pkg.bytes.length }))
    const url = str(ticket.url)
    const uploadId = str(ticket.uploadId)
    if (url === null || uploadId === null) throw new ControlError(`Cloudflare 上的 PneumaSpace 给 ${app.name} 的上传票据不全`)
    let put: Response
    try {
      put = await fetch(url, { method: 'PUT', headers: Object.fromEntries(Object.entries(obj(ticket.headers)).filter((e): e is [string, string] => typeof e[1] === 'string')), body: new Uint8Array(pkg.bytes), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      throw new ControlError(`上传 ${app.name} 的包没有完成：${error instanceof Error ? error.message : String(error)}；线上没有变`)
    }
    if (!put.ok) throw new ControlError(`上传 ${app.name} 的包被拒绝：${put.status}；线上没有变`)
    await this.#call(`发布 ${app.name}`, 'POST', `/apps/${app.id}/releases`, { uploadId })
  }

  async uploads(app: AppSummary): Promise<Uploads | null> {
    const a = obj(obj(await this.#call(`读 ${app.name} 的用量`, 'GET', `/apps/${app.id}/state`)).artifacts)
    const [used, max, reserved, limit] = [num(a.uploads), num(a.maxUploads), num(a.reservedBytes), num(a.limitBytes)]
    // The control API reports three times each: a ticket reserves its size for staging, code and static files.
    return used === null || max === null || reserved === null || limit === null ? null : { used, max, bytes: reserved / 3, limit: limit / 3 }
  }

  /** Signs out the session this run opened, if it opened one. */
  async close(): Promise<void> {
    const pending = this.#session
    this.#session = null
    const session = await pending?.catch(() => null)
    if (session) await this.#fetch('退出登录', 'POST', '/auth/logout', {}, session)
  }
}
