// The ledger's pages that tell what happened, each a feed of facts: the home page's part (since the
// owner last looked, and what needs looking at), the activity page, the scenes and one scene. Pure.
import { shortDir, type Action, type Block, type Cell, type FeedGroup, type FeedRow, type Grant, type Instant, type Stat, type ViewAnswer } from '@pneuma-base/kernel'
import type { Conversation } from './conversation.js'
import type { Fact, FactActor, SceneId } from './facts.js'
import { isArchived, type Ledger, type SceneRecord } from './fold.js'
import type { Standing } from './reconcile.js'
import { actorMark, grantCell, itemLink, sceneCell, sceneDoing, sceneLink, standingCounts, STANDING_VIEW, WHO_OPTIONS } from './ui.js'
import { actorNames, factLine, shortScene, sinceFacts, when, whereConversation } from './views.js'

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
const whoseOf = (f: Fact): FeedRow['whose'] =>
  f.kind === 'owner.op' && f.request ? 'approved' : f.actor.kind === 'owner' ? 'owner' : f.how === 'observed' || f.actor.kind === 'plugin' ? 'observed' : 'agent'

/** Where a fact opens: the thing it is about, while it is there; else its scene. */
function factLink(ledger: Ledger, f: Fact): FeedRow['link'] {
  const id = 'item' in f ? f.item : f.kind === 'said' ? f.about : null
  const item = id === null ? undefined : ledger.items.get(id)
  return item && !item.removed ? itemLink(item.path) : sceneLink(f.scene)
}

const archiveAction = (kind: 'archive' | 'unarchive', path: string): Action => ({
  label: kind === 'archive' ? '归档' : '取回',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind, path } },
})

/**
 * What can still be done about a fact: an archive taken back, a taking back archived again, while the
 * thing is still where that left it; when it was undone since, how. Anything else says nothing.
 */
function endOf(ledger: Ledger, f: Fact): Pick<FeedRow, 'action' | 'settled'> {
  if (f.kind !== 'item.move' || f.archive === null) return {}
  const item = ledger.items.get(f.item)
  if (!item || item.removed) return { settled: '已清掉' }
  if (item.path === f.to) return { action: archiveAction(f.archive === 'in' ? 'unarchive' : 'archive', item.path) }
  if (f.archive === 'in' && !isArchived(item)) return { settled: '已取回' }
  if (f.archive === 'out' && isArchived(item)) return { settled: '又归档了' }
  return {}
}

/** For a command the owner approved: the agent that asked, with its mark, and the request. */
function askedBy(f: Fact, grants: readonly Grant[]): Cell[] {
  if (f.kind !== 'owner.op' || !f.request) return []
  const mark = actorMark(f.request.by, grants)
  return [{ text: `应 ${f.request.by.name} 的请求 ${f.request.id}`, ...(typeof mark === 'string' ? {} : { actor: mark }) }]
}

/** One fact as a feed row: when, who, the sentence check says, who asked for it, in which scene and by which grant, and what can still be done. */
function factRow(ledger: Ledger, f: Fact, grants: readonly Grant[], withScene: boolean): FeedRow {
  const grant = grantCell(f.actor, grants)
  const meta: Cell[] = [...askedBy(f, grants), ...(withScene ? [sceneCell(ledger, f.scene)] : []), ...(grant ? [grant] : [])]
  return { key: f.id, at: f.at, actor: actorMark(f.actor, grants), text: factLine(ledger, f), meta, whose: whoseOf(f), link: factLink(ledger, f), ...endOf(ledger, f) }
}

/** The facts a feed tells: every one but the looks, which are no news. */
const told = (facts: readonly Fact[]) => facts.filter((f) => f.kind !== 'checked')

// ---- home ----

/** What the scene was doing, or its short id: a group's heading. */
const sceneTitle = (ledger: Ledger, id: SceneId) => {
  const scene = ledger.scenes.get(id)
  return (scene ? sceneDoing(ledger, scene) : null) ?? `场景 ${shortScene(id)}`
}

/** Checking, as the owner does it from the home page: since this look, nothing is news. */
const SEEN_ALL: Action = { label: '都看过了', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'check', request: { since: 'last', includeArchived: false } } }

/**
 * The ledger's part of the home page: what others did since `me` last looked, by scene, each headed
 * by what it said it was doing, with 都看过了, which is `me` checking; then what needs looking at,
 * one line for each kind with how many, opening the standing page on that kind.
 */
