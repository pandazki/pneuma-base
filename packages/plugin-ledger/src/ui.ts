// What the ledger shows in the management UI: the library page, the standing page, the held copies,
// its section of the kernel's item panel, and the pieces its feeds share (feeds.ts). Pure: built from
// the same fold, reconcile and views that inspect and check answer from.
import {
  formOf,
  originalPath,
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
  type Tag,
  type TableRow,
  type TreeNode,
  type ViewAnswer,
  type ViewDecl,
} from '@pneuma-base/kernel'
import type { FactActor, How, LedgerOrigin, SceneId } from './facts.js'
import { HELD_DROP, HELD_RESTORE, type HeldCopy } from './held.js'
import { isArchived, type ItemRecord, type Ledger, type LedgerLike, type SceneLike } from './fold.js'
import type { ItemState, Mark, Standing } from './reconcile.js'
import { DEFAULT_PERIOD, PERIODS } from './stats.js'
import { earlierText, MARK_LABEL, originLabel, SAID_LABEL, shortScene, standingData, STATE_LABEL, when, who, type ItemView, type StandingData } from './views.js'
import { closedActions } from './unowned.js'

export const HOME_VIEW = 'ledger.home'
export const ITEMS_VIEW = 'ledger.items'
export const SCENES_VIEW = 'ledger.scenes'
export const SCENE_VIEW = 'ledger.scene'
export const STANDING_VIEW = 'ledger.standing'
export const ACTIVITY_VIEW = 'ledger.activity'
export const HELD_VIEW = 'ledger.held'
export const STATS_VIEW = 'ledger.stats'

/** What the library page shows: the things not archived, those brought in or made of them, or the archived ones. */
const SHOWS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'brought', label: '带进来的' },
  { value: 'made', label: '做出来的' },
  { value: 'archived', label: '已归档' },
]

export const WHO_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'agent', label: 'agent 做的' },
  { value: 'owner', label: '主人做的' },
]

// The library page takes `dir` from its folder tree and the standing page `kind` from the home
// page's links; neither is a filter of the page's head, so neither is declared.
export const LEDGER_VIEWS: readonly ViewDecl[] = [
  { id: ITEMS_VIEW, title: '库', icon: 'layers', nav: true, filters: [{ name: 'show', label: '显示', options: SHOWS, default: '' }] },
  {
    id: ACTIVITY_VIEW,
    title: '活动',
    icon: 'activity',
    nav: true,
    filters: [
      { name: 'who', label: '谁做的', options: WHO_OPTIONS, default: '' },
      { name: 'agent', label: '哪个 agent', options: [{ value: '', label: '全部 agent' }], default: '' },
    ],
  },
  { id: STATS_VIEW, title: '统计', icon: 'chart-column', nav: true, filters: [{ name: 'period', label: '时间', options: [...PERIODS], default: DEFAULT_PERIOD }] },
  { id: SCENES_VIEW, title: '场景', icon: 'history', nav: true, filters: [] },
  { id: STANDING_VIEW, title: '状况', icon: 'gauge', nav: true, filters: [] },
  { id: HELD_VIEW, title: '留存', icon: 'box', nav: true, filters: [] },
  { id: SCENE_VIEW, title: '场景', icon: 'history', nav: false, filters: [] },
  { id: HOME_VIEW, title: '自上次以来', icon: 'house', nav: false, filters: [], home: true },
]

export const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })
export const sceneLink = (scene: SceneId): Link => ({ view: SCENE_VIEW, params: { scene }, target: 'panel' })
export const moment = (at: Instant): Cell => ({ text: when(at), muted: true, at })
export const none: Cell = { text: '—', muted: true }

// ---- who ----

/** An actor as blocks draw it: an agent with the name of the grant it used, the owner; the ledger's own observations by its name. */
export function actorMark(a: FactActor, grants: readonly Grant[]): ActorMark | string {
  if (a.kind === 'owner') return { kind: 'owner', name: '主人' }
  if (a.kind === 'plugin') return a.name
  const grant = a.grant === null ? undefined : (grants.find((g) => g.id === a.grant)?.name ?? a.grant)
  return { kind: 'agent', name: a.name, ...(grant === undefined ? {} : { grant }) }
}

