// The local endpoint: the part of the server agents talk to, and the rules that keep it this machine's
// alone. Each security rule has a test that says what it proves. Runs the built server.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { connect, createServer, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guideText, initLibrary } from '@pneuma-base/kernel'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type McpEndpoint, type McpRequest, type RunningServer, type ServerOptions } from '../dist/server/index.js'

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))

const running: RunningServer[] = []
const blockers: Server[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()))
  await Promise.all(blockers.splice(0).map((b) => new Promise((resolve) => b.close(resolve))))
})

async function library(): Promise<{ root: string; home: string }> {
  const root = join(tempDir('pb-e-'), 'lib')
  const home = tempDir('pb-e-home-')
  await initLibrary(root, { plugins: [], table: new Map(), actor: { kind: 'owner' }, session: { id: 's', source: 'flag', cwd: '/', machine: 'm', transcript: null }, home })
  return { root, home }
}

async function serve(dir: string, home: string, more: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer({ dir, builtins: new Map(), home, env: {}, port: 0, ...more })
  running.push(server)
  return server
}

type Answer = { status: number; headers: IncomingHttpHeaders; text: string; json(): any }

/** A raw request to 127.0.0.1, so a test can send any Host, Origin or body. */
function http(server: RunningServer, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${server.port}`, ...opts.headers }
    const req = request({ host: opts.host ?? '127.0.0.1', port: server.port, path, method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const json = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })

const reachable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    // A link-local address given without its interface can neither connect nor fail; it is not reached either.
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(false)
    })
  })

const addresses = () => Object.values(networkInterfaces()).flatMap((list) => list ?? [])
const hasIpv6Loopback = () => addresses().some((a) => a.internal && a.address === '::1')

/** A port of this machine held open on `host`, as another program would hold it. */
function block(host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const blocker = createServer()
    blocker.once('error', reject)
    blocker.listen(port, host, () => {
      blockers.push(blocker)
      resolve((blocker.address() as { port: number }).port)
    })
  })
}

/** An MCP endpoint that records what the server hands it and answers 200. */
function recorder(): { endpoint: McpEndpoint; seen: { grant: string; request: McpRequest }[] } {
  const seen: { grant: string; request: McpRequest }[] = []
  const endpoint: McpEndpoint = {
    async handle(grant: string, req: McpRequest, res: ServerResponse) {
      seen.push({ grant, request: req })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    },
    async close() {},
  }
  return { endpoint, seen }
}

describe('where the endpoint listens', () => {
  it('binds 127.0.0.1 and ::1 with one port, and no other address of the machine', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    expect(server.endpoint).toBe(`http://127.0.0.1:${server.port}`)
    expect(await reachable('127.0.0.1', server.port)).toBe(true)
    if (hasIpv6Loopback()) {
      expect(await reachable('::1', server.port)).toBe(true)
      expect((await http(server, '/guide', { host: '::1', headers: { host: `[::1]:${server.port}` } })).status).toBe(200)
    }
    const others = addresses().filter((a) => !a.internal)
    const reached = await Promise.all(others.map((a) => reachable(a.address, server.port)))
    expect(others.filter((_, i) => reached[i]).map((a) => a.address)).toEqual([])
  })

  it('takes the next free port when the preferred one is taken, on either loopback address', async () => {
    const { root, home } = await library()
    const preferred = await block('127.0.0.1')
    if (hasIpv6Loopback()) await block('::1', preferred + 1)
    const server = await serve(root, home, { port: undefined, preferredPort: preferred })
    expect(server.port).toBeGreaterThan(hasIpv6Loopback() ? preferred + 1 : preferred)
    expect(server.port).toBeLessThanOrEqual(preferred + 19)
    expect(await reachable('127.0.0.1', server.port)).toBe(true)
  })

  it('refuses to start on an exact port that is taken', async () => {
    const { root, home } = await library()
    const taken = await block('127.0.0.1')
    await expect(serve(root, home, { port: taken })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('writes its address to machine state while it runs, never the token, and takes it away on close', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const file = join(home, 'endpoints', `${server.port}.json`)
    const text = readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ format: 1, url: server.endpoint, port: server.port, pid: process.pid, library: root })
    expect(text).not.toContain(server.token)
    await server.close()
    expect(existsSync(file)).toBe(false)
  })
})

