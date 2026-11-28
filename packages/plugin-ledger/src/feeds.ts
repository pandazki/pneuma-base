// The ledger's pages that tell what happened, each a feed of facts read from the log a page at a
// time: the home page's part (since the owner last looked, and what needs looking at), the activity
// page, the scenes and one scene.
import { FIRST_WORDS, pageAt, pagingOf, PAGE_ROWS, shortDir, type Action, type Block, type Cell, type FeedGroup, type FeedRow, type Grant, type Instant, type LibraryPath, type Reopen, type Stat, type ViewAnswer } from '@pneuma-base/kernel'
import { reopenFor, type Conversation } from './conversation.js'
import { isAct, type Fact, type FactActor, type SceneId } from './facts.js'
import { archived, type SceneRow } from './model.js'
import { counters, lookupOf } from './queries.js'
import type { Records } from './rows.js'
import { ACTIVITY_VIEW, actorMark, grantCell, itemLink, ME, SCENE_VIEW, SCENES_VIEW, sceneCell, sceneDoing, sceneLink, standingCounts, STANDING_VIEW, WHO_OPTIONS } from './ui.js'
import { actorNames, factLine, shortScene, when, whereConversation, type Lookup, type StandingList } from './views.js'
import { actNow, commandNow, objectNow, saidKind } from './words.js'

type Read = Pick<Records, 'get' | 'under' | 'where' | 'count'>


/** A day as a feed's heading, in this machine's time zone, as the view runs: 今天, 昨天, else the date and the weekday. */
export function dayTitle(at: Instant, now: Instant): string {
  const d = new Date(at)
  const today = new Date(now)
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (key(d) === key(today)) return '今天'
  if (key(d) === key(yesterday)) return '昨天'
  const date = `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`
  return d.getFullYear() === today.getFullYear() ? date : `${d.getFullYear()}年${date}`
}

/** Groups in the order their first member comes, each under the heading `titleOf` gives it. */
function grouped<T>(list: readonly T[], titleOf: (t: T) => string): { title: string; members: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const t of list) {
    const title = titleOf(t)
    groups.set(title, [...(groups.get(title) ?? []), t])
  }
  return [...groups].map(([title, members]) => ({ title, members }))
}

// ---- one fact as a row ----

/** Whose act a fact was: one the owner approved at an agent's request, the owner's, one the ledger or the app only saw, or an agent's on its own. */
export const whoseOf = (f: Fact): FeedRow['whose'] =>
  f.kind === 'owner.op' && f.request ? 'approved' : f.actor.kind === 'owner' ? 'owner' : f.how === 'observed' || f.actor.kind === 'plugin' ? 'observed' : 'agent'

/** Where a fact opens: the thing it is about, while it is there; else its scene. */
function factLink(lookup: Lookup, f: Fact): FeedRow['link'] {
  const id = 'item' in f ? f.item : f.kind === 'said' ? f.about : null
  const item = id === null ? undefined : lookup.items.get(id)
  return item && !item.removed ? itemLink(item.path) : sceneLink(f.scene)
}

const archiveAction = (kind: 'archive' | 'unarchive', path: string): Action => ({
  label: kind === 'archive' ? '归档' : '取消归档',
  tone: 'default',
  as: 'icon',
  icon: kind === 'archive' ? 'archive' : 'archive-restore',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind, path } },
})

/**
 * What can still be done about a fact: an archive taken back, a taking back archived again, while the
 * thing is still where that left it; when it was undone since, how. Anything else says nothing.
 */
function endOf(lookup: Lookup, f: Fact): Pick<FeedRow, 'action' | 'settled'> {
  if (f.kind !== 'item.move' || f.archive === null) return {}
  const item = lookup.items.get(f.item)
  if (!item || item.removed) return { settled: '已清除' }
  if (item.path === f.to) return { action: archiveAction(f.archive === 'in' ? 'unarchive' : 'archive', item.path) }
  if (f.archive === 'in' && !archived(item)) return { settled: '已取消归档' }
  if (f.archive === 'out' && archived(item)) return { settled: '已重新归档' }
  return {}
}

