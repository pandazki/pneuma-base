// 溯源: the ledger plugin, on storage (plugin contract 2). Facts are appended through
// `tools.storage.records`; every answer is read from the rows derived from them, a page at a time; a
// thing is known by its state token, and its content is read only where a fingerprint decides
// something or the owner names a whole pass. ARCHITECTURE.md「溯源与核对」.
import {
  commandLine,
  CONTRACT,
  PNEUMA_BASE_VERSION,
  isFailure,
  pageAt,
  pluginName,
  rowsOf,
  type AcceptedPut,
  type Event,
  type Grant,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type PluginNote,
  type PluginSection,
  type SayAnswer,
  type SayRequest,
  type ThingNow,
} from '@pneuma-base/kernel'
import { LEDGER_EXPORT, LEDGER_STATS } from './audit.js'
import { COGNITION } from './cognition.js'
import { conversationOf } from './conversation.js'
import { fact, factActor, LEDGER_ACTOR, newItemId, sceneOf, writeFacts, type Basis, type Entered, type Fact, type FactActor, type FactBody, type ItemId, type LedgerOrigin } from './facts.js'
import { activityAnswer, homeAnswer, noSuchScene, sceneAnswer, scenesAnswer } from './feeds.js'
import { findHits, foundHits } from './find.js'
import { heldCommands, heldCopies, heldPath, keep, keyOf } from './held.js'
import { deepPass, foldAll, movedThings, rebase, refresh, scopeOf, stateOf, type Deep, type Listed } from './look.js'
import { archived, type ActorRow, type HistoryRow, type ItemRow, type SceneRow } from './model.js'
import { agentsOf, counters, getAll, itemAtPath, itemNamed, itemViewOf, lookupOf, newsSince, scenesNamed, standingList, standingLists, partialDirs } from './queries.js'
import { pagesOf } from './rows.js'
import { DEFAULT_PERIOD, isPeriod, statsFrom } from './stats.js'
import { statsAnswer } from './stats-page.js'
import { ACTIVITY_VIEW, heldAnswer, HELD_VIEW, HOME_VIEW, isStandingKind, itemSection, itemsAnswer, ITEMS_VIEW, LEDGER_VIEWS, partOfSection, SCENE_VIEW, SCENES_VIEW, STANDING_VIEW, standingAnswer, STATS_VIEW, unownedSection, type ItemsPage } from './ui.js'
import { closedLooks, DISMISS, REGISTER, unownedAsks } from './unowned.js'
import { ambiguousText, itemText, originLabel, sceneText, sceneView, sinceText, sinceViewOf, spokenItem, spokenScene, standingSections, when, type ItemView } from './views.js'
import { flavorOf, storedOrigin } from './words.js'

/** A hook's writes: the facts it will append as one write, and the things it adopted on the way. */
type Writing = { ctx: PluginContext; facts: Fact[]; adopted: Map<LibraryPath, ItemId> }

const writing = (ctx: PluginContext): Writing => ({ ctx, facts: [], adopted: new Map() })
const records = (ctx: PluginContext) => ctx.tools.storage.records

/** What storage says of a thing now, as a fact keeps it. */
type Seen = { token: string | null; size: number; modified: string | null; bundle: boolean }
const seenOf = (now: ThingNow): Seen => ({ token: now.token, size: now.size ?? 0, modified: now.modifiedAt, bundle: now.kind === 'bundle' })
const seenFields = (s: Seen) => ({ ...(s.token === null ? {} : { token: s.token }), ...(s.modified === null ? {} : { modified: s.modified }), ...(s.bundle ? { bundle: true as const } : {}) })

/** The item registered at a path, by the rows. */
async function rowAt(ctx: PluginContext, path: LibraryPath): Promise<ItemRow | undefined> {
  const id = (await getAll<{ id: ItemId }>(records(ctx), 'paths', [path])).get(path)?.id
  return id === undefined ? undefined : (await getAll<ItemRow>(records(ctx), 'items', [id])).get(id)
}

/** Enters a thing nobody registered, origin unknown, with what storage says of it. */
function adopt(w: Writing, path: LibraryPath, seen: Seen, fingerprint: ItemRow['fingerprint'] = null): ItemId {
  const item = newItemId()
  w.facts.push(fact(w.ctx, 'tool', { kind: 'item.enter', item, path, fingerprint, size: seen.size, ...seenFields(seen), origin: { kind: 'adopted' } }))
  w.adopted.set(path, item)
  return item
}

/** A thing as a basis names it: its item, its state token now, and its fingerprint when the token is the one on record. */
type Target = { id: ItemId; token: string | null; fingerprint: ItemRow['fingerprint'] }

/**
 * The item a library path names, with the version it has now: the thing at the path, else its archived
 * copy. A thing nobody registered is adopted first. Null when there is no such thing or item. No
 * content is read: the version is the token storage gives.
 */
async function itemAt(w: Writing, path: LibraryPath): Promise<Target | null> {
  const { ctx } = w
  for (const candidate of ctx.tools.regionOf(path) === 'content' ? [path, ctx.tools.archivedPath(path)] : [path]) {
    const [thing] = await ctx.tools.what([candidate])
    if (!thing || (thing.kind !== 'file' && thing.kind !== 'bundle') || thing.entry === null) continue
    const token = thing.entry.token ?? null
    const item = await rowAt(ctx, candidate)
    if (item) return { id: item.id, token, fingerprint: item.token === token ? item.fingerprint : null }
    const seen = { token, size: thing.entry.size ?? 0, modified: thing.entry.modified ?? null, bundle: thing.kind === 'bundle' }
    return { id: w.adopted.get(candidate) ?? adopt(w, candidate, seen), token, fingerprint: null }
  }
  const known = await rowAt(ctx, path)
  return known ? { id: known.id, token: known.token, fingerprint: known.fingerprint } : null
}

