// What the management UI shows, in the kernel's block types only: a thing's section of the item
// panel, and the page of every versioned thing. Pure.
import { formOf, type Action, type Block, type Cell, type ItemSection, type LibraryPath, type Link, type Paging, type Tag, type TableRow, type ViewAnswer, type ViewDecl } from '@pneuma-base/kernel'
import { VERSION_EXPORT, VERSION_PRUNE, VERSION_RESTORE } from './commands.js'
import { latest, type Thing, type Version } from './model.js'
import { aboutVersion, archived, minute, whoText } from './text.js'
import type { DiskState } from './versions.js'

export const THINGS_VIEW: ViewDecl = {
  id: 'version.things',
  title: '有版本的东西',
  icon: 'git-branch',
  nav: true,
  filters: [{ name: 'archived', label: '归档的', options: [{ value: 'hide', label: '在用的' }, { value: 'show', label: '含归档的' }], default: 'hide' }],
}

const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })

function versionTag(thing: Thing, v: Version, state: DiskState): Tag | null {
  if (v.pruned) return { text: '已清掉', tone: 'neutral' }
  // The latest is the current one: said only where there are others to tell it from.
  if (v === latest(thing) && state === 'current') return thing.versions.length > 1 ? { text: '当前', tone: 'neutral' } : null
  if (v.via === 'outside') return { text: '工具外改的', tone: 'warn' }
  return null
}

/** The versions whose content is kept, newest first, as a choice; the one before the latest is chosen. */
function versionChoice(thing: Thing) {
  const kept = thing.versions.filter((v) => !v.pruned).toReversed()
  return {
    values: { version: String((kept[1] ?? kept[0])?.n ?? '') },
    choices: { version: kept.map((v) => ({ value: String(v.n), label: `第 ${v.n} 版 · ${minute(v.at)}${v.note ? ` · ${v.note}` : ''}` })) },
  }
}

function actions(thing: Thing): Action[] {
  const fixed = { path: thing.path }
  const exported: Action = { label: '导出到库外', tone: 'default', confirm: null, ...formOf(VERSION_EXPORT, { fixed, ...versionChoice(thing) }) }
  const restored: Action = {
    label: '放回这一版',
    tone: 'default',
    confirm: `把选中的那一版放回 ${thing.path}，作为新的一版？现在的内容已经是一版，不会丢。`,
    ...formOf(VERSION_RESTORE, { fixed, ...versionChoice(thing) }),
  }
  // 「说 version」 writes the current version's note, as the command line's say version does.
  const noted: Action = {
    label: '给当前这一版写说明',
    tone: 'default',
    confirm: null,
    inputs: [{ name: 'note', label: '说明', placeholder: '一句话，说这一版改了什么', value: latest(thing)?.note ?? null, options: null }],
    call: { face: 'agent', verb: 'say', request: { kind: 'version', about: thing.path, text: '{note}', args: {} } },
  }
  const kept = thing.versions.filter((v) => !v.pruned).length
  const pruned: Action = {
    label: '只留最近几版',
    tone: 'danger',
    confirm: `${thing.path} 更早的版本会被清掉，只属于它们的内容一并删掉，不能撤回。`,
    ...formOf(VERSION_PRUNE, { fixed, values: { keep: String(Math.max(1, Math.min(kept, 3))) } }),
  }
  return archived(thing) ? [exported, pruned] : [exported, restored, noted, pruned]
}

const STATE_NOTE: Record<Exclude<DiskState, 'current'>, string> = {
  changed: '现在的内容在工具之外改过，还没记成一版；agent 跑一次 check 就会记下。',
  missing: '这个路径上现在没有东西；可以把某一版放回来。',
}

/** A declared thing: its versions newest first, with export and restore. */
export function itemSection(thing: Thing, state: DiskState): ItemSection {
  const timeline: Block = {
    kind: 'timeline',
    entries: thing.versions.toReversed().map((v) => ({ at: v.at, title: { text: `第 ${v.n} 版` }, lines: aboutVersion(v), tag: versionTag(thing, v, state) })),
  }
  const note: Block[] = state === 'current' ? [] : [{ kind: 'text', tone: 'warn', text: STATE_NOTE[state] }]
  return { title: '版本', blocks: [...note, timeline, { kind: 'actions', actions: actions(thing) }] }
}

/** A thing nobody declared: what that means, and the declaration as a button. */
export function undeclaredSection(path: LibraryPath): ItemSection {
  const declare: Action = {
    label: '声明有版本',
    tone: 'default',
    confirm: null,
    inputs: [],
    call: { face: 'agent', verb: 'say', request: { kind: 'versioned', about: path, text: null, args: {} } },
  }
  return {
    title: '版本',
    blocks: [
      { kind: 'text', tone: 'neutral', text: '没有声明有版本：放进新内容时，版本插件不替它留旧的一版。' },
      { kind: 'actions', actions: [declare] },
    ],
  }
}

function stateTag(thing: Thing, state: DiskState): Tag {
  if (state === 'missing') return { text: '不在', tone: 'bad' }
  if (archived(thing)) return { text: '已归档', tone: 'neutral' }
  return state === 'changed' ? { text: '有没记下的改动', tone: 'warn' } : { text: '已记下', tone: 'good' }
}

/** Every change written down is the usual state: the page leaves it unsaid, the text form says it. */
const stateCell = (thing: Thing, state: DiskState): Cell => {
  const tag = stateTag(thing, state)
  return state !== 'missing' && state !== 'changed' && !archived(thing) ? { text: tag.text, muted: true, normal: true } : { text: '', tag }
}

/** A page of the things declared versioned that are in the library. */
export function thingsPage(things: { thing: Thing; state: DiskState }[], page: Paging): ViewAnswer {
  const rows: TableRow[] = things.map(({ thing, state }) => {
    const last = latest(thing)
    return {
      key: thing.id,
      cells: {
        path: { text: thing.path, mono: true, link: itemLink(thing.path) },
        versions: { text: `${thing.versions.length} 版`, muted: true },
        note: { text: last?.note ?? '', muted: true },
        by: { text: last ? whoText(last.by) : '', muted: true },
        latest: last ? { text: minute(last.at), at: last.at, muted: true } : { text: '' },
        state: stateCell(thing, state),
      },
      link: itemLink(thing.path),
      actions: [],
    }
  })
  const columns = [
    { key: 'path', label: '路径' },
    { key: 'versions', label: '版本' },
    { key: 'note', label: '最近一版的说明' },
    { key: 'by', label: '谁' },
    { key: 'latest', label: '时间' },
    { key: 'state', label: '状态' },
  ]
  const empty = '还没有声明有版本的东西。agent 用 say versioned <库内路径> 声明。'
  return { title: THINGS_VIEW.title, subtitle: null, blocks: [{ kind: 'table', columns, rows, empty, page }] }
}