/** A cell that says who: the actor's mark, and its name as the text. */
export function actorCell(a: FactActor, grants: readonly Grant[]): Cell {
  const mark = actorMark(a, grants)
  return typeof mark === 'string' ? { text: mark, muted: true } : { text: mark.name, actor: mark }
}

/** By which grant an actor acted, in words: its name, area and access; the owner needs none. */
export function grantText(a: FactActor, grants: readonly Grant[]): string {
  if (a.kind !== 'agent') return a.kind === 'owner' ? '主人自己，不用授权' : `${a.name} 自己看到的`
  if (a.grant === null) return '没带授权：这个库没发授权时，谁都能用整个库'
  const g = grants.find((x) => x.id === a.grant)
  if (g === undefined) return `授权 ${a.grant}，已经撤回了`
  return `授权 ${g.name} · ${g.area === null ? '整个库' : g.area} · ${g.readOnly ? '只读' : '读写'}`
}

/** By which grant an agent acted, as a feed's meta: the grant's name, or that it had none; nothing for the owner. */
export function grantCell(a: FactActor, grants: readonly Grant[]): Cell | null {
  if (a.kind !== 'agent') return null
  if (a.grant === null) return { text: '没带授权', muted: true }
  return { text: `凭授权 ${grants.find((g) => g.id === a.grant)?.name ?? a.grant}`, muted: true }
}

/** What a scene was doing: what it said it was doing, else the owner operations done in it; null when neither. */
export function sceneDoing(ledger: LedgerLike, scene: SceneLike): string | null {
  const doing = [...new Set(scene.said.filter((s) => s.flavor === 'doing').map((s) => s.text))]
  if (doing.length > 0) return doing.join('；')
  const ops = ledger.ownerOps.filter((op) => op.scene === scene.id)
  const commands = [...new Set(ops.map((op) => op.command))]
  const prefix = ops.every((op) => op.actor.kind === 'owner') ? '主人面的操作' : '执行命令'
  return commands.length > 0 ? `${prefix}：${commands.join('、')}` : null
}

/** A scene as a link: what it was doing, else its short id. */
export function sceneCell(ledger: LedgerLike, id: SceneId): Cell {
  const scene = ledger.scenes.get(id)
  const doing = scene ? sceneDoing(ledger, scene) : null
  return { text: doing ?? `场景 ${shortScene(id)}`, link: sceneLink(id) }
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
      label: '记为带进来的',
      tone: 'default',
      confirm: null,
      inputs: [
        input('source', '出处', { placeholder: '网址、书名或别的出处；不知道就留空' }),
        input('by', '谁带来的', { value: 'owner', options: [{ value: 'owner', label: '主人' }, { value: '', label: '不知道' }] }),
      ],
      call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'brought', source: '{source}', by: '{by}' } } },
    },
    {
      label: '记为做出来的',
      tone: 'default',
      confirm: null,
      inputs: [
        input('from', '依据库里的哪些', { placeholder: '库内路径，一行一个', multiple: true }),
        input('outside', '库外的依据', { placeholder: '一行一句，比如：主人在对话里说的', multiple: true }),
      ],
      call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'made', from: ['{from}'], outside: ['{outside}'] } } },
    },
  ]
}

/** Accepting a direct change as the new version: say revised. */
export const acceptAction = (path: string): Action => ({
  label: '认下这次改动',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: path, text: null, args: {} } },
})

/** Taking a held copy back to a new path: ledger held restore. The suggested path is the item's with the old version's fingerprint in its name. */
function restoreAction(item: string, path: LibraryPath, archived: boolean, fingerprint: string): Action {
  const base = archived ? (originalPath(path) ?? path) : path
  const form = formOf(HELD_RESTORE, { fixed: { item, fingerprint }, values: { to: withSuffix(base, fingerprint.slice(0, 8)) } })
  return { label: '取回到新路径', tone: 'default', confirm: null, ...form }
}

