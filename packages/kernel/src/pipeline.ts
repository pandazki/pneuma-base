import { join } from 'node:path'
import { pluginDir } from './paths.js'
import { whyNotLoaded } from './plugin-table.js'
import type {
  AgentFace,
  Context,
  Event,
  Failure,
  Instant,
  Actor,
  Library,
  OwnerAnswer,
  OwnerArgs,
  OwnerResult,
  Plugin,
  PluginContext,
  PluginName,
  PluginProblem,
  Session,
  Verb,
} from './types.js'

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

export function pluginContext(ctx: Context, name: PluginName): PluginContext {
  return { ...ctx, dir: pluginDir(ctx.library.root, name), cacheDir: join(ctx.home, 'cache', ctx.library.config.id, name) }
}

type RequestOf<V extends Verb> = Parameters<AgentFace[V]>[0]
type ResultOf<V extends Verb> = Awaited<ReturnType<AgentFace[V]>>

/** Runs one agent-face operation and ends it at the single exit. */
export async function performVerb<V extends Verb>(verb: V, request: RequestOf<V>, ctx: Context, body: () => Promise<ResultOf<V>>): Promise<ResultOf<V>> {
  return finish(ctx, (result) => ({ face: 'agent', verb, request, result }) as Event, async () => ({ result: await body() }))
}

/**
 * Runs one owner-face operation and ends it at the single exit. A command that changes the
 * configuration hands back the reopened library, so the event reaches the plugins installed after it.
 */
export async function performOwner(
  ctx: Context,
  command: string,
  args: OwnerArgs,
  how: { destructive: boolean; readOnly: boolean; setup?: boolean },
  body: () => Promise<{ answer: OwnerAnswer; library?: Library }>,
): Promise<OwnerResult> {
  return finish(ctx, (result) => ({ face: 'owner', command, args, destructive: how.destructive, readOnly: how.readOnly, setup: how.setup ?? false, result }), async () => {
    const { answer, library } = await body()
    return { result: { ...answer, problems: [] }, ...(library ? { library } : {}) }
  })
}

/**
 * The single exit of both faces (K5). Every operation, accepted, refused or failed, ends here by
 * sending exactly one event to every installed plugin's `observe`. Problems from installed plugins
 * that are missing from the plugin table and from `observe` itself join the result (K8).
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
  const answered = { ...done.result, problems: [...missing, ...done.result.problems] }
  const observed = await eachPlugin(ctx, (plugin, pctx) => plugin.observe?.(toEvent(answered), pctx))
  return { ...answered, problems: [...answered.problems, ...observed.problems] }
}
