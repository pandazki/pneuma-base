// What the ledger answers: data for --json and short Chinese text for agents. Pure, except that
// text reads the home directory to show it as ~ (the kernel's shortDir). ledger-design.md section 7.
import { regionOf, shortDir, type Fingerprint, type Instant, type LibraryPath, type PluginSection } from '@pneuma-base/kernel'
import { ADHOC_SCENE, type Fact, type FactActor, type How, type ItemId, type SceneId } from './facts.js'
import type { Conversation } from './conversation.js'
import { archived, heldKey, type HistoryRow, type ItemRow, type ItemState, type MarkKind, type MarkRow, type OriginLike, type OriginLine, type Ref, type SaidRow, type SceneRow } from './model.js'

export const when = (at: Instant) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
export const who = (a: FactActor) => (a.kind === 'owner' ? '主人' : a.name)
/**
 * The actors of a scene by name, each name once: one agent can act in a scene both with a grant and
 * without one, or under two grants, which are distinct actors with the same name.
 */
export const actorNames = (actors: readonly FactActor[]) => [...new Set(actors.map(who))].join('、')

/** A scene id as text shows it: its first 8 characters; an ad hoc scene's id whole. */
export const shortScene = (id: SceneId) => (id.startsWith(ADHOC_SCENE) ? id : id.slice(0, 8))

/** What the views need of the rows: the items and the scenes they name, read for the view. */
export type Lookup = { items: ReadonlyMap<ItemId, ItemRow>; scenes: ReadonlyMap<SceneId, SceneRow> }

/** Who was in a scene, when it began, what it was doing. */
function sceneParts(scene: SceneRow): string[] {
  const doing = [...new Set(scene.said.filter((s) => s.flavor === 'doing').map((s) => s.text))]
  return [actorNames(scene.actors), when(scene.first), ...(doing.length ? [`在做：${doing.join('；')}`] : [])]
}

/** The heading find puts a scene's hits under. */
export const sceneLine = (scene: SceneRow) => [`场景 ${shortScene(scene.id)}`, ...sceneParts(scene)].join(' · ')

/** The answer to a scene id prefix that several scenes share: each with its whole id. */
export function ambiguousText(prefix: string, scenes: SceneRow[], more: boolean): string {
  return [`有${more ? '至少' : ''} ${scenes.length} 个场景的编号以 ${prefix} 开头，写长一点再看：`, ...scenes.map((s) => `  ${[s.id, ...sceneParts(s)].join(' · ')}`)].join('\n')
}

/** What an origin seen and not said carries wherever it is shown: the app registered it, and it may be wrong. */
export const OBSERVED = '（自动登记）'

/** An origin in words; one only seen (`how` 'observed') says so. */
export function originLabel(origin: OriginLike, how: How): string {
  const label = origin.kind === 'made' ? '做出来的' : origin.kind === 'adopted' ? '来历不明' : origin.by === 'owner' ? '带进来的，主人给的' : '带进来的'
  return how === 'observed' ? `${label}${OBSERVED}` : label
}

export type Version = Extract<HistoryRow, { kind: 'version' }>

/** How a version's content came, when it was a direct change: claimed, recorded for the owner, or only seen; null for a put. */
export function claimText(ver: Version): string | null {
  if (!ver.claimed) return null
  if (ver.how === 'observed') return '直接改的，自动登记'
  const said = ver.by === 'owner' ? `主人直接改的，${who(ver.actor)} 代记` : '认了直接改动'
  return ver.seen === null ? said : `${said}（先是自动登记）`
}

/** A version as one short word: its fingerprint's first 8, or a dash when its content was never read. */
export const shortPrint = (ver: Pick<Version, 'fingerprint'>) => ver.fingerprint?.slice(0, 8) ?? '—'

export const STATE_LABEL: Record<ItemState['kind'], string> = { consistent: '一致', changed: '已变', moved: '已搬', missing: '不在', removed: '已除', absorbed: '并入' }
export const MARK_LABEL: Record<'stale' | 'source-gone', string> = { stale: '可能过期', 'source-gone': '来源不在' }

const pathOf = (lookup: Lookup, id: ItemId) => lookup.items.get(id)?.path ?? id

