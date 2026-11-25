import { readFileSync } from 'node:fs'
import {
  abs,
  archivedPath,
  pluginName,
  regionOf,
  thingAt,
  type Event,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type SayAnswer,
  type SayRequest,
} from '@pneuma-base/kernel'
import { versionCommands } from './commands.js'
import { newThingId } from './facts.js'
import { declaredAt, declaredExactly, type Thing } from './model.js'
import { timelineData, timelineText } from './text.js'
import { THINGS_VIEW, itemSection, thingsPage, undeclaredSection } from './views.js'
import { apply, commit, diskState, load, record, thingPath, writing, type Writing } from './versions.js'

/** How many versions inspect shows; version list shows all. */
const INSPECT_VERSIONS = 10

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })

/** Writes the note on the content now at the thing's path, recording that content as a version first if it is not one. */
async function describe(w: Writing, thing: Thing, text: string): Promise<SayAnswer> {
  const r = await record(w, thing, 'outside')
  if (r === null) return refused(`${thing.path} 上现在没有东西，没法给当前这一版写说明。`)
  apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text })
  await commit(w)
  const first = r.added ? `${thing.path} 在工具之外改过，已先记为第 ${r.version.n} 版；` : ''
  return heard(`${first}已给 ${thing.path} 的第 ${r.version.n} 版写上说明：${text}`)
}

/** `say versioned <path> [一句话]`: declares the thing and records its current content as version 1. */
async function declare(w: Writing, input: string, text: string | null): Promise<SayAnswer> {
  const { root } = w.ctx.library
  const path = await thingPath(root, input)
  if (path === null) return refused(`${input} 不在库的内容里。`)
  const known = declaredAt(w.model, path)
  if (known) return text ? describe(w, known, text) : heard(`${known.path} 早已声明有版本，现在有 ${known.versions.length} 版。`)
  const candidates = regionOf(path) === 'content' ? [path, archivedPath(path)] : [path]
  let at: LibraryPath | undefined
  for (const candidate of candidates) {
    if (await thingAt(abs(root, candidate))) {
      at = candidate
      break
    }
  }
  if (at === undefined) return refused(`库里没有这样东西：${input}。先 put 进来，再声明。`)
  const thing = w.model.things.get(apply(w, { kind: 'declare', thing: newThingId(), path: at }).thing) as Thing
  const r = await record(w, thing, 'declare')
  if (r === null) return refused(`${at} 刚刚不见了，没有声明。`)
  if (text) apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text })
  await commit(w)
  return heard(`已声明 ${at} 有版本，当前内容记为第 1 版。以后用 put 放进不同的内容就多一版；inspect ${at} 看每一版。`)
}

async function hear(w: Writing, req: SayRequest): Promise<SayAnswer> {
  if (req.kind === 'versioned') {
    const input = req.about ?? req.text
    if (input === null) return refused('要写是哪样东西：say versioned <库内路径> ["一句话"]')
    return declare(w, input, req.about === null ? null : req.text)
  }
  if (req.about === null || !req.text) return refused('要写是哪样东西和一句话：say version <库内路径> "<一句话>"')
  const path = await thingPath(w.ctx.library.root, req.about)
  const thing = path === null ? undefined : declaredAt(w.model, path)
  if (!thing) return refused(`${req.about} 没有声明有版本，先 say versioned ${req.about}。`)
  return describe(w, thing, req.text)
}