/** Saying something about a thing: a decision or a note, in one sentence. */
const sayAction = (path: string, kind: 'decided' | 'note', label: string, placeholder: string): Action => ({
  label,
  tone: 'default',
  confirm: null,
  inputs: [input('text', '一句话', { placeholder })],
  call: { face: 'agent', verb: 'say', request: { kind, about: path, text: '{text}', args: {} } },
})

/** Adding to what a thing was made from: say from, with paths in the library and sentences about what is outside. */
const basisAction = (path: string): Action => ({
  label: '补上依据',
  tone: 'default',
  confirm: null,
  inputs: [
    input('from', '依据库里的哪些', { placeholder: '库内路径，一行一个', multiple: true }),
    input('outside', '库外的依据', { placeholder: '一行一句，比如：主人在对话里说的', multiple: true }),
  ],
  call: { face: 'agent', verb: 'say', request: { kind: 'from', about: path, text: null, args: { from: ['{from}'], 'from-outside': ['{outside}'] } } },
})

// ---- states, quiet when normal ----

const STATE_TONE: Record<ItemState['kind'], Tag['tone']> = { consistent: 'neutral', changed: 'warn', moved: 'info', missing: 'bad', removed: 'neutral', absorbed: 'neutral' }
const MARK_TONE: Record<Mark['kind'], Tag['tone']> = { stale: 'warn', 'source-gone': 'bad' }

// Where a thing came from is a kind, not a state: grey words, except that nobody knowing is worth a look.
const originCell = (origin: LedgerOrigin, how: How): Cell =>
  origin.kind === 'adopted' ? { text: '', tag: { text: originLabel(origin, how), tone: 'warn' } } : { text: originLabel(origin, how), muted: true }
const stateText = (state: ItemState) => (state.kind === 'moved' ? `已搬到 ${state.to}` : STATE_LABEL[state.kind])
const stateTag = (state: ItemState): Tag => ({ text: stateText(state), tone: STATE_TONE[state.kind] })

/** A normal state is grey words; a departure from it is a tag, the worst mark on the basis before the state. */
function stateCell(state: ItemState, marks: readonly Mark[]): Cell {
  const mark = marks.find((m) => m.kind === 'source-gone') ?? marks[0]
  if (mark) return { text: '', tag: { text: MARK_LABEL[mark.kind], tone: MARK_TONE[mark.kind] } }
  return state.kind === 'consistent' ? { text: STATE_LABEL.consistent, muted: true } : { text: '', tag: stateTag(state) }
}

/** A basis row's state: grey words when it is as it was, else its mark or state as a tag. */
const basisState = (state: ItemState['kind'], mark: Mark['kind'] | null): Tag | null =>
  mark ? { text: MARK_LABEL[mark], tone: MARK_TONE[mark] } : state === 'consistent' ? null : { text: STATE_LABEL[state], tone: STATE_TONE[state] }

/** The path as people know it: an archived item by the path it came from. */
export const shownPath = (item: ItemRecord) => (isArchived(item) ? (originalPath(item.path) ?? item.path) : item.path)
export const pathCell = (item: ItemRecord): Cell => ({
  text: shownPath(item),
  mono: true,
  icon: item.bundle ? 'package' : 'file',
  ...(isArchived(item) ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}),
})
const lastAt = (item: ItemRecord) => item.versions.at(-1)?.at ?? item.entered.at

// ---- the library page ----

