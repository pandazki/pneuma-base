// What the ledger shows in the management UI: its pages, and its section of the kernel's item
// panel. Pure: built from the same fold, reconcile and views that inspect and check answer from.
import { originalPath, shortDir, withSuffix, type Action, type ActionInput, type Block, type Cell, type Instant, type ItemSection, type LibraryPath, type Link, type Tag, type TableRow, type ViewAnswer, type ViewDecl } from '@pneuma-base/kernel'
import type { Fact, LedgerOrigin, SceneId } from './facts.js'
import { isArchived, type ItemRecord, type Ledger, type SceneRecord } from './fold.js'
import type { ItemState, Mark, Standing } from './reconcile.js'
import { actorNames, doingAt, factLine, MARK_LABEL, originLabel, SAID_LABEL, scenesNamed, shortScene, standingData, STATE_LABEL, when, who, type ItemView } from './views.js'

const ORIGINS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'brought', label: '带进来的' },
  { value: 'made', label: '做出来的' },
  { value: 'adopted', label: '来历不明' },
]

const STATES: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'consistent', label: '一致' },
  { value: 'changed', label: '已变' },
  { value: 'moved', label: '已搬' },
  { value: 'missing', label: '不在' },
  { value: 'marked', label: '可能过期或来源不在' },
]

export const ITEMS_VIEW = 'ledger.items'
export const SCENES_VIEW = 'ledger.scenes'
export const SCENE_VIEW = 'ledger.scene'
export const STANDING_VIEW = 'ledger.standing'
export const ACTIVITY_VIEW = 'ledger.activity'

export const LEDGER_VIEWS: readonly ViewDecl[] = [
  {
    id: ITEMS_VIEW,
    title: '条目',
    icon: 'layers',
    nav: true,
    filters: [
      { name: 'origin', label: '来历', options: ORIGINS, default: '' },
      { name: 'state', label: '现状', options: STATES, default: '' },
      { name: 'archived', label: '归档', options: [{ value: 'no', label: '不带归档的' }, { value: 'yes', label: '带上归档的' }], default: 'no' },
    ],
  },
  { id: SCENES_VIEW, title: '场景', icon: 'history', nav: true, filters: [] },
  { id: STANDING_VIEW, title: '状况', icon: 'gauge', nav: true, filters: [] },
  {
    id: ACTIVITY_VIEW,
    title: '动态',
    icon: 'activity',
    nav: true,
    filters: [{ name: 'who', label: '谁', options: [{ value: '', label: '全部' }, { value: 'agent', label: 'agent' }, { value: 'owner', label: '主人' }], default: '' }],
  },
  { id: SCENE_VIEW, title: '场景卡', icon: 'history', nav: false, filters: [] },
]

const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })
const sceneLink = (scene: SceneId): Link => ({ view: SCENE_VIEW, params: { scene }, target: 'panel' })
const moment = (at: Instant): Cell => ({ text: when(at), muted: true, at })
const none: Cell = { text: '—', muted: true }

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

/** Taking a held copy back to a new path: held restore. The suggested path is the item's with the old version's fingerprint in its name. */
function restoreAction(v: ItemView, held: string, fingerprint: string): Action {
  const base = v.archived ? (originalPath(v.path) ?? v.path) : v.path
  return {
    label: '取回到新路径',
    tone: 'default',
    confirm: null,
    inputs: [input('to', '取回到', { value: withSuffix(base, fingerprint.slice(0, 8)), placeholder: `库里一个空着的路径；留存在 ${held}` })],
    call: { face: 'owner', command: 'held restore', args: { positional: [v.item], flags: { fingerprint: [fingerprint], to: ['{to}'] } } },
  }
}

const ORIGIN_TONE: Record<LedgerOrigin['kind'], Tag['tone']> = { made: 'info', brought: 'neutral', adopted: 'warn' }
const STATE_TONE: Record<ItemState['kind'], Tag['tone']> = { consistent: 'good', changed: 'warn', moved: 'info', missing: 'bad', removed: 'neutral', absorbed: 'neutral' }
const MARK_TONE: Record<Mark['kind'], Tag['tone']> = { stale: 'warn', 'source-gone': 'bad' }