/** For a command the owner approved: the agent that asked, with its mark, and the request. */
function askedBy(f: Fact, grants: readonly Grant[]): Cell[] {
  if (f.kind !== 'owner.op' || !f.request) return []
  const mark = actorMark(f.request.by, grants)
  return [{ text: `应 ${f.request.by.name} 的请求 ${f.request.id}`, ...(typeof mark === 'string' ? {} : { actor: mark }) }]
}

const where = (lookup: Lookup, id: Fact & { item: unknown }) => lookup.items.get(id.item as never)?.path ?? null

/**
 * The fact in parts, for a page that says less than its sentence: the kind of act, the path of the
 * thing (where it is now; for an archive or a move, where the act left it or took it from), and the
 * words its actor wrote with it. An owner command is what it did to what, as it declares; one an older
 * ledger recorded without that is the command by its name. A fact a sentence says better, such as a
 * request or a command refused, has no parts.
 */
/** The acts whose object is a plugin, named on a page by its title. */
const PLUGIN_ACTS: ReadonlySet<string> = new Set(['on', 'off', 'synced', 'uninstalled'])

function partsOf(lookup: Lookup, f: Fact): Pick<FeedRow, 'act' | 'path' | 'note'> {
  const note = (text: string | undefined) => (text ? { note: text } : {})
  const at = (path: string | null) => (path === null ? {} : { path: path as LibraryPath })
  switch (f.kind) {
    case 'said':
      return { act: saidKind(f.flavor), ...at(f.about === null ? null : (lookup.items.get(f.about)?.path ?? null)), note: f.text }
    case 'item.enter':
      return { act: f.origin.kind === 'made' ? 'generated' : 'imported', ...at(where(lookup, f) ?? f.path), ...note(f.note) }
    case 'item.revise':
      return { act: 'changed', ...at(where(lookup, f)), ...note(f.note) }
    case 'item.move':
      return { act: f.archive === 'in' ? 'archived' : f.archive === 'out' ? 'restored' : 'moved', ...at(f.archive === 'in' ? f.from : f.to) }
    case 'item.basis':
      return { act: 'basis', ...at(where(lookup, f)) }
    case 'item.remove':
      return { act: 'removed', ...at(where(lookup, f)) }
    case 'owner.op':
      if (f.refused !== undefined) return {}
      return f.act === undefined ? { act: 'command', ...at(commandNow(f.command)) } : { act: actNow(f.act), ...at(f.object === undefined ? null : ((PLUGIN_ACTS.has(actNow(f.act)) ? lookup.titles?.get(f.object) : undefined) ?? objectNow(f.object))) }
    default:
      return {}
  }
}

/**
 * One fact as a feed row: when, who, the sentence check says (for an owner command, the command as
 * given) and the same in parts, who asked for it, in which scene and by which grant, and what can
 * still be done. `withScene`: the row names its scene.
 */
function factRow(lookup: Lookup, f: Fact, grants: readonly Grant[], withScene: boolean): FeedRow {
  const grant = grantCell(f.actor, grants)
  const meta: Cell[] = [...askedBy(f, grants), ...(withScene ? [sceneCell(lookup, f.scene)] : []), ...(grant ? [grant] : [])]
  return { key: f.id, at: f.at, actor: actorMark(f.actor, grants), text: factLine(lookup, f), meta, whose: whoseOf(f), link: factLink(lookup, f), ...partsOf(lookup, f), ...endOf(lookup, f) }
}

/**
 * Acts by scene, as home and each day of the activity page show them: a scene's several acts under its
 * sentence, which opens it; a scene of one act is that one row, its sentence the row's second line
 * when the act has no note of its own, else in its tooltip.
 */
