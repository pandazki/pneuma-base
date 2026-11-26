// The management UI's server and the local endpoint agents talk to: Node's http, on the loopback
// addresses only. ARCHITECTURE.md section 6.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropEndpoint, libraryFile, openLibrary, PREFERRED_PORT, recordEndpoint, stopListening, type Env, type Instant, type PluginTable } from '@pneuma-base/kernel'
import { agentRoutes, type McpEndpoint } from './agent.js'
import { call, changes, init, state, tableOf, view, type Served } from './api.js'
import { pluginUiFile, revision } from './files.js'
import { readBody, sendJson, TooLarge } from './http.js'
import { listenLoopback } from './listen.js'

export type { McpEndpoint, McpRequest } from './agent.js'

export type ServerOptions = {
  dir: string
  /**
   * The plugins built into the caller. The server imports none itself; this machine's own plugins in
   * `home/plugins/` join them on every request, so a changed plugin is used without a restart.
   */
  builtins: PluginTable
  /** This machine's `$PNEUMA_BASE_HOME`: grant copies, plugins, caches and secrets, as for the command line. */
  home: string
  env: Env
  /**
   * Absent: the preferred port, else the next free one of the 19 after it, else any free port, so the
   * sentence the owner says to an agent stays the same. 0: any free port. A number: exactly that port.
   */
  port?: number
  /** The port tried first when `port` is absent: PREFERRED_PORT, unless the caller names another. */
  preferredPort?: number
  /** The built page; by default the one next to this file. */
  webRoot?: string
  /** MCP over HTTP at `/mcp/<grant>`; absent, `/mcp/*` is 404. */
  mcp?: McpEndpoint
}

/** `url`: the page's address with the token. `endpoint`: the origin agents are told, `http://127.0.0.1:<port>`, without it. */
export type RunningServer = { url: string; endpoint: string; port: number; token: string; close(): Promise<void> }

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const BODY_LIMIT = 1024 * 1024

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** Where a plugin's own pages are served from: `/plugin-ui/<plugin>/<path in its ui directory>`. */
const PLUGIN_UI = '/plugin-ui/'
/** The kit a plugin's page loads by a fixed address: `/plugin-kit/frame.js` and `/plugin-kit/frame.css`. */
const PLUGIN_KIT = '/plugin-kit/'
/**
 * A frame's files are loaded from an opaque origin, so they are readable by any origin (module
 * scripts and fonts are fetched with CORS). A plugin's page is under the sandbox CSP: even opened
 * on its own it never shares the viewer's origin, and it is sent no referrer, which would carry the token.
 */
const FRAME_HEADERS = { 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const FRAME_CSP = "sandbox allow-scripts; frame-ancestors 'self'"

/** The request itself is malformed: answered with 400. */
class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req, BODY_LIMIT)
  try {
    return JSON.parse(text || 'null')
  } catch {
    throw new BadRequest('body is not JSON')
  }
}

/** The names and origins this server answers to: the loopback addresses with its port. */
type Own = { hosts: ReadonlySet<string>; origins: ReadonlySet<string> }

function ownOf(port: number): Own {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return { hosts: new Set(hosts), origins: new Set(hosts.map((h) => `http://${h}`)) }
}

/**
 * Why a request is refused before any route sees it, or null. A Host that is not one of this server's
 * names is DNS rebinding. Another origin, `Origin: null` included, or a fetch the browser marks
 * cross-site or same-site is a web page reaching in; only the frames' files take that, on purpose.
 */
function refusal(req: IncomingMessage, pathname: string, own: Own): string | null {
  if (!own.hosts.has((req.headers.host ?? '').toLowerCase())) return 'wrong host'
  if (pathname.startsWith(PLUGIN_UI) || pathname.startsWith(PLUGIN_KIT)) return null
  const origin = req.headers.origin
  if (origin !== undefined && !own.origins.has(origin)) return 'cross-origin request'
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return 'cross-origin request'
  return null
}


const sameToken = (given: string | null, token: string) => given !== null && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))

/** How many bytes the file route asks storage for at a time. */
const CHUNK = 1 << 20

/** The one range of a `Range: bytes=…` header, within a file of `size` bytes; null for none or one the route does not take. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null || (m[1] === '' && m[2] === '')) return null
  const [start, end] = m[1] === '' ? [Math.max(0, size - Number(m[2])), size - 1] : [Number(m[1]), m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)]
  return start > end || start >= size ? 'unsatisfiable' : { start, end }
}

/**
 * A library file as it is, through storage, typed so the browser never runs it: no HTML, no scripts,
 * sandboxed. One range when the request asks for it. A file a sync service keeps only as a placeholder
 * is fetched only with `fetch=1`; without it the answer is 409 with its size.
 */