/** What the scene was doing when `at` came: its latest `doing` up to then, else its first. */
export function doingAt(scene: SceneRow | undefined, at: Instant): string | null {
  const doings = scene?.said.filter((s) => s.flavor === 'doing') ?? []
  return (doings.filter((s) => s.at <= at).at(-1) ?? doings[0])?.text ?? null
}

// ---- inspect: an item ----

export type BasisView = { item: ItemId; path: LibraryPath | ItemId; fingerprint: string | null; state: ItemState['kind']; mark: 'stale' | 'source-gone' | null }
export type SaidView = { flavor: SaidRow['flavor']; text: string; at: Instant; scene: SceneId; actor: FactActor; about: LibraryPath | ItemId | null }
/** The key of the content a held copy keeps, from where it lies: held/<item>/<key>/<name>. */
export const heldKeyOf = (path: string) => path.split('/').at(-2) ?? ''

export type ItemView = {
  kind: 'item'
  item: ItemId
  path: LibraryPath
  origin: OriginLike
  entered: OriginLine // the current origin's
  earlier: OriginLine[] // the origins it replaced, oldest first
  doing: string | null
  basis: BasisView[]
  outside: string[]
  dependents: { item: ItemId; path: LibraryPath }[]
  said: SaidView[]
  state: ItemState
  fingerprint: Fingerprint | null // the content's on record; null while it was never read
  versions: Version[]
  held: string[] // where each held copy lies, relative to the library root
  archived: boolean
  absorbedInto: LibraryPath | null // the bundle it is part of now
  unknownOrigin: boolean // adopted, and nobody said where it came from since
  bundle: boolean
  looked: LastLook | null // a bundle's: how deep the last look went
}

/**
 * How the last look saw directory-things: `log`, the change log named places at any depth in them;
 * `level`, storage could not say what changed and their own level and first level were compared.
 */
export type LastLook = { how: 'log' | 'level'; at: Instant }

const LOOKED_TEXT: Record<LastLook['how'], string> = { log: '按变化日志，到任意深处', level: '到第一层' }

export const SAID_LABEL: Record<SaidRow['flavor'], string> = { doing: '在做', decided: '决定', note: '备注' }

/** An origin a later one replaced, in one line: what it was, who said or saw it, when, in which scene. */
export const earlierText = (e: OriginLine) => `${originLabel(e.origin, e.how)} · ${who(e.actor)} · ${when(e.at)} · 场景 ${shortScene(e.scene)}`

/** Whether a held copy keeps this version's content. */
export const keeps = (held: readonly string[], ver: Version) => held.some((path) => heldKeyOf(path) === heldKey(ver.fingerprint, ver.token))

export function itemText(v: ItemView): string {
  const where = v.entered.where?.cwd ? ` · 在 ${shortDir(v.entered.where.cwd)}` : ''
  const lines = [`${originLabel(v.origin, v.entered.how)} · ${who(v.entered.actor)} · ${when(v.entered.at)}${where} · 场景 ${shortScene(v.entered.scene)}`]
  if (v.origin.kind === 'brought' && v.origin.source) lines.push(`出处：${v.origin.source}`)
  for (const e of v.earlier) lines.push(`先前：${earlierText(e)}`)
  if (v.doing) lines.push(`当时在做：${v.doing}`)
  if (v.basis.length > 0 || v.outside.length > 0) {
    lines.push('依据：')
    for (const b of v.basis) lines.push(`  ${b.path}  ${STATE_LABEL[b.state]}${b.mark ? ` ← ${MARK_LABEL[b.mark]}` : ''}`)
    for (const o of v.outside) lines.push(`  库外：${o}`)
  }
  if (v.dependents.length > 0) lines.push(`被依据：${v.dependents.map((d) => d.path).join('、')}`)
  for (const s of v.said) lines.push(`${SAID_LABEL[s.flavor]}：${s.text}${s.about !== null && s.about !== v.path ? `（关于 ${s.about}）` : ''}`)
  const state = v.state.kind === 'moved' ? `已搬到 ${v.state.to}` : v.absorbedInto !== null ? `并入了 ${v.absorbedInto}，是它的一部分` : STATE_LABEL[v.state.kind]
  const changed = v.versions.length > 1 ? `内容换过 ${v.versions.length - 1} 次，` : ''
  lines.push(`现状：${state}${v.archived ? ' · 已归档' : ''} · ${changed}${v.held.length} 份留存 · 条目 ${v.item}`)
  if (v.looked !== null) lines.push(`上次看：${when(v.looked.at)}，${LOOKED_TEXT[v.looked.how]}`)
  if (v.versions.length > 1 || v.versions.some((ver) => ver.note !== null)) {
    for (const ver of v.versions) {
      const claimed = claimText(ver)
      const how = [...(claimed === null ? [] : [claimed]), ...(keeps(v.held, ver) ? ['被换下，在留存里'] : [])].join('，')
      lines.push([`  ${shortPrint(ver)}`, when(ver.at), who(ver.actor), ...(how ? [how] : []), ...(ver.note === null ? [] : [`「${ver.note}」`])].join('  '))
    }
  }
  return lines.join('\n')
}