function sceneGroups(lookup: Lookup, acts: readonly Fact[], grants: readonly Grant[]): FeedGroup[] {
  const groups: FeedGroup[] = []
  for (const { members } of grouped(acts, (f) => f.scene)) {
    const scene = (members[0] as Fact).scene
    if (members.length === 1) {
      const last = groups.at(-1)
      const row = factRow(lookup, members[0] as Fact, grants, true)
      if (last !== undefined && last.title === '') last.rows.push(row)
      else groups.push({ title: '', count: null, rows: [row] })
      continue
    }
    const again = lookup.scenes.get(scene)
    const reopen = again === undefined ? null : reopenFor(again)
    groups.push({ title: sceneTitle(lookup, scene), count: members.length, link: sceneLink(scene), rows: members.map((f) => factRow(lookup, f, grants, false)), ...(reopen === null ? {} : { reopen }) })
  }
  return groups
}

// ---- home ----

/** What the scene was doing, or its short id: a group's heading. */
const sceneTitle = (lookup: Lookup, id: SceneId) => {
  const scene = lookup.scenes.get(id)
  return (scene ? sceneDoing(scene) : null) ?? `场景 ${shortScene(id)}`
}

/** Checking, as the owner does it from the home page: since this look, nothing is news. */
const SEEN_ALL: Action = { label: '全部标为已读', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'check', request: { since: 'last', includeArchived: false } } }

/**
 * The ledger's part of the home page: what others did since `me` last looked, by scene, with 全部标为已读,
 * which is `me` checking; then what needs looking at, one line for each kind with how many, opening
 * the standing page on that kind. A scene of several acts is headed by what it said it was doing; a
 * scene of one act is that one row, naming its scene, and scenes of one act next to each other share
 * one list without a heading.
 */
export async function homeAnswer(records: Read, lists: readonly StandingList[], news: { since: Instant | null; facts: readonly Fact[] }, agents: readonly FactActor[], grants: readonly Grant[], titles: ReadonlyMap<string, string>): Promise<ViewAnswer> {
  const { since } = news
  const facts = news.facts.filter(isAct)
  const lookup = await lookupOf(records, facts, { titles })
  const groups = sceneGroups(lookup, facts, grants)
  const done = groups.reduce((n, g) => n + g.rows.length, 0)
  // Nothing new since the last look: when that was, and the way to everything that ever happened.
  const looked = done === 0 && since !== null
  const sinceSection: Block = {
    kind: 'section',
    title: '最近动态',
    note: looked ? `上次查看：${when(since)}` : null,
    count: done > 0 ? done : null,
    blocks: [
      { kind: 'feed', groups, empty: '暂无新动态' },
      ...(looked ? [{ kind: 'list' as const, items: [{ cell: { text: '查看全部活动', link: { view: ACTIVITY_VIEW, params: {}, target: 'main' as const } }, note: '所有 Agent 与我的操作，按日期排列', actions: [] }] }] : []),
    ],
    actions: done > 0 ? [SEEN_ALL] : [],
  }
  // Things nobody registered are a question on the home page, the ledger's ask, not something to look at.
  const kinds = standingCounts(lists).filter((k) => k.kind !== 'unowned' && k.kind !== 'closed')
  const attention: Block = {
    kind: 'section',
    title: '需要关注',
    note: null,
    count: null,
    blocks:
      kinds.length === 0
        ? [{ kind: 'text', tone: 'neutral', text: '已登记条目均与记录一致。' }]
        : [{ kind: 'list', items: kinds.map((k) => ({ cell: { text: `${k.title}：${k.atLeast ? '至少 ' : ''}${k.count} 个`, icon: 'triangle-alert' as const, link: { view: STANDING_VIEW, params: { kind: k.kind }, target: 'main' } }, note: k.note, actions: [] })) }],
    actions: [],
    ...(kinds.length === 0 ? { normal: true as const } : {}),
  }
  return { title: '最近动态', subtitle: since === null ? null : `上次查看：${when(since)}`, blocks: [sayStep(agents), sinceSection, attention] }
}