export function homeAnswer(ledger: Ledger, standing: Standing, me: FactActor, current: SceneId, grants: readonly Grant[]): ViewAnswer {
  const { since, facts } = sinceFacts(ledger, me, current, 'last')
  const groups: FeedGroup[] = grouped(facts, (f) => f.scene).map(({ members }) => {
    const scene = (members[0] as Fact).scene
    const title = sceneTitle(ledger, scene)
    // The sentence that heads the group is not a row of it as well.
    const rows = members.filter((f) => !(f.kind === 'said' && f.flavor === 'doing' && f.text === title)).map((f) => factRow(ledger, f, grants, false))
    return { title, count: rows.length, link: sceneLink(scene), rows }
  })
  const done = groups.reduce((n, g) => n + g.rows.length, 0)
  const actors = actorNames(facts.map((f) => f.actor))
  const sinceNote = facts.length === 0 ? null : `${since === null ? '你还没看过，这是最近的：' : ''}${actors} 做了 ${done} 件事`
  const sinceSection: Block = {
    kind: 'section',
    title: '自上次以来',
    note: sinceNote,
    count: null,
    blocks: [{ kind: 'feed', groups: groups.filter((g) => g.rows.length > 0), empty: since === null ? '还没有谁做过什么。' : '你上次看过之后，agent 没有做过什么。' }],
    actions: facts.length > 0 ? [SEEN_ALL] : [],
  }
  const kinds = standingCounts(ledger, standing)
  const attention: Block = {
    kind: 'section',
    title: '需要留意',
    note: null,
    count: null,
    blocks:
      kinds.length === 0
        ? [{ kind: 'text', tone: 'neutral', text: '没有要留意的：每样东西都和记录的一样。' }]
        : [{ kind: 'list', items: kinds.map((k) => ({ cell: { text: `${k.count} 样${k.title}`, link: { view: STANDING_VIEW, params: { kind: k.kind }, target: 'main' } }, note: k.note, actions: [] })) }],
    actions: [],
  }
  return { title: '自上次以来', subtitle: since === null ? null : `你上次看是 ${when(since)}`, blocks: [sinceSection, attention] }
}

// ---- activity ----

export const ACTIVITY_LIMIT = 200

/**
 * The latest facts, newest first, owner operations included, by day: `who` keeps the agents' or the
 * owner's, `agent` one agent's. Each filter's options carry how many facts each would show.
 */
export function activityAnswer(ledger: Ledger, params: Record<string, string>, grants: readonly Grant[], now: Instant): ViewAnswer {
  const who = params.who ?? ''
  const agent = params.agent ?? ''
  const all = told(ledger.facts).reverse()
  const byWho = (f: Fact, w: string) => w === '' || f.actor.kind === w
  const byAgent = (f: Fact, a: string) => a === '' || (f.actor.kind === 'agent' && f.actor.name === a)
  const agents = [...new Set(all.flatMap((f) => (f.actor.kind === 'agent' ? [f.actor.name] : [])))].sort()
  const filters = [
    { name: 'who', options: WHO_OPTIONS.map((o) => ({ ...o, count: all.filter((f) => byWho(f, o.value) && byAgent(f, agent)).length })) },
    { name: 'agent', options: [{ value: '', label: '全部 agent' }, ...agents.map((a) => ({ value: a, label: a }))].map((o) => ({ ...o, count: all.filter((f) => byWho(f, who) && byAgent(f, o.value)).length })) },
  ]
  if (all.length === 0) {
    return { title: '活动', subtitle: null, blocks: [{ kind: 'empty', title: '还没有任何记录', hint: 'agent 放东西、说在做什么，主人在这里做操作，都会一条条出现在这里。' }] }
  }
  const facts = all.filter((f) => byWho(f, who) && byAgent(f, agent))
  const groups = grouped(facts.slice(0, ACTIVITY_LIMIT), (f) => dayTitle(f.at, now)).map(({ title, members }) => ({ title, count: members.length, rows: members.map((f) => factRow(ledger, f, grants, true)) }))
  const subtitle = facts.length > ACTIVITY_LIMIT ? `最近 ${ACTIVITY_LIMIT} 条，共 ${facts.length} 条` : `${facts.length} 条`
  return { title: '活动', subtitle, blocks: [{ kind: 'feed', groups, empty: '没有符合条件的记录。' }], filters }
}

// ---- scenes ----

const newestFirst = (a: SceneRecord, b: SceneRecord) => (a.first === b.first ? (a.id < b.id ? -1 : 1) : a.first > b.first ? -1 : 1)

/** How many things a scene put into the library: those entered in it. */
const putIn = (ledger: Ledger, scene: SceneRecord) => scene.items.filter((id) => ledger.items.get(id)?.entered.scene === scene.id).length

