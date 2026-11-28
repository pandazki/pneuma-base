// What the management UI shows, in the kernel's block types only: a thing's section of the item
// panel, and the page of every versioned thing. Pure.
import { formOf, type Action, type Block, type Cell, type ItemSection, type LibraryPath, type Link, type Paging, type Tag, type TableRow, type ViewAnswer, type ViewDecl } from '@pneuma-base/kernel'
import { VERSION_EXPORT, VERSION_PRUNE, VERSION_RESTORE } from './commands.js'
import { latest, type Thing, type Version } from './model.js'
import { aboutVersion, archived, minute, whoText } from './text.js'

/** The owner as the pages name it, which the owner reads; text an agent or the command line reads says 所有者. */
const ME = '我'
import type { DiskState } from './versions.js'

export const THINGS_VIEW: ViewDecl = {
  id: 'version.items',
  title: '受版本管理的条目',
  icon: 'git-branch',
  nav: true,
  filters: [{ name: 'archived', label: '已归档', options: [{ value: 'hide', label: '使用中' }, { value: 'show', label: '包含已归档' }], default: 'hide' }],
}

const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })

function versionTag(thing: Thing, v: Version, state: DiskState): Tag | null {
  if (v.pruned) return { text: '已清除', tone: 'neutral' }
  // The latest is the current one: said only where there are others to tell it from.
  if (v === latest(thing) && state === 'current') return thing.versions.length > 1 ? { text: '当前', tone: 'neutral' } : null
  if (v.via === 'outside') return { text: '外部修改', tone: 'warn' }
  return null
}

/** The versions whose content is kept, newest first, as a choice; the one before the latest is chosen. */
function versionChoice(thing: Thing) {
  const kept = thing.versions.filter((v) => !v.pruned).toReversed()
  return {
    values: { version: String((kept[1] ?? kept[0])?.n ?? '') },
    choices: { version: kept.map((v) => ({ value: String(v.n), label: `版本 ${v.n} · ${minute(v.at)}${v.note ? ` · ${v.note}` : ''}` })) },
  }
}

function actions(thing: Thing): Action[] {
  const fixed = { path: thing.path }
  const exported: Action = { label: '导出', tone: 'default', confirm: null, ...formOf(VERSION_EXPORT, { fixed, ...versionChoice(thing) }) }
  const restored: Action = {
    label: '恢复此版本',
    tone: 'default',
    confirm: `将所选版本恢复到 ${thing.path}，并记录为新版本。当前内容已是一个版本，不会丢失。`,
    ...formOf(VERSION_RESTORE, { fixed, ...versionChoice(thing) }),
  }
  // 「说 version」 writes the current version's note, as the command line's say version does.
  const noted: Action = {
    label: '为当前版本添加说明',
    tone: 'default',
    confirm: null,
    inputs: [{ name: 'note', label: '说明', placeholder: '此版本修改的内容', value: latest(thing)?.note ?? null, options: null }],
    call: { face: 'agent', verb: 'say', request: { kind: 'version', about: thing.path, text: '{note}', args: {} } },
  }
  const kept = thing.versions.filter((v) => !v.pruned).length
  const pruned: Action = {
    label: '仅保留最近版本',
    tone: 'danger',
    confirm: `将清除 ${thing.path} 更早的版本，仅属于这些版本的内容一并删除，此操作不可撤销。`,
    ...formOf(VERSION_PRUNE, { fixed, values: { keep: String(Math.max(1, Math.min(kept, 3))) } }),
  }
  return archived(thing) ? [exported, pruned] : [exported, restored, noted, pruned]
}

const STATE_NOTE: Record<Exclude<DiskState, 'current'>, string> = {
  changed: '当前内容已被外部修改，尚未记录为版本；Agent 执行 check 时记录。',
  missing: '此路径当前不存在；可恢复任一版本。',
}

/** A declared thing: its versions newest first, with export and restore. */
export function itemSection(thing: Thing, state: DiskState): ItemSection {
  const timeline: Block = {
    kind: 'timeline',
    entries: thing.versions.toReversed().map((v) => ({ at: v.at, title: { text: `版本 ${v.n}` }, lines: aboutVersion(v, ME), tag: versionTag(thing, v, state) })),
  }
  const note: Block[] = state === 'current' ? [] : [{ kind: 'text', tone: 'warn', text: STATE_NOTE[state] }]
  return { title: '版本', blocks: [...note, timeline, { kind: 'actions', actions: actions(thing) }] }
}

/** A thing nobody declared: what that means, and the declaration as a button. */
export function undeclaredSection(path: LibraryPath): ItemSection {
  const declare: Action = {
    label: '启用版本管理',
    tone: 'default',
    confirm: null,
    inputs: [],
    call: { face: 'agent', verb: 'say', request: { kind: 'versioned', about: path, text: null, args: {} } },
  }
  return {
    title: '版本',
    blocks: [
      { kind: 'text', tone: 'neutral', text: '未启用版本管理：添加新内容时，不保留旧版本。' },
      { kind: 'actions', actions: [declare] },
    ],
  }
}

function stateTag(thing: Thing, state: DiskState): Tag {
  if (state === 'missing') return { text: '已缺失', tone: 'bad' }
  if (archived(thing)) return { text: '已归档', tone: 'neutral' }
  return state === 'changed' ? { text: '有未记录的修改', tone: 'warn' } : { text: '已记录', tone: 'good' }
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
        versions: { text: `${thing.versions.length} 个版本`, muted: true },
        note: { text: last?.note ?? '', muted: true },
        by: { text: last ? whoText(last.by, ME) : '', muted: true },
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
    { key: 'note', label: '最新版本说明' },
    { key: 'by', label: '执行者' },
    { key: 'latest', label: '时间' },
    { key: 'state', label: '状态' },
  ]
  const empty = '暂无受版本管理的条目。Agent 用 say versioned <库内路径> 启用版本管理。'
  return { title: THINGS_VIEW.title, subtitle: null, blocks: [{ kind: 'table', columns, rows, empty, page }] }
}
