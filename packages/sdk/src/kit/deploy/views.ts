// What a deploy plugin shows: its page, in two states (where to publish, while nothing is connected;
// the destination and the things, once it is), and its part of the item panel, as the kernel's
// blocks, with the places a target adds marks, fields and blocks of its own.
import { posix } from 'node:path'
import type { IconName } from '../../icons.js'
import { formOf } from '../../params.js'
import type { Action, Block, Call, Cell, ItemSection, LibraryPath, ListItem, Tag, ViewAnswer, ViewDecl } from '../../types.js'
import { SWITCH_PARAMS, switchName } from './commands.js'
import { connectAction, connectFound, disconnectAction, foundAll, settingAction, type FoundOf } from './connect.js'
import { look, looks, thingPath, thingsAt, type Kit, type Run } from './reconcile.js'
import type { Look, TargetAdapter, TargetPage } from './target.js'
import { MEANING, STATUS } from './words.js'

export const sitesView = (kit: Kit) => `${kit.name}.sites`

/** Seconds after which a page asks again when its target reports what it serves and says nothing else. */
const REFRESH = 30

/** The targets' own pages, each with its view: `<plugin>.<name>`. */
export const targetPages = (kit: Kit): (TargetPage & { id: string })[] => kit.targets.flatMap((t) => (t.views ?? []).map((v) => ({ ...v, id: `${kit.name}.${v.name}` })))

/** The kit's page in the navigation; a target's own pages are other views of the same entry. */
export const viewDecls = (kit: Kit, icon: IconName): ViewDecl[] => [
  { id: sitesView(kit), title: kit.title, icon, nav: true, filters: [] },
  ...targetPages(kit).map((p) => ({ id: p.id, title: p.title, icon: p.icon, nav: true, filters: [], with: sitesView(kit) })),
]

const action = (label: string, call: Call, inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })

/**
 * The owner's switch for a thing, as the plugin `plugin`'s page offers it: 下线 a thing switched on,
 * 上线 one switched off. Null for an archived thing switched off: it is offline whatever its switch
 * says, so it offers no 上线.
 */