const originTag = (origin: LedgerOrigin): Tag => ({ text: originLabel(origin), tone: ORIGIN_TONE[origin.kind] })
const stateTag = (state: ItemState): Tag => ({ text: state.kind === 'moved' ? `已搬到 ${state.to}` : STATE_LABEL[state.kind], tone: STATE_TONE[state.kind] })

/** An item's state with the worst mark on its basis: the mark as the tag, the state as the text before it. */
function standingCell(state: ItemState, marks: Mark[]): Cell {
  const mark = marks.find((m) => m.kind === 'source-gone') ?? marks[0]
  if (!mark) return { text: '', tag: stateTag(state) }
  return { text: STATE_LABEL[state.kind], muted: true, tag: { text: MARK_LABEL[mark.kind], tone: MARK_TONE[mark.kind] } }
}

/** The path as people know it: an archived item by the path it came from. */
const shownPath = (item: ItemRecord) => (isArchived(item) ? (originalPath(item.path) ?? item.path) : item.path)
const pathCell = (item: ItemRecord): Cell => ({
  text: shownPath(item),
  mono: true,
  icon: item.bundle ? 'package' : 'file',
  ...(isArchived(item) ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}),
})
const lastAt = (item: ItemRecord) => item.versions.at(-1)?.at ?? item.entered.at

// What was being done is in the panel too: it steps aside first when the panel needs the room.
const COLUMNS = [
  { key: 'path', label: '路径' },
  { key: 'origin', label: '来历' },
  { key: 'who', label: '谁' },
  { key: 'doing', label: '当时在做什么', optional: true },
  { key: 'state', label: '现状' },
  { key: 'at', label: '时间' },
]

/** Every item not removed, newest change first, filtered by origin, state and whether archived ones are in. */
export function itemsAnswer(ledger: Ledger, standing: Standing, params: Record<string, string>): ViewAnswer {
  const origin = params.origin ?? ''
  const state = params.state ?? ''
  const withArchived = params.archived === 'yes'
  const stateOf = (item: ItemRecord): ItemState => standing.states.get(item.id) ?? { kind: 'missing' }
  const items = [...ledger.items.values()]
    .filter((item) => !item.removed && item.absorbedInto === null && (withArchived || !isArchived(item)))
    .filter((item) => origin === '' || item.origin.kind === origin)
    .filter((item) => state === '' || (state === 'marked' ? standing.marks.has(item.id) : stateOf(item).kind === state))
    .sort((a, b) => (lastAt(a) === lastAt(b) ? (a.path < b.path ? -1 : 1) : lastAt(a) > lastAt(b) ? -1 : 1))
  const rows: TableRow[] = items.map((item) => {
    const doing = doingAt(ledger.scenes.get(item.entered.scene), item.entered.at)
    return {
      key: item.id,
      cells: {
        path: pathCell(item),
        origin: { text: '', tag: originTag(item.origin) },
        who: { text: who(item.entered.actor) },
        doing: doing === null ? none : { text: doing },
        state: standingCell(stateOf(item), standing.marks.get(item.id) ?? []),
        at: moment(lastAt(item)),
      },
      link: itemLink(item.path),
      actions: [],
    }
  })
  const filtered = origin !== '' || state !== ''
  const table: Block = { kind: 'table', columns: COLUMNS, rows, empty: filtered ? '没有符合条件的条目。' : '库里还没有登记过的东西。让 agent 用 put 放东西进来；库里原有的文件在「状况」页，可以在那里给它们补上来历。' }
  return { title: '条目', subtitle: `${rows.length} 样东西`, blocks: [table] }
}

const counted = (title: string, count: number, blocks: Block[]): Block => ({ kind: 'section', title, note: null, count, blocks, actions: [] })

