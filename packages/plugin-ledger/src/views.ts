// What the ledger answers: data for --json and short Chinese text for agents. Pure, except that
// text reads the home directory to show it as ~ (the kernel's shortDir). ledger-design.md section 7.
import { posix } from 'node:path'
import { originalPath, regionOf, shortDir, type Instant, type LibraryPath, type PluginHit, type PluginSection } from '@pneuma-base/kernel'
import { ADHOC_SCENE, type Fact, type FactActor, type ItemId, type LedgerOrigin, type SceneId } from './facts.js'
import { actorKey, isArchived, type ItemRecord, type Ledger, type Said, type SceneRecord, type Version } from './fold.js'
import { marksOf, type ItemState, type Mark, type Standing } from './reconcile.js'

export const when = (at: Instant) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
export const who = (a: FactActor) => (a.kind === 'owner' ? '主人' : a.name)
/**
 * The actors of a scene by name, each name once: one agent can act in a scene both with a grant and
 * without one, or under two grants, which are distinct actors with the same name.
 */
export const actorNames = (actors: FactActor[]) => [...new Set(actors.map(who))].join('、')

/** A scene id as text shows it: its first 8 characters; an ad hoc scene's id whole. */
export const shortScene = (id: SceneId) => (id.startsWith(ADHOC_SCENE) ? id : id.slice(0, 8))

const SCENE_PREFIX_MIN = 6

/** The scenes an input names: the one with that id, else those whose id starts with it when it has at least 6 characters. */
export function scenesNamed(ledger: Ledger, input: string): SceneRecord[] {
  const exact = ledger.scenes.get(input as SceneId)
  if (exact) return [exact]
  return input.length < SCENE_PREFIX_MIN ? [] : [...ledger.scenes.values()].filter((s) => s.id.startsWith(input))
}

/** Who was in a scene, when it began, what it was doing. */
function sceneParts(scene: SceneRecord): string[] {
  const doing = [...new Set(scene.said.filter((s) => s.flavor === 'doing').map((s) => s.text))]
  return [actorNames(scene.actors), when(scene.first), ...(doing.length ? [`在做：${doing.join('；')}`] : [])]
}

/** The heading find puts a scene's hits under. */
const sceneLine = (scene: SceneRecord) => [`场景 ${shortScene(scene.id)}`, ...sceneParts(scene)].join(' · ')

/** The answer to a scene id prefix that several scenes share: each with its whole id. */
export function ambiguousText(prefix: string, scenes: SceneRecord[]): string {
  return [`有 ${scenes.length} 个场景的编号以 ${prefix} 开头，写长一点再看：`, ...scenes.map((s) => `  ${[s.id, ...sceneParts(s)].join(' · ')}`)].join('\n')
}

export function originLabel(origin: LedgerOrigin): string {
  if (origin.kind === 'made') return '做出来的'
  if (origin.kind === 'adopted') return '来历不明'
  return origin.by === 'owner' ? '带进来的，主人给的' : '带进来的'
}

export const STATE_LABEL: Record<ItemState['kind'], string> = { consistent: '一致', changed: '已变', moved: '已搬', missing: '不在', removed: '已除', absorbed: '并入' }
export const MARK_LABEL: Record<Mark['kind'], string> = { stale: '可能过期', 'source-gone': '来源不在' }

const pathOf = (ledger: Ledger, id: ItemId) => ledger.items.get(id)?.path ?? id

/** What the scene was doing when `at` came: its latest `doing` up to then, else its first. */
export function doingAt(scene: SceneRecord | undefined, at: Instant): string | null {
  const doings = scene?.said.filter((s) => s.flavor === 'doing') ?? []
  return (doings.filter((s) => s.at <= at).at(-1) ?? doings[0])?.text ?? null
}

// ---- inspect: an item ----

export type BasisRow = { item: ItemId; path: LibraryPath | ItemId; fingerprint: string; state: ItemState['kind']; mark: Mark['kind'] | null }
export type SaidRow = { flavor: Said['flavor']; text: string; at: Instant; scene: SceneId; actor: FactActor; about: LibraryPath | ItemId | null }