/** What a caller wrote: an item id, or a path in the library. A path inside a bundle names the bundle. */
async function target(w: Writing, input: string): Promise<Target | null> {
  if (input.startsWith('i_')) {
    const known = (await getAll<ItemRow>(records(w.ctx), 'items', [input])).get(input)
    if (known) return { id: known.id, token: known.token, fingerprint: known.fingerprint }
  }
  const resolved = await w.ctx.tools.resolve(input)
  if (resolved === null || resolved.region === 'kernel') return null
  return itemAt(w, resolved.bundle ?? resolved.path)
}

/** Basis rows with each source's version as it is now. */
async function basisOf(w: Writing, from: readonly string[], outside: readonly string[]): Promise<Basis | { missing: string }> {
  const items: Basis['items'] = []
  for (const input of from) {
    const source = await target(w, input)
    if (!source) return { missing: input }
    if (!items.some((row) => row.item === source.id)) items.push({ item: source.id, fingerprint: source.fingerprint, ...(source.token === null ? {} : { token: source.token }) })
  }
  return { items, outside: [...outside] }
}

const basisNote = (basis: Basis) => `，依据 ${basis.items.length} 个条目${basis.outside.length ? `、${basis.outside.length} 条外部依据` : ''}`

/** The origin a put said, a made thing's sources as basis rows; the thing's own old content is no basis of itself. */
async function originOf(w: Writing, origin: Extract<AcceptedPut, { origin: unknown }>['origin'], self: ItemId | undefined): Promise<LedgerOrigin> {
  if (origin.kind !== 'made') return origin
  const basis = await basisOf(w, origin.from, origin.outside)
  // The kernel accepted the put only when every --from file was there; one gone since is a failure to record.
  if ('missing' in basis) throw new Error(`依据的文件已缺失，无法记录来源：${basis.missing}`)
  return { kind: 'made', basis: { ...basis, items: basis.items.filter((row) => row.item !== self) } }
}

/** Whether the thing at a path holds the version on record: by token, else by content where the record has a fingerprint (one read). */
async function sameAsRecorded(ctx: PluginContext, item: ItemRow, token: string, fingerprint: ItemRow['fingerprint']): Promise<{ same: boolean; fingerprint: ItemRow['fingerprint'] }> {
  if (item.token === token) return { same: true, fingerprint: fingerprint ?? item.fingerprint }
  if (item.fingerprint === null) return { same: false, fingerprint }
  const now = fingerprint ?? (await (async () => {
    const read = await ctx.tools.storage.content(item.path)
    return isFailure(read) ? null : read.fingerprint
  })())
  return { same: now === item.fingerprint, fingerprint: now }
}

/** The loose files of a page of an open directory the kernel registered: the ones nobody knows are entered as one fact, the known ones left as they are. */
async function recordFiles(w: Writing, req: Extract<AcceptedPut, { kind: 'register-files' }>): Promise<PluginNote> {
  const { ctx } = w
  const known = await getAll<{ id: ItemId }>(records(ctx), 'paths', req.files.map((f) => f.path))
  const items: Entered[] = req.files
    .filter((f) => !known.has(f.path))
    .map((f) => {
      const seen = seenOf(f.now)
      return { item: newItemId(), path: f.path, fingerprint: null, size: seen.size, ...seenFields(seen) }
    })
  const dir = req.path === '' ? '资料库根目录中' : `${req.path}/ 中`
  if (items.length === 0) return { text: `${dir}的 ${req.files.length} 个文件均已登记，无新增记录`, data: { entered: 0 } }
  const origin = await originOf(w, req.origin, undefined)
  const how = req.observed ? 'observed' : 'tool'
  w.facts.push(fact(ctx, how, { kind: 'items.enter', items, origin }))
  return { text: `${dir}的 ${items.length} 个文件已登记：${originLabel(origin.kind === 'made' ? { kind: 'made' } : origin, how)}`, data: { entered: items.length, items: items.map((i) => i.item) } }
}