/** The ledger's part of the item panel: provenance and scene, basis with each source's state, dependents, what was said, versions and held copies. */
export function itemSection(v: ItemView): ItemSection {
  const { entered } = v
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '怎么来的', value: { text: '', tag: originTag(v.origin) } },
      ...(v.origin.kind === 'brought' && v.origin.source ? [{ label: '出处', value: { text: v.origin.source } }] : []),
      { label: '谁', value: { text: who(entered.actor) } },
      { label: '何时', value: { text: when(entered.at), at: entered.at } },
      ...(entered.where?.cwd ? [{ label: '在哪', value: { text: shortDir(entered.where.cwd, 36), mono: true } }] : []),
      { label: '场景', value: { text: shortScene(entered.scene), mono: true } },
      ...(v.doing ? [{ label: '当时在做', value: { text: v.doing } }] : []),
      { label: '现状', value: { text: v.archived ? '已归档' : '', muted: true, tag: stateTag(v.state) } },
      ...(v.absorbedInto !== null ? [{ label: '并入', value: { text: v.absorbedInto, mono: true, icon: 'package', link: itemLink(v.absorbedInto) } }] : []),
      { label: '条目号', value: { text: v.item, mono: true, muted: true } },
    ],
  }
  // Provenance for a thing nobody gave one; a direct change accepted. An archived thing is changed only once taken back.
  const actions = v.archived ? [] : [...(v.unknownOrigin ? provenanceActions(v.path) : []), ...(v.state.kind === 'changed' ? [acceptAction(v.path)] : [])]
  const blocks: Block[] = [...(actions.length > 0 ? [{ kind: 'actions' as const, actions }] : []), fields]

  if (v.basis.length > 0 || v.outside.length > 0) {
    const items = [
      ...v.basis.map((b) => ({
        cell: { text: b.path, mono: true, link: itemLink(b.path), tag: b.mark ? { text: MARK_LABEL[b.mark], tone: MARK_TONE[b.mark] } : { text: STATE_LABEL[b.state], tone: STATE_TONE[b.state] } },
        note: null,
        actions: [],
      })),
      ...v.outside.map((text) => ({ cell: { text }, note: '库外', actions: [] })),
    ]
    blocks.push(counted('依据', items.length, [{ kind: 'list', items }]))
  }

  if (v.dependents.length > 0) {
    const items = v.dependents.map((d) => ({ cell: { text: d.path, mono: true, link: itemLink(d.path) }, note: null, actions: [] }))
    blocks.push(counted('被什么依据', items.length, [{ kind: 'list', items }]))
  }

  if (v.said.length > 0) {
    const entries = v.said.map((s) => ({
      at: s.at,
      title: { text: s.text },
      lines: [`${who(s.actor)} · 场景 ${shortScene(s.scene)}${s.about !== null && s.about !== v.path ? ` · 关于 ${s.about}` : ''}`],
      tag: { text: SAID_LABEL[s.flavor], tone: s.flavor === 'decided' ? ('info' as const) : ('neutral' as const) },
    }))
    blocks.push(counted('决定与备注', entries.length, [{ kind: 'timeline', entries }]))
  }

  const versions = [...v.versions].reverse().map((ver, i) => ({
    at: ver.at,
    title: { text: ver.fingerprint.slice(0, 12), mono: true },
    lines: [`${who(ver.actor)} · 场景 ${shortScene(ver.scene)}`],
    tag: i === 0 ? { text: '当前', tone: 'good' as const } : ver.claimed ? { text: '认了直接改动', tone: 'warn' as const } : ver.held ? { text: '换下的进了留存', tone: 'neutral' as const } : null,
  }))
  blocks.push(counted('内容的变化', versions.length, [{ kind: 'timeline', entries: versions }]))

  if (v.held.length > 0) {
    // A held copy lies at held/<item>/<fingerprint>/<name>.
    const items = v.held.map((path) => {
      const fingerprint = path.split('/').at(-2) ?? ''
      return { cell: { text: `留存 ${fingerprint.slice(0, 8)}`, mono: true }, note: path, actions: [restoreAction(v, path, fingerprint)] }
    })
    blocks.push(counted('留存', items.length, [{ kind: 'text', text: '被新内容换下来的旧内容，给主人的保险。取回时复制到一个新路径，现在的内容不动。', tone: 'neutral' }, { kind: 'list', items }]))
  }
  return { title: '来历', blocks }
}

