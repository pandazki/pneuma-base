// What a plugin's view answers, checked at the kernel's boundary (ARCHITECTURE section 6). A block
// that is not a known kind, lacks a required field, or carries an action that calls nothing the
// library runs is replaced by one that says whose it was and why, and is listed as a problem (K8);
// the rest of the page stands. Optional fields are checked only when given; fields the kernel does
// not know are left as they are.
import { isAbsolute } from 'node:path'
import { parseCall } from './call.js'
import { ownerFace } from './owner.js'
import { checkArgs } from './params.js'
import type { Action, Block, Library, OwnerParams, Plugin, PluginProblem, ViewAnswer, ViewDecl } from '@pneuma-base/sdk'

/** What is wrong with `value` at `at`, or null when it fits. */
type Check = (value: unknown, at: string) => string | null

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

const string: Check = (v, at) => (typeof v === 'string' ? null : `${at} 应是文字`)
const number: Check = (v, at) => (typeof v === 'number' && Number.isFinite(v) ? null : `${at} 应是数字`)
const boolean: Check = (v, at) => (typeof v === 'boolean' ? null : `${at} 应是 true 或 false`)
const anything: Check = () => null
const oneOf =
  (...values: string[]): Check =>
  (v, at) =>
    values.includes(v as string) ? null : `${at} 应是 ${values.join('、')} 之一`
const nullable =
  (check: Check): Check =>
  (v, at) =>
    v === null ? null : check(v, at)
const listOf =
  (check: Check): Check =>
  (v, at) => {
    if (!Array.isArray(v)) return `${at} 应是列表`
    for (const [i, item] of v.entries()) {
      const wrong = check(item, `${at}[${i}]`)
      if (wrong) return wrong
    }
    return null
  }
const recordOf =
  (check: Check): Check =>
  (v, at) => {
    if (!isObject(v)) return `${at} 应是对象`
    for (const [key, item] of Object.entries(v)) {
      const wrong = check(item, `${at}.${key}`)
      if (wrong) return wrong
    }
    return null
  }

/** An object with these fields; a key ending in `?` is optional and checked only when given. */
function shape(fields: Record<string, Check>): Check {
  return (v, at) => {
    if (!isObject(v)) return `${at} 应是对象`
    for (const [spec, check] of Object.entries(fields)) {
      const optional = spec.endsWith('?')
      const key = optional ? spec.slice(0, -1) : spec
      const value = v[key]
      if (value === undefined) {
        if (optional) continue
        return `${at} 缺少 ${key}`
      }
      const wrong = check(value, `${at}.${key}`)
      if (wrong) return wrong
    }
    return null
  }
}

const httpUrl: Check = (v, at) => {
  if (typeof v !== 'string') return `${at} 应是文字`
  const protocol = URL.canParse(v) ? new URL(v).protocol : null
  return protocol === 'http:' || protocol === 'https:' ? null : `${at} 不是 http 或 https 的地址`
}

/** A pattern as the page applies it: the whole value, with the `u` flag. */
const pattern: Check = (v, at) => {
  if (typeof v !== 'string') return `${at} 应是文字`
  try {
    new RegExp(`^(?:${v})$`, 'u')
    return null
  } catch {
    return `${at} 不是正则表达式`
  }
}

/** A path inside the plugin's `ui` directory: relative, without `..`. */
const entry: Check = (v, at) => {
  if (typeof v !== 'string') return `${at} 应是文字`
  const parts = v.split(/[\\/]/)
  return v !== '' && !isAbsolute(v) && !parts.includes('..') && !v.includes('\0') ? null : `${at} 应是 ui 目录里的相对路径`
}

const tone = oneOf('neutral', 'good', 'warn', 'bad', 'info')
const tag = shape({ text: string, tone })
const link = shape({ view: string, params: recordOf(string), target: oneOf('main', 'panel') })
const actorMark = shape({ kind: oneOf('agent', 'owner'), name: string, 'grant?': string })
/** Who, as a block says it: a name, or an actor whose mark the page draws. */
const who: Check = (v, at) => (typeof v === 'string' ? null : actorMark(v, at))
const cell = shape({ text: string, 'mono?': boolean, 'muted?': boolean, 'tag?': tag, 'link?': link, 'at?': string, 'icon?': string, 'href?': string, 'copy?': boolean, 'actor?': actorMark })

const call: Check = (v, at) => {
  const parsed = parseCall(v)
  return typeof parsed === 'string' ? `${at} 不是一个动词或一条主人命令的调用：${parsed}` : null
}
const input = shape({
  name: string,
  label: string,
  placeholder: nullable(string),
  value: nullable(string),
  options: nullable(listOf(shape({ value: string, label: string }))),
  'multiple?': boolean,
  'pattern?': pattern,
  'hint?': string,
  'secret?': (v, at) => (v === true ? null : `${at} 只能是 true`),
})
const action = shape({ label: string, tone: oneOf('default', 'danger'), confirm: nullable(string), inputs: listOf(input), call })
const actions = listOf(action)

