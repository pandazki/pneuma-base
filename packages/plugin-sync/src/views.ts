// What the sync shows: the sync.status page, its part of the item panel, and its section of check.
// Each is a function of the files, the records and the baseline; showing changes nothing.
import { formOf, TEXT_ROWS, type Action, type Block, type ItemSection, type LibraryPath, type PluginContext, type PluginSection, type ViewAnswer, type ViewDecl } from '@pneuma-base/kernel'
import { TARGET_SET } from './commands.js'
import { conflictCopies, countsText, notReadyText, pendingOf, status, when, type Prepared } from './sync.js'

export const STATUS_VIEW: ViewDecl = { id: 'sync.status', title: '同步', icon: 'refresh-cw', nav: true, filters: [], with: 'settings' }

const owner = (command: string) => ({ face: 'owner' as const, command, args: { positional: [], flags: {} } })

const archiveAction = (path: LibraryPath): Action => ({
  label: '归档',
  tone: 'default',
  as: 'icon',
  icon: 'archive',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path } },
})

const syncNow: Action = { label: '立即同步', tone: 'default', confirm: null, inputs: [], call: owner('sync now') }

const setTarget = (current: string | null): Action => ({
  label: current === null ? '设置同步目标' : '更换同步目标',
  tone: 'default',
  confirm: null,
  ...formOf(TARGET_SET, { fixed: { kind: 'folder' }, values: current === null ? {} : { to: current } }),
})

const RESOLVE = '比较两份内容，将需要的内容写回原文件，再归档冲突副本。'

const PENDING_ROWS = [
  ['pushed', '上传'],
  ['pulled', '下载'],
  ['removed', '删除（其他位置仍有内容）'],
  ['deleted', '删除（所有者用破坏性命令删除）'],
  ['kept', '保留（移入 _archive/ 或留在原位置）'],
  ['conflicts', '冲突（保留双方）'],
] as const

/** What a sync now would do, by kind, with the button that does it; or why it cannot. */
function pendingBlock(prepared: Prepared, machine: string): Block {
  const section = (note: string | null, count: number | null, blocks: Block[]): Block => ({ kind: 'section', title: '待同步', note, count, blocks, actions: [syncNow] })
  if (prepared.kind !== 'ready') return section(null, null, [{ kind: 'text', tone: 'warn', text: notReadyText(prepared, machine, false) }])
  const pending = pendingOf(prepared.plan)
  const rows = PENDING_ROWS.map(([key, label]) => ({ key, cells: { what: { text: label }, count: { text: String(pending[key]), mono: true } }, link: null, actions: [] }))
  const table: Block = { kind: 'table', columns: [{ key: 'what', label: '操作' }, { key: 'count', label: '数量' }], rows, empty: '已同步' }
  return section(pending.steps === 0 ? '已同步' : null, pending.steps, [table])
}

export async function statusView(ctx: PluginContext): Promise<ViewAnswer> {
  const { prepared, record, last, copies } = await status(ctx)
  if (record === null) {
    return {
      title: '同步',
      subtitle: null,
      blocks: [
        { kind: 'empty', title: '未设置同步目标', hint: '将本机的一个目录设为同步目标。同步不合并内容，所有内容均可恢复。' },
        { kind: 'actions', head: true, actions: [{ ...setTarget(null), as: 'primary' }] },
      ],
    }
  }
  const lastCell =
    last === null
      ? { text: '本机尚未同步', muted: true }
      : last.outcome === 'done'
        ? { text: `${when(last.at)} · ${countsText(last.counts)}` }
        : { text: `${when(last.at)} · ${last.message ?? ''}`, tag: { text: '中断', tone: 'bad' as const } }
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '上次同步', value: lastCell },
      { label: '设置时间', value: { text: `机器 ${record.machine} · ${when(record.at)}`, muted: true } },
    ],
  }
  const pendingSection = pendingBlock(prepared, ctx.session.machine)
  const conflictSection: Block = {
    kind: 'section',
    title: '冲突副本',
    note: null,
    about: `两侧修改了同一个文件，另一侧的版本放在旁边。${RESOLVE}`,
    count: copies.length,
    ...(copies.length === 0 ? { normal: true as const } : {}),
    blocks: [
      copies.length === 0
        ? { kind: 'empty', title: '无冲突副本', hint: null }
        : {
            kind: 'list',
            items: copies.map((c) => ({ cell: { text: c.copy, mono: true, link: { view: 'item', params: { path: c.copy }, target: 'panel' as const } }, note: `${c.original} 的另一侧版本`, actions: [archiveAction(c.copy)] })),
          },
    ],
    actions: [],
  }
  // The target is the page's subtitle; changing it is rare and in the head's menu. A target missing here
  // is said once, by what a sync would do.
  return { title: '同步', subtitle: `目录 ${record.target.path}`, blocks: [{ kind: 'actions', head: true, actions: [{ ...setTarget(record.target.path), as: 'menu', icon: 'pencil' }] }, fields, pendingSection, conflictSection] }
}

/** For a conflict copy, the file it was made for; for a file or a bundle with conflict copies, those copies. Null otherwise. */
export async function itemSection(path: LibraryPath, ctx: PluginContext): Promise<ItemSection | null> {
  const copies = await conflictCopies(ctx)
  const self = copies.find((c) => c.copy === path)
  if (self) {
    return { title: '同步', blocks: [{ kind: 'text', tone: 'warn', text: `此文件是 ${self.original} 的冲突副本：两侧都修改了该文件，此为另一侧的版本。${RESOLVE}` }, { kind: 'actions', actions: [archiveAction(path)] }] }
  }
  const mine = copies.filter((c) => c.original === path || c.copy.startsWith(`${path}/`))
  if (mine.length === 0) return null
  return {
    title: '同步',
    blocks: [
      { kind: 'text', tone: 'warn', text: `同步时两侧都修改了此文件，另一侧的版本放在旁边。${RESOLVE}` },
      { kind: 'list', items: mine.map((c) => ({ cell: { text: c.copy, mono: true, link: { view: 'item', params: { path: c.copy }, target: 'panel' as const } }, note: null, actions: [] })) },
    ],
  }
}

/** The conflict copies still around, for check. */
export async function checkSections(ctx: PluginContext): Promise<PluginSection[]> {
  const copies = await conflictCopies(ctx)
  if (copies.length === 0) return []
  const shown = copies.slice(0, TEXT_ROWS)
  const lines = shown.map((c) => `  ${c.copy}（${c.original} 的另一侧版本）`)
  const rest = copies.length > shown.length ? [`  ……查看全部：show ${STATUS_VIEW.id}`] : []
  const body = [`现存 ${copies.length} 个冲突副本：同步时两侧修改了同一个文件，另一侧的版本放在旁边。${RESOLVE}`, ...lines, ...rest].join('\n')
  return [{ title: '同步冲突', body, data: { conflicts: shown, count: copies.length, ...(rest.length > 0 ? { more: `show ${STATUS_VIEW.id}` } : {}) } }]
}