/** A file nobody registered, with the ways to give it its provenance. */
export function unownedSection(path: LibraryPath): ItemSection {
  return { title: '来历', blocks: [{ kind: 'text', tone: 'warn', text: '没人登记过这个文件，来历不明。知道它从哪来，就给它补上。' }, { kind: 'actions', actions: provenanceActions(path) }] }
}

/** A file inside a bundle that the ledger knows nothing of on its own: its provenance is the bundle's. */
export function partOfSection(bundle: LibraryPath): ItemSection {
  return {
    title: '来历',
    blocks: [
      { kind: 'fields', fields: [{ label: '是谁的一部分', value: { text: bundle, mono: true, icon: 'package', link: itemLink(bundle) } }] },
      { kind: 'text', tone: 'neutral', text: `它的来历记在 ${bundle} 上：${bundle} 是一样东西，整个一起记账。` },
    ],
  }
}

const table = (columns: [key: string, label: string][], rows: TableRow[], empty: string): Block => ({ kind: 'table', columns: columns.map(([key, label]) => ({ key, label })), rows, empty })

// ---- scenes ----

/** What a scene was doing: what it said it was doing, else the owner operations done in it. */
function sceneDoing(ledger: Ledger, scene: SceneRecord): Cell {
  const doing = [...new Set(scene.said.filter((s) => s.flavor === 'doing').map((s) => s.text))]
  if (doing.length > 0) return { text: doing.join('；') }
  const commands = [...new Set(ledger.ownerOps.filter((op) => op.scene === scene.id).map((op) => op.command))]
  return commands.length > 0 ? { text: `主人面的操作：${commands.join('、')}`, muted: true } : none
}

const newestFirst = (a: SceneRecord, b: SceneRecord) => (a.first === b.first ? (a.id < b.id ? -1 : 1) : a.first > b.first ? -1 : 1)

/** Every session, newest first: when it began, who, where, what it was doing, how many things it touched. */
export function scenesAnswer(ledger: Ledger): ViewAnswer {
  const scenes = [...ledger.scenes.values()].sort(newestFirst)
  if (scenes.length === 0) {
    const hint = 'agent 用 pneuma-base start "<在做什么>" 开始一件事时，这里多出一行：哪次会话、谁、在哪、在做什么、动了几样东西。'
    return { title: '场景', subtitle: null, blocks: [{ kind: 'empty', title: '还没有场景', hint }] }
  }
  const rows: TableRow[] = scenes.map((scene) => ({
    key: scene.id,
    cells: {
      at: moment(scene.first),
      who: { text: actorNames(scene.actors) },
      where: scene.cwds.length > 0 ? { text: scene.cwds.map((d) => shortDir(d)).join('、'), mono: true, muted: true } : none,
      doing: sceneDoing(ledger, scene),
      things: scene.items.length > 0 ? { text: String(scene.items.length) } : none,
    },
    link: sceneLink(scene.id),
    actions: [],
  }))
  // Where is in the scene's card too: it steps aside first when the panel needs the room.
  const columns = [
    { key: 'at', label: '时间' },
    { key: 'who', label: '谁' },
    { key: 'where', label: '在哪', optional: true },
    { key: 'doing', label: '在做什么' },
    { key: 'things', label: '几样东西' },
  ]
  return { title: '场景', subtitle: `${scenes.length} 次会话`, blocks: [{ kind: 'table', columns, rows, empty: '' }] }
}

