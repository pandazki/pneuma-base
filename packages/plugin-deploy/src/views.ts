// What the deploy plugin shows: the deploy.sites page and its part of the item panel, as the
// kernel's blocks, and the texts agents read in inspect and check.
import type { Action, Block, Call, ItemSection, LibraryPath, Tag, TableRow, ViewAnswer, ViewDecl } from '@pneuma-base/kernel'
import type { Status } from './model.js'
import { look, looks, type Look, type Run } from './reconcile.js'

export const STATUS: Record<Status, Tag> = {
  online: { text: '在线', tone: 'good' },
  pending: { text: '待发布', tone: 'warn' },
  offline: { text: '离线', tone: 'neutral' },
  retiring: { text: '待下线', tone: 'warn' },
  archived: { text: '已归档', tone: 'neutral' },
  missing: { text: '不在', tone: 'bad' },
}

/** What a state means, for the states that need saying. */
const MEANING: Record<Status, (l: Look) => string | null> = {
  online: () => null,
  offline: () => '上不上线由主人决定',
  pending: () => '开关开着，线上不是当前的内容',
  retiring: (l) => `它不该在线，目标上还有 ${[...l.held.keys()].join('、')}`,
  archived: (l) => (l.thing.on ? '开关开着，取回之后上线' : null),
  missing: () => '开关开着，但库里这个路径上没有东西',
}

/** One line, most important first: the state, the address, the switch, the site name, then what the state means. */
export function lookText(l: Look): string {
  const parts = [STATUS[l.status].text, ...(l.url ? [l.url] : []), `开关${l.thing.on ? '开' : '关'}`, ...(l.site ? [`站点名 ${l.site}`] : [])]
  const meaning = MEANING[l.status](l)
  return `${parts.join(' · ')}${meaning ? `。${meaning}` : ''}`
}

const UNSETTLED: ReadonlySet<Status> = new Set(['pending', 'retiring', 'missing'])

/** check: the declared things whose target does not match their switch and content. */
export function unsettledText(all: Look[], targetSet: boolean): { body: string; data: unknown } | null {
  const off = all.filter((l) => UNSETTLED.has(l.status))
  if (off.length === 0) return null
  const lines = off.map((l) => `${l.thing.path}：${STATUS[l.status].text}，${MEANING[l.status](l)}`)
  const next = targetSet ? '可以运行 deploy sync 再对一遍；目标出了问题就告诉主人。' : '还没配部署目标，告诉主人：deploy target set。'
  return { body: [...lines, next].join('\n'), data: off.map((l) => ({ path: l.thing.path, status: l.status, held: [...l.held.keys()] })) }
}

// ---- blocks ----

export const VIEWS: readonly ViewDecl[] = [{ id: 'deploy.sites', title: '部署', icon: 'globe', nav: true, filters: [] }]

const owner = (command: string, positional: string[], flags: Record<string, string[]> = {}): Call => ({ face: 'owner', command, args: { positional, flags } })
const action = (label: string, call: Call, inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })
const input = (name: string, label: string, placeholder: string): Action['inputs'][number] => ({ name, label, placeholder, value: null, options: null })

const switchAction = (l: Look): Action => (l.thing.on ? action('关上', owner('deploy off', [l.thing.path])) : action('打开', owner('deploy on', [l.thing.path])))
const stateCell = (l: Look) => ({ text: '', tag: STATUS[l.status] })
const addressCell = (l: Look) => (l.url ? { text: l.url, mono: true } : { text: '—', muted: true })

const SET_DIR = action('部署到本地目录', owner('deploy target set', [], { kind: ['dir'], to: ['{to}'] }), [input('to', '目录', '库外的一个目录')])
const SET_COMMAND = action('用命令部署', owner('deploy target set', [], { kind: ['command'], publish: ['{publish}'], unpublish: ['{unpublish}'], url: ['{url}'] }), [
  input('publish', '发布命令', '比如 wrangler pages deploy {dir} --project-name {name}'),
  input('unpublish', '下线命令', '比如 wrangler pages project delete {name} --yes'),
  input('url', '地址模板（可不填）', '比如 https://{name}.pages.dev'),
])

export async function sitesView(run: Run): Promise<ViewAnswer> {
  const all = await looks(run)
  const target: Block = {
    kind: 'section',
    title: '目标',
    note: null,
    count: null,
    blocks: [run.target ? { kind: 'fields', fields: [{ label: '目标', value: { text: run.target.label, mono: true } }] } : { kind: 'text', tone: 'warn', text: '还没配部署目标。开关打开的东西要等配了目标才发布。' }],
    actions: [SET_DIR, SET_COMMAND],
  }
  const rows: TableRow[] = all.map((l) => ({
    key: l.thing.id,
    cells: { path: { text: l.thing.path, mono: true }, state: stateCell(l), address: addressCell(l) },
    link: { view: 'item', params: { path: l.thing.path }, target: 'panel' },
    actions: [switchAction(l)],
  }))
  const things: Block = {
    kind: 'section',
    title: '可部署的东西',
    note: 'agent 用 say deployable 声明；在不在线由开关决定，开着的东西跟着库里当前的内容。',
    count: all.length,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '路径' }, { key: 'state', label: '状态' }, { key: 'address', label: '地址' }], rows, empty: '还没有声明过可以部署的东西' }],
    actions: [action('对一遍', owner('deploy sync', []))],
  }
  const online = all.filter((l) => l.status === 'online').length
  return { title: '部署', subtitle: `${online} 样在线，共 ${all.length} 样`, blocks: [target, things] }
}

/** The item panel's deploy section for a declared thing at `path`; null for anything else. */
export async function itemSection(run: Run, path: LibraryPath): Promise<ItemSection | null> {
  const id = run.d.byPath.get(path)
  if (id === undefined) return null
  const l = await look(run, id)
  const fields: Extract<Block, { kind: 'fields' }>['fields'] = [
    { label: '状态', value: stateCell(l) },
    { label: '开关', value: { text: l.thing.on ? '开' : '关' } },
    { label: '地址', value: addressCell(l) },
    ...(l.site ? [{ label: '站点名', value: { text: l.site, mono: true } }] : []),
  ]
  const meaning = MEANING[l.status](l)
  return { title: '部署', blocks: [{ kind: 'fields', fields }, ...(meaning ? [{ kind: 'text' as const, tone: 'neutral' as const, text: meaning }] : []), { kind: 'actions', actions: [switchAction(l)] }] }
}
