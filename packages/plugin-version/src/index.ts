import { readFileSync } from 'node:fs'
import {
  CONTRACT,
  PNEUMA_BASE_VERSION,
  pluginName,
  type Event,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type SayAnswer,
  type SayRequest,
} from '@pneuma-base/kernel'
import { versionCommands } from './commands.js'
import { newThingId } from './facts.js'
import { type Thing } from './model.js'
import { thingPages, thingsAt } from './rows.js'
import { timelineData, timelineText } from './text.js'
import { THINGS_VIEW, itemSection, thingsPage, undeclaredSection } from './views.js'
import { adopt, apply, commit, declaredAt, declaredExactly, differing, diskState, load, record, thingPath, writing, type DiskState, type Held, type Writing } from './versions.js'

/** How many versions inspect shows; version list shows all. */
const INSPECT_VERSIONS = 10
/** How many contents one check or page reads at once. */
const AT_ONCE = 8

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })
const busy = (path: string) => refused(`${path} 正在被改动，没能记下当前的内容；稍后再说一次。`)

async function eachAtMost<T>(list: readonly T[], f: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) await f(list[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, worker))
}

/** Writes the note on the content now at the thing's path, recording that content as a version first if it is not one. */
async function describe(w: Writing, thing: Thing, text: string): Promise<SayAnswer> {
  const r = await record(w, thing, 'outside')
  if (r === null) return refused(`${thing.path} 上现在没有东西，没法给当前这一版写说明。`)
  if (r === 'moved') return busy(thing.path)
  apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text })
  await commit(w)
  const first = r.added ? `${thing.path} 在工具之外改过，已先记为第 ${r.version.n} 版；` : ''
  return heard(`${first}已给 ${thing.path} 的第 ${r.version.n} 版写上说明：${text}`)
}

/** `say versioned <path> [一句话]`: declares the thing and records its current content as version 1. */
async function declare(w: Writing, input: string, text: string | null): Promise<SayAnswer> {
  const { tools } = w.ctx
  const path = await thingPath(w.ctx, input)
  if (path === null) return refused(`${input} 不在库的内容里。`)
  const known = await declaredAt(w.ctx, path)
  if (known) return text ? describe(w, adopt(w, known), text) : heard(`${known.path} 早已声明有版本，现在有 ${known.versions.length} 版。`)
  const candidates = tools.regionOf(path) === 'content' ? [path, tools.archivedPath(path)] : [path]
  const at = (await tools.what(candidates)).find((t) => t.kind === 'file' || t.kind === 'bundle')?.path
  if (at === undefined) return refused(`库里没有这样东西：${input}。先 put 进来，再声明。`)
  const thing = w.things.get(apply(w, { kind: 'declare', thing: newThingId(), path: at }).thing) as Thing
  const r = await record(w, thing, 'declare')
  if (r === null) return refused(`${at} 刚刚不见了，没有声明。`)
  if (r === 'moved') return busy(at)
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
  const path = await thingPath(w.ctx, req.about)
  const named = path === null ? undefined : await declaredAt(w.ctx, path)
  if (!named) return refused(`${req.about} 没有声明有版本，先 say versioned ${req.about}。`)
  return describe(w, adopt(w, named), req.text)
}

/** Follows a declared thing to its new path. */
async function follow(ctx: PluginContext, from: LibraryPath, to: LibraryPath, what: string) {
  const w = await writing(ctx)
  const thing = await declaredExactly(w, from)
  if (!thing) return null
  apply(w, { kind: 'move', thing: thing.id, from, to })
  await commit(w)
  return { text: `它的 ${thing.versions.length} 版跟着${what}到了 ${to}`, data: { thing: thing.id } }
}

/** A put over a declared thing, which the kernel holds: a version when its content is not the latest; the put's note on that version. */
async function putOver(w: Writing, path: LibraryPath, held: Held, note: string | null) {
  const thing = await declaredExactly(w, path)
  if (!thing) return null
  const r = await record(w, thing, 'put', held)
  if (r === null || r === 'moved') return null
  if (note !== null) apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text: note })
  await commit(w)
  const data = { thing: thing.id, version: r.version.n }
  if (r.added) return { text: `记为 ${thing.path} 的第 ${r.version.n} 版${note ? `：「${note}」` : ''}`, data }
  return note === null ? null : { text: `已给 ${thing.path} 的第 ${r.version.n} 版写上说明：${note}`, data }
}