/** One scene's card: who, when, where, what was said, the owner operations, and the things entered, changed or moved in it. */
export function sceneAnswer(ledger: Ledger, params: Record<string, string>): ViewAnswer {
  const input = params.scene ?? ''
  const named = scenesNamed(ledger, input)
  const scene = named.length === 1 ? named[0] : undefined
  if (!scene) {
    const title = named.length === 0 ? '没有这个场景' : `有 ${named.length} 个场景的编号以 ${input} 开头`
    return { title: '场景', subtitle: input || null, blocks: [{ kind: 'empty', title, hint: null }] }
  }
  const blocks: Block[] = [
    {
      kind: 'fields',
      fields: [
        { label: '谁', value: { text: actorNames(scene.actors) } },
        { label: '开始', value: { text: when(scene.first), at: scene.first } },
        { label: '最后', value: { text: when(scene.last), at: scene.last } },
        ...(scene.cwds.length > 0 ? [{ label: '在哪', value: { text: scene.cwds.map((d) => shortDir(d, 36)).join('、'), mono: true } }] : []),
        { label: '场景号', value: { text: scene.id, mono: true, muted: true } },
      ],
    },
  ]
  if (scene.said.length > 0) {
    const entries = scene.said.map((s) => ({
      at: s.at,
      title: { text: s.text },
      lines: [[who(s.actor), ...(s.about !== null ? [`关于 ${ledger.items.get(s.about)?.path ?? s.about}`] : [])].join(' · ')],
      tag: { text: SAID_LABEL[s.flavor], tone: s.flavor === 'decided' ? ('info' as const) : ('neutral' as const) },
    }))
    blocks.push(counted('说过的话', entries.length, [{ kind: 'timeline', entries }]))
  }
  const ops = ledger.ownerOps.filter((op) => op.scene === scene.id)
  if (ops.length > 0) {
    const entries = ops.map((op) => ({ at: op.at, title: { text: op.command, mono: true }, lines: [op.summary], tag: op.destructive ? { text: '丢了数据', tone: 'bad' as const } : null }))
    blocks.push(counted('主人面的操作', entries.length, [{ kind: 'timeline', entries }]))
  }
  const items = scene.items.flatMap((id) => ledger.items.get(id) ?? [])
  if (items.length > 0) {
    // A list, as the panel is narrow: each path whole, what happened to it in this scene below.
    const entries: Entry[] = items.map((item) => ({
      cell: { ...pathCell(item), link: itemLink(item.path) },
      note: item.entered.scene === scene.id ? `放入 · ${originLabel(item.origin)}` : '改过或挪过',
      actions: [],
    }))
    blocks.push(counted('条目', items.length, [{ kind: 'list', items: entries }]))
  }
  return { title: `场景 ${shortScene(scene.id)}`, subtitle: `${actorNames(scene.actors)} · ${items.length} 样东西`, blocks }
}

// ---- standing ----

/** What needs looking at, one section for each kind, each row opening the thing's panel. */
type Entry = Extract<Block, { kind: 'list' }>['items'][number]

export function standingAnswer(ledger: Ledger, standing: Standing): ViewAnswer {
  const d = standingData(ledger, standing, false)
  const names = (refs: { path: string }[]) => refs.map((r) => r.path).join('、')
  // The path opens the item panel; a note only where it says more than the section's title.
  const entry = (path: string, note: string | null, open: string, actions: Action[] = []): Entry => ({ cell: { text: path, mono: true, link: itemLink(open) }, note, actions })
  const sections: [title: string, note: string, entries: Entry[]][] = [
    ['可能过期', '它依据的东西变了，可能要重做。让 agent 看一下。', d.stale.map((r) => entry(r.path, `依据 ${names(r.sources)} 变了`, r.path))],
    ['来源不在', '它依据的东西不在了。', d.gone.map((r) => entry(r.path, `依据 ${names(r.sources)} 不在了`, r.path))],
    ['上游有标记', '它更上游的依据可能过期或不在了。', d.upstream.map((r) => entry(r.path, `上游 ${names(r.via)} 有标记`, r.path))],
    ['没人登记过的', '不知道从哪来的东西。知道来历，就给它补上。', d.unowned.map((r) => entry(r.path, r.adopted ? '入了册，来历不明' : null, r.path, provenanceActions(r.path)))],
    ['被直接改过的', '有人绕过工具改了它，内容和记录的不一样。是你改的，就认下这次改动。', d.changed.map((r) => entry(r.path, null, r.path, [acceptAction(r.path)]))],
    ['不在了的', '账上有，磁盘上找不到：可能被删掉了，或挪到了认不出的地方。', d.missing.map((r) => entry(r.path, null, r.path))],
    ['挪过的', '东西挪到了新的位置。agent 下次 check 时，记账会把新位置接上。', d.moved.map((r) => entry(r.from, `挪到了 ${r.to}`, r.to))],
  ]
  const shown = sections.filter(([, , rows]) => rows.length > 0)
  const total = shown.reduce((n, [, , rows]) => n + rows.length, 0)
  if (total === 0) {
    const hint = '可能过期的、没人登记过的、被直接改过的东西会出现在这里，每样都带着对应的处理。'
    return { title: '状况', subtitle: '一切正常', blocks: [{ kind: 'empty', title: '没有要处理的事', hint }] }
  }
  const blocks: Block[] = shown.map(([title, note, items]) => ({ kind: 'section', title, note, count: items.length, blocks: [{ kind: 'list', items }], actions: [] }))
  return { title: '状况', subtitle: `${total} 样要看`, blocks }
}

