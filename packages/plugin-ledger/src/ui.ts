// What the ledger shows in the management UI: the items view, and its section of the kernel's item
// panel. Pure: built from the same fold, reconcile and itemView that inspect and check answer from.
import { originalPath, type Block, type Cell, type ItemSection, type Link, type Tag, type TableRow, type ViewAnswer, type ViewDecl } from '@pneuma-base/kernel'
import type { LedgerOrigin } from './facts.js'
import { isArchived, type ItemRecord, type Ledger } from './fold.js'
import type { ItemState, Mark, Standing } from './reconcile.js'
import { doingAt, MARK_LABEL, originLabel, SAID_LABEL, shortDir, shortScene, STATE_LABEL, when, who, type ItemView } from './views.js'

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
]

const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })

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
const lastAt = (item: ItemRecord) => item.versions.at(-1)?.at ?? item.entered.at

const COLUMNS = [
  { key: 'path', label: '路径' },
  { key: 'origin', label: '来历' },
  { key: 'who', label: '谁' },
  { key: 'doing', label: '当时在做什么' },
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
    .filter((item) => !item.removed && (withArchived || !isArchived(item)))
    .filter((item) => origin === '' || item.origin.kind === origin)
    .filter((item) => state === '' || (state === 'marked' ? standing.marks.has(item.id) : stateOf(item).kind === state))
    .sort((a, b) => (lastAt(a) === lastAt(b) ? (a.path < b.path ? -1 : 1) : lastAt(a) > lastAt(b) ? -1 : 1))
  const rows: TableRow[] = items.map((item) => {
    const doing = doingAt(ledger.scenes.get(item.entered.scene), item.entered.at)
    return {
      key: item.id,
      cells: {
        path: { text: shownPath(item), mono: true, ...(isArchived(item) ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}) },
        origin: { text: '', tag: originTag(item.origin) },
        who: { text: who(item.entered.actor) },
        doing: doing === null ? { text: '—', muted: true } : { text: doing },
        state: standingCell(stateOf(item), standing.marks.get(item.id) ?? []),
        at: { text: when(lastAt(item)), muted: true },
      },
      link: itemLink(item.path),
      actions: [],
    }
  })
  const filtered = origin !== '' || state !== ''
  const table: Block = { kind: 'table', columns: COLUMNS, rows, empty: filtered ? '没有符合条件的条目。' : '库里还没有登记过的东西。agent 用 put 放进来的东西会出现在这里。' }
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
      { label: '何时', value: { text: when(entered.at) } },
      ...(entered.where?.cwd ? [{ label: '在哪', value: { text: shortDir(entered.where.cwd), mono: true } }] : []),
      { label: '场景', value: { text: shortScene(entered.scene), mono: true } },
      ...(v.doing ? [{ label: '当时在做', value: { text: v.doing } }] : []),
      { label: '现状', value: { text: v.archived ? '已归档' : '', muted: true, tag: stateTag(v.state) } },
      { label: '条目号', value: { text: v.item, mono: true, muted: true } },
    ],
  }
  const blocks: Block[] = [fields]

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
    tag: i === 0 ? { text: '当前', tone: 'good' as const } : ver.claimed ? { text: '认了直接改动', tone: 'warn' as const } : ver.held ? { text: '换下的旧版留存了', tone: 'neutral' as const } : null,
  }))
  blocks.push(counted('版本', versions.length, [{ kind: 'timeline', entries: versions }]))

  if (v.held.length > 0) {
    const items = v.held.map((path) => ({ cell: { text: path, mono: true, muted: true }, note: null, actions: [] }))
    blocks.push(counted('留存的旧版', items.length, [{ kind: 'text', text: '被新的一版换下来的旧内容，主人可以取回。', tone: 'neutral' }, { kind: 'list', items }]))
  }
  return { title: '来历', blocks }
}

/** A file nobody registered. */
export const UNOWNED_SECTION: ItemSection = { title: '来历', blocks: [{ kind: 'text', tone: 'warn', text: '没人登记过这个文件，来历不明。' }] }