/** Every session, newest first, by the day it began: who, what it said it was doing, how many things it put, where. */
export function scenesAnswer(ledger: Ledger, grants: readonly Grant[], now: Instant): ViewAnswer {
  const scenes = [...ledger.scenes.values()].sort(newestFirst)
  if (scenes.length === 0) {
    const hint = 'agent 用 pneuma-base start "<在做什么>" 开始一件事时，这里多出一行：哪次会话、谁、在做什么、放了几样东西。'
    return { title: '场景', subtitle: null, blocks: [{ kind: 'empty', title: '还没有场景', hint }] }
  }
  const row = (scene: SceneRecord): FeedRow => {
    const lead = scene.actors.find((a) => a.kind === 'agent') ?? scene.actors[0] ?? { kind: 'owner', name: 'owner', grant: null }
    const others = actorNames(scene.actors.filter((a) => a !== lead && a.name !== lead.name))
    const put = putIn(ledger, scene)
    const touched = scene.items.length - put
    const meta: Cell[] = [
      { text: put > 0 ? `放入 ${put} 样` : touched > 0 ? `动了 ${touched} 样` : '没放东西', muted: true },
      ...(scene.cwds.length > 0 ? [{ text: scene.cwds.map((d) => shortDir(d, 24)).join('、'), mono: true, muted: true }] : []),
      ...(others ? [{ text: `还有 ${others}`, muted: true }] : []),
    ]
    const doing = sceneDoing(ledger, scene)
    return { key: scene.id, at: scene.first, actor: actorMark(lead, grants), text: doing ?? `场景 ${shortScene(scene.id)}`, meta, link: sceneLink(scene.id) }
  }
  const groups = grouped(scenes, (s) => dayTitle(s.first, now)).map(({ title, members }) => ({ title, count: members.length, rows: members.map(row) }))
  return { title: '场景', subtitle: `${scenes.length} 次会话`, blocks: [{ kind: 'feed', groups, empty: '' }] }
}

/** A length of time in words: 不到 1 分钟, 12 分钟, 2 小时 5 分, 3 天. */
export function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天`
}

const CONVERSATION_TONE = { here: 'neutral', gone: 'warn', elsewhere: 'neutral' } as const

/** The conversation's file, to copy, with whether it is here; the command that resumes it, only when it is. */
function conversationFields(c: Conversation | null): { label: string; value: Cell }[] {
  if (c === null) return []
  const file = { label: '对话', value: { text: c.path, mono: true, copy: true as const, tag: { text: whereConversation(c), tone: CONVERSATION_TONE[c.status] } } }
  return c.status === 'here' && c.resume ? [file, { label: '接着聊', value: { text: c.resume, mono: true, copy: true } }] : [file]
}

/**
 * One scene: four figures (how long, how many things put, how many sources they rest on, how many
 * decisions), its conversation and where, then what happened in it, newest first.
 */
export function sceneAnswer(ledger: Ledger, scene: SceneRecord, conversation: Conversation | null, grants: readonly Grant[]): ViewAnswer {
  const items = scene.items.flatMap((id) => ledger.items.get(id) ?? [])
  const put = items.filter((item) => item.entered.scene === scene.id)
  const sources = new Set(put.flatMap((item) => item.basis.items.map((row) => row.item)))
  const outside = new Set(put.flatMap((item) => item.basis.outside))
  const decisions = scene.said.filter((s) => s.flavor === 'decided')
  const brought = put.filter((item) => item.origin.kind === 'brought').length
  const stats: Stat[] = [
    { label: '时长', value: durationText(Date.parse(scene.last) - Date.parse(scene.first)), note: `${when(scene.first)} 开始` },
    { label: '放入', value: String(put.length), note: put.length === 0 ? null : `带进来 ${brought} 样，做出来 ${put.length - brought} 样` },
    { label: '依据', value: String(sources.size + outside.size), note: outside.size === 0 ? null : `库外 ${outside.size} 句` },
    { label: '决定', value: String(decisions.length), note: decisions.at(-1)?.text ?? null },
  ]
  const facts = told(ledger.facts.filter((f) => f.scene === scene.id)).reverse()
  const feed: Block = { kind: 'feed', groups: [{ title: '这次会话里发生的', count: facts.length, rows: facts.map((f) => factRow(ledger, f, grants, false)) }], empty: '这次会话里还没有发生什么。' }
  const fields: Block = {
    kind: 'fields',
    fields: [
      ...conversationFields(conversation),
      { label: '谁', value: { text: actorNames(scene.actors) } },
      ...(scene.cwds.length > 0 ? [{ label: '在哪', value: { text: scene.cwds.map((d) => shortDir(d, 36)).join('、'), mono: true, muted: true } }] : []),
      { label: '场景号', value: { text: scene.id, mono: true, muted: true } },
    ],
  }
  return { title: sceneDoing(ledger, scene) ?? `场景 ${shortScene(scene.id)}`, subtitle: `${actorNames(scene.actors)} · ${when(scene.first)}`, blocks: [{ kind: 'stats', stats }, fields, feed] }
}

/** The answer when no single scene has the id or prefix asked for. */
export function noSuchScene(input: string, named: number): ViewAnswer {
  const title = named === 0 ? '没有这个场景' : `有 ${named} 个场景的编号以 ${input} 开头`
  return { title: '场景', subtitle: input || null, blocks: [{ kind: 'empty', title, hint: null }] }
}

