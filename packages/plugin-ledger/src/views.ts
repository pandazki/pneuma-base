// What the ledger answers: data for --json and short Chinese text for agents. Pure.
// ledger-design.md section 7.
import { posix } from 'node:path'
import { originalPath, regionOf, type Instant, type LibraryPath, type PluginHit } from '@pneuma-base/kernel'
import type { Fact, FactActor, ItemId, LedgerOrigin, SceneId } from './facts.js'
import { actorKey, isArchived, type ItemRecord, type Ledger, type Said, type SceneRecord, type Version } from './fold.js'
import { marksOf, type ItemState, type Mark } from './reconcile.js'

export const when = (at: Instant) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
const who = (a: FactActor) => (a.kind === 'owner' ? '主人' : a.name)

export function originLabel(origin: LedgerOrigin): string {
  if (origin.kind === 'made') return '做出来的'
  if (origin.kind === 'adopted') return '来历不明'
  return origin.by === 'owner' ? '带进来的，主人给的' : '带进来的'
}

export const STATE_LABEL: Record<ItemState['kind'], string> = { consistent: '一致', changed: '已变', moved: '已搬', missing: '不在', removed: '已除' }
const MARK_LABEL: Record<Mark['kind'], string> = { stale: '可能过期', 'source-gone': '来源不在' }

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
  }
}

const SAID_LABEL: Record<Said['flavor'], string> = { doing: '在做', decided: '决定', note: '备注' }

