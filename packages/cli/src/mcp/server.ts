// The Model Context Protocol on one connection: one JSON-RPC message per line, both eras. A client of
// the 2026-07-28 revision puts its protocol version in each request's `_meta`, may ask
// `server/discover`, and hears of changes through `subscriptions/listen`; a client of an earlier
// revision opens with `initialize` and hears of changes unasked. What is served is a `Face`, read
// fresh for each request; the transport is a parameter.
import { PNEUMA_BASE_VERSION } from '@pneuma-base/kernel'

/** One connection: the messages the client sends, one JSON text each, until it closes; and a way to send one back. */
export type Transport = { readonly incoming: AsyncIterable<string>; send(message: object): void }

export type JsonSchema = { readonly [key: string]: unknown }
export type Tool = { name: string; description: string; inputSchema: JsonSchema; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }
export type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean }
export type Resource = { uri: string; name: string; title: string; description?: string; mimeType: string }
export type ResourceText = { uri: string; mimeType: string; text: string }

/** What the server serves. Every answer is read when asked, so it follows the library as it is now. */
export interface Face {
  instructions(): Promise<string>
  tools(): Promise<Tool[]>
  /** Null when no tool has this name. */
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult | null>
  resources(): Promise<Resource[]>
  /** Null when no resource has this URI. */
  read(uri: string): Promise<ResourceText | null>
}

/** Revisions served with per-request metadata, and revisions served after an `initialize` handshake, newest first. */
const MODERN_VERSIONS = ['2026-07-28']
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'

const SERVER = { name: 'pneuma-base', version: PNEUMA_BASE_VERSION }
/** Results of these a modern client may cache. The library changes at any time and answers per grant: never fresh, never shared. */
const CACHEABLE = new Set(['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read'])
const NOT_CACHED = { ttlMs: 0, cacheScope: 'private' }
const CAPABILITIES = { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true } }

type Id = string | number
type Params = Readonly<Record<string, unknown>>
/** What a `subscriptions/listen` asked for, as far as this server honours it. */
type Filter = { toolsListChanged?: boolean; resourcesListChanged?: boolean; resourceSubscriptions?: string[] }

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

const isObject = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number'

function text(params: Params, key: string): string {
  const v = params[key]
  if (typeof v !== 'string') throw new ProtocolError(-32602, `参数 ${key} 应为字符串`)
  return v
}

/** Answers marking a `subscriptions/listen` that stays open: its response is the end of the stream. */
const LISTENING = Symbol('listening')

/**
 * Serves `face` on `transport` until the client closes it. Every `every` milliseconds, and so while
 * idle, the tool list, the resource list and each watched resource are read again; what changed is
 * told to a legacy client that finished initializing and to each listen that asked for it.
 */
