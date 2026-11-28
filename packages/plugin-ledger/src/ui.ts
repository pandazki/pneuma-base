// What the ledger shows in the management UI: the library page, the standing page, the held copies,
// its section of the kernel's item panel, and the pieces its feeds share (feeds.ts). Each page is
// built from the rows it shows, read by query a page at a time.
import {
  formOf,
  originalPath,
  pageOfList,
  pagingOf,
  placeActions,
  probeWords,
  shortDir,
  withSuffix,
  type Action,
  type ActionInput,
  type ActorMark,
  type Block,
  type Cell,
  type Grant,
  type Instant,
  type ItemSection,
  type LibraryPath,
  type Link,
  type Paging,
  type Probe,
  type Tag,
  type TableRow,
  type TreeNode,
  type ViewAnswer,
  type ViewDecl,
} from '@pneuma-base/kernel'
import { reopenFor } from './conversation.js'
import type { FactActor, How, SceneId } from './facts.js'
import { HELD_DROP, HELD_RESTORE, type heldCopies } from './held.js'
import { archived, stateOfRow, type ItemRow, type MarkRow, type OriginLike, type SceneRow } from './model.js'
import { DEFAULT_PERIOD, PERIODS } from './stats.js'
import { closedActions } from './unowned.js'
import { earlierText, heldKeyOf, keeps, LIST_LIMIT, MARK_LABEL, originLabel, SAID_LABEL, shortScene, STANDING_ORDER, standingTitle, STATE_LABEL, when, who, type ItemView, type Lookup, type StandingKind, type StandingList } from './views.js'
import { commandNow } from './words.js'

export const HOME_VIEW = 'ledger.home'
export const ITEMS_VIEW = 'ledger.items'
export const SCENES_VIEW = 'ledger.scenes'
export const SCENE_VIEW = 'ledger.scene'
export const STANDING_VIEW = 'ledger.status'
export const ACTIVITY_VIEW = 'ledger.activity'
export const HELD_VIEW = 'ledger.copies'
export const STATS_VIEW = 'ledger.stats'

/** What the library page shows: the things not archived, those brought in or made of them, or the archived ones. */
export const SHOWS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'imported', label: '导入' },
  { value: 'generated', label: '生成' },
  { value: 'archived', label: '已归档' },
]

export const WHO_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'agent', label: 'Agent' },
  { value: 'owner', label: '我' },
]

// The library page takes `dir` from its folder tree and the standing page `kind` from the home
// page's links; neither is a filter of the page's head, so neither is declared. `after` continues a
// long page where its last part ended.
export const LEDGER_VIEWS: readonly ViewDecl[] = [
  { id: ITEMS_VIEW, title: '资料库', icon: 'layers', nav: true, filters: [{ name: 'show', label: '显示', options: SHOWS, default: '' }] },
  {
    id: ACTIVITY_VIEW,
    title: '活动',
    icon: 'activity',
    nav: true,
    filters: [
      { name: 'who', label: '执行者', options: WHO_OPTIONS, default: '' },
      { name: 'agent', label: 'Agent', options: [{ value: '', label: '全部 Agent' }], default: '', as: 'menu' },
    ],
  },
  { id: STATS_VIEW, title: '统计', icon: 'chart-column', nav: true, filters: [{ name: 'period', label: '时间', options: [...PERIODS], default: DEFAULT_PERIOD }], with: ACTIVITY_VIEW },
  { id: SCENES_VIEW, title: '场景', icon: 'history', nav: true, filters: [], with: ACTIVITY_VIEW },
  { id: STANDING_VIEW, title: '状态', icon: 'gauge', nav: true, filters: [], with: ITEMS_VIEW },
  { id: HELD_VIEW, title: '历史副本', icon: 'box', nav: true, filters: [], with: ITEMS_VIEW },
  { id: SCENE_VIEW, title: '场景', icon: 'history', nav: false, filters: [] },
  { id: HOME_VIEW, title: '最近动态', icon: 'house', nav: false, filters: [], home: true },
]

export const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })
export const sceneLink = (scene: SceneId): Link => ({ view: SCENE_VIEW, params: { scene }, target: 'panel' })
export const moment = (at: Instant): Cell => ({ text: when(at), muted: true, at })
export const none: Cell = { text: '—', muted: true }

/** The link that continues a long page after its last row. */

// ---- who ----

/** The owner as the pages name it, which the owner reads; text an agent or the command line reads says 所有者 (views.ts OWNER). */
export const ME = '我'

/** An actor as blocks draw it: an agent with the name of the grant it used, the owner; the ledger's own observations by its name. */
export function actorMark(a: FactActor, grants: readonly Grant[]): ActorMark | string {
  if (a.kind === 'owner') return { kind: 'owner', name: ME }
  if (a.kind === 'plugin') return a.name
  const grant = a.grant === null ? undefined : (grants.find((g) => g.id === a.grant)?.name ?? a.grant)
  return { kind: 'agent', name: a.name, ...(grant === undefined ? {} : { grant }) }
}

