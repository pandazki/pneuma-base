// Catching up (ARCHITECTURE.md「补上」): a plugin learns what is registered from the puts it
// hears, so one added to a library in use learns what was registered before it from the register. The
// register is the plugin's that keeps it, asked through the kernel, since plugins do not know each
// other. Catching up is a named whole pass of the plugin added: it says how much, reports each page,
// stops when asked and goes on later from where it stopped. How far each plugin got is facts in the
// kernel's own record place `kernel`, folded into rows there; until a plugin's has finished, its
// answers say so in one line.
import { randomBytes } from 'node:crypto'
import type { Context, Plugin, PluginContext, PluginName, RegisteredPage, RegisteredThing } from '@pneuma-base/sdk'
import { storageOf } from './storage.js'

/** The kernel's record place: facts of how far each plugin's catching up got. */
const PLACE = 'kernel'
const TABLE = 'catchup'
/** Things in one page of the register, unless the asker says otherwise, and at most. */
const PAGE = 500
const MOST = 1000

/** How far one plugin's catching up got: the place it goes on after, how many things of how many, whether it finished. */
export type CatchingUp = { plugin: PluginName; run: string; after: string | null; done: number; total: number | null; finished: boolean; at: string }

/** What one run of catching up came to. `nothing`: there was nothing to catch up on: no plugin keeps the register, or nothing is registered. */
export type CaughtUp = { done: number; total: number | null; finished: boolean; nothing: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function factOf(raw: unknown): CatchingUp | null {
  if (!isObject(raw) || raw.kind !== 'catch-up' || typeof raw.plugin !== 'string' || typeof raw.run !== 'string') return null
  if (!(raw.after === null || typeof raw.after === 'string') || !isCount(raw.done) || !(raw.total === null || isCount(raw.total)) || typeof raw.finished !== 'boolean') return null
  return { plugin: raw.plugin as PluginName, run: raw.run, after: raw.after, done: raw.done, total: raw.total, finished: raw.finished, at: typeof raw.at === 'string' ? raw.at : '' }
}

/** A thing of the register as the keeper answered it, or null: only well-formed things reach a plugin. */
function thingOf(raw: unknown): RegisteredThing | null {
  if (!isObject(raw) || typeof raw.place !== 'string' || raw.place === '' || (raw.kind !== 'file' && raw.kind !== 'bundle')) return null
  if (!(raw.token === null || typeof raw.token === 'string') || typeof raw.fingerprinted !== 'boolean') return null
  return { place: raw.place as RegisteredThing['place'], kind: raw.kind, token: raw.token, fingerprinted: raw.fingerprinted }
}

/**
 * A page of the register: the first installed plugin with `registered` answers, without the pass of
 * the operation under way. With none, the page is empty and `keeper` null.
 */
export async function registerPage(ctx: Context, opts: { after?: string; limit?: number }): Promise<RegisteredPage & { keeper: PluginName | null }> {
  const keeper = ctx.library.plugins.find((p) => p.registered !== undefined)
  if (keeper?.registered === undefined) return { things: [], more: null, total: 0, keeper: null }
  // Imported when called: the pipeline builds plugin contexts with the tools, which ask the register.
  const { pluginContext } = await import('./pipeline.js')
  const quiet: Context = { ...ctx, pass: undefined }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? PAGE)), MOST)
  const page: unknown = await keeper.registered({ after: opts.after ?? null, limit }, pluginContext(quiet, keeper.name))
  if (!isObject(page) || !Array.isArray(page.things)) throw new Error(`插件 ${keeper.name} 的 registered 答的不是登记的一页`)
  const more = isObject(page.more) && typeof page.more.after === 'string' ? { after: page.more.after } : null
  return { things: page.things.flatMap((t) => thingOf(t) ?? []), more, total: isCount(page.total) ? page.total : null, keeper: keeper.name }
}

/** How far each of these plugins' catching up got, from the facts after the rows' cursor folded in first. */
async function progressOf(root: string, names: readonly string[]): Promise<Map<string, CatchingUp>> {
  const records = storageOf(root).records(PLACE)
  for (let tries = 0; ; tries++) {
    const got = await records.get<CatchingUp>(TABLE, names)
    const batch = await records.since(got.cursor, 10_000)
    if (batch === null) {
      // The facts the rows came from are not there any more: derive them again.
      await records.reset()
      continue
    }
    if (batch.facts.length === 0) return new Map(got.rows.map((r) => [r.key, r.value]))
    const latest = new Map<string, CatchingUp>()
    for (const { fact } of batch.facts) {
      const f = factOf(fact)
      if (f !== null) latest.set(f.plugin, f)
    }
    const put = await records.put({ [TABLE]: [...latest.values()].map((c) => ({ key: c.plugin, value: c })) }, { cursor: batch.cursor, expect: got.cursor })
    if (!put.written && tries > 20) throw new Error('补上的行一直在被别的进程改写')
  }
}

