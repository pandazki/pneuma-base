// The plugin table of this machine: the built-in plugins, and the owner's own plugins in
// `<home>/plugins/<name>/`. ARCHITECTURE "库外的插件与缓存".
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT, FEED_ACTS, KERNEL_COMMAND_NAMES, PLUGIN_NAME, RESERVED_PLUGIN_NAMES, SECRET_NAME, type Plugin, type PluginTable } from '@pneuma-base/sdk'
import { exists, regularFile, replaceWith } from './machine-files.js'

/** The plugin contract versions this kernel runs. */
export const SUPPORTED_CONTRACTS: readonly number[] = [CONTRACT]

/** Where the plugin standard says what a plugin written against contract 1 changes. */
const FROM_1 = '插件规范 PLUGINS.md 的「从第 1 版到第 2 版」一节'

/** Flags every command line call takes; no command declares one of these. */
export const GLOBAL_FLAG_NAMES: readonly string[] = ['library', 'as', 'session', 'json', 'help']

export const machinePluginsDir = (home: string) => join(home, 'plugins')

/** The directory each plugin loaded from this machine's plugin directory came from. A built-in has none. */
const loadedFrom = new WeakMap<Plugin, string>()

/** Where on this machine the plugin was loaded from; null for a built-in one. */
export function machineDirOf(plugin: Plugin): string | null {
  return loadedFrom.get(plugin) ?? null
}

/**
 * The built-in plugins, then each plugin in `<home>/plugins/` whose `index.js` loads and default-exports
 * a plugin of the directory's name. A built-in name is never taken by one of these. One that fails to
 * load is left out, so a library that installed it reports it as unavailable, with `whyNotLoaded`.
 * A plugin whose files changed since this process last loaded it is loaded afresh. A built-in plugin
 * passes the same check; one that does not is a fault of this pneuma-base, so it throws.
 */
export async function loadPlugins(home: string, builtins: PluginTable): Promise<PluginTable> {
  for (const [name, plugin] of builtins) checkBuiltin(name, plugin)
  const table = new Map(builtins)
  for (const name of await machinePlugins(home)) {
    if (table.has(name)) continue
    const loaded = await loadExternal(home, name)
    if (loaded !== null && !('failed' in loaded)) table.set(name, loaded)
  }
  return table
}

/** The names of the plugin directories in this machine's plugin directory, sorted; temporary ones left out. */
export async function machinePlugins(home: string): Promise<string[]> {
  return (await readdir(machinePluginsDir(home)).catch(() => [] as string[])).filter((n) => PLUGIN_NAME.test(n)).sort()
}

/** Why the plugin `name` in this machine's plugin directory did not load; null when it loads or is not there. */
export async function whyNotLoaded(home: string, name: string): Promise<string | null> {
  const loaded = await loadExternal(home, name)
  return loaded !== null && 'failed' in loaded ? loaded.failed : null
}

/** Built-in plugins this process already checked: they do not change while it runs. */
const checkedBuiltins = new WeakSet<Plugin>()

function checkBuiltin(name: string, plugin: Plugin): void {
  if (checkedBuiltins.has(plugin)) return
  const wrong = whatIsWrong(plugin, name)
  if (wrong.length > 0) throw new Error(`内置插件 ${name} 未通过插件校验：${wrong.join('；')}`)
  checkedBuiltins.add(plugin)
}

async function loadExternal(home: string, name: string): Promise<Plugin | { failed: string } | null> {
  if (!PLUGIN_NAME.test(name)) return null
  const dir = join(machinePluginsDir(home), name)
  if (!(await exists(dir))) return null
  const loaded = await loadDir(dir, name)
  if (!('failed' in loaded)) loadedFrom.set(loaded, dir)
  return loaded
}

// ---- loading a directory as it is now ----

/** The query parameter that makes each version of a plugin directory a module graph of its own. */
const VERSION = 'pneuma-base-load'
/** The directory, as a file URL ending in '/', each version tag was given to. */
const versionRoots = new Map<string, string>()
let hooked = false

/**
 * Every module a versioned plugin module imports from inside the plugin's directory gets the same
 * version, so the whole directory loads afresh when any of its files changed, and a directory loaded
 * for checking never shares modules with another copy.
 */
function hookVersions(): void {
  if (hooked) return
  hooked = true
  // Node has registerHooks from 22.15; on one without it, only index.js itself loads afresh.
  const register = (nodeModule as Partial<typeof nodeModule>).registerHooks
  register?.({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      const parent = context.parentURL
      if (parent === undefined || !parent.includes(VERSION) || resolved.url.includes('?')) return resolved
      const tag = new URL(parent).searchParams.get(VERSION)
      const root = tag === null ? undefined : versionRoots.get(tag)
      return root !== undefined && resolved.url.startsWith(root) ? { ...resolved, url: `${resolved.url}?${VERSION}=${tag}` } : resolved
    },
  })
}