/** A cell that says who: the actor's mark, and its name as the text. */
export function actorCell(a: FactActor, grants: readonly Grant[]): Cell {
  const mark = actorMark(a, grants)
  return typeof mark === 'string' ? { text: mark, muted: true } : { text: mark.name, actor: mark }
}

/** By which grant an actor acted, in words, under the label 授权: its name, area and access; the owner needs none. */
export function grantText(a: FactActor, grants: readonly Grant[]): string {
  if (a.kind !== 'agent') return a.kind === 'owner' ? '无需授权' : `${a.name} 自动检测`
  if (a.grant === null) return '未带授权：资料库未创建授权时，任何执行者均可访问整个资料库'
  const g = grants.find((x) => x.id === a.grant)
  if (g === undefined) return `${a.grant}（已撤销）`
  return `${g.name} · ${g.area === null ? '整个资料库' : g.area} · ${g.readOnly ? '只读' : '读写'}`
}

/** By which grant an agent acted, as a feed's meta: the grant's name, or that it had none; nothing for the owner. */
export function grantCell(a: FactActor, grants: readonly Grant[]): Cell | null {
  if (a.kind !== 'agent') return null
  if (a.grant === null) return { text: '未带授权', muted: true }
  return { text: `授权 ${grants.find((g) => g.id === a.grant)?.name ?? a.grant}`, muted: true, normal: true }
}

/** What a scene was doing: what it said it was doing, else the owner operations done in it; null when neither. */
export function sceneDoing(scene: SceneRow): string | null {
  const doing = [...new Set(scene.said.filter((s) => s.flavor === 'doing').map((s) => s.text))]
  if (doing.length > 0) return doing.join('；')
  const commands = [...new Set(scene.ops.map((op) => commandNow(op.command)))]
  const prefix = scene.ops.every((op) => op.actor.kind === 'owner') ? '所有者操作' : '执行命令'
  return commands.length > 0 ? `${prefix}：${commands.join('、')}` : null
}

/** A scene as a link: what it was doing, else its short id; with how to open its conversation again while that is on this machine. */
export function sceneCell(lookup: Lookup, id: SceneId): Cell {
  const scene = lookup.scenes.get(id)
  const doing = scene ? sceneDoing(scene) : null
  const reopen = scene ? reopenFor(scene) : null
  return { text: doing ?? `场景 ${shortScene(id)}`, link: sceneLink(id), ...(reopen === null ? {} : { reopen }) }
}

// ---- the owner's operations: each a call to one of the two faces ----

const input = (name: string, label: string, opts: Partial<Omit<ActionInput, 'name' | 'label'>> = {}): ActionInput => ({
  name,
  label,
  placeholder: opts.placeholder ?? null,
  value: opts.value ?? null,
  options: opts.options ?? null,
  ...(opts.multiple ? { multiple: true } : {}),
})

/** Giving a thing nobody registered its provenance: put register, brought in or made. Empty fields count as not given. */
export function provenanceActions(path: string): Action[] {
  return [
    {
      label: '标记为导入',
      tone: 'default',
      confirm: null,
      inputs: [
        input('source', '原始来源', { placeholder: 'URL、书名或其他来源；未知可留空' }),
        input('by', '导入者', { value: 'owner', options: [{ value: 'owner', label: ME }, { value: '', label: '未知' }] }),
      ],
      call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'brought', source: '{source}', by: '{by}' } } },
    },
    {
      label: '标记为生成',
      tone: 'default',
      confirm: null,
      inputs: [
        input('from', '依据的条目', { placeholder: '路径，每行一个', multiple: true }),
        input('outside', '外部依据', { placeholder: '每行一条，例如：对话中确认的需求', multiple: true }),
      ],
      call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'made', from: ['{from}'], outside: ['{outside}'] } } },
    },
  ]
}

/** Accepting a direct change as the new version: say revised. */
export const acceptAction = (path: string): Action => ({
  label: '确认修改',
  tone: 'default',
  icon: 'check',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: path, text: null, args: {} } },
})

/** Taking a held copy back to a new path: ledger copies restore. The suggested path is the item's with the old version's key in its name. */
function restoreAction(item: string, path: LibraryPath, isArchived: boolean, key: string): Action {
  const base = isArchived ? (originalPath(path) ?? path) : path
  const form = formOf(HELD_RESTORE, { fixed: { item, fingerprint: key }, values: { to: withSuffix(base, key.slice(0, 8)) } })
  return { label: '恢复到新路径', tone: 'default', confirm: null, as: 'icon', icon: 'archive-restore', ...form }
}

