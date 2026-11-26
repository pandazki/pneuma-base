// The six endpoints under /api. Each request opens the library afresh: the server holds no state.
import { hostname } from 'node:os'
import {
  agentFace,
  identifySession,
  initLibrary,
  loadPlugins,
  makeContext,
  openLibrary,
  ownerFace,
  parseCall,
  shortDir,
  viewerFace,
  type Actor,
  type Call,
  type Context,
  type Env,
  type Library,
  type PluginTable,
} from '@pneuma-base/kernel'
import { archiveSummary, askSummary, ownerSummary, putSummary, readSummary, saySummary, type Summary } from './summary.js'

/** What the server was started with. `builtins` are the caller's plugins; this machine's own join them on each request, as their files are then. */
export type Served = { dir: string; builtins: PluginTable; home: string; env: Env }

/** Every plugin this machine has, as their files are now: a plugin changed since the last request is loaded afresh. */
export const tableOf = (served: Served): Promise<PluginTable> => loadPlugins(served.home, served.builtins)

export type Reply = { status: number; json: unknown }

const OWNER: Actor = { kind: 'owner' }

const reply = (json: unknown, status = 200): Reply => ({ status, json })
const failure = (status: number, error: string): Reply => ({ status, json: { error } })
const NOT_A_LIBRARY = failure(409, 'not-a-library')

/** Everything in the UI is done by the owner, in the session the server's environment shows, else one minted per request. */
function ownerContext(library: Library, served: Served): Context {
  return makeContext(library, OWNER, identifySession({ flag: null, env: served.env, cwd: process.cwd(), machine: hostname() }), served.home)
}

const available = (table: PluginTable) => [...table.values()].map((p) => ({ name: p.name, title: p.cognition?.title ?? null }))

export async function state(served: Served): Promise<Reply> {
  const table = await tableOf(served)
  const library = await openLibrary(served.dir, table)
  if (!library) return reply({ dir: served.dir, library: null, views: [], problems: [], available: available(table) })
  const { views, problems } = viewerFace.views(library)
  // `shown`: the root as people read it, the home directory as ~; the page cuts it to its room.
  const shown = shortDir(library.root, Number.POSITIVE_INFINITY)
  return reply({ dir: served.dir, library: { root: library.root, shown, id: library.config.id }, views, problems, available: available(table) })
}

/** `query` holds the view's id under `view`; every other entry is a parameter of the view. */
export async function view(served: Served, query: URLSearchParams): Promise<Reply> {
  const table = await tableOf(served)
  const library = await openLibrary(served.dir, table)
  if (!library) return NOT_A_LIBRARY
  const id = query.get('view')
  if (id === null) return failure(400, 'view is missing')
  const params = Object.fromEntries([...query].filter(([name]) => name !== 'view' && name !== 'token'))
  return reply(await viewerFace.show({ view: id, params }, { ctx: ownerContext(library, served), table, env: served.env, viaGrant: false }))
}

/**
 * The call's result, and a line saying how it went. The page's confirmation is the in-person
 * confirmation; an owner call's `stdin` is what the command reads as the person's answer.
 */
async function perform(call: Call, confirmed: boolean, library: Library, table: PluginTable, served: Served): Promise<{ result: unknown; summary: Summary }> {
  const ctx = ownerContext(library, served)
  if (call.face === 'owner') {
    const stdin = call.stdin ?? null
    const ownerCall = { ctx, table, env: served.env, viaGrant: false, confirm: async () => confirmed, readSecret: async () => stdin }
    const r = await ownerFace.dispatch(ownerCall, call.command, call.args)
    return { result: r, summary: ownerSummary(r) }
  }
  switch (call.verb) {
    case 'archive': {
      const r = await agentFace.archive(call.request, ctx)
      return { result: r, summary: archiveSummary(call.request.kind, r) }
    }
    case 'put': {
      const r = await agentFace.put(call.request, ctx)
      return { result: r, summary: putSummary(r) }
    }
    case 'say': {
      const r = await agentFace.say(call.request, ctx)
      return { result: r, summary: saySummary(r) }
    }
    case 'find': {
      const r = await agentFace.find(call.request, ctx)
      return { result: r, summary: readSummary(r.problems) }
    }
    case 'inspect': {
      const r = await agentFace.inspect(call.request, ctx)
      return { result: r, summary: readSummary(r.problems) }
    }
    case 'check': {
      const r = await agentFace.check(call.request, ctx)
      return { result: r, summary: readSummary(r.problems) }
    }
    case 'ask': {
      const r = await agentFace.ask(call.request, ctx)
      return { result: r, summary: askSummary(r) }
    }
  }
}

export async function call(served: Served, body: unknown): Promise<Reply> {
  const table = await tableOf(served)
  const library = await openLibrary(served.dir, table)
  if (!library) return NOT_A_LIBRARY
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const parsed = parseCall(raw.call)
  if (typeof parsed === 'string') return failure(400, parsed)
  const { result, summary } = await perform(parsed, raw.confirmed === true, library, table, served)
  return reply({ ...summary, result })
}

/** Makes the served directory a library with the plugins chosen from the available ones. */
export async function init(served: Served, body: unknown): Promise<Reply> {
  const plugins = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).plugins : undefined
  if (!Array.isArray(plugins) || !plugins.every((p) => typeof p === 'string')) return failure(400, 'plugins is not a list of names')
  const session = identifySession({ flag: null, env: served.env, cwd: process.cwd(), machine: hostname() })
  const r = await initLibrary(served.dir, { plugins, table: await tableOf(served), actor: OWNER, session, home: served.home })
  return reply({ ...ownerSummary(r), result: r })
}