/** The names, sizes and modification times of every file under `dir`, as one hash: it changes when any file does. */
async function stampOf(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => join(e.parentPath, e.name)).sort()
  for (const file of files) {
    const s = await stat(file, { bigint: true }).catch(() => null)
    hash.update(`${relative(dir, file)}\0${s?.size ?? -1n}\0${s?.mtimeNs ?? -1n}\n`)
  }
  return hash.digest('hex')
}

/**
 * The plugin `dir/index.js` default-exports, as the directory's files are now, checked as the loader
 * checks every plugin; or why it is not one this kernel runs. `name` is the name it must have, or
 * null to take the name it gives.
 */
export async function loadDir(dir: string, name: string | null): Promise<Plugin | { failed: string }> {
  if (!(await regularFile(join(dir, 'index.js')))) return { failed: `${dir} 中缺少 index.js` }
  let file = join(dir, 'index.js')
  let module: { default?: unknown }
  try {
    // Node resolves modules by their real path, so the version is tied to the real directory.
    const real = await realpath(dir)
    file = join(real, 'index.js')
    const root = pathToFileURL(join(real, '/')).href
    const tag = createHash('sha256').update(`${root}\0${await stampOf(real)}`).digest('hex').slice(0, 16)
    versionRoots.set(tag, root)
    hookVersions()
    // A module that threw is cached as failed, so asking again before a file changes gives the same reason.
    module = (await import(`${pathToFileURL(file).href}?${VERSION}=${tag}`)) as { default?: unknown }
  } catch (error) {
    return { failed: `加载 ${file} 时出错：${error instanceof Error ? error.message : String(error)}` }
  }
  const wrong = whatIsWrong(module.default, name)
  return wrong.length === 0 ? (module.default as Plugin) : { failed: `${file} 的默认导出不是有效的插件：${wrong.join('；')}` }
}

// ---- installing on this machine ----

/**
 * Copies `from` into `<home>/plugins/<name>/` under a temporary name, then renames it into place,
 * replacing what was there. A directory without a `package.json` gets one saying its `.js` files are
 * ES modules, so how they load does not depend on what lies above `$PNEUMA_BASE_HOME`.
 */
