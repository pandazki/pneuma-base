// What a deploy plugin shows: its sites page and its part of the item panel, as the kernel's blocks,
// with the places a target adds columns, fields and blocks of its own.
import type { Action, Block, Call, Cell, ItemSection, LibraryPath, TableRow, ViewAnswer, ViewDecl } from '../../types.js'
import { look, looks, type Kit, type Run } from './reconcile.js'
import type { Look } from './target.js'
import { MEANING, STATUS } from './words.js'

export const sitesView = (kit: Kit) => `${kit.name}.sites`
export const viewDecls = (kit: Kit, icon: string): ViewDecl[] => [{ id: sitesView(kit), title: kit.title, icon, nav: true, filters: [] }]

const owner = (command: string, positional: string[], flags: Record<string, string[]> = {}): Call => ({ face: 'owner', command, args: { positional, flags } })
const action = (label: string, call: Call, inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })

/** An archived thing is offline whatever its switch says, so it offers no "turn on"; a switch left on can still be turned off. */
function switchActions(kit: Kit, l: Look): Action[] {
  if (l.thing.on) return [action('关上', owner(`${kit.name} off`, [l.thing.path]))]
  return l.status === 'archived' ? [] : [action('打开', owner(`${kit.name} on`, [l.thing.path]))]
}

const stateCell = (l: Look): Cell => ({ text: '', tag: STATUS[l.status] })
/** The address opens in a new tab when it is a web address, and can always be copied. */
const addressCell = (l: Look): Cell => (l.url ? { text: l.url, mono: true, ...(/^https?:\/\//.test(l.url) ? { href: l.url } : {}), copy: true } : { text: '—', muted: true })

/** One button per kind of target, filling `<name> target set` from its form. */
function setTargetActions(kit: Kit): Action[] {
  return kit.targets.map((t) => action(t.form.label, owner(`${kit.name} target set`, [], { kind: [t.kind], ...Object.fromEntries(t.form.inputs.map((i) => [i.name, [`{${i.name}}`]])) }), [...t.form.inputs]))
}

export async function sitesPage(run: Run): Promise<ViewAnswer> {
  const { kit, target: configured } = run
  const all = await looks(run)
  const view = configured?.view
  const unreachable = all.find((l) => l.unreachable !== null)?.unreachable
  const target: Block = {
    kind: 'section',
    title: '目标',
    note: null,
    count: null,
    blocks: [
      configured ? { kind: 'fields', fields: [{ label: '目标', value: { text: configured.label, mono: true } }] } : { kind: 'text', tone: 'warn', text: '还没配部署目标。开关打开的东西要等配了目标才发布。' },
      ...(unreachable ? [{ kind: 'text' as const, tone: 'bad' as const, text: `读不到目标：${unreachable}` }] : []),
    ],
    actions: setTargetActions(kit),
  }
  const rows: TableRow[] = all.map((l) => ({
    key: l.thing.id,
    cells: { path: { text: l.thing.path, mono: true }, state: stateCell(l), address: addressCell(l), ...view?.cells?.(l) },
    link: { view: 'item', params: { path: l.thing.path }, target: 'panel' },
    actions: switchActions(kit, l),
  }))
  const things: Block = {
    kind: 'section',
    title: '可部署的东西',
    note: 'agent 用 say deployable 声明；在不在线由开关决定，开着的东西跟着库里当前的内容。',
    count: all.length,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '路径' }, { key: 'state', label: '状态' }, { key: 'address', label: '地址' }, ...(view?.columns ?? [])], rows, empty: '还没有声明过可以部署的东西' }],
    actions: [action('对一遍', owner(`${kit.name} sync`, []))],
  }
  const online = all.filter((l) => l.status === 'online').length
  return { title: kit.title, subtitle: `${online} 样在线，共 ${all.length} 样`, blocks: [target, things, ...(view?.page?.(all) ?? [])] }
}

/** The item panel's section for a declared thing at `path`; null for anything else. */
export async function itemSection(run: Run, path: LibraryPath): Promise<ItemSection | null> {
  const id = run.d.byPath.get(path)
  if (id === undefined) return null
  const l = await look(run, id)
  const view = run.target?.view
  const fields: Extract<Block, { kind: 'fields' }>['fields'] = [
    { label: '状态', value: stateCell(l) },
    { label: '开关', value: { text: l.thing.on ? '开' : '关' } },
    { label: '地址', value: addressCell(l) },
    ...(l.site ? [{ label: '站点名', value: { text: l.site, mono: true } }] : []),
    ...(view?.fields?.(l) ?? []),
  ]
  const meaning = MEANING[l.status](l)
  const actions = switchActions(run.kit, l)
  return {
    title: run.kit.title,
    blocks: [
      { kind: 'fields', fields },
      ...(meaning ? [{ kind: 'text' as const, tone: 'neutral' as const, text: meaning }] : []),
      ...(actions.length > 0 ? [{ kind: 'actions' as const, actions }] : []),
      ...(view?.item?.(l) ?? []),
    ],
  }
}