export type ItemView = {
  kind: 'item'
  item: ItemId
  path: LibraryPath
  origin: LedgerOrigin
  entered: { at: Instant; scene: SceneId; actor: FactActor; where: Fact['where'] }
  doing: string | null
  basis: BasisRow[]
  outside: string[]
  dependents: { item: ItemId; path: LibraryPath }[]
  said: SaidRow[]
  state: ItemState
  versions: Version[]
  held: string[]
  archived: boolean
  absorbedInto: LibraryPath | null // the bundle it is part of now
  unknownOrigin: boolean // adopted, and nobody said where it came from since
  bundle: boolean
}

const saidRow = (ledger: Ledger, s: Said): SaidRow => ({
  flavor: s.flavor,
  text: s.text,
  at: s.at,
  scene: s.scene,
  actor: s.actor,
  about: s.about === null ? null : pathOf(ledger, s.about),
})

/** `states` holds the item's state and its basis items' states. `held` lists its kept old versions. */
export function itemView(ledger: Ledger, item: ItemRecord, states: ReadonlyMap<ItemId, ItemState>, held: string[]): ItemView {
  const { entered } = item
  const scene = ledger.scenes.get(entered.scene)
  const marks = new Map(marksOf(item, ledger, (id) => states.get(id)).map((m) => [m.source, m.kind]))
  const ownScene = scene?.said.filter((s) => s.about === null && s.flavor !== 'doing') ?? []
  const said = [...new Map([...item.said, ...ownScene].map((s) => [s.id, s])).values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  return {
    kind: 'item',
    item: item.id,
    path: item.path,
    origin: item.origin,
    entered: { at: entered.at, scene: entered.scene, actor: entered.actor, where: entered.where },
    doing: doingAt(scene, entered.at),
    basis: item.basis.items.map((row) => ({
      item: row.item,
      path: pathOf(ledger, row.item),
      fingerprint: row.fingerprint,
      state: states.get(row.item)?.kind ?? 'missing',
      mark: marks.get(row.item) ?? null,
    })),
    outside: item.basis.outside,
    dependents: [...ledger.items.values()].filter((o) => !o.removed && o.basis.items.some((row) => row.item === item.id)).map((o) => ({ item: o.id, path: o.path })),
    said: said.map((s) => saidRow(ledger, s)),
    state: states.get(item.id) ?? { kind: 'missing' },
    versions: item.versions,
    held,
    archived: isArchived(item),
    absorbedInto: item.absorbedInto === null ? null : (ledger.items.get(item.absorbedInto)?.path ?? null),
    unknownOrigin: item.unknownOrigin,
    bundle: item.bundle,
  }
}

export const SAID_LABEL: Record<Said['flavor'], string> = { doing: '在做', decided: '决定', note: '备注' }

export function itemText(v: ItemView): string {
  const where = v.entered.where?.cwd ? ` · 在 ${shortDir(v.entered.where.cwd)}` : ''
  const lines = [`${originLabel(v.origin)} · ${who(v.entered.actor)} · ${when(v.entered.at)}${where} · 场景 ${shortScene(v.entered.scene)}`]
  if (v.origin.kind === 'brought' && v.origin.source) lines.push(`出处：${v.origin.source}`)
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
  if (v.versions.length > 1) {
    // A held copy lies at held/<item>/<fingerprint>/<name>, so the version it keeps is the one with that fingerprint.
    const kept = new Set(v.held.flatMap((path) => path.split('/').slice(-2, -1)))
    for (const ver of v.versions) {
      const claimed = ver.by === 'owner' ? `主人直接改的，${who(ver.actor)} 代记` : '认了直接改动'
      const how = [...(ver.claimed ? [claimed] : []), ...(kept.has(ver.fingerprint) ? ['被换下，在留存里'] : [])].join('，')
      lines.push(`  ${ver.fingerprint.slice(0, 8)}  ${when(ver.at)}  ${who(ver.actor)}${how ? `  ${how}` : ''}`)
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
  said: SaidRow[]
  items: { item: ItemId; path: LibraryPath; enteredHere: boolean; origin: LedgerOrigin }[]
}

export function sceneView(ledger: Ledger, scene: SceneRecord): SceneView {
  return {
    kind: 'scene',
    id: scene.id,
    first: scene.first,
    last: scene.last,
    actors: scene.actors,
    cwds: scene.cwds,
    said: scene.said.map((s) => saidRow(ledger, s)),
    items: scene.items.flatMap((id) => {
      const item = ledger.items.get(id)
      return item ? [{ item: id, path: item.path, enteredHere: item.entered.scene === scene.id, origin: item.origin }] : []
    }),
  }
}

export function sceneText(v: SceneView): string {
  const lines = [`场景 ${shortScene(v.id)}`, `${actorNames(v.actors)} · ${when(v.first)} 到 ${when(v.last)}${v.cwds.length ? ` · 在 ${v.cwds.map((d) => shortDir(d)).join('、')}` : ''}`]
  for (const s of v.said) lines.push(`${SAID_LABEL[s.flavor]}：${s.text}${s.about !== null ? `（关于 ${s.about}）` : ''}`)
  if (v.items.length > 0) lines.push('条目：', ...v.items.map((i) => `  ${i.path}  ${i.enteredHere ? `在这里放入，${originLabel(i.origin)}` : '在这里改过或挪过'}`))
  return lines.join('\n')
}

// ---- check: since last time ----

export const SINCE_LIMIT = 20

/** Owner commands that change neither the content nor the capabilities: recorded as facts, but no news to an agent. */
export const QUIET_OWNER_COMMANDS: ReadonlySet<string> = new Set(['init', 'grant issue', 'grant revoke', 'skill install'])

/** A read-only owner command, such as a listing, is no news either; its fact says so. */
const isNews = (f: Fact) => f.kind !== 'owner.op' || !(QUIET_OWNER_COMMANDS.has(f.command) || f.readOnly)

export type SinceFact = { kind: Fact['kind']; at: Instant; actor: string; text: string }
export type SinceView = { since: Instant | null; scenes: { scene: SceneId; actors: string[]; cwds: string[]; facts: SinceFact[] }[] }

/**
 * What others did since this actor was last here: from its latest fact in another scene, else
 * from the start, at most the latest `SINCE_LIMIT` facts that are news, by scene.
 */
export function sinceView(ledger: Ledger, me: FactActor, current: SceneId, since: Instant | 'last' | null): SinceView {
  const mine = actorKey(me)
  const start = since === null || since === 'last' ? (ledger.facts.filter((f) => actorKey(f.actor) === mine && f.scene !== current).at(-1)?.at ?? null) : since
  const recent = ledger.facts.filter((f) => actorKey(f.actor) !== mine && f.scene !== current && (start === null || f.at > start) && isNews(f)).slice(-SINCE_LIMIT)
  const scenes = new Map<SceneId, SinceView['scenes'][number]>()
  for (const f of recent) {
    const entry = scenes.get(f.scene) ?? { scene: f.scene, actors: [], cwds: [], facts: [] }
    scenes.set(f.scene, entry)
    if (!entry.actors.includes(who(f.actor))) entry.actors.push(who(f.actor))
    if (f.where?.cwd && !entry.cwds.includes(f.where.cwd)) entry.cwds.push(f.where.cwd)
    entry.facts.push({ kind: f.kind, at: f.at, actor: who(f.actor), text: factLine(ledger, f) })
  }
  return { since: start, scenes: [...scenes.values()] }
}

/** One fact as one line of text, paths as they are now where they moved since. */
export function factLine(ledger: Ledger, f: Fact): string {
  const now = (id: ItemId, then: LibraryPath) => {
    const path = pathOf(ledger, id)
    return path === then ? then : `${then}（现在在 ${path}）`
  }
  switch (f.kind) {
    case 'said':
      return `${SAID_LABEL[f.flavor]}：${f.text}${f.about !== null ? `（关于 ${pathOf(ledger, f.about)}）` : ''}`
    case 'item.enter':
      return `放入 ${now(f.item, f.path)}（${originLabel(f.origin)}）`
    case 'item.revise':
      if (!f.claimed) return `${pathOf(ledger, f.item)} 换了新内容`
      return f.by === 'owner' ? `记下 ${pathOf(ledger, f.item)} 是主人直接改的` : `认了 ${pathOf(ledger, f.item)} 的直接改动`
    case 'item.move': {
      const seen = f.how === 'observed' ? '（看到的）' : ''
      if (f.archive === 'in') return `归档 ${f.from}${seen}`
      if (f.archive === 'out') return `取回 ${f.to}${seen}`
      return `挪 ${f.from} → ${f.to}${seen}`
    }
    case 'item.basis':
      return `补上 ${pathOf(ledger, f.item)} 的依据`
    case 'item.remove':
      return `${pathOf(ledger, f.item)} 随归档区一起清掉了`
    case 'owner.op':
      return f.actor.kind === 'owner' ? `主人面的操作 ${f.command}：${f.summary}` : `执行 ${f.command}：${f.summary}`
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

type Ref = { item: ItemId; path: LibraryPath | ItemId }

/** What needs looking at after full reconciliation, by kind. The data of check's sections and of the standing page. */
export type StandingData = {
  stale: (Ref & { sources: Ref[] })[]
  gone: (Ref & { sources: Ref[] })[]
  upstream: (Ref & { via: Ref[] })[]
  unowned: ({ path: LibraryPath; adopted: false } | (Ref & { adopted: true }))[]
  changed: Ref[]
  missing: Ref[]
  moved: { item: ItemId; from: LibraryPath; to: LibraryPath }[]
}

/**
 * An archived item is no subject of these lists, and an unowned file in the archive is not
 * listed, unless `includeArchived`.
 */
export function standingData(ledger: Ledger, standing: Standing, includeArchived: boolean): StandingData {
  const shown = (item: ItemRecord) => !item.removed && item.absorbedInto === null && (includeArchived || !isArchived(item))
  const items = [...ledger.items.values()].filter(shown)
  const ref = (id: ItemId): Ref => ({ item: id, path: pathOf(ledger, id) })
  const withMark = (kind: Mark['kind']) =>
    items.flatMap((item) => {
      const sources = (standing.marks.get(item.id) ?? []).filter((m) => m.kind === kind).map((m) => ref(m.source))
      return sources.length > 0 ? [{ ...ref(item.id), sources }] : []
    })
  const inState = (kind: ItemState['kind']) => items.filter((item) => standing.states.get(item.id)?.kind === kind).map((item) => ref(item.id))
  return {
    stale: withMark('stale'),
    gone: withMark('source-gone'),
    upstream: items
      .filter((item) => !standing.marks.has(item.id) && standing.upstream.has(item.id))
      .map((item) => ({ ...ref(item.id), via: (standing.upstream.get(item.id) ?? []).map(ref) })),
    unowned: [
      ...standing.unowned.filter((path) => includeArchived || regionOf(path) !== 'archive').map((path) => ({ path, adopted: false as const })),
      ...items.filter((item) => item.unknownOrigin).map((item) => ({ ...ref(item.id), adopted: true as const })),
    ],
    changed: inState('changed'),
    missing: inState('missing'),
    moved: [...ledger.items.values()].flatMap((item) => {
      const state = standing.states.get(item.id)
      return state?.kind === 'moved' ? [{ item: item.id, from: item.path, to: state.to }] : []
    }),
  }
}

/** check's sections, empty ones left out. */
export function standingSections(ledger: Ledger, standing: Standing, includeArchived: boolean): PluginSection[] {
  const { stale, gone, upstream, unowned, changed, missing, moved } = standingData(ledger, standing, includeArchived)
  const names = (rows: { path: string }[]) => rows.map((r) => r.path).join('、')
  const sections: [string, unknown[], string[]][] = [
    ['可能过期', stale, stale.map((r) => `  ${r.path} ← 依据 ${names(r.sources)} 变了`)],
    ['来源不在', gone, gone.map((r) => `  ${r.path} ← 依据 ${names(r.sources)} 不在了`)],
    ['上游有标记', upstream, upstream.map((r) => `  ${r.path} ← 上游 ${names(r.via)} 有标记`)],
    ['没人登记过的', unowned, [...unowned.map((r) => `  ${r.path}${r.adopted ? '（入了册，来历不明）' : ''}`), '它们不是经 put 放进来的。要留着用的，知道来历就用 put <库内路径> --brought 或 --made 补上；不要的归档。']],
    ['被直接改过的', changed, [...changed.map((r) => `  ${r.path}`), '是你改的，就用 say revised <库内路径> 认下；主人说是自己改的，加 --by owner。']],
    ['不在了的', missing, missing.map((r) => `  ${r.path}`)],
    ['挪过的', moved, moved.map((r) => `  ${r.from} → ${r.to}，已接回`)],
  ]
  return sections.filter(([, data]) => data.length > 0).map(([title, data, lines]) => ({ title, body: lines.join('\n'), data }))
}

// ---- find ----

export type Candidate = { hit: PluginHit; haystack: string }

/** An item, under the heading of the scene it was entered in. */
export function itemHit(ledger: Ledger, item: ItemRecord): PluginHit {
  const scene = ledger.scenes.get(item.entered.scene)
  return { path: item.path, title: posix.basename(item.path), group: scene ? sceneLine(scene) : null, detail: originLabel(item.origin) }
}

/** The parts of a find request the ledger reads, and the scene to leave out: start's own, or null. */
export type FindScope = { filters: Record<string, string>; includeArchived: boolean; skip: SceneId | null }

/**
 * The items and scenes find looks at, with the text each is matched against. Items: the path, what
 * was said about it, where it was brought from, and its text `content` when given. Scenes: what was
 * said in them. A scene's own hit is its group's detail: where it was and what it decided.
 */
export function findCandidates(ledger: Ledger, opts: FindScope & { content: ReadonlyMap<ItemId, string> }): Candidate[] {
  const { scene: sceneFilter, origin: originFilter } = opts.filters
  const named = sceneFilter === undefined ? null : scenesNamed(ledger, sceneFilter)
  const items = findableItems(ledger, opts).map((item): Candidate => {
    const shown = regionOf(item.path) === 'archive' ? (originalPath(item.path) ?? item.path) : item.path
    const source = item.origin.kind === 'brought' ? [item.origin.source ?? '', item.origin.by ?? ''] : []
    const haystack = [shown, ...item.said.map((s) => s.text), ...source, opts.content.get(item.id) ?? ''].join('\n').toLowerCase()
    return { hit: itemHit(ledger, item), haystack }
  })
  const scenes = originFilter !== undefined ? [] : (named ?? [...ledger.scenes.values()]).filter((s) => s.id !== opts.skip && s.said.length > 0)
  return [
    ...items,
    ...scenes.map((s): Candidate => {
      const decided = s.said.filter((x) => x.flavor === 'decided').map((x) => x.text)
      const parts = [...(s.cwds.length ? [`在 ${s.cwds.map((d) => shortDir(d)).join('、')}`] : []), ...(decided.length ? [`决定：${decided.join('；')}`] : [])]
      const hit: PluginHit = { path: null, title: `场景 ${s.id}`, group: sceneLine(s), detail: parts.length ? parts.join(' · ') : null }
      return { hit, haystack: s.said.map((x) => x.text).join('\n').toLowerCase() }
    }),
  ]
}

/** The items a find with these filters may give. A scene filter takes a scene id or a prefix of one, as inspect does. */
export function findableItems(ledger: Ledger, opts: FindScope): ItemRecord[] {
  const { scene, origin } = opts.filters
  const named = scene === undefined ? null : scenesNamed(ledger, scene)
  return [...ledger.items.values()].filter(
    (item) =>
      !item.removed &&
      item.absorbedInto === null &&
      item.entered.scene !== opts.skip &&
      (opts.includeArchived || !isArchived(item)) &&
      (origin === undefined || item.origin.kind === origin) &&
      (named === null || named.some((s) => s.items.includes(item.id))),
  )
}
