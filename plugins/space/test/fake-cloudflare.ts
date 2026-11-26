// PneumaSpace on Cloudflare in memory, as the test kit's stand-in serves it: the control API calls the
// plugin makes, answering as the owner's deployment answered them (scripts in the brief's run, and
// pneuma-space cf/src/worker.ts, artifacts.ts, app.ts): sign-in with a session cookie and a CSRF token,
// the exact Origin on every write, upload tickets PUT to their own address, releases, the remove,
// resume, rollback and purge actions, the manager's name on managed writes, and the app's own address
// served only to a signed-in session. It counts what a test asserts on: sign-ins, sign-outs, tickets,
// and which apps' details were read.
import { createHash, randomBytes } from 'node:crypto'

type Manager = { name: string; url: string | null }
type Release = { number: number; digest: string; bytes: number; createdAt: number; files: Map<string, { body: Buffer; contentType: string }> }
type App = {
  id: string
  name: string
  tenant: string
  ownerId: string
  manager: Manager | null
  status: 'draft' | 'registered' | 'removed' | 'purging'
  current: number | null
  releases: Release[]
  generation: number
  tickets: number
  reserved: number
  requests: number
  lastAccessAt: number | null
  createdAt: number
}
type Upload = { id: string; app: string; digest: string; bytes: number; generation: number; data: Buffer | null }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const STORAGE = 10 * 1024 * 1024
const MAX_UPLOADS = 200
const LIMIT = 4 * 1024 * 1024
const MANIFEST = JSON.stringify({ contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } })

export type FakeCloudflare = ReturnType<typeof fakeCloudflare>