// ---- inspect: a scene ----

export type SceneView = {
  kind: 'scene'
  id: SceneId
  first: Instant
  last: Instant
  actors: FactActor[]
  cwds: string[]
  conversation: Conversation | null
  said: SaidView[]
  items: { item: ItemId; path: LibraryPath; enteredHere: boolean; origin: OriginLike; how: How }[]
  touched: number
}

const saidView = (lookup: Lookup, scene: SceneId, s: SaidRow): SaidView => ({ flavor: s.flavor, text: s.text, at: s.at, scene, actor: s.actor, about: s.about === null ? null : pathOf(lookup, s.about) })

export function sceneView(lookup: Lookup, scene: SceneRow, conversation: Conversation | null): SceneView {
  return {
    kind: 'scene',
    id: scene.id,
    first: scene.first,
    last: scene.last,
    actors: scene.actors,
    cwds: scene.cwds,
    conversation,
    said: scene.said.map((s) => saidView(lookup, scene.id, s)),
    items: scene.items.flatMap((id) => {
      const item = lookup.items.get(id)
      return item ? [{ item: id, path: item.path, enteredHere: item.entered.scene === scene.id, origin: item.origin, how: item.entered.how }] : []
    }),
    touched: scene.touched,
  }
}

export function sceneText(v: SceneView): string {
  const lines = [`场景 ${shortScene(v.id)}`, `${actorNames(v.actors)} · ${when(v.first)} 到 ${when(v.last)}${v.cwds.length ? ` · 在 ${v.cwds.map((d) => shortDir(d)).join('、')}` : ''}`]
  if (v.conversation) {
    lines.push(`对话：${v.conversation.path}（${whereConversation(v.conversation)}）`)
    if (v.conversation.status === 'here' && v.conversation.resume) lines.push(`接着聊：${v.conversation.resume}`)
  }
  for (const s of v.said) lines.push(`${SAID_LABEL[s.flavor]}：${s.text}${s.about !== null ? `（关于 ${s.about}）` : ''}`)
  if (v.items.length > 0) {
    lines.push('条目：', ...v.items.map((i) => `  ${i.path}  ${i.enteredHere ? `在这里放入，${originLabel(i.origin, i.how)}` : '在这里改过或挪过'}`))
    if (v.touched > v.items.length) lines.push(`  ……共 ${v.touched} 样，看全部：show ledger.scene --scene ${v.id}`)
  }
  return lines.join('\n')
}

export function whereConversation(c: Conversation): string {
  return c.status === 'here' ? '在这台机器上' : c.status === 'gone' ? '这台机器上已经没有了' : `在 ${c.machine} 上，不是这台机器`
}

// ---- check: since last time ----

export const SINCE_LIMIT = 20

export type SinceFact = { kind: Fact['kind']; at: Instant; actor: string; text: string }
export type SinceView = { since: Instant | null; scenes: { scene: SceneId; actors: string[]; cwds: string[]; facts: SinceFact[] }[] }

/** The news since the actor was last here by scene, each fact as one line: check's section. */
export function sinceViewOf(lookup: Lookup, news: { since: Instant | null; facts: readonly Fact[] }): SinceView {
  const scenes = new Map<SceneId, SinceView['scenes'][number]>()
  for (const f of news.facts) {
    const entry = scenes.get(f.scene) ?? { scene: f.scene, actors: [], cwds: [], facts: [] }
    scenes.set(f.scene, entry)
    if (!entry.actors.includes(who(f.actor))) entry.actors.push(who(f.actor))
    if (f.where?.cwd && !entry.cwds.includes(f.where.cwd)) entry.cwds.push(f.where.cwd)
    entry.facts.push({ kind: f.kind, at: f.at, actor: who(f.actor), text: factLine(lookup, f) })
  }
  return { since: news.since, scenes: [...scenes.values()] }
}