async function recordPut(w: Writing, req: AcceptedPut): Promise<{ note: PluginNote; rebase: LibraryPath[] }> {
  const { ctx } = w
  if (req.kind === 'register-files') return { note: await recordFiles(w, req), rebase: [] }
  const seen = seenOf(req.now)
  if (req.kind === 'move') {
    const moved = await rowAt(ctx, req.from)
    if (!moved) return { note: { text: `移动的文件未登记，已登记为来源未知 · 条目 ${adopt(w, req.path, seen, req.fingerprint)}` }, rebase: [] }
    w.facts.push(fact(ctx, 'tool', { kind: 'item.move', item: moved.id, from: req.from, to: req.path, archive: null, ...(seen.token === null ? {} : { token: seen.token }), ...(seen.modified === null ? {} : { modified: seen.modified }) }))
    return { note: { text: `已记录移动 · 条目 ${moved.id}`, data: { item: moved.id } }, rebase: [] }
  }
  const item = await rowAt(ctx, req.path)
  const origin = await originOf(w, req.origin, item?.id)
  const noted = req.note === null ? {} : { note: req.note }
  const made = origin.kind === 'made' ? basisNote(origin.basis) : ''
  // An origin the owner's side saw, not one somebody said: a later one said replaces it.
  const how = req.kind === 'register' && req.observed ? 'observed' : 'tool'
  const size = req.kind === 'place' && seen.bundle ? (req.now.size ?? 0) : seen.size
  if (!item) {
    const id = newItemId()
    w.facts.push(fact(ctx, how, { kind: 'item.enter', item: id, path: req.path, fingerprint: req.fingerprint, size, ...seenFields(seen), origin, ...noted }))
    // A directory-thing's record is its token and its first level, taken now.
    return { note: { text: `已记录：${originLabel(origin.kind === 'made' ? { kind: 'made' } : origin, how)}${made} · 条目 ${id}`, data: { item: id } }, rebase: seen.bundle ? [req.path] : [] }
  }
  const { same, fingerprint } = await sameAsRecorded(ctx, item, req.now.token, req.fingerprint)
  if (same) {
    // The same content under a new token is the version on record: the look takes the token as recorded.
    const rebased = item.token === req.now.token ? [] : [req.path]
    const seenOnly = item.entered.how === 'observed'
    if (!item.unknownOrigin && !(seenOnly && how !== 'observed')) {
      if (req.note === null) return { note: { text: `已登记：条目 ${item.id}，内容与记录一致，无新增记录`, data: { item: item.id } }, rebase: rebased }
      // No fact is written for this put, so its sentence is a note about the thing.
      w.facts.push(fact(ctx, 'reported', { kind: 'said', flavor: 'note', text: req.note, about: item.id }))
      return { note: { text: `已登记：条目 ${item.id}，内容与记录一致，已添加备注：${req.note}`, data: { item: item.id } }, rebase: rebased }
    }
    // An enter at a path an item holds is an alias of it; it gives the item the origin it lacked, or replaces one only seen.
    w.facts.push(fact(ctx, how, { kind: 'item.enter', item: newItemId(), path: req.path, fingerprint: fingerprint ?? item.fingerprint, size, ...seenFields(seen), origin, ...noted }))
    const label = `${originLabel(origin.kind === 'made' ? { kind: 'made' } : origin, how)}${made}`
    const text = item.unknownOrigin ? `已补充来源：${label}` : `已更正来源：${label}；之前为自动登记：${originLabel(item.origin, 'observed')}`
    return { note: { text: `${text} · 条目 ${item.id}`, data: { item: item.id } }, rebase: rebased }
  }
  const held = req.kind === 'place' && req.previous !== null ? heldPath(ctx, item.id, keyOf(item, req.previous.token, req.previous.fingerprint), req.path) : null
  const claimed = req.kind === 'register'
  const basis = origin.kind === 'made' ? { basis: origin.basis } : {}
  const seenNow = { ...(seen.token === null ? {} : { token: seen.token }), ...(seen.modified === null ? {} : { modified: seen.modified }) }
  w.facts.push(fact(ctx, how === 'observed' ? how : claimed ? 'reported' : 'tool', { kind: 'item.revise', item: item.id, base: item.fingerprint, fingerprint, size, ...seenNow, ...basis, held, claimed, ...noted }))
  const text = held ? '已记录内容更新，旧内容已存入历史副本，所有者可恢复' : how === 'observed' ? '已记录外部修改（自动登记）' : claimed ? '已确认外部修改' : '已记录内容更新'
  return { note: { text: `${text} · 条目 ${item.id}`, data: { item: item.id } }, rebase: [] }
}

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })
const SAID = { doing: '任务', decided: '决策', note: '备注' } as const

/** The versions of an item, oldest first, from its history rows. */
async function versionsOf(ctx: PluginContext, item: ItemId): Promise<Extract<HistoryRow, { kind: 'version' }>[]> {
  const out: Extract<HistoryRow, { kind: 'version' }>[] = []
  for await (const page of pagesOf<HistoryRow>(records(ctx), 'history', `${item}|`)) for (const r of page) if (r.value.kind === 'version') out.push(r.value)
  return out
}