export async function serve(transport: Transport, face: Face, { every = 2000 }: { every?: number } = {}): Promise<void> {
  let legacy: { ready: boolean } | null = null
  const legacyWatched = new Set<string>()
  const listens = new Map<Id, Filter>()
  const inflight = new Set<Id>()
  const cancelled = new Set<Id>()
  const pending = new Set<Promise<void>>()
  const seen = { tools: JSON.stringify(await face.tools()), resources: JSON.stringify(await face.resources()), contents: new Map<string, string>() }

  const send = (message: object) => transport.send({ jsonrpc: '2.0', ...message })

  /** A notification to the legacy client if `toLegacy`, and to each listen whose filter `wants` it. */
  function notify(method: string, params: Params, toLegacy: boolean, wants: (f: Filter) => boolean): void {
    if (legacy?.ready && toLegacy) send({ method, ...(Object.keys(params).length > 0 ? { params } : {}) })
    for (const [id, filter] of listens) if (wants(filter)) send({ method, params: { ...params, _meta: { [SUBSCRIPTION_ID]: id } } })
  }

  const watched = () => new Set([...legacyWatched, ...[...listens.values()].flatMap((f) => f.resourceSubscriptions ?? [])])
  const watch = async (uri: string) => void (seen.contents.has(uri) || seen.contents.set(uri, JSON.stringify(await face.read(uri))))

  let noticing = false
  async function notice(): Promise<void> {
    if (noticing) return
    noticing = true
    try {
      const tools = JSON.stringify(await face.tools())
      if (tools !== seen.tools) {
        seen.tools = tools
        notify('notifications/tools/list_changed', {}, true, (f) => f.toolsListChanged === true)
      }
      const resources = JSON.stringify(await face.resources())
      if (resources !== seen.resources) {
        seen.resources = resources
        notify('notifications/resources/list_changed', {}, true, (f) => f.resourcesListChanged === true)
      }
      for (const uri of watched()) {
        const now = JSON.stringify(await face.read(uri))
        if (seen.contents.get(uri) === now) continue
        seen.contents.set(uri, now)
        notify('notifications/resources/updated', { uri }, legacyWatched.has(uri), (f) => f.resourceSubscriptions?.includes(uri) === true)
      }
    } catch {
      // The library may be between writes; the next round reads it again.
    } finally {
      noticing = false
    }
  }

  async function answer(method: string, params: Params, id: Id, modern: boolean): Promise<object | typeof LISTENING> {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion
        legacy = { ready: false }
        const protocolVersion = typeof asked === 'string' && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]
        return { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER, instructions: await face.instructions() }
      }
      case 'server/discover':
        return { supportedVersions: MODERN_VERSIONS, capabilities: CAPABILITIES, instructions: await face.instructions() }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: await face.tools() }
      case 'tools/call': {
        const name = text(params, 'name')
        const args = params.arguments ?? {}
        if (!isObject(args)) throw new ProtocolError(-32602, '参数 arguments 应为对象')
        const result = await face.call(name, args)
        if (result === null) throw new ProtocolError(-32602, `工具不存在：${name}`)
        return result
      }
      case 'resources/list':
        return { resources: await face.resources() }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read': {
        const uri = text(params, 'uri')
        const contents = await face.read(uri)
        // Earlier revisions named a missing resource -32002; 2026-07-28 names it -32602.
        if (contents === null) throw new ProtocolError(modern ? -32602 : -32002, `资源不存在：${uri}`, { uri })
        return { contents: [contents] }
      }
      case 'resources/subscribe': {
        const uri = text(params, 'uri')
        await watch(uri)
        legacyWatched.add(uri)
        return {}
      }
      case 'resources/unsubscribe':
        legacyWatched.delete(text(params, 'uri'))
        return {}
      case 'subscriptions/listen': {
        const asked = isObject(params.notifications) ? params.notifications : {}
        const uris = Array.isArray(asked.resourceSubscriptions) ? asked.resourceSubscriptions.filter((u): u is string => typeof u === 'string') : []
        const filter: Filter = {
          ...(asked.toolsListChanged === true ? { toolsListChanged: true } : {}),
          ...(asked.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
          ...(uris.length > 0 ? { resourceSubscriptions: uris } : {}),
        }
        for (const uri of uris) await watch(uri)
        // Acknowledged before anything else is sent on it, and in the same turn it starts to hear.
        send({ method: 'notifications/subscriptions/acknowledged', params: { _meta: { [SUBSCRIPTION_ID]: id }, notifications: filter } })
        listens.set(id, filter)
        return LISTENING
      }
      default:
        throw new ProtocolError(-32601, `Method not found: ${method}`)
    }
  }

  async function request(id: Id, method: string, params: Params): Promise<void> {
    const meta = isObject(params._meta) ? params._meta : {}
    const version = meta[PROTOCOL_VERSION]
    const modern = version !== undefined
    inflight.add(id)
    try {
      if (modern && (typeof version !== 'string' || !MODERN_VERSIONS.includes(version))) {
        throw new ProtocolError(-32022, 'Unsupported protocol version', { supported: MODERN_VERSIONS, requested: version })
      }
      if (modern && !isObject(meta[CLIENT_CAPABILITIES])) throw new ProtocolError(-32602, `请求的 _meta 中缺少 ${CLIENT_CAPABILITIES}`)
      const result = await answer(method, params, id, modern)
      if (result === LISTENING || cancelled.has(id)) return
      send({ id, result: modern ? { ...result, ...(CACHEABLE.has(method) ? NOT_CACHED : {}), resultType: 'complete', _meta: { [SERVER_INFO]: SERVER } } : result })
    } catch (error) {
      if (cancelled.has(id)) return
      const e = error instanceof ProtocolError ? error : new ProtocolError(-32603, error instanceof Error ? error.message : String(error))
      send({ id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } })
    } finally {
      inflight.delete(id)
      cancelled.delete(id)
    }
  }

  function notification(method: string, params: Params): void {
    if (method === 'notifications/initialized' && legacy) legacy.ready = true
    if (method === 'notifications/cancelled' && isId(params.requestId)) {
      if (!listens.delete(params.requestId) && inflight.has(params.requestId)) cancelled.add(params.requestId)
    }
  }

  function receive(line: string): Promise<void> | void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (!isObject(message) || typeof message.method !== 'string') {
      // A response, which this server never asks for, or no JSON-RPC message at all.
      if (isObject(message) && isId(message.id) && message.result === undefined && message.error === undefined) send({ id: message.id, error: { code: -32600, message: 'Invalid Request' } })
      return
    }
    const params = isObject(message.params) ? message.params : {}
    if (isId(message.id)) return request(message.id, message.method, params)
    notification(message.method, params)
  }

  const timer = setInterval(() => void notice(), every)
  try {
    for await (const line of transport.incoming) {
      if (line.trim() === '') continue
      const handled = receive(line)
      if (handled) {
        pending.add(handled)
        void handled.finally(() => pending.delete(handled))
      }
    }
  } finally {
    clearInterval(timer)
    await Promise.all(pending)
  }
}
