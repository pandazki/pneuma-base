// The page's only way to the library: the server's /api, with the token from the page's address.
import type { Call, PluginProblem, ViewDecl, ViewRequest, ViewResult } from '@pneuma-base/kernel'

export const TOKEN = new URLSearchParams(window.location.search).get('token') ?? ''

export type State = {
  dir: string
  library: { root: string; id: string } | null
  views: ViewDecl[]
  problems: PluginProblem[]
  available: { name: string; title: string | null }[]
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
    throw new Unreachable('连不上服务')
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText)
  return json as T
}

export const api = {
  state: () => request<State>('/api/state'),
  view: (req: ViewRequest) => request<ViewResult>(`/api/view?${new URLSearchParams({ ...req.params, view: req.view })}`),
  call: (call: Call, confirmed: boolean) => request<CallReply>('/api/call', { call, confirmed }),
  init: (plugins: string[]) => request<CallReply>('/api/init', { plugins }),
  rev: () => request<{ rev: string }>('/api/rev'),
  fileUrl: (path: string) => `/api/file?${new URLSearchParams({ path, token: TOKEN })}`,
}