async function recordSay(w: Writing, req: SayRequest): Promise<{ answer: SayAnswer; rebase: LibraryPath[] }> {
  const { ctx } = w
  const just = (answer: SayAnswer) => ({ answer, rebase: [] })
  const flavor = flavorOf(req.kind)
  if (flavor !== null) {
    if (!req.text) return just(refused(`缺少说明：say ${req.kind} "<说明>"`))
    const about = req.about === null ? null : await target(w, req.about)
    if (req.about !== null && !about) return just(refused(`文件不存在：${req.about}`))
    w.facts.push(fact(ctx, 'reported', { kind: 'said', flavor, text: req.text, about: about?.id ?? null }))
    return just(heard(`${SAID[flavor]}：${req.text}${req.about !== null ? `（关于 ${req.about}）` : ''}`))
  }
  if (req.kind === 'basis') {
    const input = req.about ?? req.text
    const subject = input === null ? null : await target(w, input)
    if (!subject) return just(refused(input === null ? '缺少条目：say basis <库内路径> --from <库内路径…>' : `文件不存在：${input}`))
    const basis = await basisOf(w, req.args.from ?? [], req.args['from-external'] ?? [])
    if ('missing' in basis) return just(refused(`文件不存在：${basis.missing}`))
    if (basis.items.length === 0 && basis.outside.length === 0) return just(refused('缺少依据：--from <库内路径…> 或 --from-external "<说明>"'))
    w.facts.push(fact(ctx, 'reported', { kind: 'item.basis', item: subject.id, fingerprint: subject.fingerprint, basis }))
    return just(heard(`已补充 ${input} 的依据${basisNote(basis)}`))
  }
  if (req.kind === 'revised') {
    const input = req.about ?? req.text
    const by = req.args.by?.[0]?.trim() || null
    const observed = req.args.observed !== undefined
    if (by !== null && by !== 'owner') return just(refused('say revised 的 --by 只接受 owner：say revised <库内路径> [--by owner]'))
    // What the owner's side saw is the owner's to record, and it cannot know who made the change.
    if (observed && ctx.actor.kind !== 'owner') return just(refused('say revised 的 --observed 仅所有者可用，记录所有者一侧自动检测到的修改。Agent 自己的修改不加 --observed。'))
    if (observed && by !== null) return just(refused('say revised 的 --observed 记录检测到的修改，执行者未知，不能与 --by 同用。'))
    const resolved = input === null ? null : await ctx.tools.resolve(input)
    const path = resolved === null || resolved.region === 'kernel' ? null : (resolved.bundle ?? resolved.path)
    const item = path === null ? undefined : await rowAt(ctx, path)
    if (!item || path === null) return just(refused(`文件未登记：${input ?? '（未指定）'}。补充来源请用 put <库内路径> --imported 或 --generated。`))
    const [thing] = await ctx.tools.what([path])
    if (!thing || thing.entry === null || (thing.kind !== 'file' && thing.kind !== 'bundle')) return just(refused(`文件不存在：${input}`))
    const token = thing.entry.token ?? ''
    const { same, fingerprint } = await sameAsRecorded(ctx, item, token, null)
    // A change only seen is replaced by the claim somebody makes for the same content.
    const seen = item.last.how === 'observed' && item.last.claimed
    const rebased = same && item.token !== token ? [path] : []
    if (same && (observed || !seen)) return { answer: heard(`${input} 的内容与记录一致，无需确认修改`), rebase: rebased }
    // The envelope's actor is who the library recognised; what the caller says goes in the body.
    const forOwner = by === 'owner' && ctx.actor.kind !== 'owner'
    const base = same ? ((await versionsOf(ctx, item.id)).at(-2)?.fingerprint ?? null) : item.fingerprint
    const size = thing.kind === 'file' ? (thing.entry.size ?? item.size) : item.size
    const modified = thing.entry.modified === undefined ? {} : { modified: thing.entry.modified }
    w.facts.push(fact(ctx, observed ? 'observed' : 'reported', { kind: 'item.revise', item: item.id, base, fingerprint: same ? (fingerprint ?? item.fingerprint) : fingerprint, size, token, ...modified, held: null, claimed: true, ...(forOwner ? { by: 'owner' as const } : {}) }))
    const replaced = same ? '，已替换自动登记的记录' : ''
    if (observed) return { answer: heard(`已记录 ${input} 的外部修改（自动登记，执行者未知）`), rebase: rebased }
    return { answer: heard(forOwner ? `已记录 ${input} 的外部修改为所有者直接修改${replaced}` : `已确认 ${input} 的外部修改${replaced}`), rebase: rebased }
  }
  return just(refused(`溯源插件不支持此类型：${req.kind}`))
}