/** The installed plugins whose catching up has not finished, and how far each got. */
export async function catchingUp(ctx: Context): Promise<Map<PluginName, CatchingUp>> {
  const hooked = ctx.library.plugins.filter((p) => p.catchUp !== undefined).map((p) => p.name)
  if (hooked.length === 0) return new Map()
  const all = await progressOf(ctx.library.root, hooked)
  return new Map(hooked.flatMap((name) => {
    const c = all.get(name)
    return c === undefined || c.finished ? [] : [[name, c] as const]
  }))
}

const COMMAND = (name: string) => `pneuma-base plugin catch-up ${name}`

/** How far a plugin's catching up got, in words. */
export const catchingUpCount = (c: CatchingUp): string => `装上之前登记的${c.total === null ? '东西' : ` ${c.total} 样`}补了 ${c.done} 样`

/** The one line a plugin's answers carry until its catching up has finished. */
export const catchingUpLine = (c: CatchingUp): string => `${catchingUpCount(c)}；接着补：${COMMAND(c.plugin)}`

/** What a run of catching up came to, in one line. */
export function caughtUpText(name: string, r: CaughtUp, keeper: boolean): string {
  if (r.nothing) return keeper ? '库里还没有登记过的东西。' : '这个库没装记着登记的插件。'
  if (r.finished) return `${name} 补上了装上之前登记的 ${r.done} 样。`
  return `${name} 补了装上之前登记的 ${r.done}${r.total === null ? '' : ` / ${r.total}`} 样；接着补：${COMMAND(name)}`
}

/**
 * Runs the plugin's catching up: page after page of the register to its `catchUp`, how far it got
 * written after each page, reported on the operation's pass and stopped there when asked. `fresh`
 * starts from the first page; otherwise it goes on from where an unfinished one stopped, or starts
 * again when the last one finished. Null for a plugin without `catchUp`. A hook that throws ends the
 * run there; the next one goes on from that page.
 */
export async function catchUp(ctx: Context, plugin: Plugin, how: 'fresh' | 'resume'): Promise<(CaughtUp & { keeper: boolean }) | null> {
  const hook = plugin.catchUp
  if (hook === undefined) return null
  const { pluginContext } = await import('./pipeline.js')
  const pctx: PluginContext = pluginContext(ctx, plugin.name)
  const records = storageOf(ctx.library.root).records(PLACE)
  const prior = how === 'resume' ? (await progressOf(ctx.library.root, [plugin.name])).get(plugin.name) : undefined
  const going = prior !== undefined && !prior.finished ? prior : null
  let after = going?.after ?? null
  let done = going?.done ?? 0
  let page = await registerPage(ctx, { ...(after === null ? {} : { after }), limit: PAGE })
  if (page.keeper === null || (going === null && page.things.length === 0)) return { done: 0, total: page.total, finished: true, nothing: true, keeper: page.keeper !== null }
  const run = going?.run ?? randomBytes(4).toString('hex')
  const total = page.total ?? going?.total ?? null
  const text = () => `${plugin.name} 补上装上之前登记的东西：${done}${total === null ? '' : ` / ${total}`} 样`
  const note = (finished: boolean) => records.append([{ kind: 'catch-up', plugin: plugin.name, run, after, done, total, finished, at: ctx.now }])
  if (going === null) await note(false)
  pctx.pass?.report({ done, total, text: text() })
  for (;;) {
    if (page.things.length > 0) await hook(page.things, pctx)
    done += page.things.length
    after = page.more?.after ?? null
    const finished = page.more === null
    await note(finished)
    pctx.pass?.report({ done, total, text: text() })
    if (finished) return { done, total, finished, nothing: false, keeper: true }
    if (pctx.pass?.stopped()) return { done, total, finished, nothing: false, keeper: true }
    page = await registerPage(ctx, { after: after as string, limit: PAGE })
  }
}
