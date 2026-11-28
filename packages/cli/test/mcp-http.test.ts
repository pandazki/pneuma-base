// MCP over HTTP at /mcp/<grant> on the management UI's server, driven by the official SDK client's
// streamable HTTP transport in both eras:
// - the same tools as the stdio server for the same grant, and the command line's answers for a
//   read, a write, a refusal and a page; a management command called by name is refused as over stdio;
// - 2026-07-28: mirrored headers checked against the body, an unknown method 404, `?session=` names
//   the scene, `subscriptions/listen` hears a plugin added;
// - legacy: one connection is one scene of the grant's agent, an unknown session 404, DELETE ends it,
//   the GET stream hears a plugin added.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startServer, type RunningServer } from '@pneuma-base/viewer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpOverHttp } from '../dist/mcp/http.js'
import { builtinPlugins } from '../dist/plugins.js'
import { factsOf, sandbox, tempDir, type Sandbox } from './helpers.js'
import { BOTH_FACES, call, connect, eraOptions, expectParity, library, ok, PARITY_CASES, sameStart, sceneRows, textOf, type Era } from './mcp-cases.js'

const servers: RunningServer[] = []
const views: ChildProcessWithoutNullStreams[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const v of views.splice(0)) v.kill('SIGINT')
})

/** `pneuma-base view` for `lib`, the real command, on a free port; its endpoint once it printed its address. */
function viewEndpoint(sb: Sandbox, lib: string): Promise<string> {
  const child = sb.start(['view', lib, '--no-open', '--port', '0'])
  views.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=/.exec(out)
      if (match) resolve(match[1] as string)
    })
    child.once('exit', (code) => reject(new Error(`view exited with ${code}: ${out}`)))
  })
}

/** The management UI's server for `lib` with MCP over HTTP, as `view` starts it, on a free port. */
async function serveHttp(sb: Sandbox, lib: string): Promise<RunningServer> {
  const home = join(sb.home, '.pneuma-base')
  const server = await startServer({ dir: lib, builtins: builtinPlugins, home, env: {}, port: 0, mcp: mcpOverHttp({ home, builtins: builtinPlugins, env: {}, cwd: sb.home }) })
  servers.push(server)
  return server
}

type Connected = { client: Client; transport: StreamableHTTPClientTransport }