describe('who may ask (DNS rebinding, cross-origin)', () => {
  const ROUTES = ['/', '/guide', '/pair', '/mcp/x', '/api/state']

  it('answers 403 to a Host that is not a loopback name with this port, on every route', async () => {
    const { root, home } = await library()
    const server = await serve(root, home, { mcp: recorder().endpoint })
    for (const host of ['evil.example', `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, `localhost:${server.port + 1}`, `[::1]:${server.port + 1}`, `127.0.0.1.evil.example:${server.port}`]) {
      for (const path of ROUTES) expect((await http(server, `${path}?token=${server.token}`, { headers: { host } })).status, `${host} ${path}`).toBe(403)
    }
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]) {
      expect((await http(server, `/api/state?token=${server.token}`, { headers: { host } })).status, host).toBe(200)
    }
  })

  it('answers 403 to another origin, Origin: null and a cross-site or same-site fetch, everywhere but the frames’ files', async () => {
    const { root, home } = await library()
    const server = await serve(root, home, { mcp: recorder().endpoint })
    const foreign: Record<string, string>[] = [{ origin: 'http://evil.example' }, { origin: 'null' }, { origin: `http://127.0.0.1:${server.port + 1}` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]
    for (const headers of foreign) {
      for (const path of ROUTES) expect((await http(server, `${path}?token=${server.token}`, { headers })).status, `${JSON.stringify(headers)} ${path}`).toBe(403)
      const kit = await http(server, '/plugin-kit/frame.js', { headers })
      expect(kit.status, JSON.stringify(headers)).toBe(200)
      expect(kit.headers['access-control-allow-origin']).toBe('*')
    }
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, `http://[::1]:${server.port}`]) {
      expect((await http(server, `/api/state?token=${server.token}`, { headers: { origin, 'sec-fetch-site': 'same-origin' } })).status, origin).toBe(200)
    }
  })

  it('lets no other origin read an agent route or /api: no access-control-allow-origin on them', async () => {
    const { root, home } = await library()
    const server = await serve(root, home, { mcp: recorder().endpoint })
    const own = { origin: `http://127.0.0.1:${server.port}` }
    for (const r of [
      await http(server, '/guide', { headers: own }),
      await http(server, '/pair', { method: 'POST', ...json({ product: 'x', why: 'y' }), headers: { ...own, 'content-type': 'application/json' } }),
      await http(server, '/pair/p-00000000', { headers: own }),
      await http(server, '/mcp/x', { method: 'POST', ...json({}), headers: { ...own, 'content-type': 'application/json' } }),
      await http(server, `/api/state?token=${server.token}`, { headers: own }),
      await http(server, '/api/state', { headers: own }),
    ]) {
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('still asks for the token on /api from the server’s own origin', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const own = { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' }
    expect((await http(server, '/api/state', { headers: own })).status).toBe(401)
    expect((await http(server, '/api/call', { method: 'POST', ...json({}), headers: { ...own, 'content-type': 'application/json' } })).status).toBe(401)
  })

  it('cannot reach the owner’s routes from the agent routes’ module: the lint refuses the import', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const eslint = new ESLint({ cwd: root })
    const lint = async (code: string) => ((await eslint.lintText(code, { filePath: join(root, 'packages/viewer/src/server/agent.ts') }))[0]?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports')
    expect(await lint(`export { call } from './api.js'\n`)).toHaveLength(1)
    expect(await lint(`export { ownerFace } from '@pneuma-base/kernel'\n`)).toHaveLength(1)
    expect(await lint(`export { initLibrary } from '@pneuma-base/kernel'\n`)).toHaveLength(1)
    expect(await lint(`export { guideText } from '@pneuma-base/kernel'\n`)).toEqual([])
  })
})

describe('the guide', () => {
  it('serves the kernel’s guide, generic or for a product, as markdown that is never cached or sniffed', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const facts = { root, home, env: {}, url: server.endpoint }
    for (const [path, product] of [['/guide', null], ['/guide/claude-code', 'claude-code'], ['/guide?for=codex', 'codex']] as const) {
      const r = await http(server, path)
      expect(r.status, path).toBe(200)
      expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8')
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.text, path).toBe(guideText(facts, product))
    }
  })

  it('answers 404 for a product that is no grant name, and 409 with a sentence where the directory is not a library', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    for (const path of ['/guide/Claude', '/guide/a_b', '/guide?for=..%2Fx', '/guide/', '/guide?for=']) expect((await http(server, path)).status, path).toBe(404)
    const plain = await serve(tempDir('pb-e-plain-'), home)
    const r = await http(plain, '/guide')
    expect(r.status).toBe(409)
    expect(r.text).toMatch(/[一-鿿]/)
  })
})