// ---- activity ----

export const ACTIVITY_LIMIT = 200

function kindTag(f: Fact): Tag {
  switch (f.kind) {
    case 'said':
      return { text: SAID_LABEL[f.flavor], tone: f.flavor === 'decided' ? 'info' : 'neutral' }
    case 'item.enter':
      return { text: '放入', tone: 'neutral' }
    case 'item.revise':
      return f.claimed ? { text: '认改动', tone: 'warn' } : { text: '换内容', tone: 'neutral' }
    case 'item.move':
      return { text: f.archive === 'in' ? '归档' : f.archive === 'out' ? '取回' : '挪动', tone: 'neutral' }
    case 'item.basis':
      return { text: '补依据', tone: 'neutral' }
    case 'item.remove':
      return { text: '除掉', tone: 'bad' }
    case 'owner.op':
      return { text: '主人面', tone: 'info' }
  }
}

/** Where a fact opens: the thing it is about, while it is there; else its scene. */
function factLink(ledger: Ledger, f: Fact): Link {
  const id = 'item' in f ? f.item : f.kind === 'said' ? f.about : null
  const item = id === null ? undefined : ledger.items.get(id)
  return item && !item.removed ? itemLink(item.path) : sceneLink(f.scene)
}

/** The latest facts, newest first, owner operations included; `who` keeps the owner's or the agents'. */
export function activityAnswer(ledger: Ledger, params: Record<string, string>): ViewAnswer {
  const by = params.who ?? ''
  if (ledger.facts.length === 0) {
    return { title: '动态', subtitle: null, blocks: [{ kind: 'empty', title: '还没有任何记录', hint: 'agent 放东西、说在做什么，主人在这里做操作，都会一条条出现在这里。' }] }
  }
  const facts = ledger.facts.filter((f) => by === '' || f.actor.kind === by).reverse()
  const rows: TableRow[] = facts.slice(0, ACTIVITY_LIMIT).map((f) => ({
    key: f.id,
    cells: {
      at: moment(f.at),
      who: { text: who(f.actor) },
      kind: { text: '', tag: kindTag(f) },
      what: { text: factLine(ledger, f) },
      scene: { text: shortScene(f.scene), mono: true, muted: true, link: sceneLink(f.scene) },
    },
    link: factLink(ledger, f),
    actions: [],
  }))
  const columns: [string, string][] = [['at', '时间'], ['who', '谁'], ['kind', '种类'], ['what', '内容'], ['scene', '场景']]
  const subtitle = facts.length > ACTIVITY_LIMIT ? `最近 ${ACTIVITY_LIMIT} 条，共 ${facts.length} 条` : `${facts.length} 条`
  return { title: '动态', subtitle, blocks: [table(columns, rows, '没有符合条件的记录。')] }
}