async function sendLibraryFile(req: IncomingMessage, res: ServerResponse, served: Served, query: URLSearchParams): Promise<void> {
  const library = await openLibrary(served.dir, await tableOf(served))
  if (!library) return sendJson(res, { status: 409, json: { error: 'not-a-library' } })
  const file = await libraryFile(library.root, query.get('path') ?? '', { fetch: query.get('fetch') === '1' })
  if (!file) return sendJson(res, { status: 404, json: { error: 'no such file in the content or the archive' } })
  if (file.kind === 'elsewhere') return sendJson(res, { status: 409, json: { error: 'elsewhere', size: file.size } })
  const range = rangeOf(req.headers.range, file.size)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${file.size}` })
    return void res.end()
  }
  const { start, end } = range ?? { start: 0, end: file.size - 1 }
  res.writeHead(range === null ? 200 : 206, {
    'content-type': file.type,
    'content-length': Math.max(0, end - start + 1),
    'accept-ranges': 'bytes',
    ...(range === null ? {} : { 'content-range': `bytes ${start}-${end}/${file.size}` }),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  })
  for (let at = start; at <= end; ) {
    const chunk = await file.read(at, Math.min(CHUNK, end - at + 1))
    // Gone or changed since the first read: the bytes sent so far are of another version, so the response is cut short.
    if (chunk === null || chunk.token !== file.token || chunk.data.length === 0) return void res.destroy()
    if (!res.write(chunk.data)) await new Promise((resolve) => res.once('drain', resolve))
    at += chunk.data.length
  }
  res.end()
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, served: Served): Promise<void> {
  const route = `${req.method} ${url.pathname}`
  switch (route) {
    case 'GET /api/state':
      return sendJson(res, await state(served))
    case 'GET /api/view':
      return sendJson(res, await view(served, url.searchParams))
    case 'POST /api/call':
      return sendJson(res, await call(served, await readJson(req)))
    case 'GET /api/file':
      return sendLibraryFile(req, res, served, url.searchParams)
    case 'GET /api/rev':
      // Pairings are machine state, not the library's: the home page hears of one through the same stamp.
      return sendJson(res, { status: 200, json: { rev: `${await changes(served)}-${await revision(join(served.home, 'pairings'))}` } })
    case 'POST /api/init':
      return sendJson(res, await init(served, await readJson(req)))
    default:
      return sendJson(res, { status: 404, json: { error: `no such endpoint: ${route}` } })
  }
}

/** The built page and its assets. `/` is the page; nothing outside the web root is served. */
async function staticFile(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '')
  const file = join(webRoot, relative)
  if (!file.startsWith(webRoot) || relative.split(sep).includes('..')) return sendJson(res, { status: 404, json: { error: 'not found' } })
  const s = await stat(file).catch(() => null)
  if (!s?.isFile()) {
    if (pathname === '/') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      return void res.end('管理界面还没有构建。在 pneuma-base 的仓库里运行 pnpm build。')
    }
    return sendJson(res, { status: 404, json: { error: 'not found' } })
  }
  res.writeHead(200, {
    'content-type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=3600',
    ...(pathname.startsWith(PLUGIN_KIT) ? FRAME_HEADERS : {}),
  })
  res.end(await readFile(file))
}

/** A file of an installed plugin's `ui` directory, for its `custom` blocks' frames. No token: a frame never holds it. */
async function pluginUi(res: ServerResponse, served: Served, pathname: string): Promise<void> {
  const [name = '', ...rest] = pathname.slice(PLUGIN_UI.length).split('/')
  const library = await openLibrary(served.dir, await tableOf(served))
  const ui = library?.plugins.find((p) => p.name === name)?.ui
  const file = typeof ui === 'string' && isAbsolute(ui) ? await pluginUiFile(ui, rest.join('/')) : null
  if (file === null) return sendJson(res, { status: 404, json: { error: 'not found' } })
  const s = await stat(file)
  res.writeHead(200, {
    'content-type': STATIC_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': s.size,
    'cache-control': 'no-store',
    'content-security-policy': FRAME_CSP,
    ...FRAME_HEADERS,
  })
  createReadStream(file).pipe(res)
}

/**
 * Serves the UI for `dir`, and the agent routes, on 127.0.0.1 and ::1. Every request must carry a
 * Host of this server and come from no other origin. Every /api request must also carry the token,
 * as the `token` query parameter or the `x-pneuma-token` header; the page and the agent routes are open.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(16).toString('hex')
  const served: Served = { dir: opts.dir, builtins: opts.builtins, home: opts.home, env: opts.env, listened: new Set() }
  const webRoot = opts.webRoot ?? WEB_ROOT
  let own: Own = { hosts: new Set(), origins: new Set() }
  let agent: ReturnType<typeof agentRoutes> = () => null

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const refused = refusal(req, url.pathname, own)
    if (refused !== null) return sendJson(res, { status: 403, json: { error: refused } })
    if (url.pathname.startsWith(PLUGIN_UI)) return pluginUi(res, served, url.pathname)
    if (url.pathname.startsWith('/api/')) {
      const given = (req.headers['x-pneuma-token'] as string | undefined) ?? url.searchParams.get('token')
      if (!sameToken(given, token)) return sendJson(res, { status: 401, json: { error: 'missing or wrong token' } })
      return api(req, res, url, served)
    }
    return agent(req, res, url) ?? staticFile(res, webRoot, url.pathname)
  }

  const { port, servers } = await listenLoopback(
    (req, res) => {
      handle(req, res).catch((error: unknown) => {
        if (res.headersSent) return void res.end()
        const status = error instanceof TooLarge ? 413 : error instanceof BadRequest ? 400 : 500
        sendJson(res, { status, json: { error: error instanceof Error ? error.message : String(error) } })
      })
    },
    opts.port,
    opts.preferredPort ?? PREFERRED_PORT,
  )
  const endpoint = `http://127.0.0.1:${port}`
  own = ownOf(port)
  agent = agentRoutes({ dir: opts.dir, home: opts.home, env: opts.env, origin: endpoint, mcp: opts.mcp ?? null })
  const stop = () =>
    Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          }),
      ),
    )
  try {
    await recordEndpoint(opts.home, { url: endpoint, port, pid: process.pid, library: await realpath(opts.dir).catch(() => opts.dir), at: new Date().toISOString() as Instant })
  } catch (error) {
    await stop()
    throw error
  }
  return {
    url: `${endpoint}/?token=${token}`,
    endpoint,
    port,
    token,
    close: async () => {
      for (const root of served.listened) stopListening(root)
      await dropEndpoint(opts.home, port, process.pid)
      await opts.mcp?.close()
      await stop()
    },
  }
}