export function switchAction(plugin: string, l: Look): Action | null {
  if (!l.thing.on && l.standing.archived) return null
  const on = !l.thing.on
  const { inputs, call } = formOf({ name: switchName(plugin, on), params: SWITCH_PARAMS }, { fixed: { path: l.thing.path } })
  return { ...action(on ? '上线' : '下线', call, inputs), as: 'icon', icon: 'power' }
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

/** Offline is where a thing rests until the owner turns it on: the panel leaves it unsaid, the text form says it. */
const stateCell = (l: Look): Cell => (l.status === 'offline' ? { text: STATUS.offline.text, muted: true, normal: true } : { text: '', tag: STATUS[l.status] })
/** The address opens in a new tab when it is a web address, and can always be copied. */
const addressOf = (url: string): Cell => ({ text: url, mono: true, ...(/^https?:\/\//.test(url) ? { href: url } : {}), copy: true })
const addressCell = (l: Look): Cell => (l.url ? addressOf(l.url) : { text: '—', muted: true, normal: true })

/** A thing's mark on its row, when it is not as it should be: the target's own first, then the kit's, each with why. Online and offline show nothing. */
function markOf(run: Run, l: Look & { refused?: string | null }): Tag | null {
  const own = run.target?.view?.mark?.(l) ?? null
  if (own !== null) return own
  const why = (fallback: string | null) => (fallback === null ? {} : { tip: fallback })
  switch (l.status) {
    case 'pending':
      return { text: '待发布', tone: 'warn', ...why(l.refused ?? MEANING.pending(l)) }
    case 'retiring':
      return { text: '待下线', tone: 'warn', ...why(MEANING.retiring(l)) }
    case 'missing':
      return { text: '不在', tone: 'warn', ...why(MEANING.missing(l)) }
    case 'unknown':
      return { text: '读不到', tone: 'bad', ...why(l.unreachable) }
    default:
      return null
  }
}

/** Where to publish, while nothing is connected: each destination found on this machine, one row per group of kinds, the other kinds in the menu. */
async function whereTo(run: Run): Promise<Block> {
  const { kit } = run
  const found = await foundAll(kit, run.ctx)
  const items: ListItem[] = found.map((f) => ({ cell: { text: f.found.label, ...iconOf(f.adapter) }, note: null, actions: [{ ...connectFound(kit, f, '连上'), as: 'primary' }] }))
  const groups = [...new Set(kit.targets.flatMap((t) => (t.group ? [t.group.name] : [])))]
  for (const name of groups) {
    const kinds = kit.targets.filter((t) => t.group?.name === name)
    const any = found.some((f) => kinds.includes(f.adapter))
    items.push({ cell: { text: any ? `别的 ${name}` : name }, note: null, actions: [connectAction(kit, kinds, '连上…', { choose: (t) => t.group?.choice ?? t.label })] })
  }
  const loose = kit.targets.filter((t) => t.group === undefined)
  // With nothing found and no group, the kinds themselves are the rows.
  const rows = items.length === 0 ? loose.map((t): ListItem => ({ cell: { text: t.label, ...iconOf(t) }, note: null, actions: [connectAction(kit, [t], '连上…')] })) : []
  const menu = items.length === 0 ? [] : loose.map((t): Action => ({ ...connectAction(kit, [t], `${t.label}…`), as: 'menu' }))
  return { kind: 'section', title: '发到哪里', note: null, count: null, blocks: [{ kind: 'list', items: [...items, ...rows] }], actions: menu }
}

const iconOf = (t: TargetAdapter | undefined): { icon?: IconName } => (t?.icon === undefined ? {} : { icon: t.icon })

/** The connected destination as one row: what it is, a mark only while it cannot be read, and changing, a setting, or disconnecting in its menu. */
function destination(run: Run, all: readonly Look[], found: readonly FoundOf[]): Block {
  const { kit, target, set } = run
  if (target === null || set === null) throw new Error('no target')
  const adapter = kit.targets.find((t) => t.kind === set.kind)
  const unreachable = all.find((l) => l.unreachable !== null)?.unreachable
  const cell: Cell = {
    text: target.label,
    ...iconOf(adapter),
    ...(target.local ? { local: true as const } : {}),
    ...(unreachable ? { tag: { text: '读不到', tone: 'bad' as const, tip: unreachable } } : {}),
  }
  const actions: Action[] = [
    { ...connectAction(kit, kit.targets, '换一个…', { found, start: set.kind }), as: 'menu' },
    ...(adapter === undefined ? [] : (target.settings ?? []).map((s): Action => ({ ...settingAction(kit, set.kind, set.given, s, adapter), as: 'menu' }))),
    { ...disconnectAction(kit, target.label), as: 'menu' },
  ]
  return { kind: 'list', items: [{ cell, note: null, actions }] }
}

/**
 * The library's directory things nobody declared, as the choice of what to put online: from the first
 * page of the register, in the content, newest first, at most 200. Nothing walks the library.
 */
async function undeclaredDirs(run: Run): Promise<{ value: string; label: string }[]> {
  const { tools } = run.ctx
  const page = await tools.registered()
  const places = page.things.filter((t) => t.kind === 'bundle' && tools.regionOf(t.place) === 'content' && !run.d.byPath.has(t.place)).map((t) => t.place)
  const glanced = places.length === 0 ? [] : await tools.storage.glance(places)
  const modified = new Map(glanced.flatMap((g) => ('modified' in g && g.modified !== undefined ? [[g.place, g.modified]] : [])))
  return places
    .sort((a, b) => ((modified.get(b) ?? '') < (modified.get(a) ?? '') ? -1 : (modified.get(b) ?? '') > (modified.get(a) ?? '') ? 1 : a < b ? -1 : 1))
    .slice(0, 200)
    .map((p) => ({ value: p, label: p }))
}

/** 上线一样东西: one of the library's directory things, chosen, declared in the owner's name and switched on in one act; a typed path when there is none to choose. */
async function putOnline(run: Run): Promise<Action> {
  const options = await undeclaredDirs(run)
  const { inputs, call } = formOf({ name: switchName(run.kit.name, true), params: SWITCH_PARAMS }, options.length === 0 ? {} : { choices: { path: options }, values: { path: options[0]?.value ?? '' } })
  return { ...action('上线一样东西', call, inputs), icon: 'plus', as: 'primary' }
}

/** A thing as a row: its name, its folder in grey, its mark, its address at the end, and its switch. */
function thingItem(run: Run, l: Look & { refused?: string | null }): ListItem {
  const { path } = l.thing
  const folder = posix.dirname(path)
  const mark = markOf(run, l)
  const turn = switchAction(run.kit.name, l)
  return {
    cell: { text: posix.basename(path), link: { view: 'item', params: { path }, target: 'panel' }, ...(mark === null ? {} : { tag: mark }) },
    note: folder === '.' ? null : folder,
    actions: [],
    ...(l.url ? { aside: addressOf(l.url) } : {}),
    ...(turn === null ? {} : { toggle: { on: l.thing.on, action: turn } }),
  }
}

export async function sitesPage(run: Run): Promise<ViewAnswer> {
  const { kit, target } = run
  if (target === null) return { title: kit.title, subtitle: null, blocks: [await whereTo(run)] }
  const all = await looks(run)
  const view = target.view
  // The things in the content, and an archived one only while something of it is still online.
  const shown = all.filter((l) => run.ctx.tools.regionOf(l.thing.path) === 'content' || l.status === 'retiring')
  const waiting = all.some((l) => l.status === 'pending' || l.status === 'retiring')
  const retry: Action = { ...action('重试', { face: 'owner', command: `${kit.name} sync`, args: { positional: [], flags: {} } }), icon: 'refresh-cw', as: 'icon' }
  const head: Block = { kind: 'actions', head: true, actions: [await putOnline(run), ...(waiting ? [retry] : [])] }
  const things: Block = shown.length === 0 ? { kind: 'empty', title: '还没有上线的东西', hint: null } : { kind: 'list', items: shown.map((l) => thingItem(run, l)) }
  const found = await foundAll(kit, run.ctx)
  return { title: kit.title, subtitle: subtitleOf(all), blocks: [head, ...(view?.before?.(all) ?? []), destination(run, all, found), things, ...(view?.page?.(all) ?? [])], ...refreshOf(run) }
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
 * The item panel's section for a thing at `path`: a declared one's state, switch and address; a
 * directory thing in the content nobody declared, while a destination is connected, putting it online
 * from the panel's menu; null for anything else.
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

/** A directory thing of the content nobody declared, as the panel of the thing itself shows it: 上线… in its menu, while there is somewhere to put it. */
async function undeclaredSection(run: Run, path: LibraryPath): Promise<ItemSection | null> {
  const { tools } = run.ctx
  if (run.target === null || tools.regionOf(path) !== 'content' || (await thingPath(tools, path)) !== path || (await thingsAt(tools, [path]))[0] !== 'bundle') return null
  const { inputs, call } = formOf({ name: switchName(run.kit.name, true), params: SWITCH_PARAMS }, { fixed: { path } })
  return { title: run.kit.title, blocks: [], actions: [{ ...action('上线…', call, inputs), as: 'menu', confirm: `把 ${posix.basename(path)} 发到 ${run.target.label}？` }] }
}
