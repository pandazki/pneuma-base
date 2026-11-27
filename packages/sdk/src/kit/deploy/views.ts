// What a deploy plugin shows: its sites page and its part of the item panel, as the kernel's blocks,
// with the places a target adds columns, fields and blocks of its own.
import type { IconName } from '../../icons.js'
import { formOf } from '../../params.js'
import type { Action, Block, Call, Cell, ItemSection, LibraryPath, TableRow, ViewAnswer, ViewDecl } from '../../types.js'
import { kindFlag, SWITCH_PARAMS, switchName, targetSetName } from './commands.js'
import { look, looks, onlyTarget, thingPath, thingsAt, type Kit, type Run } from './reconcile.js'
import type { Look, TargetPage } from './target.js'
import { MEANING, STATUS } from './words.js'

export const sitesView = (kit: Kit) => `${kit.name}.sites`

/** Seconds after which a page asks again when its target reports what it serves and says nothing else. */
const REFRESH = 30

/** The targets' own pages, each with its view: `<plugin>.<name>`. */
export const targetPages = (kit: Kit): (TargetPage & { id: string })[] => kit.targets.flatMap((t) => (t.views ?? []).map((v) => ({ ...v, id: `${kit.name}.${v.name}` })))

export const viewDecls = (kit: Kit, icon: IconName): ViewDecl[] => [
  { id: sitesView(kit), title: kit.title, icon, nav: true, filters: [] },
  ...targetPages(kit).map((p) => ({ id: p.id, title: p.title, icon: p.icon, nav: true, filters: [] })),
]

const action = (label: string, call: Call, inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })

/**
 * The owner's switch for a thing, as the plugin `plugin`'s page offers it: turn off a switch that is
 * on, turn on one that is off. Null for an archived thing switched off: it is offline whatever its
 * switch says, so it offers no "turn on".
 */
export function switchAction(plugin: string, l: Look): Action | null {
  if (!l.thing.on && l.status === 'archived') return null
  const on = !l.thing.on
  const { inputs, call } = formOf({ name: switchName(plugin, on), params: SWITCH_PARAMS }, { fixed: { path: l.thing.path } })
  return { ...action(on ? '打开' : '关上', call, inputs), as: 'icon', icon: 'power' }
}

const switchActions = (kit: Kit, l: Look): Action[] => [switchAction(kit.name, l)].filter((a) => a !== null)

/** A page's `refresh`: the target's own, else 30 seconds when it reports what it serves; none without a target. */
function refreshOf(run: Run): { refresh?: number } {
  const t = run.target
  const refresh = t?.view?.refresh !== undefined ? t.view.refresh : t?.serving ? REFRESH : null
  return refresh === null ? {} : { refresh }
}

/** How many are online, when any is: the rest are offline, which goes unsaid. */
const subtitleOf = (all: readonly Look[]) => {
  const online = all.filter((l) => l.status === 'online').length
  return online === 0 ? null : `${online} 样在线`
}

