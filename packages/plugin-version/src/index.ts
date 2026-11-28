import { readFileSync } from 'node:fs'
import {
  CONTRACT,
  pageOfList,
  pagingOf,
  PNEUMA_BASE_VERSION,
  pluginName,
  rowsOf,
  TEXT_ROWS,
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
const busy = (path: string) => refused(`${path} 正在被修改，无法记录当前内容；请稍后重试。`)

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
  if (r === null) return refused(`${thing.path} 当前不存在，无法为当前版本添加说明。`)
  if (r === 'moved') return busy(thing.path)
  apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text })
  await commit(w)
  const first = r.added ? `${thing.path} 已被外部修改，已先记录为版本 ${r.version.n}；` : ''
  return heard(`${first}已为 ${thing.path} 的版本 ${r.version.n} 添加说明：${text}`)
}

/** `say versioned <path> [说明]`: declares the thing and records its current content as version 1. */
async function declare(w: Writing, input: string, text: string | null): Promise<SayAnswer> {
  const { tools } = w.ctx
  const path = await thingPath(w.ctx, input)
  if (path === null) return refused(`${input} 不在资料库中。`)
  const known = await declaredAt(w.ctx, path)
  if (known) return text ? describe(w, adopt(w, known), text) : heard(`${known.path} 已启用版本管理，当前共 ${known.versions.length} 个版本。`)
  const candidates = tools.regionOf(path) === 'content' ? [path, tools.archivedPath(path)] : [path]
  const at = (await tools.what(candidates)).find((t) => t.kind === 'file' || t.kind === 'bundle')?.path
  if (at === undefined) return refused(`条目不存在：${input}。请先用 put 添加，再启用版本管理。`)
  const thing = w.things.get(apply(w, { kind: 'declare', thing: newThingId(), path: at }).thing) as Thing
  const r = await record(w, thing, 'declare')
  if (r === null) return refused(`${at} 已缺失，未启用版本管理。`)
  if (r === 'moved') return busy(at)
  if (text) apply(w, { kind: 'note', thing: thing.id, version: r.version.id, text })
  await commit(w)
  return heard(`已为 ${at} 启用版本管理，当前内容记录为版本 1。之后每次用 put 添加不同的内容即新增一个版本；inspect ${at} 查看所有版本。`)
}

async function hear(w: Writing, req: SayRequest): Promise<SayAnswer> {
  if (req.kind === 'versioned') {
    const input = req.about ?? req.text
    if (input === null) return refused('缺少条目：say versioned <库内路径> ["<说明>"]')
    return declare(w, input, req.about === null ? null : req.text)
  }
  if (req.about === null || !req.text) return refused('缺少条目或说明：say version <库内路径> "<说明>"')
  const path = await thingPath(w.ctx, req.about)
  const named = path === null ? undefined : await declaredAt(w.ctx, path)
  if (!named) return refused(`${req.about} 未启用版本管理，请先执行 say versioned ${req.about}。`)
  return describe(w, adopt(w, named), req.text)
}

/** Follows a declared thing to its new path. */
async function follow(ctx: PluginContext, from: LibraryPath, to: LibraryPath, what: string) {
  const w = await writing(ctx)
  const thing = await declaredExactly(w, from)
  if (!thing) return null
  apply(w, { kind: 'move', thing: thing.id, from, to })
  await commit(w)
  return { text: `${thing.versions.length} 个版本已随条目${what}到 ${to}`, data: { thing: thing.id } }
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
  if (r.added) return { text: `已记录为 ${thing.path} 的版本 ${r.version.n}${note ? `：「${note}」` : ''}`, data }
  return note === null ? null : { text: `已为 ${thing.path} 的版本 ${r.version.n} 添加说明：${note}`, data }
}

/** What `check --deep` reads: each declared thing in the library, not archived, at or under `dir` (all of them when null), from the rows a page at a time. */
async function inScope(ctx: PluginContext, dir: LibraryPath | null): Promise<Thing[]> {
  const out: Thing[] = []
  const under = (path: string) => dir === null || path === dir || path.startsWith(`${dir}/`)
  for await (const page of thingPages(ctx.tools.storage.records)) out.push(...page.filter((t) => !t.gone && ctx.tools.regionOf(t.path) === 'content' && under(t.path)))
  return out
}

const DEEP_PAGE = 100

/**
 * The named whole pass of `check --deep`: each declared thing in scope not `looked` at already, read by
 * content with `check`, a page at a time, each page kept; how many first, then how far, on the
 * operation's pass. Stops after the page under way when asked.
 */