export function itemText(v: ItemView): string {
  const where = v.entered.where?.cwd ? ` · 在 ${v.entered.where.cwd}` : ''
  const lines = [`${originLabel(v.origin)} · ${who(v.entered.actor)} · ${when(v.entered.at)}${where} · 场景 ${v.entered.scene}`]
  if (v.origin.kind === 'brought' && v.origin.source) lines.push(`出处：${v.origin.source}`)
  if (v.doing) lines.push(`当时在做：${v.doing}`)
  if (v.basis.length > 0 || v.outside.length > 0) {
    lines.push('依据：')
    for (const b of v.basis) lines.push(`  ${b.path}  ${STATE_LABEL[b.state]}${b.mark ? ` ← ${MARK_LABEL[b.mark]}` : ''}`)
    for (const o of v.outside) lines.push(`  库外：${o}`)
  }
  if (v.dependents.length > 0) lines.push(`被依据：${v.dependents.map((d) => d.path).join('、')}`)
  for (const s of v.said) lines.push(`${SAID_LABEL[s.flavor]}：${s.text}${s.about !== null && s.about !== v.path ? `（关于 ${s.about}）` : ''}`)
  const state = v.state.kind === 'moved' ? `已搬到 ${v.state.to}` : STATE_LABEL[v.state.kind]
  lines.push(`现状：${state}${v.archived ? ' · 已归档' : ''} · ${v.versions.length} 个版本，${v.held.length} 份留存 · 条目 ${v.item}`)
  if (v.versions.length > 1) {
    for (const ver of v.versions) {
      const how = ver.claimed ? '认了直接改动' : ver.held ? '换下的旧版留存了' : ''
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
  const lines = [`场景 ${v.id}`, `${v.actors.map(who).join('、')} · ${when(v.first)} 到 ${when(v.last)}${v.cwds.length ? ` · 在 ${v.cwds.join('、')}` : ''}`]
  for (const s of v.said) lines.push(`${SAID_LABEL[s.flavor]}：${s.text}${s.about !== null ? `（关于 ${s.about}）` : ''}`)
  if (v.items.length > 0) lines.push('条目：', ...v.items.map((i) => `  ${i.path}  ${i.enteredHere ? `在这里放入，${originLabel(i.origin)}` : '在这里改过或挪过'}`))
  return lines.join('\n')
}

// ---- check: since last time ----

export const SINCE_LIMIT = 20

export type SinceFact = { kind: Fact['kind']; at: Instant; actor: string; text: string }
export type SinceView = { since: Instant | null; scenes: { scene: SceneId; actors: string[]; cwds: string[]; facts: SinceFact[] }[] }

/**
 * What others did since this actor was last here: from its latest fact in another scene, else
 * from the start, at most the latest `SINCE_LIMIT` facts, by scene.
 */
export function sinceView(ledger: Ledger, me: FactActor, current: SceneId, since: Instant | 'last' | null): SinceView {
  const mine = actorKey(me)
  const start = since === null || since === 'last' ? (ledger.facts.filter((f) => actorKey(f.actor) === mine && f.scene !== current).at(-1)?.at ?? null) : since
  const recent = ledger.facts.filter((f) => actorKey(f.actor) !== mine && f.scene !== current && (start === null || f.at > start)).slice(-SINCE_LIMIT)
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

function factLine(ledger: Ledger, f: Fact): string {
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
      return f.claimed ? `认了 ${pathOf(ledger, f.item)} 的直接改动` : `${pathOf(ledger, f.item)} 有了新的一版`
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
      return `主人面的操作 ${f.command}：${f.summary}`
  }
}

export function sinceText(v: SinceView): string {
  const head = v.since === null ? '你第一次来，下面是最近的记录：' : `${when(v.since)} 以来：`
  const scenes = v.scenes.flatMap((s) => [
    `场景 ${s.scene} · ${s.actors.join('、')}${s.cwds.length ? ` · 在 ${s.cwds.join('、')}` : ''}`,
    ...s.facts.map((f) => `  ${f.text}`),
  ])
  return [head, ...scenes].join('\n')
}

// ---- find ----

export type Candidate = { hit: PluginHit; haystack: string }

export function itemHit(ledger: Ledger, item: ItemRecord): PluginHit {
  const { entered } = item
  const doing = doingAt(ledger.scenes.get(entered.scene), entered.at)
  const parts = [originLabel(item.origin), who(entered.actor), when(entered.at), `场景 ${entered.scene}`, ...(doing ? [`在做：${doing}`] : []), ...(isArchived(item) ? ['已归档'] : [])]
  return { path: item.path, title: posix.basename(item.path), detail: parts.join(' · ') }
}

/**
 * The items and scenes find looks at, with the text each is matched against. Items: the path, what
 * was said about it, where it was brought from, and its text `content` when given. Scenes: what was
 * said in them. The caller's own scene is left out.
 */
export function findCandidates(
  ledger: Ledger,
  opts: { filters: Record<string, string>; includeArchived: boolean; current: SceneId; content: ReadonlyMap<ItemId, string> },
): Candidate[] {
  const { scene: sceneFilter, origin: originFilter } = opts.filters
  const items = findableItems(ledger, opts).map((item): Candidate => {
    const shown = regionOf(item.path) === 'archive' ? (originalPath(item.path) ?? item.path) : item.path
    const source = item.origin.kind === 'brought' ? [item.origin.source ?? '', item.origin.by ?? ''] : []
    const haystack = [shown, ...item.said.map((s) => s.text), ...source, opts.content.get(item.id) ?? ''].join('\n').toLowerCase()
    return { hit: itemHit(ledger, item), haystack }
  })
  const scenes = originFilter !== undefined ? [] : [...ledger.scenes.values()].filter((s) => s.id !== opts.current && (sceneFilter === undefined || s.id === sceneFilter) && s.said.length > 0)
  return [
    ...items,
    ...scenes.map((s): Candidate => {
      const doing = s.said.filter((x) => x.flavor === 'doing').map((x) => x.text)
      const decided = s.said.filter((x) => x.flavor === 'decided').map((x) => x.text)
      const parts = [s.actors.map(who).join('、'), when(s.first), ...(s.cwds.length ? [`在 ${s.cwds.join('、')}`] : []), ...(doing.length ? [`在做：${doing.join('；')}`] : []), ...(decided.length ? [`决定：${decided.join('；')}`] : [])]
      return { hit: { path: null, title: `场景 ${s.id}`, detail: parts.join(' · ') }, haystack: s.said.map((x) => x.text).join('\n').toLowerCase() }
    }),
  ]
}

/** The items a find with these filters may give. */
export function findableItems(ledger: Ledger, opts: { filters: Record<string, string>; includeArchived: boolean }): ItemRecord[] {
  const { scene, origin } = opts.filters
  return [...ledger.items.values()].filter(
    (item) =>
      !item.removed &&
      (opts.includeArchived || !isArchived(item)) &&
      (origin === undefined || item.origin.kind === origin) &&
      (scene === undefined || ledger.scenes.get(scene as SceneId)?.items.includes(item.id) === true),
  )
}