/** Saying something about a thing in one sentence: a note, written where its history is; a decision, from the menu. */
const sayAction = (path: string, kind: 'decision' | 'note', label: string, placeholder: string): Action => ({
  label,
  tone: 'default',
  confirm: null,
  inputs: [input('text', '说明', { placeholder })],
  call: { face: 'agent', verb: 'say', request: { kind, about: path, text: '{text}', args: {} } },
  as: kind === 'note' ? 'inline' : 'menu',
  icon: kind === 'note' ? 'message-square-plus' : 'scale',
})

/** Adding to what a thing was made from, an icon button: say basis, with paths in the library and sentences about what is outside. */
const basisAction = (path: string): Action => ({
  label: '补充依据',
  tone: 'default',
  as: 'icon',
  icon: 'link-2',
  confirm: null,
  inputs: [
    input('from', '依据的条目', { placeholder: '路径，每行一个', multiple: true }),
    input('outside', '外部依据', { placeholder: '每行一条，例如：对话中确认的需求', multiple: true }),
  ],
  call: { face: 'agent', verb: 'say', request: { kind: 'basis', about: path, text: null, args: { from: ['{from}'], 'from-external': ['{outside}'] } } },
})

// ---- states, quiet when normal ----

type StateKind = keyof typeof STATE_LABEL
const STATE_TONE: Record<StateKind, Tag['tone']> = { consistent: 'neutral', changed: 'warn', moved: 'info', missing: 'bad', removed: 'neutral', absorbed: 'neutral' }
const MARK_TONE: Record<keyof typeof MARK_LABEL, Tag['tone']> = { stale: 'warn', 'source-gone': 'bad' }

// Where a thing came from is a kind, not a state: grey words, except that nobody knowing is worth a look.
const originCell = (origin: OriginLike, how: How): Cell =>
  origin.kind === 'adopted' ? { text: '', tag: { text: originLabel(origin, how), tone: 'warn' } } : { text: originLabel(origin, how), muted: true }
// In the library's table, made is what most things are and goes unsaid; brought in is said, and who brought it is in the next column.
const originColumnCell = (origin: OriginLike, how: How): Cell =>
  origin.kind === 'made' && how !== 'observed' ? { text: originLabel(origin, how), muted: true, normal: true } : origin.kind === 'brought' && how !== 'observed' ? { text: '导入', muted: true } : originCell(origin, how)
const stateText = (state: ItemView['state']) => (state.kind === 'moved' ? `已移动到 ${state.to}` : STATE_LABEL[state.kind])
const stateTag = (state: ItemView['state']): Tag => ({ text: stateText(state), tone: STATE_TONE[state.kind] })

/** A normal state is grey words; a departure from it is a tag, the worst mark on the basis before the state. */
function stateCell(item: ItemRow): Cell {
  const gone = item.marks.some((k) => k.startsWith('gone:'))
  const stale = item.marks.some((k) => k.startsWith('stale:'))
  if (gone || stale) return { text: '', tag: { text: MARK_LABEL[gone ? 'source-gone' : 'stale'], tone: MARK_TONE[gone ? 'source-gone' : 'stale'] } }
  const state = stateOfRow(item)
  return state.kind === 'consistent' ? { text: STATE_LABEL.consistent, muted: true, normal: true } : { text: '', tag: stateTag(state) }
}

/** A basis row's state: grey words when it is as it was, else its mark or state as a tag. */
const basisState = (state: StateKind, mark: keyof typeof MARK_LABEL | null): Tag | null =>
  mark ? { text: MARK_LABEL[mark], tone: MARK_TONE[mark] } : state === 'consistent' ? null : { text: STATE_LABEL[state], tone: STATE_TONE[state] }

/** The path as people know it: an archived item by the path it came from. */
export const shownPath = (item: Pick<ItemRow, 'path'>) => (archived(item) ? (originalPath(item.path) ?? item.path) : item.path)
export const pathCell = (item: Pick<ItemRow, 'path' | 'bundle'>): Cell => ({
  text: shownPath(item),
  mono: true,
  icon: item.bundle ? 'package' : 'file',
  ...(archived(item) ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}),
})

/** Where a path is: its folder, after `dir` it is shown in; '' for one right in `dir`. */
const folderIn = (path: string, dir: string): string => {
  const inside = dir === '' ? path : path.slice(dir.length + 1)
  const cut = inside.lastIndexOf('/')
  return cut < 0 ? '' : inside.slice(0, cut)
}

// ---- the library page ----

