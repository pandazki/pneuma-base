// The management UI's server: Node's http, on 127.0.0.1 only. ARCHITECTURE.md section 6.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLibrary, type Env, type PluginTable } from '@pneuma-base/kernel'
import { call, init, state, view, type Reply, type Served } from './api.js'
import { libraryFile, pluginUiFile, revision } from './files.js'

export type ServerOptions = {
  dir: string
  /** The plugins this pneuma-base knows. The server imports none itself. */
  table: PluginTable
  /** Where local grant copies live, as for the command line. */
  home: string
  env: Env
  /** 0 or absent: a free port. */
  port?: number
  /** The built page; by default the one next to this file. */
  webRoot?: string
}

export type RunningServer = { url: string; port: number; token: string; close(): Promise<void> }

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

function sendJson(res: ServerResponse, { status, json }: Reply): void {
  const body = JSON.stringify(json)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) throw new BadRequest('body is too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    throw new BadRequest('body is not JSON')
  }
}


const sameToken = (given: string | null, token: string) => given !== null && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))

/** A library file as it is, typed so the browser never runs it: no HTML, no scripts, sandboxed. */
async function sendLibraryFile(res: ServerResponse, served: Served, query: URLSearchParams): Promise<void> {
  const library = await openLibrary(served.dir, served.table)
  if (!library) return sendJson(res, { status: 409, json: { error: 'not-a-library' } })
  const file = await libraryFile(library.root, query.get('path') ?? '')
  if (!file) return sendJson(res, { status: 404, json: { error: 'no such file in the content or the archive' } })
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  })
  createReadStream(file.path).pipe(res)
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
      return sendLibraryFile(res, served, url.searchParams)
    case 'GET /api/rev':
      return sendJson(res, { status: 200, json: { rev: await revision(served.dir) } })
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
  const library = await openLibrary(served.dir, served.table)
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
 * Serves the UI for `dir` on 127.0.0.1. Every /api request must carry the token, as the `token`
 * query parameter or the `x-pneuma-token` header, and a Host of this address; the page is open.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(16).toString('hex')
  const served: Served = { dir: opts.dir, table: opts.table, home: opts.home, env: opts.env }
  const webRoot = opts.webRoot ?? WEB_ROOT
  let hosts: ReadonlySet<string> = new Set()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const plugin = url.pathname.startsWith(PLUGIN_UI)
    if (!url.pathname.startsWith('/api/') && !plugin) return staticFile(res, webRoot, url.pathname)
    if (!hosts.has(req.headers.host ?? '')) return sendJson(res, { status: 403, json: { error: 'wrong host' } })
    if (plugin) return pluginUi(res, served, url.pathname)
    const given = (req.headers['x-pneuma-token'] as string | undefined) ?? url.searchParams.get('token')
    if (!sameToken(given, token)) return sendJson(res, { status: 401, json: { error: 'missing or wrong token' } })
    return api(req, res, url, served)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const bad = error instanceof BadRequest
      if (res.headersSent) return void res.end()
      sendJson(res, { status: bad ? 400 : 500, json: { error: error instanceof Error ? error.message : String(error) } })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