/**
 * The step of getting started only the ledger can tell: whether an agent has worked here yet. It
 * joins the kernel's steps in the home page's 「快速开始」, which is gone once all are done.
 */
function sayStep(agents: readonly FactActor[]): Block {
  const blocks: Block[] = [{ kind: 'list', items: [{ cell: { text: FIRST_WORDS, copy: true }, note: '在已连接的 Agent 中发送此指令。Agent 先查看资料库中的条目，再继续执行任务。', actions: [] }] }]
  const done = agents.length > 0
  return { kind: 'steps', steps: [{ key: 'say', title: '向 Agent 发出第一条指令', done, summary: done ? `${actorNames(agents, ME)} 已在此资料库中执行操作` : null, blocks }] }
}

// ---- activity ----

/**
 * The latest acts, newest first, owner operations included, by day and in each day by scene, as home
 * shows them, a page at a time: `who` keeps the agents' or the owner's, `agent` one agent's. A scene
 * saying what it is doing is no act: it heads its acts or is their second line. Each filter's options
 * carry how many acts each would show, from the counts the rows keep, so they count the rows.
 */
export async function activityAnswer(records: Read, params: Record<string, string>, grants: readonly Grant[], titles: ReadonlyMap<string, string>, now: Instant, size = PAGE_ROWS): Promise<ViewAnswer> {
  const who = params.who ?? ''
  const agent = params.agent ?? ''
  const { after } = pageAt(params)
  const counts = await counters(records)
  const total = counts.acts ?? 0
  const agents = Object.keys(counts)
    .filter((k) => k.startsWith('acts:agent:') && (counts[k] ?? 0) > 0)
    .map((k) => k.slice('acts:agent:'.length))
    .sort()
  const n = (w: string, a: string) => (a !== '' ? (w === 'owner' ? 0 : (counts[`acts:agent:${a}`] ?? 0)) : w !== '' ? (counts[`acts:who:${w}`] ?? 0) : total)
  const filters = [
    { name: 'who', options: WHO_OPTIONS.map((o) => ({ ...o, count: n(o.value, agent) })) },
    { name: 'agent', options: [{ value: '', label: '全部 Agent' }, ...agents.map((a) => ({ value: a, label: a }))].map((o) => ({ ...o, count: n(who, o.value) })) },
  ]
  if (total === 0) {
    return { title: '活动', subtitle: null, blocks: [{ kind: 'empty', title: '暂无记录', hint: 'Agent 添加和修改条目、我在此执行的操作，均逐条记录在此。' }] }
  }
  const opts = { limit: size, ...(after === undefined ? {} : { after }) }
  const page = agent !== '' ? (who === 'owner' ? { rows: [], more: null } : await records.where<Fact>('acts', 'agent', agent, opts)) : who !== '' ? await records.where<Fact>('acts', 'who', who, opts) : await records.under<Fact>('acts', '', opts)
  const facts = page.rows.map((r) => r.value)
  const lookup = await lookupOf(records, facts, { titles })
  const groups = grouped(facts, (f) => dayTitle(f.at, now)).map(({ title, members }) => ({ title, count: members.length, rows: [], groups: sceneGroups(lookup, members, grants) }))
  const shown = n(who, agent)
  const paging = pagingOf({ view: ACTIVITY_VIEW, params, rows: size, shown: facts.length, next: page.more?.after ?? null, total: shown })
  // How many: the tabs say it.
  return { title: '活动', subtitle: null, blocks: [exportBlock(now), { kind: 'feed', groups, empty: '无符合条件的记录', page: paging }], filters }
}

/**
 * 导出, folded: the command that writes every record to a file outside the library, to copy into a
 * terminal. The page has no way to hand the person a file, so it gives the command that does.
 */