/** The open directories as a tree: each with how many registered things lie under it, folders before their children, by name. */
export function folderTree(dirs: readonly { path: string; count: number }[], strip = ''): TreeNode[] {
  type Folder = { count: number; children: Map<string, Folder> }
  const root: Folder = { count: 0, children: new Map() }
  for (const { path, count } of dirs) {
    let at = root
    const parts = path.slice(strip.length).split('/')
    for (const [i, part] of parts.entries()) {
      const next = at.children.get(part) ?? { count: 0, children: new Map() }
      at.children.set(part, next)
      if (i === parts.length - 1) next.count = count
      at = next
    }
  }
  const nodes = (folder: Folder, prefix: string): TreeNode[] =>
    [...folder.children]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, f]) => ({ value: `${prefix}${name}`, label: name, count: f.count, children: nodes(f, `${prefix}${name}/`) }))
  return nodes(root, '')
}

// Who and where it came from step aside first when the panel needs the room; the panel has both.
const COLUMNS = [
  { key: 'path', label: '路径' },
  { key: 'origin', label: '来源', optional: true },
  { key: 'who', label: '执行者', optional: true },
  { key: 'state', label: '状态' },
  { key: 'at', label: '时间' },
]

/** One page of the library page: its rows, where the next page starts, and the counts and the tree it shows. */
/** One page of the library: the rows, the cursor of what follows, the counts and folders, the view's parameters and how many rows a page holds. */
export type ItemsPage = {
  show: string
  dir: string
  items: ItemRow[]
  after: string | null
  counts: Record<string, number>
  tree: { path: string; count: number }[]
  params: Record<string, string>
  size: number
  /** The closed directories right in the folder, the first of them with what a look into each found, and how many there are. */
  closed: { rows: { path: LibraryPath; look: Probe | null }[]; count: number }
}

/** The library page: the things `show` keeps in the folder `dir`, a page of them, with a tree of the open folders and how many each holds. */
export function itemsAnswer(page: ItemsPage, grants: readonly Grant[]): ViewAnswer {
  const { show, dir, items } = page
  // Rows stand under the folder they are in, said once: the name is all a row says of its path.
  const rows: TableRow[] = items.map((item) => {
    const path = shownPath(item)
    const group = folderIn(path, dir)
    return {
      key: item.id,
      cells: {
        path: { ...pathCell(item), text: group === '' ? path.slice(dir === '' ? 0 : dir.length + 1) : path.slice(path.lastIndexOf('/') + 1) },
        origin: originColumnCell(item.origin, item.entered.how),
        who: actorCell(item.entered.actor, grants),
        state: stateCell(item),
        at: moment(item.last.at),
      },
      link: itemLink(item.path),
      actions: [],
      ...(group === '' ? {} : { group: dir === '' ? group : `${dir}/${group}` }),
      place: { path: item.path, kind: item.bundle ? 'bundle' : 'file', token: item.now?.token ?? item.token },
    }
  })
  const empty =
    show !== '' || dir !== ''
      ? '暂无条目'
      : '暂无已登记条目。Agent 用 put 添加条目；资料库中原有的文件列在「状态」页，可在该页补充来源。'
  const shown = page.counts[show] ?? 0
  const tree: Block = { kind: 'tree', param: 'dir', selected: dir, nodes: [{ value: '', label: '全部', count: null, children: folderTree(page.tree, show === 'archived' ? '_archive/' : '') }] }
  // A folder's count is of everything in it, so only the whole of it has an exact total; a kind of thing in a folder counts as far as the page goes.
  const inFolder = page.tree.find((t) => t.path === (show === 'archived' ? `_archive/${dir}` : dir))?.count
  const exact = dir === '' ? shown : show === '' ? inFolder : undefined
  const at = { view: ITEMS_VIEW, params: page.params, rows: page.size, shown: rows.length, next: page.after }
  const paging = pagingOf(exact === undefined ? { ...at, total: rows.length + (page.after === null ? 0 : 1), atLeast: page.after !== null } : { ...at, total: exact })
  // Archived things are taken back one by one, from their own panel.
  const table: Block = { kind: 'table', columns: COLUMNS, rows, empty, page: paging, ...(show === 'archived' ? {} : { each: placeActions() }) }
  // How many: the tabs say it for the library, the tree for each folder.
  return { title: '资料库', subtitle: null, blocks: [tree, table, ...closedBlocks(page.closed)], filters: [{ name: 'show', options: SHOWS.map((o) => ({ ...o, count: page.counts[o.value] ?? 0 })) }] }
}