/** The folders of `paths`, each with how many of them lie under it, folders before their children, by name. */
export function folderTree(paths: readonly string[]): TreeNode[] {
  type Folder = { count: number; children: Map<string, Folder> }
  const root: Folder = { count: 0, children: new Map() }
  for (const path of paths) {
    let at = root
    for (const part of path.split('/').slice(0, -1)) {
      const next = at.children.get(part) ?? { count: 0, children: new Map() }
      at.children.set(part, next)
      next.count++
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
  { key: 'origin', label: '来历', optional: true },
  { key: 'who', label: '谁', optional: true },
  { key: 'state', label: '现状' },
  { key: 'at', label: '时间' },
]

const inShow = (item: ItemRecord, show: string) => (show === 'archived' ? isArchived(item) : !isArchived(item) && (show === '' || item.origin.kind === show))

/**
 * Every item not removed, newest change first: the ones `show` keeps (all not archived, those
 * brought in or made, or the archived ones) in the folder `dir`, with a tree of their folders and
 * how many each segment holds.
 */
export function itemsAnswer(ledger: Ledger, standing: Standing, params: Record<string, string>, grants: readonly Grant[]): ViewAnswer {
  const show = params.show ?? ''
  const dir = params.dir ?? ''
  const live = [...ledger.items.values()].filter((item) => !item.removed && item.absorbedInto === null)
  const counted = SHOWS.map((o) => ({ ...o, count: live.filter((item) => inShow(item, o.value)).length }))
  const shown = live.filter((item) => inShow(item, show))
  const items = shown
    .filter((item) => dir === '' || shownPath(item).startsWith(`${dir}/`))
    .sort((a, b) => (lastAt(a) === lastAt(b) ? (a.path < b.path ? -1 : 1) : lastAt(a) > lastAt(b) ? -1 : 1))
  const rows: TableRow[] = items.map((item) => ({
    key: item.id,
    cells: {
      path: pathCell(item),
      origin: originCell(item.origin, item.entered.how),
      who: actorCell(item.entered.actor, grants),
      state: stateCell(standing.states.get(item.id) ?? { kind: 'missing' }, standing.marks.get(item.id) ?? []),
      at: moment(lastAt(item)),
    },
    link: itemLink(item.path),
    actions: [],
  }))
  const empty =
    show !== '' || dir !== ''
      ? '这里没有东西。'
      : '库里还没有登记过的东西。让 agent 用 put 放东西进来；库里原有的文件在「状况」页，可以在那里给它们补上来历。'
  const tree: Block = { kind: 'tree', param: 'dir', selected: dir, nodes: [{ value: '', label: '全部文件夹', count: shown.length, children: folderTree(shown.map(shownPath)) }] }
  const table: Block = { kind: 'table', columns: COLUMNS, rows, empty }
  return { title: '库', subtitle: `${rows.length} 样东西${dir === '' ? '' : ` · 在 ${dir}/`}`, blocks: [tree, table], filters: [{ name: 'show', options: counted }] }
}

// ---- the item panel ----

/** A direct change as words: claimed, recorded for the owner, or only seen. */
const claimWords = (ver: ItemView['versions'][number]) => (ver.how === 'observed' ? '直接改的（自动登记）' : ver.by === 'owner' ? '主人直接改的' : '认了直接改动')

const counted = (title: string, count: number | null, blocks: Block[]): Block => ({ kind: 'section', title, note: null, count, blocks, actions: [] })

/**
 * The ledger's part of the item panel, in the panel's order: when, who and in which scene, with its
 * state only when it is not as recorded; how it came, from where or from what, each source with its
 * state; what happened to it, each change and what was said; by which grant; what was made from it;
 * its held copies. Its actions go to the panel's bottom row.
 */
export function itemSection(v: ItemView, ledger: Ledger, grants: readonly Grant[]): ItemSection {
  const { entered } = v
  const off = v.state.kind !== 'consistent' && !(v.state.kind === 'absorbed' && v.absorbedInto !== null)
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '何时', value: moment(entered.at) },
      { label: '谁', value: actorCell(entered.actor, grants) },
      { label: '场景', value: { ...sceneCell(ledger, entered.scene), ...(v.doing ? { text: v.doing } : {}) } },
      ...(entered.where?.cwd ? [{ label: '在哪', value: { text: shortDir(entered.where.cwd, 36), mono: true, muted: true } }] : []),
      ...(off ? [{ label: '现状', value: { text: '', tag: stateTag(v.state) } }] : []),
      ...(v.absorbedInto !== null ? [{ label: '并入', value: { text: v.absorbedInto, mono: true, icon: 'package' as const, link: itemLink(v.absorbedInto) } }] : []),
    ],
  }
  const blocks: Block[] = [fields]

  // How it came: brought from where, or made from what, each source with its state now.
  const came: Block[] = [
    {
      kind: 'fields',
      fields: [
        { label: '来历', value: originCell(v.origin, v.entered.how) },
        ...(v.origin.kind === 'brought' && v.origin.source ? [{ label: '出处', value: { text: v.origin.source } }] : []),
        ...v.earlier.map((e) => ({ label: '先前', value: { text: earlierText(e), muted: true } })),
      ],
    },
  ]
  const basis = [
    ...v.basis.map((b) => {
      const tag = basisState(b.state, b.mark)
      return { cell: { text: b.path, mono: true, link: itemLink(b.path), ...(tag ? { tag } : {}) }, note: tag ? null : '一致', actions: [] }
    }),
    ...v.outside.map((text) => ({ cell: { text }, note: '库外', actions: [] })),
  ]
  if (basis.length > 0) came.push({ kind: 'list', items: basis })
  blocks.push(counted('怎么来的', basis.length > 0 ? basis.length : null, came))

  // What happened to it: each content change with the sentence it came with, and what was said about it, newest first.
  const changes = v.versions.map((ver, i) => ({
    at: ver.at,
    title: { text: i === 0 ? '放进来' : ver.claimed ? claimWords(ver) : '换了新内容' },
    lines: [
      `${ver.by === 'owner' ? `主人，${who(ver.actor)} 代记` : who(ver.actor)} · 场景 ${shortScene(ver.scene)} · ${ver.fingerprint.slice(0, 8)}`,
      ...(ver.seen === null ? [] : [`先是自动登记：${who(ver.seen.actor)} · ${when(ver.seen.at)}`]),
      ...(ver.note === null ? [] : [ver.note]),
    ],
    tag: i === v.versions.length - 1 && i > 0 ? { text: '当前', tone: 'neutral' as const } : ver.held ? { text: '换下的进了留存', tone: 'neutral' as const } : null,
  }))
  // A decision says so in its tag; a note in its grey line. Either way the word comes once.
  const said = v.said.map((s) => ({
    at: s.at,
    title: { text: s.text },
    lines: [[...(s.flavor === 'decided' ? [] : [SAID_LABEL[s.flavor]]), who(s.actor), `场景 ${shortScene(s.scene)}`, ...(s.about !== null && s.about !== v.path ? [`关于 ${s.about}`] : [])].join(' · ')],
    tag: s.flavor === 'decided' ? { text: SAID_LABEL.decided, tone: 'neutral' as const } : null,
  }))
  const happened = [...changes, ...said].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  blocks.push(counted('发生过什么', happened.length, [{ kind: 'timeline', entries: happened }]))

  blocks.push(counted('凭什么', null, [{ kind: 'text', tone: 'neutral', text: grantText(entered.actor, grants) }]))

  if (v.dependents.length > 0) {
    const items = v.dependents.map((d) => ({ cell: { text: d.path, mono: true, link: itemLink(d.path) }, note: null, actions: [] }))
    blocks.push(counted('被什么依据', items.length, [{ kind: 'list', items }]))
  }

  if (v.held.length > 0) {
    // A held copy lies at held/<item>/<fingerprint>/<name>.
    const items = v.held.map((path) => {
      const fingerprint = path.split('/').at(-2) ?? ''
      // Whose content it was, as the changes above show it; where it lies is the plugin's business.
      const ver = v.versions.find((x) => x.fingerprint === fingerprint)
      const note = !ver ? null : ver.by === 'owner' ? `主人直接改的那份内容，${who(ver.actor)} 代记` : `${who(ver.actor)} 放进来的那份内容`
      return { cell: { text: `留存 ${fingerprint.slice(0, 8)}`, mono: true }, note, actions: [restoreAction(v.item, v.path, v.archived, fingerprint)] }
    })
    blocks.push(counted('留存', items.length, [{ kind: 'text', text: '被新内容换下来的旧内容，给主人的保险。取回时复制到一个新路径，现在的内容不动。', tone: 'neutral' }, { kind: 'list', items }]))
  }

  // An archived thing is changed and added to only once taken back.
  const actions = v.archived
    ? []
    : [
        ...(v.unknownOrigin ? provenanceActions(v.path) : []),
        ...(v.state.kind === 'changed' ? [acceptAction(v.path)] : []),
        basisAction(v.path),
        sayAction(v.path, 'decided', '记一条决定', '比如：用 Paddle，因为它替我们处理欧洲的税'),
        sayAction(v.path, 'note', '记一条备注', '留给主人和下一个 agent 的一句话'),
      ]
  return { title: '来历', blocks, actions }
}

