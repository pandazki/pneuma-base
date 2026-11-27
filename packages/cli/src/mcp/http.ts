// MCP over HTTP: the streamable HTTP transport of both protocol eras, at /mcp/<grant> on the
// management UI's server. Every message goes to the one protocol implementation, `serve`, through an
// in-memory transport: a 2026-07-28 request is a `serve` of its own, a legacy connection one
// long-lived `serve`. The server has already checked the origin, the method, the content type, the
// size and the grant's name. ARCHITECTURE.md「MCP over HTTP」.
import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { identifySession, type Env, type PluginTable, type Session } from '@pneuma-base/kernel'
import type { McpEndpoint, McpRequest } from '@pneuma-base/viewer'
import { LEGACY_VERSIONS, PROTOCOL_VERSION, serve } from './server.js'
import { libraryFace } from './tools.js'

const FIRST_MODERN = '2026-07-28'
const KEEP_ALIVE = 15_000
const IDLE = 30 * 60_000
const MAX_CONNECTIONS = 32
/** The body field a method's `Mcp-Name` header mirrors. */
const NAME_FIELD = new Map([
  ['tools/call', 'name'],
  ['resources/read', 'uri'],
  ['prompts/get', 'name'],
])
/** A 2026-07-28 error's HTTP status by its JSON-RPC code; any other error is 200. */
const ERROR_STATUS = new Map([
  [-32601, 404],
  [-32022, 400],
])
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/

type Id = string | number
type Message = Readonly<Record<string, unknown>>
type Request = Message & { id: Id; method: string }

const isObject = (v: unknown): v is Message => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number'
const isRequest = (m: Message): m is Request => typeof m.method === 'string' && isId(m.id)
const isReply = (m: Message): m is Message & { id: Id } => isId(m.id) && ('result' in m || 'error' in m)
const isModern = (version: unknown) => typeof version === 'string' && version >= FIRST_MODERN
const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
const cancelled = (id: Id) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : undefined
}