export async function installDir(home: string, from: string, name: string): Promise<void> {
  const plugins = machinePluginsDir(home)
  await mkdir(plugins, { recursive: true })
  const tmp = join(plugins, `.install-${name}-${randomBytes(4).toString('hex')}`)
  try {
    await cp(from, tmp, { recursive: true })
    if (!(await exists(join(tmp, 'package.json')))) await writeFile(join(tmp, 'package.json'), '{ "type": "module" }\n')
    await replaceWith(tmp, join(plugins, name), plugins)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Removes `<home>/plugins/<name>/`: renamed out of the plugin directory first, so no half-removed plugin ever loads. */
export async function uninstallDir(home: string, name: string): Promise<void> {
  const gone = join(machinePluginsDir(home), `.uninstall-${name}-${randomBytes(4).toString('hex')}`)
  await rename(join(machinePluginsDir(home), name), gone)
  await rm(gone, { recursive: true, force: true })
}

// ---- what the loader checks ----

type Hook = { [K in keyof Plugin]-?: NonNullable<Plugin[K]> extends (...args: never[]) => unknown ? K : never }[keyof Plugin]
/** Every hook of the contract; the type makes this list whole. */
const HOOKS: Record<Hook, true> = {
  onPut: true,
  revise: true,
  onFind: true,
  onFound: true,
  onInspect: true,
  onSay: true,
  onCheck: true,
  onAsks: true,
  openDirs: true,
  onArchive: true,
  observe: true,
  onPurged: true,
  onAdd: true,
  onRemove: true,
  catchUp: true,
  registered: true,
  onView: true,
  onItemView: true,
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isText = (v: unknown): v is string => typeof v === 'string'
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const optional = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v)
const isAct = (v: unknown) => isObject(v) && (FEED_ACTS as readonly unknown[]).includes(v.kind) && optional(v.object, isText) && optional(v.name, isText)
const isPattern = (v: unknown) => {
  if (!isText(v)) return false
  try {
    new RegExp(`^(?:${v})$`, 'u')
    return true
  } catch {
    return false
  }
}

/** Checks the list `items` entry by entry; `id` gives the name an entry claims, which may appear once. */
function eachOf(items: unknown, what: string, wrong: string[], entry: (v: unknown) => string | null, id: (v: unknown) => unknown = () => undefined): void {
  if (!Array.isArray(items)) {
    wrong.push(`${what} 不是列表`)
    return
  }
  const seen = new Set<unknown>()
  for (const item of items) {
    const problem = entry(item)
    if (problem !== null) wrong.push(problem)
    const claimed = id(item)
    if (claimed === undefined) continue
    if (seen.has(claimed)) wrong.push(`${String(claimed)} 重复声明`)
    seen.add(claimed)
  }
}

/**
 * What the loader finds wrong with a plugin, built-in or default-exported, in Chinese; empty when it is
 * a plugin it runs. Checked here, at load, is everything that needs no hook called: the contract
 * version, the name (none of the reserved ones), the optional fields' types, the cognition section, the lists and each entry's
 * shape, each `say` kind, command name, view id and secret name given once, command names starting
 * with `<name> ` and none of them the kernel's own, each command's `params`, view ids starting with
 * `<name>.`, and every hook given being a function. The kernel hears no `say` kind itself, so a kind can clash only with
 * another plugin's, which `plugin enable` refuses. Left to call time: what a hook or a command's `run`
 * answers and whether it throws (K8), and where the plugin writes.
 */
function whatIsWrong(p: unknown, name: string | null): string[] {
  if (!isObject(p)) return ['不是对象']
  const wrong: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) wrong.push(what)
  }
  const supported = `第 ${SUPPORTED_CONTRACTS.join('、')} 版`
  if (p.contract === undefined) wrong.push(`缺少 contract，即插件依据的插件契约版本；此 pneuma-base 支持${supported}`)
  else if (p.contract === 1) wrong.push(`contract 为 1：此 pneuma-base 仅运行第 ${CONTRACT} 版插件契约。需修改之处见${FROM_1}`)
  else check(SUPPORTED_CONTRACTS.includes(p.contract as number), `contract 为 ${JSON.stringify(p.contract)}，此 pneuma-base 仅支持${supported}插件契约`)
  if (name !== null) check(p.name === name, `名称为 ${JSON.stringify(p.name)}，与目录名 ${name} 不一致`)
  else check(isText(p.name) && PLUGIN_NAME.test(p.name), `名称 ${JSON.stringify(p.name)} 不是有效的插件名称：须以小写字母开头，仅含小写字母、数字和连字符`)
  const own = isText(p.name) ? p.name : String(name)
  check(!RESERVED_PLUGIN_NAMES.includes(own), `名称 ${own} 为命令行或内核保留，插件不能使用`)
  for (const key of ['version', 'title', 'summary', 'about']) check(optional(p[key], isText), `${key} 不是字符串`)
  check(optional(p.keeps, (v) => v === 'every' || v === 'some'), 'keeps 只能为 every 或 some')
  const c = p.cognition
  check(c === null || (isObject(c) && isText(c.title) && isText(c.text)), 'cognition 既不是 null 也不是 { title, text }')
  eachOf(p.storage, 'storage', wrong, (d) => (isObject(d) && isText(d.dir) && (d.kind === 'body' || d.kind === 'cache') ? null : `storage 的每一项须为 { dir, kind: 'body' | 'cache' }`))
  eachOf(p.statements, 'statements', wrong, (k) => (isText(k) && k !== '' ? null : 'statements 的每一项须为非空字符串'), (k) => k)
  eachOf(p.ownerCommands, 'ownerCommands', wrong, (cmd) => commandWrong(cmd, own), (cmd) => (isObject(cmd) ? cmd.name : undefined))
  if (p.views !== undefined) eachOf(p.views, 'views', wrong, (v) => viewWrong(v, own), (v) => (isObject(v) ? v.id : undefined))
  if (p.secrets !== undefined) {
    const secretWrong = (s: unknown) =>
      isObject(s) && isText(s.name) && SECRET_NAME.test(s.name) && isText(s.description) && optional(s.title, isText) && (s.optional === undefined || typeof s.optional === 'boolean')
        ? null
        : 'secrets 的每一项须为 { name, description }，可带字符串 title 和 optional: true 或 false；name 须以小写字母开头，仅含小写字母、数字和连字符'
    eachOf(p.secrets, 'secrets', wrong, secretWrong, (s) => (isObject(s) ? s.name : undefined))
  }
  for (const hook of Object.keys(HOOKS)) check(optional(p[hook], (v) => typeof v === 'function'), `${hook} 不是函数`)
  return wrong
}