/** Every held copy: whose content it was, where its thing is now, with the way back to a new path; and dropping them all, which asks first. */
export function heldAnswer(ledger: Ledger, copies: readonly HeldCopy[]): ViewAnswer {
  const rows: TableRow[] = copies.map((c) => {
    const item = ledger.items.get(c.item)
    return {
      key: `${c.item}/${c.fingerprint}`,
      cells: {
        path: item === undefined ? { text: c.item, mono: true, muted: true } : pathCell(item),
        held: { text: `留存 ${c.fingerprint.slice(0, 8)}`, mono: true, ...(c.bundle ? { icon: 'package' as const } : {}) },
        size: { text: `${c.size} 字节`, muted: true },
      },
      link: item === undefined ? null : itemLink(item.path),
      actions: item === undefined ? [] : [restoreAction(item.id, item.path, isArchived(item), c.fingerprint)],
    }
  })
  const drop: Action = { label: '清掉全部留存', tone: 'danger', confirm: `${copies.length} 份留存会被删掉，不能撤回。`, ...formOf(HELD_DROP) }
  const section: Block = {
    kind: 'section',
    title: '留存',
    note: '被新内容换下来的旧内容，给主人的保险。取回时复制到一个新路径，现在的内容不动。',
    count: rows.length,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '东西' }, { key: 'held', label: '留存' }, { key: 'size', label: '大小' }], rows, empty: '没有留存。放进内容不同的同名东西时，换下的旧内容留在这里。' }],
    actions: rows.length > 0 ? [drop] : [],
  }
  return { title: '留存', subtitle: `${rows.length} 份`, blocks: [section] }
}