/** Both checks, the first fault first. */
const both =
  (a: Check, b: Check): Check =>
  (v, at) =>
    a(v, at) ?? b(v, at)

const feedRow = both(
  shape({ key: string, at: string, actor: who, text: string, meta: listOf(cell), 'whose?': oneOf('agent', 'owner', 'observed'), 'action?': action, 'settled?': string, link: nullable(link) }),
  (v, at) => ((v as Raw).action !== undefined && (v as Raw).settled !== undefined ? `${at} 不能同时有 action 和 settled` : null),
)
const feedGroup = shape({ title: string, count: nullable(number), 'link?': link, rows: listOf(feedRow) })
const treeNode: Check = (v, at) => shape({ value: string, label: string, count: nullable(number), children: listOf(treeNode) })(v, at)
const ask = both(
  shape({ key: string, by: who, text: string, about: nullable(string), actions, 'suggested?': number }),
  (v, at) => {
    const { suggested, actions: list } = v as { suggested?: number; actions: unknown[] }
    return suggested === undefined || (Number.isInteger(suggested) && suggested >= 0 && suggested < list.length) ? null : `${at}.suggested 应是 actions 里的一个位置`
  },
)

/** The fields each kind of block requires; a section's own blocks are checked one by one. */
const KINDS: Record<Block['kind'], Check> = {
  section: shape({ title: string, note: nullable(string), count: nullable(number), blocks: listOf(anything), actions, 'collapse?': oneOf('open', 'closed') }),
  table: shape({
    columns: listOf(shape({ key: string, label: string, 'optional?': boolean })),
    rows: listOf(shape({ key: string, cells: recordOf(cell), link: nullable(link), actions })),
    empty: string,
  }),
  fields: shape({ fields: listOf(shape({ label: string, value: cell })) }),
  list: shape({ items: listOf(shape({ cell, note: nullable(string), actions })) }),
  timeline: shape({ entries: listOf(shape({ at: string, title: cell, lines: listOf(string), tag: nullable(tag), 'actions?': actions })) }),
  text: shape({ text: string, tone }),
  preview: shape({ path: string }),
  actions: shape({ actions }),
  empty: shape({ title: string, hint: nullable(string) }),
  embed: shape({ url: httpUrl, title: string, height: number }),
  custom: shape({ entry, height: number, text: string, 'data?': anything, actions: recordOf(action) }),
  feed: shape({ groups: listOf(feedGroup), empty: string }),
  stats: shape({ stats: listOf(shape({ label: string, value: string, note: nullable(string) })) }),
  tree: shape({ param: string, selected: string, nodes: listOf(treeNode) }),
  asks: shape({ asks: listOf(ask), empty: string }),
}

/** An ask a plugin's `onAsks` answered, its `by` not yet stamped: what is wrong with it, or null. */
export const askFault = (value: unknown, at: string): string | null => ask(isObject(value) ? { ...value, by: '' } : value, at)

/** What a page's buttons may call: the owner commands the library runs, with their `params`, and the kinds of 「说」 its plugins hear. */
export type Callable = { commands: ReadonlyMap<string, OwnerParams>; heard: ReadonlySet<string> }

export function callableIn(library: Library): Callable {
  return {
    commands: new Map(ownerFace.commands(library.plugins).map((c) => [c.name, c.params])),
    heard: new Set(library.plugins.flatMap((p) => (p.onSay ? p.statements : []))),
  }
}

const PLACEHOLDER = /\{([^{}]+)\}/g
const open = (value: string) => /\{[^{}]+\}/.test(value)
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : isObject(v) ? Object.values(v).flatMap(strings) : [])

/**
 * What is wrong with an action of a well-formed block, or null when it resolves: its call is a verb,
 * or an owner command the library runs with arguments its `params` take, a `say` is of a kind some
 * plugin hears, and every `{input}` it writes is one of its inputs. An input's value is checked when
 * the person gives it.
 */
export function actionFault(action: Action, callable: Callable): string | null {
  const asked = new Set(action.inputs.map((i) => i.name))
  const unasked = strings(action.call)
    .flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1] as string))
    .find((name) => !asked.has(name))
  if (unasked !== undefined) return `动作「${action.label}」写了 {${unasked}}，却没有叫这个名字的输入`
  const call = parseCall(action.call)
  if (typeof call === 'string') return `动作「${action.label}」不是一个动词或一条主人命令的调用：${call}`
  if (call.face === 'owner') {
    const params = callable.commands.get(call.command)
    if (params === undefined) return `动作「${action.label}」调的主人命令「${call.command}」这个库里没有`
    const checked = checkArgs(call.command, params, call.args, open)
    return 'usage' in checked ? `动作「${action.label}」的参数不合「${call.command}」的参数表：${checked.usage.split('\n')[0]}` : null
  }
  if (call.verb === 'say' && !open(call.request.kind) && !callable.heard.has(call.request.kind)) return `动作「${action.label}」说的「${call.request.kind}」这个库里没有插件听`
  return null
}