async function connectHttp(server: RunningServer | string, grant: string, era: Era, session?: string): Promise<Connected> {
  const endpoint = typeof server === 'string' ? server : server.endpoint
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp/${grant}${session === undefined ? '' : `?session=${session}`}`))
  const client = new Client({ name: 'pneuma-base-test', version: '0' }, eraOptions(era))
  await client.connect(transport)
  return { client, transport }
}

const MODERN = '2026-07-28'
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} }

/** One raw POST to `/mcp/<grant>`, so a test can send any header or body. */
async function post(server: RunningServer, grant: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.endpoint}/mcp/${grant}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) }
}

const modernHeaders = (method: string, name?: string): Record<string, string> => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name === undefined ? {} : { 'mcp-name': name }) })
const initialize = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })

describe.each(['legacy', 'modern'] as const)('MCP over HTTP answers as over stdio (%s)', (era) => {
  let sb: Sandbox
  let http: Connected
  let stdio: Client
  beforeAll(async () => {
    sb = sandbox()
    const lib = library(sb)
    http = await connectHttp(await viewEndpoint(sb, lib), 'g', era, BOTH_FACES)
    stdio = await connect(sb, 'g', era)
    await sameStart(sb, http.client)
  })
  afterAll(async () => {
    await http?.client.close()
    await stdio?.close()
  })

  it('speaks the era asked for and lists the same tools as the stdio server for the same grant', async () => {
    expect(http.client.getProtocolEra()).toBe(era)
    expect((await http.client.listTools()).tools).toEqual((await stdio.listTools()).tools)
  })

  // The full list runs over standard input and output in mcp.test.ts; over HTTP, one case of each kind.
  it('answers a read, a write, a refusal and a page as the command line does', async () => {
    for (const argv of ['find notes --include-archived', 'put - --to notes/a.md --imported', 'archive notes/missing.md', 'show files --dir notes']) {
      const c = PARITY_CASES.find((p) => p[2].join(' ') === argv)
      if (c === undefined) throw new Error(`no parity case ${argv}`)
      await expectParity(sb, http.client, c)
    }
  })

  it('refuses a management command called by name as over stdio', async () => {
    const overHttp = await call(http.client, 'grant_create', { name: 'x', agent: 'y' })
    const overStdio = await call(stdio, 'grant_create', { name: 'x', agent: 'y' })
    expect(overHttp).toMatchObject({ isError: true, structuredContent: { outcome: 'refused', reason: 'agent-session' } })
    expect(overHttp.structuredContent).toEqual(overStdio.structuredContent)
    expect(textOf(overHttp)).toBe(textOf(overStdio))
  })
})

describe('a legacy connection', () => {
  let sb: Sandbox
  let lib: string
  let server: RunningServer
  beforeAll(async () => {
    sb = sandbox()
    lib = library(sb)
    server = await serveHttp(sb, lib)
  })

  it('is one scene of the grant’s agent for all its calls', async () => {
    const { client } = await connectHttp(server, 'g', 'legacy')
    expect(textOf(await call(client, 'start', { sentence: '整理下单流程' }))).toContain('【记下】')
    expect(await call(client, 'put', { text: '# 流程\n', to: 'docs/flow.md', generated: true })).toMatchObject({ isError: false })
    expect(await call(client, 'say', { kind: 'note', about: 'docs/flow.md', text: '初稿' })).toMatchObject({ isError: false })
    await client.close()
    const claude = sceneRows(sb, lib).filter((row) => row.actor.name === 'claude')
    expect(claude).toHaveLength(1)
    expect(claude[0].text).toBe('整理下单流程')
    expect(claude[0].meta[0].text).toBe('放入 1 样')
  })

  it('lives by its session id: needed after initialize, 404 when unknown or ended by DELETE, 400 with an era it does not serve', async () => {
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400)
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'no-such-session' })).status).toBe(404)
    const get = (headers: Record<string, string>) => fetch(`${server.endpoint}/mcp/g`, { headers: { accept: 'text/event-stream', ...headers } })
    expect((await get({})).status).toBe(400)
    expect((await get({ 'mcp-session-id': 'no-such-session' })).status).toBe(404)

    const opened = await post(server, 'g', initialize())
    expect(opened.status).toBe(200)
    const raw = opened.headers.get('mcp-session-id') as string
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': raw, 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
    expect((await post(server, 'g', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': raw })).status).toBe(202)

    const { client, transport } = await connectHttp(server, 'g', 'legacy')
    const id = transport.sessionId as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': id })).status).toBe(200)
    await transport.terminateSession()
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-session-id': id })).status).toBe(404)
    expect((await post(server, 'ro', { jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-session-id': id })).status).toBe(404)
    await client.close()
  })

  it('holds at most 32 connections: a 33rd ends the one idle longest', async () => {
    const ids: string[] = []
    for (let i = 0; i < 33; i++) ids.push((await post(server, 'g', initialize())).headers.get('mcp-session-id') as string)
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': ids[0] as string })).status).toBe(404)
    expect((await post(server, 'g', { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': ids[32] as string })).status).toBe(200)
  })
})

describe('a 2026-07-28 request', () => {
  let sb: Sandbox
  let lib: string
  let server: RunningServer
  beforeAll(async () => {
    sb = sandbox()
    lib = library(sb)
    server = await serveHttp(sb, lib)
  })

  const listTools = (id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: META } })
  const callFind = (id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'find', arguments: { text: '甲' }, _meta: META } })

  it('is answered when its mirrored headers match the body, a name given in base64 too', async () => {
    const r = await post(server, 'g', listTools(), modernHeaders('tools/list'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(r.json().result.tools.length).toBeGreaterThan(5)
    expect((await post(server, 'g', callFind(), modernHeaders('tools/call', 'find'))).json().result).toMatchObject({ isError: false })
    expect((await post(server, 'g', callFind(), modernHeaders('tools/call', `=?base64?${Buffer.from('find').toString('base64')}?=`))).status).toBe(200)
  })

  it('is refused what the era does not take: a mirrored header missing or saying otherwise, a method or version it does not have, a batch; a notification is 202', async () => {
    for (const [body, headers] of [
      [callFind(), modernHeaders('tools/call', 'inspect')],
      [callFind(), modernHeaders('tools/call')],
      [callFind(), modernHeaders('tools/list', 'find')],
      [callFind(), { 'mcp-method': 'tools/call', 'mcp-name': 'find' }],
      [callFind(), { ...modernHeaders('tools/call', 'find'), 'mcp-protocol-version': '2025-11-25' }],
      [listTools(), {}],
    ] as const) {
      const r = await post(server, 'g', body, headers)
      expect(r.status, JSON.stringify(headers)).toBe(400)
      expect(r.json()).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32020 } })
    }

    const unknown = await post(server, 'g', { jsonrpc: '2.0', id: 7, method: 'nothing/here', params: { _meta: META } }, modernHeaders('nothing/here'))
    expect(unknown.status).toBe(404)
    expect(unknown.json()).toMatchObject({ id: 7, error: { code: -32601 } })
    const future = { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }
    const unsupported = await post(server, 'g', { jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: future } }, { ...modernHeaders('tools/list'), 'mcp-protocol-version': '2099-01-01' })
    expect(unsupported.status).toBe(400)
    expect(unsupported.json()).toMatchObject({ id: 8, error: { code: -32022, data: { supported: [MODERN] } } })

    expect((await post(server, 'g', [listTools(1), listTools(2)], modernHeaders('tools/list'))).status).toBe(400)
    expect((await post(server, 'g', { jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { 'mcp-protocol-version': MODERN })).status).toBe(202)
  })

  it('works in the scene `?session=` names; with none, each call is the agent’s scene of the day', async () => {
    const { client } = await connectHttp(server, 'g', 'modern', 'named-scene')
    expect(textOf(await call(client, 'start', { sentence: '整理支付服务' }))).toContain('【记下】')
    expect(await call(client, 'put', { text: '# 支付\n', to: 'docs/pay.md', generated: true })).toMatchObject({ isError: false })
    await client.close()
    const anonymous = await connectHttp(server, 'g', 'modern')
    expect(await call(anonymous.client, 'put', { text: '# 别的\n', to: 'docs/other.md', generated: true })).toMatchObject({ isError: false })
    await anonymous.client.close()
    const scenes = [...new Set(factsOf(lib).map((f) => f.scene as string))]
    expect(scenes).toContain('named-scene')
    expect(scenes.filter((s) => s.startsWith('adhoc-claude-'))).toHaveLength(1)
    const claude = sceneRows(sb, lib).filter((row) => row.actor.name === 'claude')
    expect(claude.map((row) => row.text)).toContain('整理支付服务')
  })
})

describe.each(['legacy', 'modern'] as const)('a plugin added while connected over HTTP (%s)', (era) => {
  let sb: Sandbox
  let lib: string
  let http: Connected
  beforeAll(async () => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    ok(sb.run(['init', lib]))
    ok(sb.run(['--library', lib, 'grant', 'create', 'g', '--agent', 'claude']))
    http = await connectHttp(await serveHttp(sb, lib), 'g', era)
  })
  afterAll(() => http?.client.close())

  it(era === 'modern' ? 'is heard on a subscriptions/listen stream' : 'is heard on the GET stream', async () => {
    const heard: string[] = []
    http.client.setNotificationHandler('notifications/tools/list_changed', () => void heard.push('tools'))
    if (era === 'modern') await http.client.listen({ toolsListChanged: true })
    expect((await http.client.listTools()).tools.map((t) => t.name)).not.toContain('version_list')
    ok(sb.run(['--library', lib, 'plugin', 'enable', 'version']))
    await expect.poll(() => heard, { timeout: 15_000, interval: 200 }).toContain('tools')
    expect((await http.client.listTools()).tools.map((t) => t.name)).toContain('version_list')
  })
})
