import { join } from 'node:path'
import { whyNotLoaded } from './plugin-table.js'
import { pluginSecrets } from './secrets.js'
import { pluginTools } from './tools.js'
import type {
  AgentFace,
  Context,
  Event,
  Failure,
  Instant,
  Actor,
  Library,
  Note,
  OwnerAnswer,
  OwnerArgs,
  OwnerResult,
  Plugin,
  PluginContext,
  PluginName,
  PluginNoteAnswer,
  PluginProblem,
  Requested,
  Session,
  Verb,
} from '@pneuma-base/sdk'

export function makeContext(library: Library, actor: Actor, session: Session, home: string, now: Instant = new Date().toISOString() as Instant): Context {
  return { library, actor, session, now, home }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type Collected<T> = { values: { plugin: PluginName; value: T }[]; problems: PluginProblem[] }

/**
 * Calls one hook on every installed plugin in configuration order. A plugin without the hook
 * answers `undefined` and is skipped. A plugin that throws becomes a problem; the rest still run (K8).
 */
export async function eachPlugin<T>(
  ctx: Context,
  call: (plugin: Plugin, pctx: PluginContext) => Promise<T> | undefined,
): Promise<Collected<NonNullable<T>>> {
  const out: Collected<NonNullable<T>> = { values: [], problems: [] }
  for (const plugin of ctx.library.plugins) {
    try {
      const value = await call(plugin, pluginContext(ctx, plugin.name))
      if (value !== undefined && value !== null) out.values.push({ plugin: plugin.name, value })
    } catch (error) {
      out.problems.push({ plugin: plugin.name, message: messageOf(error) })
    }
  }
  return out
}

/** The notes of hooks that answer `PluginNoteAnswer`, and the problems they answered beside them, stamped with each plugin's name. */
export function notesOf(heard: Collected<PluginNoteAnswer>): { notes: Note[]; problems: PluginProblem[] } {
  const notes: Note[] = []
  const problems: PluginProblem[] = [...heard.problems]
  for (const { plugin, value } of heard.values) {
    const answer = 'problems' in value ? value : { note: value, problems: [] }
    if (answer.note !== null) notes.push({ ...answer.note, plugin })
    problems.push(...answer.problems.map((message) => ({ plugin, message })))
  }
  return { notes, problems }
}

export function pluginContext(ctx: Context, name: PluginName): PluginContext {
  return { ...ctx, cacheDir: join(ctx.home, 'cache', ctx.library.config.id, name), tools: pluginTools(ctx, name), secrets: pluginSecrets(ctx.home, name) }
}

type RequestOf<V extends Verb> = Parameters<AgentFace[V]>[0]
type ResultOf<V extends Verb> = Awaited<ReturnType<AgentFace[V]>>

/** Runs one agent-face operation and ends it at the single exit. */
export async function performVerb<V extends Verb>(verb: V, request: RequestOf<V>, ctx: Context, body: () => Promise<ResultOf<V>>): Promise<ResultOf<V>> {
  return finish(ctx, (result) => ({ face: 'agent', verb, request, result }) as Event, async () => ({ result: await body() }))
}

/**
 * Runs one owner-face operation and ends it at the single exit. A command that changes the
 * configuration hands back the reopened library, so the event reaches the plugins installed after it;
 * a kernel command that called plugins' hooks hands back their problems. An operation that runs an
 * approved request carries it on its event.
 */
export async function performOwner(
  ctx: Context,
  command: string,
  args: OwnerArgs,
  how: { destructive: boolean; readOnly: boolean; setup?: boolean; request?: Requested },
  body: () => Promise<{ answer: OwnerAnswer; library?: Library; problems?: PluginProblem[] }>,
): Promise<OwnerResult> {
  const marks = { destructive: how.destructive, readOnly: how.readOnly, setup: how.setup ?? false, ...(how.request ? { request: how.request } : {}) }
  return finish(ctx, (result) => ({ face: 'owner', command, args, ...marks, result }), async () => {
    const { answer, library, problems } = await body()
    return { result: { ...answer, problems: problems ?? [] }, ...(library ? { library } : {}) }
  })
}

/**
 * The single exit of both faces (K5). Every operation, accepted, refused or failed, ends here by
 * sending exactly one event to every installed plugin's `observe`. Problems from installed plugins
 * that are missing from the plugin table, from names a later plugin could not claim, and from
 * `observe` itself join the result (K8).
 */
async function finish<R extends { problems: PluginProblem[] }>(
  before: Context,
  toEvent: (result: R | Failure) => Event,
  body: () => Promise<{ result: R; library?: Library }>,
): Promise<R> {
  let done: { result: R; library?: Library }
  try {
    done = await body()
  } catch (error) {
    await eachPlugin(before, (plugin, pctx) => plugin.observe?.(toEvent({ outcome: 'failed', message: messageOf(error) }), pctx))
    throw error
  }
  const ctx = done.library ? { ...before, library: done.library } : before
  const missing: PluginProblem[] = []
  for (const plugin of ctx.library.unavailable) {
    missing.push({ plugin, message: (await whyNotLoaded(ctx.home, plugin)) ?? 'installed in this library but not known to this pneuma-base' })
  }
  // A command that ran another, as approving a request does, already carries that one's problems.
  const problems = [...missing, ...ctx.library.clashes, ...done.result.problems]
  const answered = { ...done.result, problems: problems.filter((p, i) => problems.findIndex((q) => q.plugin === p.plugin && q.message === p.message) === i) }
  const observed = await eachPlugin(ctx, (plugin, pctx) => plugin.observe?.(toEvent(answered), pctx))
  return { ...answered, problems: [...answered.problems, ...observed.problems] }
}