/** What `check --deep` reads: each declared thing in the library, not archived, at or under `dir` (all of them when null), from the rows a page at a time. */
async function inScope(ctx: PluginContext, dir: LibraryPath | null): Promise<Thing[]> {
  const out: Thing[] = []
  const under = (path: string) => dir === null || path === dir || path.startsWith(`${dir}/`)
  for await (const page of thingPages(ctx.tools.storage.records)) out.push(...page.filter((t) => !t.gone && ctx.tools.regionOf(t.path) === 'content' && under(t.path)))
  return out
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Event): LibraryPath[] {
  if (event.face !== 'owner' || event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/** 版本：things declared versioned keep every version's content. */
export const version: Plugin = {
  contract: CONTRACT,
  name: pluginName('version'),
  version: PNEUMA_BASE_VERSION,
  summary: '声明了有版本的东西，每一版的内容都留着，能列出、导出、放回。',
  cognition: { title: '版本', text: readFileSync(new URL('../cognition/version-section.md', import.meta.url), 'utf8') },
  keeps: 'some',
  storage: [
    { dir: 'objects', kind: 'body' },
    { dir: 'trees', kind: 'body' },
    { dir: 'facts', kind: 'body' },
    { dir: 'pending', kind: 'cache' },
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
    if (req.kind !== 'register-files') return putOver(w, req.path, { token: req.now.token, fingerprint: req.fingerprint }, req.note)
    const notes: string[] = []
    for (const f of req.files) {
      const answer = await putOver(w, f.path, { token: f.now.token, fingerprint: null }, req.note)
      if (answer) notes.push(answer.text)
    }
    return notes.length === 0 ? null : { text: notes.join('；') }
  },

  /** Holds only a declared thing, and only once its current content is a recorded version. */
  async revise(req, ctx) {
    const w = await writing(ctx)
    const thing = await declaredExactly(w, req.path)
    if (!thing) return { outcome: 'declined', reason: `${req.path} 没有声明有版本。要改它并留住旧版，先 say versioned ${req.path}，再放。` }
    const r = await record(w, thing, 'outside', { token: req.token, fingerprint: req.current })
    if (r === null || r === 'moved') return { outcome: 'declined', reason: `${req.path} 正在被改动，没能留住当前的内容` }
    await commit(w)
    return { outcome: 'held', note: r.added ? `当前内容是在工具之外改的，已先记为第 ${r.version.n} 版` : null }
  },

  async onArchive(req, ctx) {
    return req.moved ? follow(ctx, req.from, req.to, req.kind === 'archive' ? '归档' : '取回') : null
  },

  /**
   * Changed outside the tool: recorded as a version and reported once. Gone from its path: reported
   * every time. Storage compares every thing's token with the one on record; only what differs is read,
   * and with `--deep` every thing in its scope.
   */
  async onCheck(req, ctx) {
    const w = await writing(ctx)
    const diffs = await differing(ctx)
    const at = await thingsAt(ctx.tools.storage.records, [...diffs.keys()])
    const looked = at.map((t) => adopt(w, t)).filter((t) => req.includeArchived || ctx.tools.regionOf(t.path) !== 'archive')
    const deep = req.deep ? await inScope(ctx, req.deep.dir) : []
    const already = new Set(looked.map((t) => t.id))
    for (const thing of deep) if (!already.has(thing.id)) looked.push(adopt(w, thing))
    const read = new Set(deep.map((t) => t.id))
    const recorded: { path: LibraryPath; version: number }[] = []
    const missing: LibraryPath[] = []
    await eachAtMost(looked, async (thing) => {
      const r = diffs.get(thing.path) === 'gone' ? null : await record(w, thing, 'outside', null, read.has(thing.id) ? 'content' : 'token')
      if (r === null) missing.push(thing.path)
      else if (r !== 'moved' && r.added) recorded.push({ path: thing.path, version: r.version.n })
    })
    await commit(w)
    if (recorded.length === 0 && missing.length === 0) return []
    const lines = [
      ...recorded.map((r) => `${r.path} 在工具之外被改过，已记为第 ${r.version} 版`),
      ...missing.map((path) => `${path} 不在了；它的每一版都还在，version restore ${path} --version <n> 能放回来`),
    ]
    return [{ title: '有版本的东西', body: lines.join('\n'), data: { recorded, missing } }]
  },

  async onInspect(req, ctx) {
    await load(ctx)
    const path = await thingPath(ctx, req.target)
    const thing = path === null ? undefined : await declaredAt(ctx, path)
    if (!thing) return []
    const state = await diskState(ctx, thing)
    return [{ title: '版本', body: timelineText(thing, state, INSPECT_VERSIONS), data: timelineData(thing, state) }]
  },

  /** The owner deleted things from the archive: they are gone from the library; their versions stay. */
  async observe(event, ctx) {
    const paths = purged(event)
    if (paths.length === 0) return
    const w = await writing(ctx)
    for (const path of paths) {
      const thing = await declaredExactly(w, path)
      if (thing) apply(w, { kind: 'gone', thing: thing.id })
    }
    await commit(w)
  },

  /** Every thing in the library, from the rows a page at a time; storage compares their tokens, and only what differs is read. */
  async onView(req, ctx) {
    await load(ctx)
    const diffs = await differing(ctx)
    const showArchived = req.params.archived === 'show'
    const rows: { thing: Thing; state: DiskState }[] = []
    for await (const page of thingPages(ctx.tools.storage.records)) {
      for (const thing of page) if (!thing.gone && (showArchived || ctx.tools.regionOf(thing.path) !== 'archive')) rows.push({ thing, state: 'current' })
    }
    await eachAtMost(rows, async (row) => {
      const look = diffs.get(row.thing.path)
      if (look !== undefined) row.state = await diskState(ctx, row.thing, look)
    })
    return thingsPage(rows, showArchived)
  },

  async onItemView(path, ctx) {
    const named = await thingPath(ctx, path)
    if (named === null) return null
    await load(ctx)
    const thing = await declaredAt(ctx, named)
    if (thing) return itemSection(thing, await diskState(ctx, thing))
    if (ctx.tools.regionOf(named) !== 'content') return null
    const [at] = await ctx.tools.what([named])
    return at?.kind === 'file' || at?.kind === 'bundle' ? undeclaredSection(named) : null
  },
}