/** A mirrored header's value, decoded when it is given in the `=?base64?…?=` form. */
function decoded(value: string): string {
  const base64 = BASE64_SENTINEL.exec(value)?.[1]
  return base64 === undefined ? value : Buffer.from(base64, 'base64').toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

const sendEmpty = (res: ServerResponse, status: number) => void res.writeHead(status, { 'content-length': 0 }).end()

/** Where a 2026-07-28 request's mirrored headers say otherwise than its body, or null when they agree. */
function mismatch(headers: IncomingHttpHeaders, request: Request): string | null {
  const params = isObject(request.params) ? request.params : {}
  const meta = isObject(params._meta) ? params._meta : {}
  const mirrored: [string, unknown, string | undefined][] = [
    ['MCP-Protocol-Version', meta[PROTOCOL_VERSION], header(headers, 'mcp-protocol-version')],
    ['Mcp-Method', request.method, header(headers, 'mcp-method')],
  ]
  const field = NAME_FIELD.get(request.method)
  if (field !== undefined) {
    const given = header(headers, 'mcp-name')
    const body = typeof params[field] === 'string' ? params[field] : undefined
    mirrored.push(['Mcp-Name', body, given === undefined ? undefined : decoded(given)])
  }
  const wrong = mirrored.find(([, body, given]) => given !== body)
  if (wrong === undefined) return null
  const [name, body, given] = wrong
  return `Header mismatch: ${name} is ${given === undefined ? 'missing' : `'${given}'`}, the body has ${body === undefined ? 'none' : `'${String(body)}'`}`
}

/** Lines handed to `serve` as they come, until ended. */
type Channel = { readonly incoming: AsyncIterable<string>; push(line: string): void; end(): void }

function channel(): Channel {
  const queue: string[] = []
  let ended = false
  let wake: (() => void) | null = null
  const poke = () => {
    const w = wake
    wake = null
    w?.()
  }
  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      const line = queue.shift()
      if (line !== undefined) yield line
      else if (ended) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  return {
    incoming: lines(),
    push: (line) => {
      if (ended) return
      queue.push(line)
      poke()
    },
    end: () => {
      ended = true
      poke()
    },
  }
}

/** An SSE response: one event per message, a comment every 15 seconds so nothing between closes it while quiet. */
type Stream = { send(message: object): void; end(): void }

function openStream(res: ServerResponse): Stream {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.flushHeaders()
  const timer = setInterval(() => res.write(':\n\n'), KEEP_ALIVE)
  res.once('close', () => clearInterval(timer))
  return {
    send: (message) => void res.write(`data: ${JSON.stringify(message)}\n\n`),
    end: () => {
      clearInterval(timer)
      res.end()
    },
  }
}

/** One legacy connection: its `serve`, the requests waiting for an answer by id, the GET stream for the rest. */
type Connection = { id: string; grant: string; channel: Channel; waiting: Map<Id, ServerResponse>; stream: Stream | null; used: number }

export type McpOverHttpOptions = { home: string; builtins: PluginTable; env: Env; cwd: string }

/**
 * MCP over HTTP for every grant of this machine. A grant that does not resolve is answered through
 * the protocol, as the stdio face answers once connected: its tools and calls refuse with the
 * grant's reason, so the agent can tell its user why.
 */
export function mcpOverHttp({ home, builtins, env, cwd }: McpOverHttpOptions): McpEndpoint {
  const machine = hostname()
  const faceFor = (grant: string, session: Session) => libraryFace({ grant, home, builtins, env, cwd, session })
  const running = new Set<Promise<void>>()
  const streams = new Set<Stream>()
  const connections = new Map<string, Connection>()

  const track = (work: Promise<void>) => {
    running.add(work)
    void work.finally(() => running.delete(work))
  }

  function opened(res: ServerResponse): Stream {
    const stream = openStream(res)
    streams.add(stream)
    res.once('close', () => streams.delete(stream))
    return stream
  }

  /** A 2026-07-28 request: a `serve` of its own, in the scene `?session=` names, else in a session minted for it. */
  function modern(grant: string, request: Request, given: McpRequest, res: ServerResponse): void {
    const problem = mismatch(given.headers, request)
    if (problem !== null) return sendJson(res, 400, rpcError(request.id, -32020, problem))
    const lines = channel()
    const listen = request.method === 'subscriptions/listen'
    // Opened on the listen's first notification, its acknowledgement: a refusal before it is still a status and a JSON body.
    let stream: Stream | null = null
    let done = false
    const finish = () => {
      done = true
      lines.end()
    }
    // Closing the response is the client cancelling the request, a listen included.
    res.once('close', () => {
      if (done) return
      lines.push(cancelled(request.id))
      finish()
    })
    const send = (message: object) => {
      if (done) return
      const m = message as Message
      if (!isReply(m) || m.id !== request.id) {
        if (listen) (stream ??= opened(res)).send(message)
        return
      }
      finish()
      if (stream === null) return sendJson(res, isObject(m.error) ? (ERROR_STATUS.get(m.error.code as number) ?? 200) : 200, message)
      stream.send(message)
      stream.end()
    }
    lines.push(JSON.stringify(request))
    const session = identifySession({ flag: given.session, env: {}, cwd, machine })
    track(
      serve({ incoming: lines.incoming, send }, faceFor(grant, session)).catch((error: unknown) => {
        if (done) return
        finish()
        if (stream) return stream.end()
        sendJson(res, 500, rpcError(request.id, -32603, error instanceof Error ? error.message : String(error)))
      }),
    )
  }

  function end(c: Connection): void {
    connections.delete(c.id)
    c.stream?.end()
    c.channel.end()
  }

  /** The connection to make room for: the one idle longest, else the one used longest ago. */
  function oldest(): Connection | undefined {
    const all = [...connections.values()]
    const idle = all.filter((c) => c.waiting.size === 0 && c.stream === null)
    return (idle.length > 0 ? idle : all).reduce<Connection | undefined>((a, b) => (a === undefined || b.used < a.used ? b : a), undefined)
  }

  /** True when the request names a legacy version this server does not serve, and is answered. */
  function unsupported(given: McpRequest, res: ServerResponse): boolean {
    const version = header(given.headers, 'mcp-protocol-version')
    if (version === undefined || LEGACY_VERSIONS.includes(version)) return false
    sendJson(res, 400, rpcError(null, -32600, `Unsupported protocol version: ${version}`))
    return true
  }

  /** The connection the request's `Mcp-Session-Id` names on this grant, or null when the request is answered with why not. */
  function connectionOf(grant: string, given: McpRequest, res: ServerResponse): Connection | null {
    const id = header(given.headers, 'mcp-session-id')
    const c = id === undefined ? undefined : connections.get(id)
    if (id === undefined) sendJson(res, 400, rpcError(null, -32600, 'Bad Request: the Mcp-Session-Id header is required'))
    else if (c === undefined || c.grant !== grant) sendJson(res, 404, rpcError(null, -32001, 'Session not found'))
    else if (!unsupported(given, res)) return c
    return null
  }

  function deliver(c: Connection, message: Message, res: ServerResponse): void {
    c.used = Date.now()
    if (isRequest(message)) {
      const id = message.id
      c.waiting.set(id, res)
      res.once('close', () => {
        if (c.waiting.get(id) === res) c.waiting.delete(id)
      })
    } else sendEmpty(res, 202)
    c.channel.push(JSON.stringify(message))
  }

  /** `initialize` opens a connection: one long-lived `serve`, one session, so one scene: `?session=`'s name, else a new one. */
  function open(grant: string, request: Request, given: McpRequest, res: ServerResponse): void {
    if (unsupported(given, res)) return
    if (connections.size >= MAX_CONNECTIONS) {
      const room = oldest()
      if (room !== undefined) end(room)
    }
    const c: Connection = { id: randomUUID(), grant, channel: channel(), waiting: new Map(), stream: null, used: Date.now() }
    connections.set(c.id, c)
    const send = (message: object) => {
      const m = message as Message
      if (!isReply(m)) return c.stream?.send(message)
      const waiting = c.waiting.get(m.id)
      c.waiting.delete(m.id)
      if (waiting !== undefined) sendJson(waiting, 200, message, { 'mcp-session-id': c.id })
    }
    const session = identifySession({ flag: given.session ?? `mcp-${randomUUID()}`, env: {}, cwd, machine })
    track(
      serve({ incoming: c.channel.incoming, send }, faceFor(grant, session)).catch((error: unknown) => {
        end(c)
        for (const [id, waiting] of c.waiting) sendJson(waiting, 500, rpcError(id, -32603, error instanceof Error ? error.message : String(error)))
      }),
    )
    deliver(c, request, res)
  }

  function post(grant: string, given: McpRequest, res: ServerResponse): void {
    let message: unknown
    try {
      message = JSON.parse(given.body)
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    if (Array.isArray(message)) return sendJson(res, 400, rpcError(null, -32600, 'One JSON-RPC message per request: batches are not served'))
    if (!isObject(message)) return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'))
    const params = isObject(message.params) ? message.params : {}
    const meta = isObject(params._meta) ? params._meta : {}
    const version = header(given.headers, 'mcp-protocol-version')
    if (isRequest(message) && (meta[PROTOCOL_VERSION] !== undefined || isModern(version))) return modern(grant, message, given, res)
    if (header(given.headers, 'mcp-session-id') !== undefined) {
      const c = connectionOf(grant, given, res)
      return c === null ? undefined : deliver(c, message, res)
    }
    if (isRequest(message) && message.method === 'initialize') return open(grant, message, given, res)
    // A notification in the 2026-07-28 era: nothing on this transport listens for one.
    if (isModern(version)) return sendEmpty(res, 202)
    sendJson(res, 400, rpcError(isRequest(message) ? message.id : null, -32600, 'Bad Request: the Mcp-Session-Id header is required'))
  }

  /** The legacy GET: the stream of the connection's notifications; a new one replaces the old. */
  function listen(grant: string, given: McpRequest, res: ServerResponse): void {
    const c = connectionOf(grant, given, res)
    if (c === null) return
    if (!(header(given.headers, 'accept') ?? '').includes('text/event-stream')) return sendJson(res, 406, rpcError(null, -32600, 'Not Acceptable: the stream is text/event-stream'))
    c.stream?.end()
    const stream = opened(res)
    c.stream = stream
    res.once('close', () => {
      if (c.stream !== stream) return
      c.stream = null
      c.used = Date.now()
    })
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const c of connections.values()) if (c.waiting.size === 0 && c.stream === null && now - c.used > IDLE) end(c)
  }, 60_000)
  sweep.unref()

  return {
    async handle(grant, given, res) {
      if (given.method === 'POST') return post(grant, given, res)
      if (given.method === 'GET') return listen(grant, given, res)
      const c = connectionOf(grant, given, res)
      if (c === null) return
      end(c)
      sendEmpty(res, 200)
    },
    async close() {
      clearInterval(sweep)
      for (const stream of streams) stream.end()
      for (const c of connections.values()) end(c)
      await Promise.allSettled(running)
    },
  }
}