/** A file nobody registered, with the ways to give it its provenance in the panel's bottom row. */
export function unownedSection(path: LibraryPath): ItemSection {
  return { title: '来历', blocks: [{ kind: 'text', tone: 'warn', text: '没人登记过这个文件，来历不明。知道它从哪来，就给它补上。' }], actions: provenanceActions(path) }
}

/** A file inside a bundle that the ledger knows nothing of on its own: its provenance is the bundle's. */
export function partOfSection(bundle: LibraryPath): ItemSection {
  return {
    title: '来历',
    blocks: [
      { kind: 'fields', fields: [{ label: '是谁的一部分', value: { text: bundle, mono: true, icon: 'package' as const, link: itemLink(bundle) } }] },
      { kind: 'text', tone: 'neutral', text: `它的来历记在 ${bundle} 上：${bundle} 是一样东西，整个一起记账。` },
    ],
  }
}

// ---- standing ----

type Entry = Extract<Block, { kind: 'list' }>['items'][number]

/** What needs looking at, by kind: the key the home page's links give, the title, and what it means. */
export const STANDING_KINDS: readonly { kind: keyof StandingData; title: string; note: string }[] = [
  { kind: 'stale', title: '可能过期', note: '它依据的东西变了，可能要重做。让 agent 看一下。' },
  { kind: 'gone', title: '来源不在', note: '它依据的东西不在了。' },
  { kind: 'upstream', title: '上游有标记', note: '它更上游的依据可能过期或不在了。' },
  { kind: 'unowned', title: '没人登记过的', note: '不知道从哪来的东西。知道来历，就给它补上。' },
  { kind: 'closed', title: '没登记的目录', note: '' },
  { kind: 'changed', title: '被直接改过的', note: '有人绕过工具改了它，内容和记录的不一样。是你改的，就认下这次改动。' },
  { kind: 'missing', title: '不在了的', note: '账上有，磁盘上找不到：可能被删掉了，或挪到了认不出的地方。' },
  { kind: 'moved', title: '挪过的', note: '东西挪到了新的位置。agent 下次 check 时，记账会把新位置接上。' },
]