const noteTail = (note: string | undefined) => (note ? `：${note}` : '')

/** The items a fact names, to read their rows before telling it. */
export const itemsOf = (f: Fact): ItemId[] => ('item' in f ? [f.item] : f.kind === 'said' && f.about !== null ? [f.about] : [])

/** One fact as one line of text, paths as they are now where they moved since. */
export function factLine(lookup: Lookup, f: Fact): string {
  const now = (id: ItemId, then: LibraryPath) => {
    const path = pathOf(lookup, id)
    return path === then ? then : `${then}（现在在 ${path}）`
  }
  switch (f.kind) {
    case 'said':
      return `${SAID_LABEL[f.flavor]}：${f.text}${f.about !== null ? `（关于 ${pathOf(lookup, f.about)}）` : ''}`
    case 'item.enter':
      return `放入 ${now(f.item, f.path)}（${originLabel(f.origin.kind === 'made' ? { kind: 'made' } : f.origin, f.how)}）${noteTail(f.note)}`
    case 'items.enter':
      return `一次登记了 ${f.items.length} 样没人登记过的东西（${originLabel(f.origin.kind === 'made' ? { kind: 'made' } : f.origin, f.how)}）`
    case 'item.revise': {
      const path = pathOf(lookup, f.item)
      const what = !f.claimed
        ? `${path} 换了新内容`
        : f.how === 'observed'
          ? `看到 ${path} 被直接改了${OBSERVED}`
          : f.by === 'owner'
            ? `记下 ${path} 是主人直接改的`
            : `认了 ${path} 的直接改动`
      return `${what}${noteTail(f.note)}`
    }
    case 'item.move': {
      const seen = f.how === 'observed' ? '（看到的）' : ''
      if (f.archive === 'in') return `归档 ${f.from}${seen}`
      if (f.archive === 'out') return `取回 ${f.to}${seen}`
      return `挪 ${f.from} → ${f.to}${seen}`
    }
    case 'item.basis':
      return `补上 ${pathOf(lookup, f.item)} 的依据`
    case 'item.remove':
      return `${pathOf(lookup, f.item)} 随归档区一起清掉了`
    case 'owner.op':
      if (f.request) return `批准了 ${f.request.by.name} 的请求，执行 ${f.command}${f.refused === undefined ? '' : ` 被拒绝（${f.refused}）`}：${f.summary}`
      return f.actor.kind === 'owner' ? `主人面的操作 ${f.command}：${f.summary}` : `执行 ${f.command}：${f.summary}`
    case 'request':
      return f.act === 'asked' ? `请主人做 ${f.line}：${f.why ?? ''}` : `撤回了请求 ${f.request}：${f.line}`
    case 'checked':
      return '看过了库的变化'
    case 'unowned.left':
      return `${f.paths.length} 样没人登记过的东西照原样留着，不再问`
  }
}

export function sinceText(v: SinceView): string {
  const head = v.since === null ? '你第一次来，下面是最近的记录：' : `${when(v.since)} 以来：`
  const scenes = v.scenes.flatMap((s) => [
    `场景 ${shortScene(s.scene)} · ${s.actors.join('、')}${s.cwds.length ? ` · 在 ${s.cwds.map((d) => shortDir(d)).join('、')}` : ''}`,
    ...s.facts.map((f) => `  ${f.text}`),
  ])
  return [head, ...scenes].join('\n')
}

// ---- check: how the library stands ----

/** What needs looking at, by kind: the key the pages and commands use, and the kind of mark it is kept as. */
export type StandingKind = 'stale' | 'gone' | 'upstream' | 'unowned' | 'closed' | 'changed' | 'missing' | 'moved'
export const STANDING_ORDER: readonly StandingKind[] = ['stale', 'gone', 'upstream', 'unowned', 'closed', 'changed', 'missing', 'moved']

/** One kind of what needs looking at: how many, at least when past what storage counts, and the first ones. */
export type StandingList = { kind: StandingKind; count: number; atLeast: boolean; rows: MarkRow[] }