async function deepRead(ctx: PluginContext, w: Writing, dir: LibraryPath | null, looked: ReadonlySet<string>, check: (thing: Thing) => Promise<void>): Promise<{ scope: number; done: number; stopped: boolean }> {
  const scope = (await inScope(ctx, dir)).filter((t) => !looked.has(t.id)).map((t) => adopt(w, t))
  const where = dir === null ? '整个资料库中' : ` ${dir} 下`
  ctx.pass?.report({ done: 0, total: scope.length, text: `将读取${where}受版本管理的条目：${scope.length} 个。` })
  let done = 0
  for (let i = 0; i < scope.length; i += DEEP_PAGE) {
    if (ctx.pass?.stopped()) return { scope: scope.length, done, stopped: true }
    const page = scope.slice(i, i + DEEP_PAGE)
    await eachAtMost(page, check)
    await commit(w)
    done += page.length
    ctx.pass?.report({ done, total: scope.length, text: `受版本管理的条目已检索 ${done} / ${scope.length} 个` })
  }
  return { scope: scope.length, done, stopped: false }
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Event): LibraryPath[] {
  if (event.face !== 'owner' || event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/** 版本管理: things declared versioned keep every version's content. */
export const version: Plugin = {
  contract: CONTRACT,
  name: pluginName('version'),
  version: PNEUMA_BASE_VERSION,
  title: '版本管理',
  summary: '保留条目的每个版本',
  about: '启用版本管理的条目保留每个版本的内容，可列出、导出和恢复。',
  cognition: { title: '版本管理', text: readFileSync(new URL('../cognition/version-section.md', import.meta.url), 'utf8') },
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
    if (req.kind === 'move') return follow(ctx, req.from, req.path, '移动')
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
    if (!thing) return { outcome: 'declined', reason: `${req.path} 未启用版本管理。如需修改并保留旧版本，请先执行 say versioned ${req.path}，再添加。` }
    const r = await record(w, thing, 'outside', { token: req.token, fingerprint: req.current })
    if (r === null || r === 'moved') return { outcome: 'declined', reason: `${req.path} 正在被修改，无法保留当前内容` }
    await commit(w)
    return { outcome: 'held', note: r.added ? `当前内容为外部修改，已先记录为版本 ${r.version.n}` : null }
  },

  async onArchive(req, ctx) {
    return req.moved ? follow(ctx, req.from, req.to, req.kind === 'archive' ? '归档' : '取消归档') : null
  },

  /**
   * Changed outside the tool: recorded as a version and reported once. Gone from its path: reported
   * every time. Storage compares every thing's token with the one on record; only what differs is read.
   * `--deep` is a named whole pass over the rest of its scope: it says how many first, reads them by
   * content a page at a time, keeping each page, and stops after the page under way when asked.
   */
  async onCheck(req, ctx) {
    const w = await writing(ctx)
    const diffs = await differing(ctx)
    const at = await thingsAt(ctx.tools.storage.records, [...diffs.keys()])
    const looked = at.map((t) => adopt(w, t)).filter((t) => req.includeArchived || ctx.tools.regionOf(t.path) !== 'archive')
    const recorded: { path: LibraryPath; version: number }[] = []
    const missing: LibraryPath[] = []
    const check = (how: 'token' | 'content') => async (thing: Thing) => {
      const r = diffs.get(thing.path) === 'gone' ? null : await record(w, thing, 'outside', null, how)
      if (r === null) missing.push(thing.path)
      else if (r !== 'moved' && r.added) recorded.push({ path: thing.path, version: r.version.n })
    }
    await eachAtMost(looked, check('token'))
    await commit(w)
    const deep = req.deep ? await deepRead(ctx, w, req.deep.dir, new Set(looked.map((t) => t.id)), check('content')) : null
    if (recorded.length === 0 && missing.length === 0 && !deep?.stopped) return []
    // Each list names its first TEXT_ROWS, then how many and the page that lists every versioned thing.
    const rest = (n: number, shown: number) => (n > shown ? [`  ……共 ${n} 个，查看全部：show ${THINGS_VIEW.id}`] : [])
    const lines = [
      ...(deep?.stopped ? [`已停止：受版本管理的条目已检索 ${deep.done} / ${deep.scope} 个。`] : []),
      ...recorded.slice(0, TEXT_ROWS).map((r) => `${r.path} 已被外部修改，已记录为版本 ${r.version}`),
      ...rest(recorded.length, TEXT_ROWS),
      ...missing.slice(0, TEXT_ROWS).map((path) => `${path} 已缺失；所有版本仍保留，可用 version restore ${path} --version <n> 恢复`),
      ...rest(missing.length, TEXT_ROWS),
    ]
    const more = recorded.length > TEXT_ROWS || missing.length > TEXT_ROWS ? { more: `show ${THINGS_VIEW.id}` } : {}
    const data = { recorded: recorded.slice(0, TEXT_ROWS), missing: missing.slice(0, TEXT_ROWS), count: { recorded: recorded.length, missing: missing.length }, ...more, ...(deep ? { deep } : {}) }
    return [{ title: '受版本管理的条目', body: lines.join('\n'), data }]
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

  /** Every thing in the library, from the rows, a page of them at a time; storage compares their tokens, and only what differs on the page is read. */
  async onView(req, ctx) {
    await load(ctx)
    const diffs = await differing(ctx)
    const showArchived = req.params.archived === 'show'
    const listed: Thing[] = []
    for await (const page of thingPages(ctx.tools.storage.records)) {
      for (const thing of page) if (!thing.gone && (showArchived || ctx.tools.regionOf(thing.path) !== 'archive')) listed.push(thing)
    }
    const size = rowsOf(req)
    const { rows: shown, next } = pageOfList(listed, req.params, size)
    const rows = shown.map((thing): { thing: Thing; state: DiskState } => ({ thing, state: 'current' }))
    await eachAtMost(rows, async (row) => {
      const look = diffs.get(row.thing.path)
      if (look !== undefined) row.state = await diskState(ctx, row.thing, look)
    })
    return thingsPage(rows, pagingOf({ view: THINGS_VIEW.id, params: req.params, rows: size, shown: rows.length, next, total: listed.length }))
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