/** The closed directories of a folder: each one row with what a look into it found and its three answers, opening its panel. */
function closedBlocks(closed: ItemsPage['closed']): Block[] {
  if (closed.count === 0) return []
  const items = closed.rows.map(({ path, look }) => ({
    cell: { text: `${path.slice(path.lastIndexOf('/') + 1)}/`, mono: true, icon: 'folder-dot' as const, link: itemLink(path) },
    note: look === null ? null : probeWords(look),
    actions: closedActions(path, look),
  }))
  const all: Block[] = closed.count > closed.rows.length ? [{ kind: 'list', items: [{ cell: { text: `查看全部 ${closed.count} 个`, icon: 'list', link: { view: STANDING_VIEW, params: { kind: 'closed' }, target: 'main' } }, note: null, actions: [] }] }] : []
  return [{ kind: 'section', title: '未登记的目录', note: null, count: closed.count, blocks: [{ kind: 'list', items }, ...all], actions: [] }]
}

// ---- the item panel ----

/** A direct change as words: claimed, recorded for the owner, or only seen. */
const claimWords = (ver: ItemView['versions'][number]) => (ver.how === 'observed' ? '外部修改（自动登记）' : ver.by === 'owner' ? '所有者直接修改' : '已确认外部修改')

const counted = (title: string, count: number | null, blocks: Block[]): Extract<Block, { kind: 'section' }> => ({ kind: 'section', title, note: null, count, blocks, actions: [] })

/** A thing's state as words: as recorded, changed outside the library, moved, gone, removed, or part of a bundle now. */
function stateWords(v: ItemView): Cell {
  const { state } = v
  switch (state.kind) {
    case 'consistent':
      return { text: '一致', muted: true }
    case 'changed':
      return { text: state.now === null ? '仅比较了状态，内容未读取' : '内容与记录不一致', tag: { text: '外部修改', tone: 'warn' } }
    case 'moved':
      return { text: state.to, mono: true, link: itemLink(state.to), tag: { text: '已移动到', tone: 'info' } }
    case 'missing':
      return { text: '', tag: { text: '已缺失', tone: 'bad' } }
    case 'removed':
      return { text: '', tag: { text: '已删除', tone: 'neutral' } }
    case 'absorbed':
      return { text: v.absorbedInto ?? '', mono: true, icon: 'package', ...(v.absorbedInto === null ? {} : { link: itemLink(v.absorbedInto) }), tag: { text: '已合并到', tone: 'neutral' } }
  }
}

/** Reading a thing's content now: the named whole pass over this one thing. */
const readAction = (path: LibraryPath): Action => ({ label: '读取内容', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'check', request: { since: null, includeArchived: false, deep: { dir: path } } } })

/** Where the panel's lists stand and how many rows a page of each holds. */
export type PanelPage = { params: Record<string, string>; size: number }

/** One page of one of the panel's lists, under its own name, and the way to the pages around it. */
function panelPage<T>(all: readonly T[], panel: PanelPage, path: LibraryPath, name: string): { rows: T[]; page: Paging } {
  const { rows, next } = pageOfList(all, panel.params, panel.size, name)
  return { rows, page: pagingOf({ view: 'item', params: { ...panel.params, path }, rows: panel.size, shown: rows.length, next, total: all.length, target: 'panel', name }) }
}

/**
 * The ledger's part of the item panel, in the panel's order: who brought or made it, when, in which
 * scene, said as one line; its state only when it departs from the record; how it came, from where or
 * from what, each source with its state; what happened to it, each change and what was said, with the
 * line where one more note is written; what was made from it; its held copies; and, folded, the record
 * behind the line: whether its content was read, where the agent worked, by which grant. Each long list
 * a page at a time. Its other actions go to the panel's head.
 */
