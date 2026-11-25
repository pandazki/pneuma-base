// What the sync shows: the sync.status page, its part of the item panel, and its section of check.
// Each is a function of the files, the records and the baseline; showing changes nothing.
import type { Action, Block, ItemSection, LibraryPath, PluginContext, PluginSection, ViewAnswer, ViewDecl } from '@pneuma-base/kernel'
import { conflictCopies, countsText, notReadyText, pendingOf, status, when, type Prepared } from './sync.js'

export const STATUS_VIEW: ViewDecl = { id: 'sync.status', title: '同步', icon: 'refresh-cw', nav: true, filters: [] }

const owner = (command: string, flags: Record<string, string[]> = {}) => ({ face: 'owner' as const, command, args: { positional: [], flags } })

const archiveAction = (path: LibraryPath): Action => ({
  label: '归档',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path } },
})

const syncNow: Action = { label: '现在同步', tone: 'default', confirm: null, inputs: [], call: owner('sync now') }

const setTarget = (current: string | null): Action => ({
  label: current === null ? '设同步目标' : '换同步目标',
  tone: 'default',
  confirm: null,
  inputs: [{ name: 'to', label: '目标目录', placeholder: '本机上一个库外的目录', value: current, options: null }],
  call: owner('sync target set', { kind: ['dir'], to: ['{to}'] }),
})

const RESOLVE = '看过两份，把要的内容放回原文件，再把冲突副本归档。'

const PENDING_ROWS = [
  ['pushed', '推上去'],
  ['pulled', '拉下来'],
  ['removed', '删掉（内容别处还有）'],
  ['kept', '留下（进 _archive/ 或留在原处）'],
  ['conflicts', '冲突（两份都留）'],
] as const

/** What a sync now would do, by kind, with the button that does it; or why it cannot. */
function pendingBlock(prepared: Prepared, machine: string): Block {
  const section = (note: string | null, count: number | null, blocks: Block[]): Block => ({ kind: 'section', title: '待同步', note, count, blocks, actions: [syncNow] })
  if (prepared.kind !== 'ready') return section(null, null, [{ kind: 'text', tone: 'warn', text: notReadyText(prepared, machine) }])
  const pending = pendingOf(prepared.plan)
  const rows = PENDING_ROWS.map(([key, label]) => ({ key, cells: { what: { text: label }, count: { text: String(pending[key]), mono: true } }, link: null, actions: [] }))
  const table: Block = { kind: 'table', columns: [{ key: 'what', label: '做什么' }, { key: 'count', label: '数目' }], rows, empty: '两边一样' }
  return section(pending.steps === 0 ? '两边一样' : null, pending.steps, [table])
}

export async function statusView(ctx: PluginContext): Promise<ViewAnswer> {
  const { prepared, record, last, copies } = await status(ctx)
  if (record === null) {
    return {
      title: '同步',
      subtitle: null,
      blocks: [
        { kind: 'empty', title: '还没设同步目标', hint: '设一个本机上的目录作同步目标。同步不合并内容，也不让任何内容找不回。' },
        { kind: 'actions', actions: [setTarget(null)] },
      ],
    }
  }
  const lastCell =
    last === null
      ? { text: '这台机器还没同步过', muted: true }
      : last.outcome === 'done'
        ? { text: `${when(last.at)} · ${countsText(last.counts)}`, tag: { text: '完成', tone: 'good' as const } }
        : { text: `${when(last.at)} · ${last.message ?? ''}`, tag: { text: '中断', tone: 'bad' as const } }
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '目标', value: { text: record.target.path, mono: true, ...(prepared.kind === 'target-missing' ? { tag: { text: '这台机器上没有', tone: 'warn' as const } } : {}) } },
      { label: '设于', value: { text: `机器 ${record.machine} · ${when(record.at)}`, muted: true } },
      { label: '上次同步', value: lastCell },
    ],
  }
  const pendingSection = pendingBlock(prepared, ctx.session.machine)
  const conflictSection: Block = {
    kind: 'section',
    title: '冲突副本',
    note: copies.length > 0 ? `两边都改过同一个文件，另一边的那份放在旁边。${RESOLVE}` : null,
    count: copies.length,
    blocks: [
      copies.length === 0
        ? { kind: 'empty', title: '没有冲突副本', hint: null }
        : {
            kind: 'list',
            items: copies.map((c) => ({ cell: { text: c.copy, mono: true, link: { view: 'item', params: { path: c.copy }, target: 'panel' as const } }, note: `${c.original} 的另一份`, actions: [archiveAction(c.copy)] })),
          },
    ],
    actions: [],
  }
  return { title: '同步', subtitle: `目录 ${record.target.path}`, blocks: [fields, pendingSection, conflictSection, { kind: 'actions', actions: [setTarget(record.target.path)] }] }
}

/** For a conflict copy, the file it was made for; for a file or a bundle with conflict copies, those copies. Null otherwise. */
export async function itemSection(path: LibraryPath, ctx: PluginContext): Promise<ItemSection | null> {
  const copies = await conflictCopies(ctx)
  const self = copies.find((c) => c.copy === path)
  if (self) {
    return { title: '同步', blocks: [{ kind: 'text', tone: 'warn', text: `这是 ${self.original} 的冲突副本：两边都改过它，这是另一边的那份。${RESOLVE}` }, { kind: 'actions', actions: [archiveAction(path)] }] }
  }
  const mine = copies.filter((c) => c.original === path || c.copy.startsWith(`${path}/`))
  if (mine.length === 0) return null
  return {
    title: '同步',
    blocks: [
      { kind: 'text', tone: 'warn', text: `同步时两边都改过它，另一边的那份放在旁边。${RESOLVE}` },
      { kind: 'list', items: mine.map((c) => ({ cell: { text: c.copy, mono: true, link: { view: 'item', params: { path: c.copy }, target: 'panel' as const } }, note: null, actions: [] })) },
    ],
  }
}

/** The conflict copies still around, for check. */
export async function checkSections(ctx: PluginContext): Promise<PluginSection[]> {
  const copies = await conflictCopies(ctx)
  if (copies.length === 0) return []
  const lines = copies.map((c) => `  ${c.copy}（${c.original} 的另一份）`)
  const body = [`还有 ${copies.length} 份冲突副本：同步时两边都改过同一个文件，另一边的那份放在旁边。${RESOLVE}`, ...lines].join('\n')
  return [{ title: '同步冲突', body, data: { conflicts: copies } }]
}