/** The actions a block carries itself, a section's own blocks aside. */
function ownActions(block: Block): Action[] {
  switch (block.kind) {
    case 'section':
    case 'actions':
      return block.actions
    case 'table':
      return block.rows.flatMap((r) => r.actions)
    case 'list':
      return block.items.flatMap((i) => i.actions)
    case 'timeline':
      return block.entries.flatMap((e) => e.actions ?? [])
    case 'custom':
      return Object.values(block.actions)
    case 'feed':
      return block.groups.flatMap((g) => g.rows.flatMap((r) => (r.action ? [r.action] : [])))
    case 'asks':
      return block.asks.flatMap((a) => a.actions)
    default:
      return []
  }
}

const known = (kind: unknown): kind is Block['kind'] => typeof kind === 'string' && Object.hasOwn(KINDS, kind)

/** What is wrong with one block of `plugin`'s, its own blocks aside; null when nothing is. */
function wrongWith(value: unknown, where: string, plugin: Plugin, callable: Callable): string | null {
  if (!isObject(value)) return `${where} 应是对象`
  const { kind } = value
  if (!known(kind)) return `${where} 是不认识的块：${String(kind)}`
  const wrong = KINDS[kind](value, where)
  if (wrong !== null) return wrong
  if (kind === 'custom' && typeof plugin.ui !== 'string') return `${where} 是 custom 块，插件却没有声明 ui 目录`
  for (const action of ownActions(value as Block)) {
    const fault = actionFault(action, callable)
    if (fault !== null) return `${where} 的${fault}`
  }
  return null
}

type Checked = { blocks: Block[]; problems: PluginProblem[] }

/** The plugin's blocks, each malformed one replaced by a block saying so; a custom block carries the plugin's name. */
export function checkBlocks(blocks: unknown[], plugin: Plugin, callable: Callable, at = 'blocks'): Checked {
  const problems: PluginProblem[] = []
  const checked = blocks.map((value, i): Block => {
    const where = `${at}[${i}]`
    const wrong = wrongWith(value, where, plugin, callable)
    if (wrong !== null) {
      problems.push({ plugin: plugin.name, message: `一块没法显示：${wrong}` })
      return { kind: 'text', tone: 'bad', text: `插件 ${plugin.name} 的一块没法显示：${wrong}` }
    }
    const block = value as Block
    if (block.kind === 'custom') return { ...block, plugin: plugin.name }
    if (block.kind !== 'section') return block
    const inner = checkBlocks(block.blocks, plugin, callable, `${where}.blocks`)
    problems.push(...inner.problems)
    return { ...block, blocks: inner.blocks }
  })
  return { blocks: checked, problems }
}

const answeredFilter = shape({ name: string, options: listOf(shape({ value: string, label: string, 'count?': number })) })

/** A view's `filters`: the options of filters it declares; one that names no declared filter, or is of the wrong shape, is dropped as a problem. */
export function checkFilters(filters: unknown, decl: ViewDecl, plugin: Plugin): { filters?: NonNullable<ViewAnswer['filters']>; problems: PluginProblem[] } {
  if (filters === undefined) return { problems: [] }
  if (!Array.isArray(filters)) return { problems: [{ plugin: plugin.name, message: 'filters 应是列表' }] }
  const kept: NonNullable<ViewAnswer['filters']> = []
  const problems: PluginProblem[] = []
  for (const [i, f] of filters.entries()) {
    const wrong = answeredFilter(f, `filters[${i}]`) ?? (decl.filters.some((d) => d.name === (f as { name: string }).name) ? null : `filters[${i}] 说的筛选 ${(f as { name: string }).name} 视图 ${decl.id} 没有声明`)
    if (wrong === null) kept.push(f as NonNullable<ViewAnswer['filters']>[number])
    else problems.push({ plugin: plugin.name, message: wrong })
  }
  return { filters: kept, problems }
}

/** The shortest time, in seconds, after which a view is asked again on its own. */
const MIN_REFRESH = 5

/** A view's `refresh`: at least five seconds; one that is not a number is dropped as a problem. */
export function checkRefresh(refresh: unknown, plugin: Plugin): { refresh?: number; problems: PluginProblem[] } {
  if (refresh === undefined) return { problems: [] }
  if (number(refresh, 'refresh') !== null) return { problems: [{ plugin: plugin.name, message: `refresh 应是秒数，不是 ${JSON.stringify(refresh)}` }] }
  return { refresh: Math.max(MIN_REFRESH, refresh as number), problems: [] }
}