/** Offline is where a thing rests until the owner turns it on: the page leaves it unsaid, the text form says it. */
const stateCell = (l: Look): Cell => (l.status === 'offline' ? { text: STATUS.offline.text, muted: true, normal: true } : { text: '', tag: STATUS[l.status] })
/** The address opens in a new tab when it is a web address, and can always be copied. */
const addressCell = (l: Look): Cell => (l.url ? { text: l.url, mono: true, ...(/^https?:\/\//.test(l.url) ? { href: l.url } : {}), copy: true } : { text: '—', muted: true, normal: true })

/**
 * One action per kind of target, asking for that kind's flags of `<name> target set`: with no target
 * yet, the first is the page's main action; once one is set, changing it is rare and in the menu.
 */
function setTargetActions(kit: Kit, set: boolean): Action[] {
  return kit.targets.map((t, i) => {
    const { inputs, call } = formOf({ name: targetSetName(kit), params: { flags: [kindFlag(kit), ...t.params] } }, { fixed: { kind: t.kind } })
    return { ...action(onlyTarget(kit) ? '设部署目标' : `设为${t.label}`, call, inputs), icon: 'pencil', as: set ? 'menu' : i === 0 ? 'primary' : 'menu' }
  })
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
      configured ? { kind: 'fields', line: true, fields: [{ label: '目标', value: { text: configured.label, mono: true } }] } : { kind: 'text', tone: 'warn', text: '还没配部署目标。开关打开的东西要等配了目标才发布。' },
      ...(unreachable ? [{ kind: 'text' as const, tone: 'bad' as const, text: `读不到目标：${unreachable}` }] : []),
    ],
    actions: setTargetActions(kit, configured !== null),
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
    note: null,
    about: 'agent 用 say deployable 声明；在不在线由开关决定，开着的东西跟着库里当前的内容。',
    count: all.length,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '路径' }, { key: 'state', label: '状态' }, { key: 'address', label: '地址' }, ...(view?.columns ?? [])], rows, empty: '还没有声明过可以部署的东西' }],
    actions: [{ ...action('对一遍', { face: 'owner', command: `${kit.name} sync`, args: { positional: [], flags: {} } }), as: 'icon', icon: 'refresh-cw' }],
  }
  return { title: kit.title, subtitle: subtitleOf(all), blocks: [...(view?.before?.(all) ?? []), target, things, ...(view?.page?.(all) ?? [])], ...refreshOf(run) }
}

/** One of the target's own pages, from the same looks as the kit's page; it says so when the configured target does not draw it. */
export async function targetPage(run: Run, page: TargetPage): Promise<ViewAnswer> {
  const draw = run.target?.view?.pages?.[page.name]
  if (run.target === null || draw === undefined) {
    const text = run.target === null ? '还没配部署目标，这一页要等配了目标才有。' : `现在的部署目标（${run.target.label}）不画这一页。`
    return { title: page.title, subtitle: null, blocks: [{ kind: 'text', tone: 'warn', text }] }
  }
  const all = await looks(run)
  const unreachable = all.find((l) => l.unreachable !== null)?.unreachable
  const warning: Block[] = unreachable ? [{ kind: 'text', tone: 'bad', text: `读不到目标：${unreachable}` }] : []
  return { title: page.title, subtitle: subtitleOf(all), blocks: [...warning, ...draw(all)], ...refreshOf(run) }
}

/**
 * The item panel's section for a thing at `path`: a declared one's state, switch and address; a thing
 * in the content nobody declared, what that means and the declaration as a button; null for anything else.
 */
export async function itemSection(run: Run, path: LibraryPath): Promise<ItemSection | null> {
  const id = run.d.byPath.get(path)
  if (id === undefined) return undeclaredSection(run, path)
  const l = await look(run, id)
  const view = run.target?.view
  const fields: Extract<Block, { kind: 'fields' }>['fields'] = [
    { label: '状态', value: stateCell(l) },
    { label: '开关', value: { text: l.thing.on ? '开' : '关', ...(l.thing.on ? {} : { normal: true as const }) } },
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

/** A thing of the content nobody declared deployable, as the panel of the thing itself shows it, not of a file inside a bundle. */
async function undeclaredSection(run: Run, path: LibraryPath): Promise<ItemSection | null> {
  const { tools } = run.ctx
  if ((await thingPath(tools, path)) !== path || tools.regionOf(path) !== 'content' || (await thingsAt(tools, [path]))[0] === null) return null
  const declare = action('声明可以部署', { face: 'agent', verb: 'say', request: { kind: 'deployable', about: path, text: null, args: {} } })
  return {
    title: run.kit.title,
    blocks: [
      { kind: 'text', tone: 'neutral', text: '没有声明可以部署：它不会上线。声明之后，上不上线由主人的开关决定。' },
      { kind: 'actions', actions: [declare] },
    ],
  }
}