describe('pairing over HTTP', () => {
  it('takes only a small JSON object with a product and a reason', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    expect((await http(server, '/pair', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"product":"a","why":"b"}' })).status).toBe(415)
    expect((await http(server, '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'a', why: 'x'.repeat(4096) }) })).status).toBe(413)
    for (const body of ['{', '[]', '"x"', '{"product":"a"}', '{"product":1,"why":"b"}']) {
      expect((await http(server, '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, body).toBe(400)
    }
    expect((await http(server, '/pair')).status).toBe(405)
  })

  it('answers a request as the kernel decides: 201 with where to poll, or the refusal’s status', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const r = await http(server, '/pair', { method: 'POST', ...json({ product: 'claude-code', why: '想帮主人整理资料' }) })
    const body = r.json()
    if (body.outcome === 'requested') {
      expect(r.status).toBe(201)
      expect(body).toMatchObject({ id: expect.stringMatching(/^p-[0-9a-f]{8}$/), code: expect.any(String), expires: expect.any(String), again: false, text: expect.any(String) })
      expect(body.poll).toBe(`${server.endpoint}/pair/${body.id}`)
      expect((await http(server, `/pair/${body.id}`)).status).toBe(200)
    } else {
      expect(body).toMatchObject({ outcome: 'refused', text: expect.any(String) })
      expect(r.status).toBe({ usage: 400, 'too-many': 429, 'not-a-library': 409 }[body.reason as string])
    }
  })

  it('answers 404 for a pairing it does not have, and for an id of another shape', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const r = await http(server, '/pair/p-0000abcd')
    expect(r.status).toBe(404)
    expect(r.json()).toEqual({ error: 'no-such-pairing' })
    for (const id of ['x', 'p-123', '..%2F..%2Fsecret', 'p-0000ABCD']) expect((await http(server, `/pair/${id}`)).status, id).toBe(404)
  })

  it('a pairing written to machine state changes /api/rev, so the open home page fetches again', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const rev = async () => (await http(server, `/api/rev?token=${server.token}`)).json().rev as string
    const before = await rev()
    mkdirSync(join(home, 'pairings'), { recursive: true })
    writeFileSync(join(home, 'pairings', 'p-0000abcd.json'), '{}')
    expect(await rev()).not.toBe(before)
  })
})

describe('rate limits', () => {
  it('lets 120 guides, 20 pairing requests and 240 pairing polls through in a minute, then answers 429 with Retry-After', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    const limits: [number, () => Promise<Answer>][] = [
      [120, () => http(server, '/guide')],
      [20, () => http(server, '/pair', { method: 'POST', ...json({ product: 'claude-code', why: 'x' }) })],
      [240, () => http(server, '/pair/p-0000abcd')],
    ]
    for (const [limit, ask] of limits) {
      for (let i = 0; i < limit; i++) expect((await ask()).status).not.toBe(429)
      const over = await ask()
      expect(over.status).toBe(429)
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
      expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(60)
    }
  })
})

describe('the MCP route', () => {
  it('hands a POST, GET or DELETE for a grant name to the MCP endpoint, with the body and the scene named in the address', async () => {
    const { root, home } = await library()
    const { endpoint, seen } = recorder()
    const server = await serve(root, home, { mcp: endpoint })
    expect((await http(server, '/mcp/claude?session=work-1', { method: 'POST', ...json({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status).toBe(200)
    expect((await http(server, '/mcp/claude', { method: 'DELETE' })).status).toBe(200)
    expect(seen.map((s) => [s.grant, s.request.method, s.request.session])).toEqual([
      ['claude', 'POST', 'work-1'],
      ['claude', 'DELETE', null],
    ])
    expect(JSON.parse(seen[0]?.request.body ?? '')).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })

  it('refuses another method, another content type, a body over 8 MiB and a name that is no grant name, before the endpoint sees it', async () => {
    const { root, home } = await library()
    const { endpoint, seen } = recorder()
    const server = await serve(root, home, { mcp: endpoint })
    expect((await http(server, '/mcp/claude', { method: 'PUT', ...json({}) })).status).toBe(405)
    expect((await http(server, '/mcp/claude', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    expect((await http(server, '/mcp/claude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20) })).status).toBe(413)
    for (const name of ['Claude', 'a_b', 'a.b', '-x']) expect((await http(server, `/mcp/${name}`, { method: 'POST', ...json({}) })).status, name).toBe(404)
    expect(seen).toEqual([])
  })

  it('is 404 when the server was started without one', async () => {
    const { root, home } = await library()
    const server = await serve(root, home)
    expect((await http(server, '/mcp/claude', { method: 'POST', ...json({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status).toBe(404)
  })
})