const archiveSide = (from: LibraryPath, to: LibraryPath) => {
  const [a, b] = [archived({ path: from }), archived({ path: to })]
  return a === b ? null : b ? ('in' as const) : ('out' as const)
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Extract<Event, { face: 'owner' }>): LibraryPath[] {
  if (event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/**
 * The fact an event makes, if any. Approving a request is no row of its own: the run it approved is
 * the row, carrying who asked, whether the command did it or refused, since the owner decided either way.
 * A read-only command leaves none: it only looks, as `ledger stats` reads the page 统计 as text. The
 * record keeps the command as given and what it did to what, as the command declares; not what it printed.
 */
function recordOf(event: Event): FactBody | null {
  if (event.face === 'agent') {
    if (event.verb !== 'ask') return null
    const r = event.result
    if (r.outcome === 'asked' && !r.again) return { kind: 'request', act: 'asked', request: r.request.id, line: r.request.line, why: r.request.why }
    if (r.outcome === 'withdrawn') return { kind: 'request', act: 'withdrawn', request: r.request.id, line: r.request.line }
    return null
  }
  const r = event.result
  if (event.readOnly || event.command === 'request approve' || r.outcome === 'failed' || (r.outcome === 'refused' && !event.request)) return null
  return {
    kind: 'owner.op',
    command: event.command,
    summary: ownerSummary(r.text),
    destructive: event.destructive,
    line: commandLine(event.command, event.args),
    ...(event.act ? { act: event.act.kind, ...(event.act.object === null ? {} : { object: event.act.object }) } : {}),
    ...(event.setup ? { setup: true as const } : {}),
    ...(event.request ? { request: { id: event.request.id, by: { kind: 'agent' as const, name: event.request.by.name, grant: event.request.by.grant } } } : {}),
    ...(r.outcome === 'refused' ? { refused: r.reason } : {}),
  }
}

/** A decline's record names the request it turned down, and the agent that had asked, as the request's row says. */
async function withDeclined(ctx: PluginContext, body: FactBody, event: Event): Promise<FactBody> {
  if (body.kind !== 'owner.op' || event.face !== 'owner' || event.command !== 'request decline' || event.result.outcome !== 'done') return body
  const id = (event.result.data as { request?: unknown } | undefined)?.request
  if (typeof id !== 'string') return body
  const asked = (await getAll<{ by: FactActor }>(records(ctx), 'requests', [id])).get(id)
  return { ...body, declined: { id, by: asked?.by ?? null } }
}

/**
 * An owner command's answer as one line of the record, its lines joined, each absolute path or
 * file URL shortened to its last name: it is read in check, on the scene card and in the activity
 * list, where a name will do and the whole path only crowds the line.
 */
export const ownerSummary = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('；')
    .replace(/(^|[\s：:（(「，,]|file:\/\/)\/(?:[^\s/：:，,。；、）)」]+\/)*([^\s/：:，,。；、）)」]+\/?)/gu, (_, before: string, name: string) => `${before === 'file://' ? '' : before}${name}`)

/**
 * An agent by the grant it acts with, as `inspect @<grant>` names it: when it was last here, in how
 * many sessions, how many things it put in. Nothing for a name no grant of this library has.
 */
async function agentSections(ctx: PluginContext, name: string, grants: readonly Grant[]): Promise<PluginSection[]> {
  const grant = grants.find((g) => g.name === name)
  if (grant === undefined) return []
  const rows = (await records(ctx).where<ActorRow>('actors', 'grant', grant.id, { limit: 50 })).rows.map((r) => r.value)
  const last = rows.reduce<string | null>((at, r) => (at === null || r.last.at > at ? r.last.at : at), null)
  const scenes = rows.reduce((n, r) => n + r.scenes, 0)
  const put = rows.reduce((n, r) => n + r.put, 0)
  const body = last === null ? '暂无活动' : `最近访问：${when(last as never)}；${scenes} 次会话，添加 ${put} 个条目`
  return [{ title: '访问过', body, data: { kind: 'agent', grant: name, last, scenes, put } }]
}

/** The item panel's view of the thing at `path`: the one recorded there, or the one the look found moved there. */
async function panelItem(ctx: PluginContext, path: LibraryPath): Promise<ItemRow | undefined> {
  const named = await itemAtPath(records(ctx), ctx, path)
  if (named) return named
  const taken = (await getAll<{ id: ItemId }>(records(ctx), 'taken', [path])).get(path)
  return taken ? (await getAll<ItemRow>(records(ctx), 'items', [taken.id])).get(taken.id) : undefined
}

/** Whether a thing is at a content or archive path, or at its archived copy. */
async function thingAt(ctx: PluginContext, path: LibraryPath): Promise<boolean> {
  if (ctx.tools.regionOf(path) === 'kernel') return false
  const paths = ctx.tools.regionOf(path) === 'content' ? [path, ctx.tools.archivedPath(path)] : [path]
  return (await ctx.tools.what(paths)).some((t) => t.kind === 'file' || t.kind === 'bundle')
}

/** The library page's rows: by latest change for the whole library, by path within a folder, a page at a time. */
const TREE_MAX = 2000

async function itemsPage(ctx: PluginContext, params: Record<string, string>, size: number): Promise<ItemsPage> {
  const recs = records(ctx)
  const show = params.show ?? ''
  const dir = params.dir ?? ''
  const { after } = pageAt(params)
  const c = await counters(recs)
  const n = (k: string) => c[`class:${k}`] ?? 0
  const counts = { '': n('brought') + n('made') + n('adopted'), imported: n('brought'), generated: n('made'), archived: n('archived') }
  // The class the rows keep the page's word under; null for a word that names none, which shows nothing.
  const cls = show === '' || show === 'archived' ? show : storedOrigin(show)
  const inShow = (item: ItemRow) => cls !== null && (cls === 'archived' ? archived(item) : !archived(item) && (cls === '' || item.origin.kind === cls))
  let items: ItemRow[] = []
  let next: string | null = null
  if (dir === '') {
    const opts = { limit: size, ...(after === undefined ? {} : { after }) }
    const page = cls === null ? { rows: [], more: null } : cls === '' ? await recs.where<{ id: ItemId }>('bytime', 'live', 'y', opts) : await recs.where<{ id: ItemId }>('bytime', 'show', cls, opts)
    const rows = await getAll<ItemRow>(recs, 'items', page.rows.map((r) => r.value.id))
    items = page.rows.flatMap((r) => rows.get(r.value.id) ?? [])
    next = page.more?.after ?? null
  } else {
    const prefix = `${show === 'archived' ? ctx.tools.archivedPath(dir as LibraryPath) : dir}/`
    let at = after
    for (let pages = 0; items.length < size && pages < 5; pages++) {
      const page = await recs.under<{ id: ItemId }>('paths', prefix, { limit: size - items.length, ...(at === undefined ? {} : { after: at }) })
      const rows = await getAll<ItemRow>(recs, 'items', page.rows.map((r) => r.value.id))
      items.push(...page.rows.flatMap((r) => rows.get(r.value.id) ?? []).filter((i) => !i.removed && i.absorbedInto === null && inShow(i)))
      next = page.more?.after ?? null
      if (next === null) break
      at = next
    }
  }
  const tree: { path: string; count: number }[] = []
  for await (const page of pagesOf<number>(recs, 'dirs', show === 'archived' ? '_archive/' : '', 1000)) {
    tree.push(...page.filter((r) => (show === 'archived' ? true : r.key !== '_archive' && !r.key.startsWith('_archive/'))).map((r) => ({ path: r.key, count: r.value })))
    if (tree.length >= TREE_MAX) break
  }
  const closed = show === 'archived' ? { rows: [], count: 0 } : await closedIn(ctx, dir)
  return { show, dir, items, after: next, counts, tree, params, size, closed }
}

/** How many closed directories the library page lists in a folder before the way to all of them. */
const CLOSED_SHOWN = 20

/** The closed directories right inside `dir`, as the last looks marked them, the first of them with what a look into each found. */
async function closedIn(ctx: PluginContext, dir: string): Promise<ItemsPage['closed']> {
  const all = (await standingList(records(ctx), 'closed', false, 1000)).rows.filter((m) => (m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '') === dir)
  const first = all.slice(0, CLOSED_SHOWN).map((m) => m.path)
  const looks = await closedLooks(ctx, first)
  return { rows: first.map((path) => ({ path, look: looks.get(path) ?? null })), count: all.length }
}

/** The text of the named whole pass, its lists at most 20 long. */
function deepSection(d: Deep): PluginSection {
  const where = d.dir === null ? '整个资料库' : `${d.dir} `
  const list = (title: string, l: Listed, after: string) => (l.count === 0 ? [] : [`${title}（${l.count} 个）：`, ...l.first.map((p) => `  ${p}`), ...(l.count > l.first.length ? [`  ……共 ${l.count} 个`] : []), ...(after ? [after] : [])])
  const head = d.stopped ? `已停止：${where}已检索 ${d.done} / ${d.scope} 个已登记条目。` : `内容检索完成：${where}共 ${d.done} 个已登记条目。`
  const body = [
    head,
    ...list('内容已变更', d.changed, 'Agent 自己的修改，用 say revised <库内路径> 确认。'),
    ...list('仅元数据变化，内容未变，已按当前状态记录', d.touched, ''),
    ...list('无法读取', d.failed, ''),
    ...(d.changed.count + d.touched.count + d.failed.count === 0 ? ['内容均与记录一致。'] : []),
  ]
  return { title: '内容检索', body: body.join('\n'), data: d }
}

/** The named whole pass of `check --deep`: how much it reads first, then how far, on the operation's pass; it stops after the page under way when asked. */
async function deepCheck(ctx: PluginContext, dir: LibraryPath | null): Promise<Deep> {
  const where = dir === null ? '整个资料库' : ` ${dir} `
  const progress = (done: number, scope: number) => ctx.pass?.report({ done, total: scope, text: done === 0 ? `将读取${where}的内容：${scope} 个已登记条目。` : `已检索 ${done} / ${scope} 个` })
  return deepPass(ctx, dir, progress, () => ctx.pass?.stopped() ?? false)
}

/** 溯源. */
export const ledger: Plugin = {
  contract: CONTRACT,
  name: pluginName('ledger'),
  version: PNEUMA_BASE_VERSION,
  title: '溯源',
  summary: '记录每个条目的来源与经手者',
  about: '记录每个条目由哪次会话、哪个 Agent、为什么任务添加，依据了哪些条目，以及读取和修改过它的执行者。',
  cognition: { title: '溯源', text: COGNITION },
  keeps: 'every',
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'held', kind: 'body' },
  ],
  statements: ['task', 'decision', 'note', 'basis', 'revised'],
  ownerCommands: [...heldCommands, REGISTER, DISMISS, LEDGER_STATS, LEDGER_EXPORT],
  views: LEDGER_VIEWS,

  async onPut(req, ctx) {
    await stateOf(ctx)
    const w = writing(ctx)
    const { note, rebase: paths } = await recordPut(w, req)
    await writeFacts(ctx, w.facts)
    await rebase(ctx, paths)
    return note
  },

  /** Keeps what is at the path in held/ before the kernel writes the new version; a thing nobody registered is adopted first. */
  async revise(req, ctx) {
    await stateOf(ctx)
    const w = writing(ctx)
    const item = await rowAt(ctx, req.path)
    let id = item?.id
    if (id === undefined) {
      const [thing] = await ctx.tools.what([req.path])
      id = adopt(w, req.path, { token: req.token, size: thing?.entry?.size ?? 0, modified: thing?.entry?.modified ?? null, bundle: thing?.kind === 'bundle' }, req.current)
    }
    const fingerprint = req.current ?? (item?.token === req.token ? item.fingerprint : null)
    if ((await keep(ctx, id, req.path, keyOf(item, req.token, req.current), fingerprint)) === null) return { outcome: 'declined', reason: `${req.path} 正在被修改，无法将旧内容存入历史副本；请稍后重试。` }
    await writeFacts(ctx, w.facts)
    return { outcome: 'held', note: null }
  },

  async onSay(req, ctx) {
    // A sentence about nothing in particular needs nothing read: start's `task` costs one write.
    const plain = req.about === null && flavorOf(req.kind) !== null
    if (!plain) await stateOf(ctx)
    const w = writing(ctx)
    const { answer, rebase: paths } = await recordSay(w, req)
    if (answer.outcome !== 'heard') return answer
    await writeFacts(ctx, w.facts)
    await rebase(ctx, paths)
    return answer
  },

  async onFind(req, ctx) {
    await stateOf(ctx)
    return findHits(req, ctx)
  },

  async onFound(paths, req, ctx) {
    await stateOf(ctx)
    return foundHits(paths, req, ctx)
  },

  /** The target is an agent's grant as `@<grant>`, a scene id, an item id or path, a file nobody registered, else a scene id prefix: exact names first. */
  async onInspect(req, ctx) {
    await stateOf(ctx)
    const recs = records(ctx)
    if (req.target.startsWith('@')) return agentSections(ctx, req.target.slice(1), ctx.library.config.grants)
    const card = async (scene: SceneRow) => {
      const lookup = await lookupOf(recs, [], { items: scene.items })
      const view = sceneView(lookup, scene, conversationOf(scene, ctx.session.machine))
      return [{ title: '场景', body: sceneText(view), data: spokenScene(view) }]
    }
    const scene = (await getAll<SceneRow>(recs, 'scenes', [req.target])).get(req.target)
    if (scene) return card(scene)
    const item = await itemNamed(ctx, req.target)
    if (item) {
      const view = await itemViewOf(recs, item)
      return [{ title: '溯源', body: itemText(view), data: spokenItem(view) }]
    }
    const resolved = await ctx.tools.resolve(req.target)
    if (resolved !== null && resolved.region !== 'kernel') {
      const bundle = resolved.bundle ?? (resolved.region === 'content' ? ((await ctx.tools.resolve(ctx.tools.archivedPath(resolved.path)))?.bundle ?? null) : null)
      if (bundle !== null) {
        const body = `该文件属于 ${bundle}：${bundle} 是一个条目（带标记的目录），来源见 inspect ${bundle}。`
        return [{ title: '溯源', body, data: { kind: 'part-of', path: resolved.path, bundle } }]
      }
      if (await thingAt(ctx, resolved.path)) {
        const body = '文件未登记，来源未知。已知来源时，用 put <库内路径> --imported 或 --generated 补充。'
        return [{ title: '溯源', body, data: { kind: 'unowned', path: resolved.path } }]
      }
    }
    const { scenes, more } = await scenesNamed(recs, req.target)
    if (scenes.length === 1 && !more) return card(scenes[0] as SceneRow)
    if (scenes.length === 0) return []
    return [{ title: '场景', body: ambiguousText(req.target, scenes, more), data: { kind: 'ambiguous', prefix: req.target, scenes: scenes.map((s) => s.id) } }]
  },

  async onCheck(req, ctx) {
    const deep = req.deep ? await deepCheck(ctx, req.deep.dir) : null
    await refresh(ctx)
    const recs = records(ctx)
    const me = factActor(ctx.actor)
    const news = await newsSince(recs, me, sceneOf(ctx), req.since)
    // What moved is told as found, before its new path is recorded.
    const moved = await standingList(recs, 'moved', req.includeArchived)
    // A moved thing is taken back: its new path is recorded, as seen by the ledger itself, a page at a time.
    for await (const page of movedThings(ctx)) {
      const moves = page.map((m) => fact(ctx, 'observed', { kind: 'item.move', item: m.item, from: m.from, to: m.to, archive: archiveSide(m.from, m.to), ...(m.token === null ? {} : { token: m.token }), ...(m.modified === null ? {} : { modified: m.modified }) }, LEDGER_ACTOR))
      await writeFacts(ctx, moves)
    }
    // This look is what the next check counts since, for agents and for the owner's 全部标为已读 alike.
    await writeFacts(ctx, [fact(ctx, 'tool', { kind: 'checked' })])
    await foldAll(ctx)
    const since = sinceViewOf(await lookupOf(recs, news.facts), news)
    const lists = (await standingLists(recs, req.includeArchived)).map((l) => (l.kind === 'moved' ? moved : l))
    return [
      ...(deep ? [deepSection(deep)] : []),
      ...(since.scenes.length > 0 ? [{ title: '最近动态', body: sinceText(since), data: since }] : []),
      ...standingSections(lists, await partialDirs(recs)),
    ]
  },

  /** The open directories: each holds something registered at some depth. */
  async openDirs(ctx) {
    await stateOf(ctx)
    const out: LibraryPath[] = []
    for await (const page of pagesOf<number>(records(ctx), 'dirs', '')) out.push(...page.map((r) => r.key as LibraryPath))
    return out
  },

  /** The register: each thing on record by its path, in the content and the archive, a page of the rows at a time. */
  async registered(req, ctx) {
    await stateOf(ctx)
    const recs = records(ctx)
    const page = await recs.under<{ id: ItemId }>('paths', '', { limit: req.limit, ...(req.after === null ? {} : { after: req.after }) })
    const items = await getAll<ItemRow>(recs, 'items', page.rows.map((r) => r.value.id))
    const things = page.rows.flatMap(({ key, value }) => {
      const item = items.get(value.id)
      if (item === undefined || item.removed || item.absorbedInto !== null || item.path !== key) return []
      return [{ place: item.path, kind: item.bundle ? ('bundle' as const) : ('file' as const), token: item.token, fingerprinted: item.fingerprint !== null }]
    })
    return { things, more: page.more, total: await scopeOf(ctx, null) }
  },

  /** Things nobody registered, one ask for each place, until they are registered or the owner leaves them so. */
  onAsks: unownedAsks,

  async onArchive(req, ctx) {
    if (!req.moved) return null
    await stateOf(ctx)
    const w = writing(ctx)
    const known = await rowAt(ctx, req.from)
    const [thing] = await ctx.tools.what([req.to])
    const entry = thing?.entry ?? null
    const seen = { token: entry?.token ?? null, size: entry?.size ?? 0, modified: entry?.modified ?? null, bundle: thing?.kind === 'bundle' }
    const id = known?.id ?? (entry !== null && (thing?.kind === 'file' || thing?.kind === 'bundle') ? adopt(w, req.from, seen) : undefined)
    if (id === undefined) return null
    w.facts.push(fact(ctx, 'tool', { kind: 'item.move', item: id, from: req.from, to: req.to, archive: req.kind === 'archive' ? 'in' : 'out', ...(seen.token === null ? {} : { token: seen.token }), ...(seen.modified === null ? {} : { modified: seen.modified }) }))
    await writeFacts(ctx, w.facts)
    const what = req.kind === 'archive' ? '已记录归档' : '已记录取消归档'
    return { text: `${what}${known ? '' : '；此文件之前未登记，已登记为来源未知'} · 条目 ${id}`, data: { item: id } }
  },

  /** The ledger's pages, each from the rows it shows. Writes no fact: a move a look sees stays for check to record. */
  async onView(req, ctx) {
    const { grants } = ctx.library.config
    const recs = records(ctx)
    switch (req.view) {
      case HOME_VIEW: {
        await refresh(ctx)
        const news = await newsSince(recs, factActor(ctx.actor), sceneOf(ctx), 'last')
        return homeAnswer(recs, await standingLists(recs, false, 1), news, await agentsOf(recs), grants)
      }
      case ITEMS_VIEW:
        await refresh(ctx)
        return itemsAnswer(await itemsPage(ctx, req.params, rowsOf(req)), grants)
      case STANDING_VIEW: {
        await refresh(ctx)
        const only = isStandingKind(req.params.kind) ? req.params.kind : null
        const lists = only === null ? await standingLists(recs, false) : [await standingList(recs, only, false, rowsOf(req), pageAt(req.params).after)]
        const looks = await closedLooks(ctx, lists.flatMap((l) => (l.kind === 'closed' ? l.rows.map((m) => m.path) : [])))
        const deep = only === null || only === 'changed' ? await scopeOf(ctx, null) : null
        return standingAnswer(lists, only, req.params, rowsOf(req), looks, deep)
      }
      case SCENES_VIEW:
        await stateOf(ctx)
        return scenesAnswer(recs, req.params, grants, ctx.now, rowsOf(req))
      case SCENE_VIEW: {
        await stateOf(ctx)
        const input = req.params.scene ?? ''
        const { scenes, more } = await scenesNamed(recs, input)
        const scene = scenes.length === 1 && !more ? scenes[0] : undefined
        return scene ? sceneAnswer(recs, scene, conversationOf(scene, ctx.session.machine), grants, req.params, rowsOf(req)) : noSuchScene(input, scenes.length, more)
      }
      case ACTIVITY_VIEW:
        await stateOf(ctx)
        return activityAnswer(recs, req.params, grants, ctx.now, rowsOf(req))
      case STATS_VIEW: {
        // From the hours' rows alone: no file is read, so the page costs the same however large the library is.
        await stateOf(ctx)
        const period = req.params.period
        return statsAnswer(await statsFrom(recs, isPeriod(period) ? period : DEFAULT_PERIOD, ctx.now))
      }
      case HELD_VIEW: {
        await stateOf(ctx)
        const held = await heldCopies(ctx, rowsOf(req), pageAt(req.params).after)
        const glanced = await ctx.tools.storage.own.glance(held.copies.map((c) => c.place))
        const sizes = new Map(glanced.map((g) => [g.place, 'kind' in g ? { size: g.kind === 'file' ? (g.size ?? null) : null, bundle: g.kind === 'dir' } : { size: null, bundle: false }]))
        return heldAnswer(held, sizes, req.params, rowsOf(req))
      }
      default:
        throw new Error(`the ledger has no view ${req.view}`)
    }
  },

  /** The item panel's provenance section, from the same view inspect gives; a file nobody registered says so. */
  async onItemView(path, ctx, panel) {
    await refresh(ctx)
    const recs = records(ctx)
    const item = await panelItem(ctx, path)
    if (!item) {
      // A file inside a bundle that was never an item of its own has the bundle's provenance.
      const bundle = (await ctx.tools.resolve(path))?.bundle ?? null
      if (bundle !== null) return partOfSection(bundle)
      return (await thingAt(ctx, path)) ? unownedSection(path) : null
    }
    const view: ItemView = await itemViewOf(recs, item)
    return itemSection(view, await lookupOf(recs, [], { scenes: [item.entered.scene] }), ctx.library.config.grants, panel)
  },

  /**
   * Records each owner operation that was done, and an approved request's run however it ended, so
   * agents see them in check; an archive purge removes the items it deleted. An agent's ask and its
   * withdrawal are facts too.
   */
  async observe(event, ctx) {
    const body = recordOf(event)
    if (body === null) return
    const needsRows = event.face === 'owner' && (event.command === 'request decline' || event.command === 'archive purge')
    if (needsRows) await stateOf(ctx)
    const facts: Fact[] = [fact(ctx, 'tool', await withDeclined(ctx, body, event))]
    if (event.face === 'owner') {
      const gone = purged(event)
      const held = await getAll<{ id: ItemId }>(records(ctx), 'paths', gone)
      for (const path of gone) {
        const id = held.get(path)?.id
        if (id !== undefined) facts.push(fact(ctx, 'tool', { kind: 'item.remove', item: id }))
      }
    }
    await writeFacts(ctx, facts)
  },
}