function exportBlock(now: Instant): Block {
  const d = new Date(now)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const command = `pneuma-base ledger export --to ~/Desktop/pneuma-base-活动-${day}.csv`
  const note = '在终端中运行，将全部记录导出为 CSV，可用表格软件打开；加 --format jsonl 导出为 JSON Lines（每行一条），加 --since、--until 仅导出指定时间段（日期如 2026-11-01，或具体时刻）。'
  return { kind: 'section', title: '导出', note: null, count: null, collapse: 'closed', blocks: [{ kind: 'list', items: [{ cell: { text: command, mono: true, copy: true }, note, actions: [] }] }], actions: [] }
}

// ---- scenes ----

/** Every session, newest first, by the day it began, a page at a time: who, what it said it was doing, how many things it put, where. */
export async function scenesAnswer(records: Read, params: Record<string, string>, grants: readonly Grant[], now: Instant, size = PAGE_ROWS): Promise<ViewAnswer> {
  const { after } = pageAt(params)
  const page = await records.under<{ id: SceneId }>('sceneOrder', '', { limit: size, ...(after === undefined ? {} : { after }) })
  const lookup = await lookupOf(records, [], { scenes: page.rows.map((r) => r.value.id) })
  const scenes = page.rows.flatMap((r) => lookup.scenes.get(r.value.id) ?? [])
  if (scenes.length === 0 && after === undefined) {
    const hint = 'Agent 执行 pneuma-base start "<任务描述>" 开始任务时，此处新增一行：会话、执行者、任务、新增条目数。'
    return { title: '场景', subtitle: null, blocks: [{ kind: 'empty', title: '暂无场景', hint }] }
  }
  const row = (scene: SceneRow): FeedRow => {
    const lead = scene.actors.find((a) => a.kind === 'agent') ?? scene.actors[0] ?? { kind: 'owner', name: 'owner', grant: null }
    const others = actorNames(scene.actors.filter((a) => a !== lead && a.name !== lead.name), ME)
    const touched = scene.touched - scene.puts
    const meta: Cell[] = [
      { text: scene.puts > 0 ? `添加 ${scene.puts} 个条目` : touched > 0 ? `修改 ${touched} 个条目` : '无新增条目', muted: true },
      ...(others ? [{ text: `另有 ${others}`, muted: true }] : []),
    ]
    return { key: scene.id, at: scene.first, actor: actorMark(lead, grants), text: sceneDoing(scene) ?? `场景 ${shortScene(scene.id)}`, meta, link: sceneLink(scene.id) }
  }
  const groups = grouped(scenes, (s) => dayTitle(s.first, now)).map(({ title, members }) => ({ title, count: members.length, rows: members.map(row) }))
  const total = (await counters(records)).scenes ?? scenes.length
  const paging = pagingOf({ view: SCENES_VIEW, params, rows: size, shown: scenes.length, next: page.more?.after ?? null, total })
  // The newest scene opens in the panel when the window has room for both, as a click on its row would open it.
  const open = after === undefined && scenes[0] ? { open: sceneLink(scenes[0].id) } : {}
  return { title: '场景', subtitle: null, blocks: [{ kind: 'feed', groups, empty: '', page: paging }], ...open }
}

/** A length of time in words: 不足 1 分钟, 12 分钟, 2 小时 5 分, 3 天. */
export function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '不足 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天`
}

const CONVERSATION_TONE = { here: 'neutral', gone: 'warn', elsewhere: 'neutral' } as const

/** The conversation's file, to copy, with whether it is here; the command that resumes it, only when it is. */
function conversationFields(c: Conversation | null, reopen: Reopen | null): { label: string; value: Cell }[] {
  if (c === null) return []
  const file = { label: '对话', value: { text: c.path, mono: true, copy: true as const, tag: { text: whereConversation(c), tone: CONVERSATION_TONE[c.status] }, ...(reopen === null ? {} : { reopen }) } }
  return c.status === 'here' && c.resume ? [file, { label: '继续对话', value: { text: c.resume, mono: true, copy: true } }] : [file]
}