function commandWrong(cmd: unknown, plugin: string): string | null {
  if (!isObject(cmd) || !isText(cmd.name)) return 'ownerCommands 的每一项须为带 name 的所有者命令'
  const name = cmd.name
  if (!name.startsWith(`${plugin} `)) return `所有者命令「${name}」未以「${plugin} 」开头`
  if ((KERNEL_COMMAND_NAMES as readonly string[]).includes(name)) return `所有者命令「${name}」为内核命令`
  const typed = isText(cmd.summary) && isBoolean(cmd.destructive) && isBoolean(cmd.ownerOnly) && typeof cmd.run === 'function'
  const flags = optional(cmd.readOnly, isBoolean) && optional(cmd.setup, isBoolean) && optional(cmd.askable, (v) => v === false)
  if (!typed || !flags) return `所有者命令「${name}」须有字符串 summary、布尔值 destructive 和 ownerOnly、函数 run；readOnly 和 setup 为布尔值，askable 省略或为 false`
  if (!optional(cmd.act, isAct)) return `所有者命令「${name}」的 act 须有 kind（${FEED_ACTS.join('、')} 之一），object 和 name 省略或为字符串`
  if (cmd.params === undefined) return `所有者命令「${name}」缺少 params：每条命令须声明参数，无参数时写 params: {}`
  const wrong = paramsWrong(cmd.params)
  return wrong === null ? null : `所有者命令「${name}」的 params：${wrong}`
}

const FLAG_NAME = /^[a-z][a-z0-9-]*$/

/** What is wrong with a command's `params`, in Chinese; null when nothing is. */
function paramsWrong(params: unknown): string | null {
  if (!isObject(params)) return '须为 { positional, flags }'
  const positional = params.positional ?? []
  const flags = params.flags ?? []
  if (!Array.isArray(positional) || !Array.isArray(flags)) return 'positional 和 flags 须为列表'
  const names = new Set<string>()
  const named = (p: unknown, what: string): string | null => {
    if (!isObject(p) || !isText(p.name) || p.name === '' || !isText(p.hint)) return `${what}的每一项须有字符串 name 和 hint`
    if (names.has(p.name)) return `${p.name} 重复声明`
    names.add(p.name)
    return optional(p.required, isBoolean) && optional(p.pattern, isPattern) ? null : `${p.name} 的 required 须为布尔值，pattern 须为正则表达式`
  }
  let optionalSeen = false
  for (const [i, p] of positional.entries()) {
    const wrong = named(p, '位置参数')
    if (wrong !== null) return wrong
    const a = p as Record<string, unknown>
    if (!optional(a.many, isBoolean)) return `${String(a.name)} 的 many 须为布尔值`
    if (a.many === true && i !== positional.length - 1) return `仅最后一个位置参数可为 many：${String(a.name)}`
    if (a.required === true && optionalSeen) return `必填位置参数 ${String(a.name)} 不能位于可选参数之后`
    if (a.required !== true) optionalSeen = true
  }
  for (const f of flags) {
    const wrong = named(f, 'flags ')
    if (wrong !== null) return wrong
    const flag = f as Record<string, unknown>
    const id = String(flag.name)
    if (!FLAG_NAME.test(id)) return `--${id} 不是有效名称：须以小写字母开头，仅含小写字母、数字和连字符`
    if (GLOBAL_FLAG_NAMES.includes(id)) return `--${id} 是全局参数，不能重复声明`
    if (flag.kind !== 'value' && flag.kind !== 'list' && flag.kind !== 'boolean') return `--${id} 的 kind 只能为 value、list 或 boolean`
    if (flag.kind === 'boolean' && (flag.required !== undefined || flag.pattern !== undefined)) return `--${id} 为开关，不能设置 required 或 pattern`
    if (flag.options !== undefined) {
      const ok = flag.kind === 'value' && Array.isArray(flag.options) && flag.options.length > 0 && flag.options.every((o) => isObject(o) && isText(o.value) && isText(o.label))
      if (!ok) return `--${id} 的 options 仅用于 value，须为非空的 { value, label } 列表`
    }
  }
  return null
}

function viewWrong(view: unknown, plugin: string): string | null {
  if (!isObject(view) || !isText(view.id)) return 'views 的每一项须为带 id 的视图'
  if (!view.id.startsWith(`${plugin}.`)) return `视图 ${view.id} 未以 ${plugin}. 开头`
  const ok = isText(view.title) && isText(view.icon) && typeof view.nav === 'boolean' && Array.isArray(view.filters) && optional(view.ownerOnly, isBoolean) && optional(view.home, isBoolean) && optional(view.with, isText)
  return ok ? null : `视图 ${view.id} 须有字符串 title 和 icon、布尔值 nav、列表 filters；ownerOnly 和 home 省略或为布尔值，with 省略或为字符串`
}