export function fakeCloudflare(options: { apps?: number } = {}) {
  const account = 'demo'
  const key = randomBytes(32).toString('hex')
  const user = 'u_demo'
  const tenant = 't_demo'
  const sessions = new Map<string, string>()
  const apps = new Map<string, App>()
  const uploads = new Map<string, Upload>()
  const state = { logins: 0, logouts: 0, failNextPut: false, detailsRead: new Map<string, number>() }
  let origin = ''
  let next = 0
  const id = (prefix: string) => `${prefix}_${(++next).toString(16).padStart(8, '0')}`

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
  const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const named = (name: string) => [...apps.values()].find((a) => a.name === name)
  const current = (a: App) => a.releases.find((r) => r.number === a.current) ?? null
  const releaseView = (r: Release) => ({ digest: r.digest, bytes: r.bytes, key: `apps/x/artifacts/${r.digest}/package.json`, manifest: JSON.parse(MANIFEST), number: r.number, createdAt: r.createdAt, createdBy: user })
  const summary = (a: App) => ({
    id: a.id,
    name: a.name,
    tenantId: a.tenant,
    ownerId: a.ownerId,
    url: `${origin}/apps/${a.name}/`,
    status: a.status,
    runtime: { state: 'asleep' },
    release: a.current,
    observedAt: Date.now(),
    createdAt: a.createdAt,
    expiresAt: null,
    manager: a.manager,
  })
  const snapshot = (a: App) => ({
    ...summary(a),
    generation: a.generation,
    current: current(a) && releaseView(current(a) as Release),
    releases: a.releases.map(releaseView),
    capabilities: a.current === null ? [] : ['static'],
    lastAccessAt: a.lastAccessAt,
    usage: { requests: a.requests, errors: 0, wakes: 0, sleeps: 0 },
    wake: null,
  })
  const cookieOf = (request: Request) => /__Host-pneuma-space-control=([0-9a-f]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null
  const csrfOf = (request: Request) => {
    const cookie = cookieOf(request)
    return cookie === null ? null : (sessions.get(cookie) ?? null)
  }

  /** An app's package as the control API checks it before a release: the manifest, 1 to 256 files, safe paths, 4 MiB. */
  function parsePackage(data: Buffer): Release['files'] | string {
    let pkg: { manifest?: unknown; files?: { path?: unknown; body?: unknown; contentType?: unknown }[] }
    try {
      pkg = JSON.parse(data.toString('utf8'))
    } catch {
      return 'Package is not valid JSON.'
    }
    if (JSON.stringify(pkg.manifest) !== MANIFEST) return 'Uploaded manifest does not match.'
    if (!Array.isArray(pkg.files) || pkg.files.length === 0 || pkg.files.length > 256) return 'Package must contain 1–256 files.'
    const files: Release['files'] = new Map()
    let size = 0
    for (const f of pkg.files) {
      const path = f.path
      if (typeof path !== 'string' || path.length > 300 || /[\u0000-\u001f\\]/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..')) return 'Invalid relative path.'
      if (typeof f.body !== 'string') return 'File body must be base64.'
      size += f.body.length
      if (size > LIMIT) return 'Package is too large.'
      files.set(path, { body: Buffer.from(f.body, 'base64'), contentType: typeof f.contentType === 'string' ? f.contentType : 'application/octet-stream' })
    }
    return files
  }

  async function control(request: Request, path: string): Promise<Response> {
    const write = !['GET', 'HEAD'].includes(request.method)
    if (write && request.headers.get('origin') !== origin) return fail(403, 'origin', 'The request origin is not allowed.')
    const body = write ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}
    if (path === '/auth/login') {
      state.logins++
      if (body.account !== account || body.key !== key) return fail(401, 'login_failed', 'Account or access key is incorrect.')
      const cookie = randomBytes(32).toString('hex')
      const csrf = randomBytes(32).toString('hex')
      sessions.set(cookie, csrf)
      return json({ user: { id: user, username: account }, platformAdmin: true, tenants: [{ id: tenant, role: 'admin' }], csrf }, 200, { 'set-cookie': `__Host-pneuma-space-control=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800` })
    }
    const csrf = csrfOf(request)
    if (csrf === null) return fail(401, 'unauthorized', 'Sign in to continue.')
    if (write && request.headers.get('x-pneuma-space-csrf') !== csrf) return fail(403, 'csrf', 'Reload the page before trying again.')
    if (path === '/auth/logout') {
      state.logouts++
      sessions.delete(cookieOf(request) as string)
      return new Response(null, { status: 204 })
    }
    const list = /^\/tenants\/([^/]+)\/apps$/.exec(path)
    if (list) {
      if (list[1] !== tenant) return fail(403, 'tenant_role', 'A tenant administrator is required.')
      if (request.method === 'GET') return json({ items: [...apps.values()].filter((a) => a.tenant === tenant).map(summary) })
      const name = body.name
      if (typeof name !== 'string' || !NAME.test(name)) return fail(400, 'name', 'Use lowercase letters, numbers and hyphens.')
      if (named(name)) return fail(409, 'app_exists', 'An application already uses this name.')
      if ([...apps.values()].filter((a) => a.tenant === tenant).length >= (options.apps ?? 50)) return fail(409, 'app_quota', 'The space has reached its application or allocated storage limit.')
      const m = body.manager as Manager | undefined
      const app: App = { id: id('a'), name, tenant, ownerId: user, manager: m ? { name: m.name, url: m.url ?? null } : null, status: 'draft', current: null, releases: [], generation: 0, tickets: 0, reserved: 0, requests: 0, lastAccessAt: null, createdAt: Date.now() }
      apps.set(app.id, app)
      return json(summary(app), 201)
    }
    const route = /^\/apps\/([a-zA-Z0-9_-]+)(?:\/([a-z]+))?$/.exec(path)
    const app = route ? apps.get(route[1] as string) : undefined
    if (!route || app === undefined || app.tenant !== tenant) return fail(404, 'app_not_found', 'Application not found.')
    const section = route[2]
    const managed = (action?: string) => {
      const header = request.headers.get('x-pneuma-space-manager')
      if (app.manager && header !== app.manager.name && (action === undefined || ['rollback', 'remove', 'resume', 'purge'].includes(action))) return fail(409, 'managed', `Application ${app.name} is managed by ${app.manager.name}.`)
      return null
    }
    if (section === undefined && request.method === 'GET') {
      state.detailsRead.set(app.name, (state.detailsRead.get(app.name) ?? 0) + 1)
      return json(snapshot(app))
    }
    if (section === 'state' && request.method === 'GET') return json({ artifacts: { reservedBytes: app.reserved * 3, limitBytes: STORAGE * 3, uploads: app.tickets, maxUploads: MAX_UPLOADS } })
    if (section === 'uploads' && write) {
      const refused = managed()
      if (refused) return refused
      if (app.status === 'purging') return fail(409, 'purging', 'Application is being purged.')
      const bytes = Number(body.bytes)
      if (JSON.stringify(body.manifest) !== MANIFEST || typeof body.digest !== 'string' || !(bytes > 0 && bytes <= LIMIT)) return fail(400, 'input', 'Invalid upload.')
      if (app.tickets >= MAX_UPLOADS || app.reserved + bytes > STORAGE) return fail(409, 'artifact_quota', 'The application has reached its retained package storage or upload limit.')
      app.tickets++
      app.reserved += bytes
      const upload: Upload = { id: id('up'), app: app.id, digest: body.digest, bytes, generation: app.generation, data: null }
      uploads.set(upload.id, upload)
      return json({ uploadId: upload.id, url: `${origin}/r2/${upload.id}`, headers: { 'content-type': 'application/json' }, expiresAt: Date.now() + 180_000 }, 201)
    }
    if (section === 'releases' && write) {
      const refused = managed()
      if (refused) return refused
      const upload = uploads.get(String(body.uploadId))
      if (upload === undefined || upload.app !== app.id) return fail(404, 'upload', 'Upload not found.')
      if (app.status !== 'draft' && app.status !== 'registered') return fail(409, 'inactive', 'Resume the application before publishing.')
      if (upload.generation !== app.generation) return fail(409, 'retired', 'Application changed after this upload began.')
      if (upload.data === null || upload.data.length !== upload.bytes) return fail(409, 'upload_missing', 'Package upload is missing or has an unexpected size.')
      if (createHash('sha256').update(upload.data).digest('hex') !== upload.digest) return fail(409, 'digest', 'Package checksum does not match.')
      const files = parsePackage(upload.data)
      if (typeof files === 'string') return fail(400, 'package', files)
      const number = Math.max(0, ...app.releases.map((r) => r.number)) + 1
      app.releases.push({ number, digest: upload.digest, bytes: upload.bytes, createdAt: Date.now(), files })
      Object.assign(app, { current: number, status: 'registered' })
      return json(snapshot(app))
    }
    if (section === 'actions' && write) {
      const type = String(body.type)
      const refused = managed(type)
      if (refused) return refused
      if (type === 'remove') app.status = app.status === 'purging' ? app.status : 'removed'
      else if (type === 'resume') {
        if (app.status === 'removed') Object.assign(app, { status: app.current === null ? 'draft' : 'registered', generation: app.generation + 1 })
      } else if (type === 'rollback') {
        if (app.status !== 'registered') return fail(409, 'inactive', 'Application is not active.')
        const earlier = app.releases.find((r) => r.number === body.release)
        if (earlier === undefined) return fail(404, 'release', 'Release not found.')
        const number = Math.max(...app.releases.map((r) => r.number)) + 1
        app.releases.push({ ...earlier, number, createdAt: Date.now() })
        app.current = number
      } else if (type === 'purge') {
        if (app.status !== 'removed' || body.confirmation !== app.name) return fail(409, 'purge_confirmation', 'Remove first and confirm the exact application name.')
        apps.delete(app.id)
        return json({ pending: true, retryAt: Date.now() })
      } else return fail(400, 'action', 'Unknown application action.')
      return json(snapshot(app))
    }
    return fail(404, 'not_found', 'Route not found.')
  }

  /** The app's own address: a static file of its live release, to a signed-in session only. */
  function site(request: Request, name: string, rest: string): Response {
    if (csrfOf(request) === null) return request.headers.get('accept')?.includes('text/html') ? new Response(null, { status: 303, headers: { location: `${origin}/login` } }) : fail(401, 'unauthorized', 'Sign in to this application.')
    const app = named(name)
    if (app === undefined) return fail(404, 'app_not_found', 'Application not found.')
    const live = app.status === 'registered' ? current(app) : null
    if (live === null) return fail(409, 'inactive', 'Application is not active.')
    const file = live.files.get(`public/${rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest}`)
    if (file === undefined) return fail(404, 'not_found', 'File not found.')
    app.requests++
    app.lastAccessAt = Date.now()
    return new Response(new Uint8Array(file.body), { headers: { 'content-type': file.contentType } })
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    origin ||= url.origin
    if (url.pathname.startsWith('/api/v1/')) return control(request, url.pathname.slice('/api/v1'.length))
    const put = /^\/r2\/([a-z0-9_]+)$/.exec(url.pathname)
    if (put && request.method === 'PUT') {
      const upload = uploads.get(put[1] as string)
      if (state.failNextPut) {
        state.failNextPut = false
        return new Response('<Error><Code>ServiceUnavailable</Code></Error>', { status: 503 })
      }
      if (upload === undefined) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
      upload.data = Buffer.from(await request.arrayBuffer())
      return new Response(null, { status: 200 })
    }
    const app = /^\/apps\/([^/]+)\/(.*)$/.exec(url.pathname)
    if (app) return site(request, app[1] as string, app[2] as string)
    return fail(404, 'not_found', 'Route not found.')
  }

  return {
    account,
    key,
    tenant,
    state,
    handler,
    /** An app by name, as the stand-in holds it. */
    app: (name: string) => named(name),
    /** An app someone else holds: another manager or none, in another space when `tenant` is given. */
    seed(name: string, holder: { manager: Manager | null; tenant?: string; status?: App['status'] }) {
      const app: App = { id: id('a'), name, tenant: holder.tenant ?? tenant, ownerId: user, manager: holder.manager, status: holder.status ?? 'registered', current: null, releases: [], generation: 0, tickets: 0, reserved: 0, requests: 0, lastAccessAt: null, createdAt: Date.now() }
      apps.set(app.id, app)
      return app
    },
    /** GET of an app's address with a session of its own, as a signed-in browser: the status and the text. */
    async browse(url: string): Promise<{ status: number; type: string | null; text: string }> {
      const cookie = randomBytes(32).toString('hex')
      sessions.set(cookie, 'browser')
      const r = await fetch(url, { headers: { cookie: `__Host-pneuma-space-control=${cookie}` } })
      sessions.delete(cookie)
      return { status: r.status, type: r.headers.get('content-type'), text: (await r.text()).trim() }
    },
  }
}