export function itemSection(v: ItemView, lookup: Lookup, grants: readonly Grant[], panel: PanelPage = { params: {}, size: LIST_LIMIT }): ItemSection {
  const { entered } = v
  const live = !v.archived && v.state.kind !== 'removed' && v.state.kind !== 'missing' && v.state.kind !== 'absorbed'
  // Reading is worth it where a fingerprint decides something: things rest on one never read, or only its state says a thing read before changed.
  const worthReading = live && ((v.state.kind === 'consistent' && v.fingerprint === null && v.dependents.length > 0) || (v.state.kind === 'changed' && v.state.now === null && v.fingerprint !== null))
  const blocks: Block[] = [
    { kind: 'fields', line: true, fields: [{ label: '执行者', value: actorCell(entered.actor, grants) }, { label: '来源', value: originCell(v.origin, v.entered.how) }, { label: '时间', value: moment(entered.at) }] },
    { kind: 'fields', line: true, fields: [{ label: '场景', value: { ...sceneCell(lookup, entered.scene), icon: 'history', ...(v.doing ? { text: v.doing } : {}) } }] },
  ]
  if (v.state.kind !== 'consistent') blocks.push({ kind: 'fields', fields: [{ label: '状态', value: stateWords(v) }] })

  // How it came: brought from where, or made from what, each source with its state now; nothing to say when made from nothing named.
  const came: Block[] = []
  const said = [
    ...(v.origin.kind === 'brought' && v.origin.source ? [{ label: '原始来源', value: { text: v.origin.source, ...(/^https?:\/\//.test(v.origin.source) ? { href: v.origin.source } : {}) } }] : []),
    ...v.earlier.map((e) => ({ label: '之前', value: { text: earlierText(e, ME), muted: true } })),
  ]
  if (said.length > 0) came.push({ kind: 'fields', fields: said })
  const basis = [
    ...v.basis.map((b) => {
      const tag = basisState(b.state, b.mark)
      return { cell: { text: b.path, mono: true, link: itemLink(b.path), ...(tag ? { tag } : {}) }, note: null, actions: [] }
    }),
    ...v.outside.map((text) => ({ cell: { text }, note: '外部', actions: [] })),
  ]
  if (basis.length > 0) {
    const { rows, page } = panelPage(basis, panel, v.path, 'basis.')
    came.push({ kind: 'list', items: rows, page })
  }
  if (came.length > 0) blocks.push(counted(basis.length > 0 ? '依据' : '来源', basis.length > 0 ? basis.length : null, came))

  // What happened to it: each content change with the sentence it came with, and what was said about it, newest first.
  const changes = v.versions.map((ver, i) => ({
    at: ver.at,
    title: { text: i === 0 ? '添加' : ver.claimed ? claimWords(ver) : '内容已更新' },
    actor: ver.by === 'owner' ? ({ kind: 'owner', name: ME } as const) : actorMark(ver.actor, grants),
    lines: [
      ...(ver.note === null ? [] : [ver.note]),
      ...(ver.by === 'owner' ? [`${who(ver.actor, ME)} 代为记录`] : []),
      ...(ver.seen === null ? [] : [`之前为自动登记：${who(ver.seen.actor, ME)} · ${when(ver.seen.at)}`]),
    ],
    tag: i === v.versions.length - 1 && i > 0 ? { text: '当前', tone: 'neutral' as const } : ver.held ? { text: '旧内容已存入历史副本', tone: 'neutral' as const } : null,
  }))
  // A decision says so in its tag; a note is the sentence itself.
  const sayings = v.said.map((s) => ({
    at: s.at,
    title: { text: s.text },
    actor: actorMark(s.actor, grants),
    lines: [...(s.flavor === 'doing' ? [SAID_LABEL.doing] : []), ...(s.about !== null && s.about !== v.path ? [`关于 ${s.about}`] : [])],
    tag: s.flavor === 'decided' ? { text: SAID_LABEL.decided, tone: 'neutral' as const } : null,
  }))
  const happened = [...changes, ...sayings].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const history = panelPage(happened, panel, v.path, 'history.')
  const note = sayAction(v.path, 'note', '添加备注', '留给 Agent 的说明')
  blocks.push({ ...counted('历史记录', happened.length, [{ kind: 'timeline', entries: history.rows, page: history.page }]), actions: v.archived ? [] : [note] })

  if (v.dependents.length > 0) {
    const { rows, page } = panelPage(v.dependents, panel, v.path, 'dependents.')
    const items = rows.map((d) => ({ cell: { text: d.path, mono: true, link: itemLink(d.path) }, note: null, actions: [] }))
    blocks.push(counted('被引用', v.dependents.length, [{ kind: 'list', items, page }]))
  }

  if (v.held.length > 0) {
    const { rows, page } = panelPage(v.held, panel, v.path, 'held.')
    const items = rows.map((path) => {
      const key = heldKeyOf(path)
      // Whose content it was, as the changes above show it; where it lies is the plugin's business.
      const ver = v.versions.find((x) => keeps([path], x))
      const note = !ver ? null : ver.by === 'owner' ? `所有者直接修改的内容，${who(ver.actor, ME)} 代为记录` : `${who(ver.actor, ME)} 添加的内容`
      return { cell: { text: `历史副本 ${key.slice(0, 8)}`, mono: true }, note, actions: [restoreAction(v.item, v.path, v.archived, key)] }
    })
    blocks.push({ ...counted('历史副本', v.held.length, [{ kind: 'list', items, page }]), about: HELD_ABOUT })
  }

  // The record behind the line above, folded: whether the content was read, where the agent worked, by which grant.
  const record: Block = {
    kind: 'fields',
    fields: [
      ...(live ? [{ label: '内容', value: v.fingerprint === null ? { text: '未读取', muted: true } : { text: `已读取 · ${v.fingerprint.slice(0, 12)}`, mono: true, muted: true } }] : []),
      ...(entered.where?.cwd ? [{ label: '位置', value: { text: shortDir(entered.where.cwd, 36), mono: true, muted: true } }] : []),
      { label: '授权', value: { text: grantText(entered.actor, grants), muted: true } },
      { label: '场景编号', value: { text: entered.scene, mono: true, muted: true } },
    ],
  }
  blocks.push({ kind: 'section', title: '记录', note: null, count: null, blocks: [record], actions: [], collapse: 'closed' })

  // An archived thing is changed and added to only once taken back. What its state asks for comes first, as the panel's one main action.
  const actions: Action[] = v.archived
    ? []
    : [
        ...(v.state.kind === 'changed' ? [{ ...acceptAction(v.path), as: 'primary' as const }] : []),
        ...(v.unknownOrigin ? provenanceActions(v.path).map((a, i) => (i === 0 && v.state.kind !== 'changed' ? { ...a, as: 'primary' as const } : a)) : []),
        ...(worthReading ? [readAction(v.path)] : []),
        basisAction(v.path),
        sayAction(v.path, 'decision', '添加决策', '例如：使用 Paddle，因为它代为处理欧洲的税务'),
      ]
  return { title: '溯源', blocks, actions }
}

/** What held copies are, for someone new to them. */
const HELD_ABOUT = '条目内容被替换时保存的旧内容。恢复时复制到新路径，当前内容不变。'

/** Every held copy, a page of them: whose content it was, where its thing is now, with the way back to a new path; and dropping them all, which asks first. */
export function heldAnswer(held: Awaited<ReturnType<typeof heldCopies>>, sizes: ReadonlyMap<string, { size: number | null; bundle: boolean }>, params: Record<string, string>, size: number): ViewAnswer {
  const rows: TableRow[] = held.copies.map((c) => {
    const item = c.current
    const size = sizes.get(c.place)
    return {
      key: `${c.item}/${c.key}`,
      cells: {
        path: item === undefined ? { text: c.item, mono: true, muted: true } : pathCell(item),
        held: { text: c.key.slice(0, 8), mono: true, muted: true, ...(size?.bundle ? { icon: 'package' as const } : {}) },
        size: size?.size === null || size === undefined ? none : { text: `${size.size} 字节`, muted: true },
      },
      link: item === undefined ? null : itemLink(item.path),
      actions: item === undefined ? [] : [restoreAction(item.id, item.path, archived(item), c.key)],
    }
  })
  const drop: Action = { label: '清除全部历史副本', tone: 'danger', icon: 'trash-2', confirm: `将删除 ${held.total} 个历史副本，此操作不可撤销。`, ...formOf(HELD_DROP) }
  const section: Block = {
    kind: 'section',
    title: '历史副本',
    note: null,
    about: HELD_ABOUT,
    count: held.total,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'path', label: '条目' }, { key: 'held', label: '历史副本' }, { key: 'size', label: '大小' }],
        rows,
        empty: '暂无历史副本。条目内容被替换时，旧内容保存在此处。',
        page: pagingOf({ view: HELD_VIEW, params, rows: size, shown: rows.length, next: held.next, total: held.total }),
      },
    ],
    actions: held.total > 0 ? [drop] : [],
  }
  return { title: '历史副本', subtitle: null, blocks: [section] }
}

/** A file nobody registered, with the ways to give it its provenance in the panel's bottom row. */
export function unownedSection(path: LibraryPath): ItemSection {
  const [first, ...rest] = provenanceActions(path)
  return { title: '溯源', blocks: [{ kind: 'text', tone: 'warn', text: '文件未登记，来源未知。已知来源时可补充。' }], actions: first === undefined ? rest : [{ ...first, as: 'primary' }, ...rest] }
}

/** A file inside a bundle that the ledger knows nothing of on its own: its provenance is the bundle's, which the line links to. */
export function partOfSection(bundle: LibraryPath): ItemSection {
  return {
    title: '溯源',
    blocks: [{ kind: 'fields', line: true, fields: [{ label: '来源记录于', value: { text: `来源记录于 ${bundle}`, icon: 'package' as const, link: itemLink(bundle) } }] }],
  }
}

// ---- standing ----

type Entry = Extract<Block, { kind: 'list' }>['items'][number]

/** What each kind of what needs looking at means. */
export const STANDING_NOTES: Record<StandingKind, string> = {
  stale: '依据的条目已修改，可能需要重新生成，可交由 Agent 检查。',
  gone: '依据的条目已缺失。',
  upstream: '上游依据可能已过期或已缺失。',
  unowned: '来源未知的文件。已知来源时可补充。',
  closed: '',
  changed: '文件被绕过资料库直接修改，内容与记录不一致。可确认此修改。',
  missing: '记录中存在，存储中不存在：可能已被删除，或已移动到无法识别的位置。',
  moved: '条目已移动到新位置。Agent 下次执行 check 时，溯源插件记录新位置。',
}

/** One row of a kind, opening the thing's panel, with the actions that settle it; a closed directory with what a look into it found. */
function standingEntry(kind: StandingKind, m: MarkRow, looks: ReadonlyMap<string, Probe | null>): Entry {
  const names = (refs: readonly { path: string }[] | undefined) => (refs ?? []).map((r) => r.path).join('、')
  // The path opens the item panel; a note only where it says more than the section's title.
  const entry = (path: string, note: string | null, open: string, actions: Action[] = []): Entry => ({ cell: { text: path, mono: true, link: itemLink(open) }, note, actions })
  switch (kind) {
    case 'stale':
      return entry(m.path, `依据 ${names(m.sources)} 已修改`, m.path)
    case 'gone':
      return entry(m.path, `依据 ${names(m.sources)} 已缺失`, m.path)
    case 'upstream':
      return entry(m.path, `上游 ${names(m.sources)} 已标记`, m.path)
    case 'unowned':
      return entry(m.path, m.adopted ? '已登记，来源未知' : null, m.path, provenanceActions(m.path))
    case 'closed': {
      const look = looks.get(m.path) ?? null
      return entry(`${m.path}/`, look === null ? null : probeWords(look), m.path, closedActions(m.path, look))
    }
    case 'changed':
      return entry(m.path, null, m.path, [acceptAction(m.path)])
    case 'missing':
      return entry(m.path, null, m.path)
    case 'moved':
      return entry(m.path, `已移动到 ${m.to ?? ''}`, m.to ?? m.path)
  }
}

/** How many of each kind need looking at, empty kinds left out. */
export const standingCounts = (lists: readonly StandingList[]) =>
  lists.filter((l) => l.count > 0).map((l) => ({ kind: l.kind, title: standingTitle(l.kind), note: STANDING_NOTES[l.kind], count: l.count, atLeast: l.atLeast }))

/** What needs looking at, one section for each kind with its first rows and how many, or one kind a page at a time; each row opens the thing's panel. */
export function standingAnswer(
  lists: readonly (StandingList & { after: string | null })[],
  only: StandingKind | null,
  params: Record<string, string> = {},
  size = LIST_LIMIT,
  looks: ReadonlyMap<string, Probe | null> = new Map(),
  deep: number | null = null,
): ViewAnswer {
  const shown = lists.filter((l) => l.count > 0 && (only === null || l.kind === only))
  const title = only ? `状态 · ${standingTitle(only)}` : '状态'
  // Reading every registered thing's content tells a real change from a touch: a named whole pass, which says first how much it reads.
  const read: Block[] = deep === null || deep === 0 ? [] : [{ kind: 'actions', head: true, actions: [deepAction(deep)] }]
  if (shown.length === 0) {
    const hint = '可能已过期、未登记、外部修改的条目列在此处，每项附带对应的操作。'
    return { title, subtitle: null, blocks: [...read, { kind: 'empty', title: '暂无待处理事项', hint }] }
  }
  const total = shown.reduce((n, l) => n + l.count, 0)
  const blocks: Block[] = shown.map((l) => {
    const items = l.rows.map((m) => standingEntry(l.kind, m, looks))
    // One kind alone pages through all of it; on the page of every kind each shows its first rows and the way to all of it.
    const list: Block =
      only === null
        ? { kind: 'list', items }
        : { kind: 'list', items, page: pagingOf({ view: STANDING_VIEW, params: { ...params, kind: l.kind }, rows: size, shown: items.length, next: l.after, total: l.count, atLeast: l.atLeast }) }
    const all: Block[] = only === null && l.after !== null ? [{ kind: 'list', items: [{ cell: { text: `查看全部 ${l.atLeast ? '至少 ' : ''}${l.count} 个`, icon: 'list', link: { view: STANDING_VIEW, params: { kind: l.kind }, target: 'main' } }, note: null, actions: [] }] }] : []
    return { kind: 'section', title: standingTitle(l.kind), note: null, ...(STANDING_NOTES[l.kind] === '' ? {} : { about: STANDING_NOTES[l.kind] }), count: l.count, blocks: [list, ...all], actions: [] }
  })
  // Each section counts its own; the head says the sum only when there is more than one.
  return { title, subtitle: shown.length > 1 ? `${shown.some((l) => l.atLeast) ? '至少 ' : ''}${total} 个待处理` : null, blocks: [...read, ...blocks] }
}

/** The named whole pass over the library: `check --deep`, reading the content of each of `scope` registered things. */
export const deepAction = (scope: number): Action => ({
  label: '深度检查',
  tone: 'default',
  as: 'icon',
  icon: 'scan-search',
  confirm: `将读取整个资料库的内容：${scope} 个已登记条目。`,
  inputs: [],
  call: { face: 'agent', verb: 'check', request: { since: null, includeArchived: false, deep: { dir: null } } },
})

export const isStandingKind = (k: string | undefined): k is StandingKind => STANDING_ORDER.includes(k as StandingKind)
