// The agent routes: what an agent that is not connected yet reads and asks for (the guide, pairing),
// and MCP over HTTP for a connected one. They never see the token and never reach the owner's face;
// the lint keeps the owner's routes and the owner face out of this module. ARCHITECTURE.md「本机的 endpoint」.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { GRANT_NAME, guideText, openLibrary, pairingAnswer, requestPairing, type Env, type Instant, type PairRequested } from '@pneuma-base/kernel'
import { mediaType, readBody, sendJson } from './http.js'

/** One MCP request as the server hands it over: already checked for origin, method, content type, size and grant name. */
export type McpRequest = { method: 'POST' | 'GET' | 'DELETE'; headers: IncomingHttpHeaders; body: string; session: string | null }

/** MCP over HTTP at `/mcp/<grant>`, given by the caller: the protocol lives with the command line's verb table. */
export type McpEndpoint = { handle(grant: string, request: McpRequest, res: ServerResponse): Promise<void>; close(): Promise<void> }

export type AgentFacts = { dir: string; home: string; env: Env; origin: string; mcp: McpEndpoint | null }

const PAIR_BODY_LIMIT = 4 * 1024
const MCP_BODY_LIMIT = 8 * 1024 * 1024
const PAIRING_ID = /^p-[0-9a-f]{8}$/
const MINUTE = 60_000
const NOT_A_LIBRARY = '这个目录还不是 Pneuma Base 库，没有接入的说明。请主人先在管理界面里把它建成库。'
const REFUSAL_STATUS: Record<Extract<PairRequested, { outcome: 'refused' }>['reason'], number> = { usage: 400, 'too-many': 429, 'not-a-library': 409 }

/** At most `limit` requests in any sixty seconds, for the whole server. */
class Window {
  private readonly at: number[] = []
  constructor(private readonly limit: number) {}

  /** 0 when a request now is within the limit, and it is counted; else the seconds until one is. */
  take(now: number): number {
    while (this.at.length > 0 && (this.at[0] as number) <= now - MINUTE) this.at.shift()
    if (this.at.length < this.limit) {
      this.at.push(now)
      return 0
    }
    return Math.max(1, Math.ceil(((this.at[0] as number) + MINUTE - now) / 1000))
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const now = () => new Date().toISOString() as Instant
const fail = (res: ServerResponse, status: number, error: string, headers = {}) => sendJson(res, { status, json: { error } }, headers)
const notAllowed = (res: ServerResponse, allow: string) => fail(res, 405, `method not allowed: ${allow}`, { allow })

function sendText(res: ServerResponse, status: number, type: string, text: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

type Route = (req: IncomingMessage, res: ServerResponse, url: URL, segment: string | undefined) => Promise<void>

/** The handler of `pathname` when it is an agent route, else null. Rate limits are per returned set of routes, so per server. */
export function agentRoutes({ dir, home, env, origin, mcp }: AgentFacts): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | null {
  const windows = { guide: new Window(120), pair: new Window(20), poll: new Window(240) }

  /** True when the request was over the limit and is answered. */
  function limited(res: ServerResponse, window: Window): boolean {
    const wait = window.take(Date.now())
    if (wait > 0) fail(res, 429, 'too many requests', { 'retry-after': String(wait) })
    return wait > 0
  }

  const guide: Route = async (req, res, url, segment) => {
    if (req.method !== 'GET') return notAllowed(res, 'GET')
    if (limited(res, windows.guide)) return
    const product = segment ?? url.searchParams.get('for')
    if (product !== null && !GRANT_NAME.test(product)) return fail(res, 404, 'no such product')
    const library = await openLibrary(dir, new Map())
    if (library === null) return sendText(res, 409, 'text/plain', NOT_A_LIBRARY)
    sendText(res, 200, 'text/markdown', guideText({ root: library.root, home, env, url: origin }, product))
  }

  const pair: Route = async (req, res) => {
    if (req.method !== 'POST') return notAllowed(res, 'POST')
    if (limited(res, windows.pair)) return
    if (mediaType(req) !== 'application/json') return fail(res, 415, 'content-type must be application/json')
    const text = await readBody(req, PAIR_BODY_LIMIT)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return fail(res, 400, 'body is not JSON')
    }
    if (!isObject(body) || typeof body.product !== 'string' || typeof body.why !== 'string') return fail(res, 400, 'body must be an object with the strings product and why')
    const r = await requestPairing({ home, library: dir, product: body.product, why: body.why, via: 'http', now: now() })
    if (r.outcome === 'refused') return sendJson(res, { status: REFUSAL_STATUS[r.reason], json: r })
    const { id, code, expires } = r.pairing
    sendJson(res, { status: 201, json: { outcome: r.outcome, id, code, expires, again: r.again, poll: `${origin}/pair/${id}`, text: r.text } })
  }

  const poll: Route = async (req, res, _url, id = '') => {
    if (req.method !== 'GET') return notAllowed(res, 'GET')
    if (limited(res, windows.poll)) return
    const answer = PAIRING_ID.test(id) ? await pairingAnswer(home, id, now()) : null
    if (answer === null) return sendJson(res, { status: 404, json: { error: 'no-such-pairing' } })
    sendJson(res, { status: 200, json: answer })
  }

  const mcpRoute: Route = async (req, res, url, grant = '') => {
    if (mcp === null || !GRANT_NAME.test(grant)) return fail(res, 404, 'not found')
    const method = req.method
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return notAllowed(res, 'POST, GET, DELETE')
    if (method === 'POST' && mediaType(req) !== 'application/json') return fail(res, 415, 'content-type must be application/json')
    const body = method === 'POST' ? await readBody(req, MCP_BODY_LIMIT) : ''
    await mcp.handle(grant, { method, headers: req.headers, body, session: url.searchParams.get('session') || null }, res)
  }

  const routes: [RegExp, Route][] = [
    [/^\/guide(?:\/([^/]*))?$/, guide],
    [/^\/pair$/, pair],
    [/^\/pair\/([^/]*)$/, poll],
    [/^\/mcp\/([^/]*)$/, mcpRoute],
  ]

  return (req, res, url) => {
    for (const [pattern, route] of routes) {
      const match = pattern.exec(url.pathname)
      if (match) return route(req, res, url, match[1])
    }
    return null
  }
}