/** How many entries a list in check names; past that it says how many there are and where they all are. */
export const LIST_LIMIT = 20

/** The sources a line names: the first three, then how many more. */
const refsText = (refs: readonly Ref[] | undefined) => {
  const all = refs ?? []
  return `${all.slice(0, 3).map((r) => r.path).join('、')}${all.length > 3 ? ` 等 ${all.length} 样` : ''}`
}

/** One row of a kind as check's line says it. */
export function standingLine(kind: StandingKind, m: MarkRow): string {
  switch (kind) {
    case 'stale':
      return `  ${m.path} ← 依据 ${refsText(m.sources)} 变了`
    case 'gone':
      return `  ${m.path} ← 依据 ${refsText(m.sources)} 不在了`
    case 'upstream':
      return `  ${m.path} ← 上游 ${refsText(m.sources)} 有标记`
    case 'unowned':
      return `  ${m.path}${m.adopted ? '（入了册，来历不明）' : ''}`
    case 'closed':
      return `  ${m.path}/`
    case 'changed':
    case 'missing':
      return `  ${m.path}`
    case 'moved':
      return `  ${m.path} → ${m.to ?? ''}，已接回`
  }
}

const TITLES: Record<StandingKind, string> = { stale: '可能过期', gone: '来源不在', upstream: '上游有标记', unowned: '没人登记过的', closed: '没登记的目录', changed: '被直接改过的', missing: '不在了的', moved: '挪过的' }
const AFTER: Partial<Record<StandingKind, string>> = {
  unowned: '它们不是经 put 放进来的。要留着用的，知道来历就用 put <库内路径> --brought 或 --made 补上；不要的归档。',
  changed: '是你改的，就用 say revised <库内路径> 认下；主人说是自己改的，加 --by owner。',
}

/** The data a section of check carries for one row, by kind: the thing, and the sources, the upstream or the new place it names. */
function rowData(kind: StandingKind, m: MarkRow) {
  const ref = { item: m.item as ItemId, path: m.path }
  switch (kind) {
    case 'stale':
    case 'gone':
      return { ...ref, sources: m.sources ?? [] }
    case 'upstream':
      return { ...ref, via: m.sources ?? [] }
    case 'unowned':
      return m.adopted ? { ...ref, adopted: true } : { path: m.path, adopted: false }
    case 'closed':
      return { path: m.path }
    case 'changed':
    case 'missing':
      return ref
    case 'moved':
      return { item: m.item as ItemId, from: m.path, to: m.to ?? m.path }
  }
}

/**
 * check's sections, empty ones left out. Each names at most `limit` things, then how many there are and
 * the page that lists them all; `data` carries the same first ones and the count. `partial`: open
 * directories with more entries than one look lists.
 */
export function standingSections(lists: readonly StandingList[], partial: readonly { dir: string; atLeast: number }[], limit = LIST_LIMIT): PluginSection[] {
  const more = partial.map((m) => `${m.dir === '' ? '库的根目录' : `${m.dir}/`}的条目多，只看了前面的，至少还有 ${m.atLeast} 个没看。`)
  return lists
    .filter((l) => l.count > 0)
    .map((l) => {
      const shown = l.rows.slice(0, limit)
      const total = `${l.atLeast ? '至少 ' : ''}${l.count}`
      const rest = l.count > shown.length ? [`  ……共 ${total} 样，看全部：show ledger.standing --kind ${l.kind}`] : []
      const after = [...(l.kind === 'unowned' ? more : []), ...(AFTER[l.kind] ? [AFTER[l.kind] as string] : [])]
      return { title: TITLES[l.kind], body: [...shown.map((m) => standingLine(l.kind, m)), ...rest, ...after].join('\n'), data: { count: l.count, shown: shown.map((m) => rowData(l.kind, m)) } }
    })
}

export const standingTitle = (kind: StandingKind) => TITLES[kind]
/** Which marks a kind of what needs looking at is kept as. */
export const markOfKind = (kind: StandingKind): MarkKind => kind

/** Whether a thing is shown in the lists: not removed, not part of a bundle, and not archived unless asked. */
export const shownIn = (item: ItemRow, includeArchived: boolean) => !item.removed && item.absorbedInto === null && (includeArchived || !archived(item))

/** An archived thing by the path people know it by. */
export const inArchive = (path: LibraryPath) => regionOf(path) === 'archive'