/**
 * One scene: its figures that are not nothing (how long, how many things put, how many sources they
 * rest on, how many decisions), as figures when there are a few, else one line; its conversation; what
 * happened in it, newest first, a page at a time; then, folded, where it worked and its id.
 */
export async function sceneAnswer(records: Read, scene: SceneRow, conversation: Conversation | null, grants: readonly Grant[], titles: ReadonlyMap<string, string>, params: Record<string, string> = {}, size = PAGE_ROWS): Promise<ViewAnswer> {
  const { after } = pageAt(params)
  const long = Date.parse(scene.last) - Date.parse(scene.first)
  const stats: Stat[] = [
    ...(long >= 60_000 ? [{ label: '时长', value: durationText(long), note: `${when(scene.first)} 开始` }] : []),
    ...(scene.puts > 0 ? [{ label: '添加', value: String(scene.puts), note: scene.brought === 0 ? '全部为生成' : scene.brought === scene.puts ? '全部为导入' : `导入 ${scene.brought} 个，生成 ${scene.puts - scene.brought} 个` }] : []),
    ...(scene.sources.length + scene.outside.length > 0 ? [{ label: '依据', value: String(scene.sources.length + scene.outside.length), note: scene.outside.length === 0 ? null : `外部 ${scene.outside.length} 条` }] : []),
    ...(scene.decided > 0 ? [{ label: '决策', value: String(scene.decided), note: scene.lastDecided }] : []),
  ]
  // A figure or two read better as words in a line than as cards.
  const figures: Block[] =
    stats.length >= 3 ? [{ kind: 'stats', stats }] : stats.length > 0 ? [{ kind: 'fields', line: true, fields: stats.map((s) => ({ label: s.label, value: { text: `${s.label} ${s.value}${s.note === null ? '' : `（${s.note}）`}`, muted: true } })) }] : []
  const page = await records.where<Fact>('acts', 'scene', scene.id, { limit: size, ...(after === undefined ? {} : { after }) })
  const facts = page.rows.map((r) => r.value)
  const lookup = await lookupOf(records, facts, { scenes: [scene.id], titles })
  const count = page.more === null && after === undefined ? facts.length : await records.count('acts', 'scene', scene.id)
  const paging = pagingOf({ view: SCENE_VIEW, params: { ...params, scene: scene.id }, rows: size, shown: facts.length, next: page.more?.after ?? null, total: count, target: 'panel' })
  // The page is the scene: its rows need no heading of their own.
  const feed: Block = { kind: 'feed', groups: [{ title: '', count: null, rows: facts.map((f) => factRow(lookup, f, grants, false)) }], empty: '本次会话暂无活动', page: paging }
  const talk = conversationFields(conversation, reopenFor(scene))
  const record: Block = {
    kind: 'section',
    title: '记录',
    note: null,
    count: null,
    collapse: 'closed',
    actions: [],
    blocks: [
      {
        kind: 'fields',
        fields: [
          { label: '执行者', value: { text: actorNames(scene.actors, ME) } },
          ...(scene.cwds.length > 0 ? [{ label: '位置', value: { text: scene.cwds.map((d) => shortDir(d, 36)).join('、'), mono: true, muted: true } }] : []),
          { label: '场景编号', value: { text: scene.id, mono: true, muted: true } },
        ],
      },
    ],
  }
  return { title: sceneDoing(scene) ?? `场景 ${shortScene(scene.id)}`, subtitle: `${actorNames(scene.actors, ME)} · ${when(scene.first)}`, blocks: [...figures, ...(talk.length > 0 ? [{ kind: 'fields' as const, fields: talk }] : []), feed, record] }
}

/** The answer when no single scene has the id or prefix asked for. */
export function noSuchScene(input: string, named: number, more: boolean): ViewAnswer {
  const title = named === 0 ? '场景不存在' : `${more ? '至少有' : '有'} ${named} 个场景的编号以 ${input} 开头`
  return { title: '场景', subtitle: input || null, blocks: [{ kind: 'empty', title, hint: null }] }
}
