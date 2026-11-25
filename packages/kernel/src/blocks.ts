// What a plugin's view answers, checked at the kernel's boundary (ARCHITECTURE section 6). A block
// that is not a known kind or lacks a required field is replaced by one that says whose it was and
// why, and is listed as a problem (K8); the rest of the page stands. Optional fields are checked
// only when given; fields the kernel does not know are left as they are.
import { isAbsolute } from 'node:path'
import type { Block, Plugin, PluginProblem } from './types.js'

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
const cell = shape({ text: string, 'mono?': boolean, 'muted?': boolean, 'tag?': tag, 'link?': link, 'at?': string, 'icon?': string, 'href?': string, 'copy?': boolean })

const call: Check = (v, at) => {
  if (!isObject(v)) return `${at} 应是对象`
  if (v.face === 'owner') return shape({ command: string, args: shape({ positional: listOf(string), flags: recordOf((f, a) => (f === true ? null : listOf(string)(f, a))) }) })(v, at)
  if (v.face === 'agent') return shape({ verb: string, request: shape({}) })(v, at)
  return `${at}.face 应是 agent 或 owner`
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
})
const action = shape({ label: string, tone: oneOf('default', 'danger'), confirm: nullable(string), inputs: listOf(input), call })
const actions = listOf(action)

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
  custom: shape({ entry, height: number, 'data?': anything, actions: recordOf(action) }),
}

const known = (kind: unknown): kind is Block['kind'] => typeof kind === 'string' && Object.hasOwn(KINDS, kind)

/** What is wrong with one block of `plugin`'s, its own blocks aside; null when nothing is. */
function wrongWith(value: unknown, where: string, plugin: Plugin): string | null {
  if (!isObject(value)) return `${where} 应是对象`
  const { kind } = value
  if (!known(kind)) return `${where} 是不认识的块：${String(kind)}`
  const wrong = KINDS[kind](value, where)
  if (wrong !== null) return wrong
  return kind === 'custom' && typeof plugin.ui !== 'string' ? `${where} 是 custom 块，插件却没有声明 ui 目录` : null
}

type Checked = { blocks: Block[]; problems: PluginProblem[] }

/** The plugin's blocks, each malformed one replaced by a block saying so; a custom block carries the plugin's name. */
export function checkBlocks(blocks: unknown[], plugin: Plugin, at = 'blocks'): Checked {
  const problems: PluginProblem[] = []
  const checked = blocks.map((value, i): Block => {
    const where = `${at}[${i}]`
    const wrong = wrongWith(value, where, plugin)
    if (wrong !== null) {
      problems.push({ plugin: plugin.name, message: `一块没法显示：${wrong}` })
      return { kind: 'text', tone: 'bad', text: `插件 ${plugin.name} 的一块没法显示：${wrong}` }
    }
    const block = value as Block
    if (block.kind === 'custom') return { ...block, plugin: plugin.name }
    if (block.kind !== 'section') return block
    const inner = checkBlocks(block.blocks, plugin, `${where}.blocks`)
    problems.push(...inner.problems)
    return { ...block, blocks: inner.blocks }
  })
  return { blocks: checked, problems }
}

/** The shortest time, in seconds, after which a view is asked again on its own. */
const MIN_REFRESH = 5

/** A view's `refresh`: at least five seconds; one that is not a number is dropped as a problem. */
export function checkRefresh(refresh: unknown, plugin: Plugin): { refresh?: number; problems: PluginProblem[] } {
  if (refresh === undefined) return { problems: [] }
  if (number(refresh, 'refresh') !== null) return { problems: [{ plugin: plugin.name, message: `refresh 应是秒数，不是 ${JSON.stringify(refresh)}` }] }
  return { refresh: Math.max(MIN_REFRESH, refresh as number), problems: [] }
}