/** The entries of one kind, each opening the thing's panel, with the actions that settle it. */
function standingEntries(d: StandingData, kind: keyof StandingData): Entry[] {
  const names = (refs: { path: string }[]) => refs.map((r) => r.path).join('、')
  // The path opens the item panel; a note only where it says more than the section's title.
  const entry = (path: string, note: string | null, open: string, actions: Action[] = []): Entry => ({ cell: { text: path, mono: true, link: itemLink(open) }, note, actions })
  switch (kind) {
    case 'stale':
      return d.stale.map((r) => entry(r.path, `依据 ${names(r.sources)} 变了`, r.path))
    case 'gone':
      return d.gone.map((r) => entry(r.path, `依据 ${names(r.sources)} 不在了`, r.path))
    case 'upstream':
      return d.upstream.map((r) => entry(r.path, `上游 ${names(r.via)} 有标记`, r.path))
    case 'unowned':
      return d.unowned.map((r) => entry(r.path, r.adopted ? '入了册，来历不明' : null, r.path, provenanceActions(r.path)))
    case 'closed':
      return d.closed.map((r) => entry(`${r.path}/`, null, r.path, closedActions(r.path)))
    case 'changed':
      return d.changed.map((r) => entry(r.path, null, r.path, [acceptAction(r.path)]))
    case 'missing':
      return d.missing.map((r) => entry(r.path, null, r.path))
    case 'moved':
      return d.moved.map((r) => entry(r.from, `挪到了 ${r.to}`, r.to))
  }
}

/** How many of each kind need looking at, empty kinds left out. */
export function standingCounts(ledger: LedgerLike, standing: Standing): { kind: keyof StandingData; title: string; note: string; count: number }[] {
  const d = standingData(ledger, standing, false)
  return STANDING_KINDS.map((k) => ({ ...k, count: d[k.kind].length })).filter((k) => k.count > 0)
}

/** What needs looking at, one section for each kind, or only the kind `params.kind` names; each row opens the thing's panel. */
export function standingAnswer(ledger: Ledger, standing: Standing, params: Record<string, string>): ViewAnswer {
  const d = standingData(ledger, standing, false)
  const only = STANDING_KINDS.find((k) => k.kind === params.kind)
  const shown = (only ? [only] : STANDING_KINDS).map((k) => ({ ...k, items: standingEntries(d, k.kind) })).filter((k) => k.items.length > 0)
  const total = shown.reduce((n, k) => n + k.items.length, 0)
  if (total === 0) {
    const hint = '可能过期的、没人登记过的、被直接改过的东西会出现在这里，每样都带着对应的处理。'
    return { title: only ? `状况 · ${only.title}` : '状况', subtitle: '一切正常', blocks: [{ kind: 'empty', title: '没有要处理的事', hint }] }
  }
  const blocks: Block[] = shown.map((k) => ({ kind: 'section', title: k.title, note: k.note, count: k.items.length, blocks: [{ kind: 'list', items: k.items }], actions: [] }))
  return { title: only ? `状况 · ${only.title}` : '状况', subtitle: `${total} 样要看`, blocks }
}
