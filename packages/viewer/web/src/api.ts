// The page's only way to the library: the server's /api, with the token from the page's address.
import { knowAgentMarks } from './agents'
import type { Call, ListedView, PassProgress, PluginProblem, ViewRequest, ViewResult } from '@pneuma-base/kernel'

export const TOKEN = new URLSearchParams(window.location.search).get('token') ?? ''

export type State = {
  dir: string
  /** `shown` is the root as people read it, the home directory as ~. */
  library: { root: string; shown: string; id: string } | null
  /** In the navigation's order: each plugin's in configuration order, then the kernel's. */
  views: ListedView[]
  problems: PluginProblem[]
  available: { name: string; title: string | null }[]
  /** The agents drawn as their product's icon, and the names each goes by. */
  agentMarks: { product: string; names: string[] }[]
}

export type Tone = 'good' | 'warn' | 'bad'
export type CallReply = { tone: Tone; text: string; result: unknown }

/** The server answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** No answer at all: the server is not running or not reachable. */
export class Unreachable extends Error {}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-pneuma-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Unreachable('无法连接服务')
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText)
  return json as T
}

/**
 * A call whose named whole pass, if it runs one, reports to `onProgress`: the server answers it line by
 * line, each report as it comes, then the reply. `api.stop(pass)` asks it to stop.
 */
async function streamed(call: Call, confirmed: boolean, pass: string, onProgress: (p: PassProgress) => void): Promise<CallReply> {
  let res: Response
  try {
    res = await fetch('/api/call', { method: 'POST', headers: { 'x-pneuma-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ call, confirmed, pass }) })
  } catch {
    throw new Unreachable('无法连接服务')
  }
  if (!res.ok || res.body === null) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, json?.error ?? res.statusText)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  for (;;) {
    const { value, done } = await reader.read().catch(() => {
      throw new Unreachable('无法连接服务')
    })
    if (done) break
    buffered += value
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines.filter((l) => l.trim() !== '')) {
      const message = JSON.parse(line) as { progress?: PassProgress; reply?: { status: number; json: unknown } }
      if (message.progress) onProgress(message.progress)
      if (message.reply) {
        const json = message.reply.json as { error?: string } | null
        if (message.reply.status >= 400) throw new ApiError(message.reply.status, json?.error ?? String(message.reply.status))
        return message.reply.json as CallReply
      }
    }
  }
  throw new Unreachable('无法连接服务')
}

const passId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

export const api = {
  /** Runs a call, hearing the progress of a named whole pass it may run with the id to stop it by. */
  pass: (call: Call, confirmed: boolean, onProgress: (p: PassProgress, pass: string) => void) => {
    const id = passId()
    return streamed(call, confirmed, id, (p) => onProgress(p, id))
  },
  stop: (pass: string) => request<{ running: boolean }>('/api/stop', { pass }),
  state: () =>
    request<State>('/api/state').then((s) => {
      knowAgentMarks(s.agentMarks)
      return s
    }),
  view: (req: ViewRequest) => request<ViewResult>(`/api/view?${new URLSearchParams({ ...req.params, view: req.view })}`),
  call: (call: Call, confirmed: boolean) => request<CallReply>('/api/call', { call, confirmed }),
  init: (plugins: string[]) => request<CallReply>('/api/init', { plugins }),
  rev: () => request<{ rev: string }>('/api/rev'),
  fileUrl: (path: string) => `/api/file?${new URLSearchParams({ path, token: TOKEN })}`,
  /** A file of a plugin's ui directory. It carries no token: the frame that loads it must never hold one. */
  pluginUiUrl: (plugin: string, entry: string) => `/plugin-ui/${encodeURIComponent(plugin)}/${entry.split('/').map(encodeURIComponent).join('/')}`,
}

/** The address when it is http or https, the only outside addresses the page opens; null for anything else. */
export function outsideUrl(href: string | undefined): string | null {
  if (href === undefined || !URL.canParse(href)) return null
  const url = new URL(href)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}