/** Follows a declared thing to its new path. */
async function follow(ctx: PluginContext, from: LibraryPath, to: LibraryPath, what: string) {
  const w = await writing(ctx)
  const thing = declaredExactly(w.model, from)
  if (!thing) return null
  apply(w, { kind: 'move', thing: thing.id, from, to })
  await commit(w)
  return { text: `它的 ${thing.versions.length} 版跟着${what}到了 ${to}`, data: { thing: thing.id } }
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Event): LibraryPath[] {
  if (event.face !== 'owner' || event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/** 版本：things declared versioned keep every version's content. */
export const version: Plugin = {
  name: pluginName('version'),
  cognition: { title: '版本', text: readFileSync(new URL('../cognition/version-section.md', import.meta.url), 'utf8') },
  keeps: 'some',
  storage: [
    { dir: 'objects', kind: 'body' },
    { dir: 'facts', kind: 'body' },
  ],
  statements: ['versioned', 'version'],
  ownerCommands: versionCommands,
  views: [THINGS_VIEW],

  async onSay(req, ctx) {
    return hear(await writing(ctx), req)
  },

  /** A put over a declared thing: a new version when the content differs from the latest; a move follows it. */
  async onPut(req, ctx) {
    if (req.kind === 'move') return follow(ctx, req.from, req.path, '挪')
    const w = await writing(ctx)
    const thing = declaredExactly(w.model, req.path)
    if (!thing) return null
    const r = await record(w, thing, 'put')
    if (!r?.added) return null
    await commit(w)
    return { text: `记为 ${thing.path} 的第 ${r.version.n} 版`, data: { thing: thing.id, version: r.version.n } }
  },

  /** Holds only a declared thing, and only once its current content is a recorded version. */
  async revise(req, ctx) {
    const w = await writing(ctx)
    const thing = declaredExactly(w.model, req.path)
    if (!thing) return { outcome: 'declined', reason: `${req.path} 没有声明有版本。要改它并留住旧版，先 say versioned ${req.path}，再放。` }
    const r = await record(w, thing, 'outside')
    if (r === null || r.version.fingerprint !== req.current) return { outcome: 'declined', reason: `${req.path} 正在被改动，没能留住当前的内容` }
    await commit(w)
    return { outcome: 'held', note: r.added ? `当前内容是在工具之外改的，已先记为第 ${r.version.n} 版` : null }
  },

  async onArchive(req, ctx) {
    return req.moved ? follow(ctx, req.from, req.to, req.kind === 'archive' ? '归档' : '取回') : null
  },

  /** Changed outside the tool: recorded as a version and reported once. Gone from its path: reported every time. */
  async onCheck(req, ctx) {
    const w = await writing(ctx)
    const recorded: { path: LibraryPath; version: number }[] = []
    const missing: LibraryPath[] = []
    for (const thing of w.model.things.values()) {
      if (thing.gone || (!req.includeArchived && regionOf(thing.path) === 'archive')) continue
      const r = await record(w, thing, 'outside')
      if (r === null) missing.push(thing.path)
      else if (r.added) recorded.push({ path: thing.path, version: r.version.n })
    }
    await commit(w)
    if (recorded.length === 0 && missing.length === 0) return []
    const lines = [
      ...recorded.map((r) => `${r.path} 在工具之外被改过，已记为第 ${r.version} 版`),
      ...missing.map((path) => `${path} 不在了；它的每一版都还在，version restore ${path} --version <n> 能放回来`),
    ]
    return [{ title: '有版本的东西', body: lines.join('\n'), data: { recorded, missing } }]
  },

  async onInspect(req, ctx) {
    const path = await thingPath(ctx.library.root, req.target)
    const thing = path === null ? undefined : declaredAt(await load(ctx), path)
    if (!thing) return []
    const state = await diskState(ctx.library.root, thing)
    return [{ title: '版本', body: timelineText(thing, state, INSPECT_VERSIONS), data: timelineData(thing, state) }]
  },

  /** The owner deleted things from the archive: they are gone from the library; their versions stay. */
  async observe(event, ctx) {
    const paths = purged(event)
    if (paths.length === 0) return
    const w = await writing(ctx)
    for (const path of paths) {
      const thing = declaredExactly(w.model, path)
      if (thing) apply(w, { kind: 'gone', thing: thing.id })
    }
    await commit(w)
  },

  async onView(req, ctx) {
    const model = await load(ctx)
    const things = [...model.things.values()].filter((t) => !t.gone)
    const rows = await Promise.all(things.map(async (thing) => ({ thing, state: await diskState(ctx.library.root, thing) })))
    return thingsPage(rows, req.params.archived === 'show')
  },

  async onItemView(path, ctx) {
    const { root } = ctx.library
    const named = await thingPath(root, path)
    if (named === null) return null
    const thing = declaredAt(await load(ctx), named)
    if (thing) return itemSection(thing, await diskState(root, thing))
    return regionOf(named) === 'content' && (await thingAt(abs(root, named))) ? undeclaredSection(named) : null
  },
}
