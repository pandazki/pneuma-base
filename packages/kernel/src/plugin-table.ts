// The plugin table of this machine: the built-in plugins, and the owner's own plugins in
// `<home>/plugins/<name>/`. ARCHITECTURE "库外的插件与缓存".
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT, PLUGIN_NAME, SECRET_NAME, type Plugin, type PluginTable } from '@pneuma-base/sdk'
import { KERNEL_COMMAND_NAMES } from './claims.js'
import { exists, regularFile, replaceWith } from './files.js'

/** The plugin contract versions this kernel runs. */
export const SUPPORTED_CONTRACTS: readonly number[] = [CONTRACT]

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
 * A plugin whose files changed since this process last loaded it is loaded afresh.
 */
export async function loadPlugins(home: string, builtins: PluginTable): Promise<PluginTable> {
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
  if (!(await regularFile(join(dir, 'index.js')))) return { failed: `${dir} 里没有 index.js` }
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
  return wrong.length === 0 ? (module.default as Plugin) : { failed: `${file} 的缺省导出不是能用的插件：${wrong.join('；')}` }
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
  onArchive: true,
  observe: true,
  onPurged: true,
  onAdd: true,
  onRemove: true,
  onView: true,
  onItemView: true,
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isText = (v: unknown): v is string => typeof v === 'string'
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const optional = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v)
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
    if (seen.has(claimed)) wrong.push(`${String(claimed)} 写了两次`)
    seen.add(claimed)
  }
}

/**
 * What the loader finds wrong with a default export, in Chinese; empty when it is a plugin it runs.
 * Checked here, at load, is everything that needs no hook called: the contract version, the name,
 * the optional fields' types, the cognition section, the lists and each entry's shape, each `say`
 * kind, command name, view id and secret name given once, command names starting with `<name> ` and
 * none of them the kernel's own, each command's `params`, view ids starting with `<name>.`, and every
 * hook given being a function. The kernel hears no `say` kind itself, so a kind can clash only with
 * another plugin's, which `plugin add` refuses. Left to call time: what a hook or a command's `run`
 * answers and whether it throws (K8), and where the plugin writes.
 */
function whatIsWrong(p: unknown, name: string | null): string[] {
  if (!isObject(p)) return ['它不是一个对象']
  const wrong: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) wrong.push(what)
  }
  const supported = `第 ${SUPPORTED_CONTRACTS.join('、')} 版`
  if (p.contract === undefined) wrong.push(`没有写 contract，即它按哪一版插件契约写的；这个 pneuma-base 认识${supported}`)
  else check(SUPPORTED_CONTRACTS.includes(p.contract as number), `contract 是 ${JSON.stringify(p.contract)}，这个 pneuma-base 只认识${supported}插件契约`)
  if (name !== null) check(p.name === name, `名字是 ${JSON.stringify(p.name)}，不是目录名 ${name}`)
  else check(isText(p.name) && PLUGIN_NAME.test(p.name), `名字 ${JSON.stringify(p.name)} 不是插件名：小写字母开头，只用小写字母、数字和连字符`)
  const own = isText(p.name) ? p.name : String(name)
  for (const key of ['version', 'summary']) check(optional(p[key], isText), `${key} 不是文字`)
  check(optional(p.keeps, (v) => v === 'every' || v === 'some'), 'keeps 只能是 every 或 some')
  const c = p.cognition
  check(c === null || (isObject(c) && isText(c.title) && isText(c.text)), 'cognition 既不是 null 也不是 { title, text }')
  eachOf(p.storage, 'storage', wrong, (d) => (isObject(d) && isText(d.dir) && (d.kind === 'body' || d.kind === 'cache') ? null : `storage 的每一项要是 { dir, kind: 'body' | 'cache' }`))
  eachOf(p.statements, 'statements', wrong, (k) => (isText(k) && k !== '' ? null : 'statements 的每一项要是不空的文字'), (k) => k)
  eachOf(p.ownerCommands, 'ownerCommands', wrong, (cmd) => commandWrong(cmd, own), (cmd) => (isObject(cmd) ? cmd.name : undefined))
  if (p.views !== undefined) eachOf(p.views, 'views', wrong, (v) => viewWrong(v, own), (v) => (isObject(v) ? v.id : undefined))
  if (p.secrets !== undefined) {
    const secretWrong = (s: unknown) => (isObject(s) && isText(s.name) && SECRET_NAME.test(s.name) && isText(s.description) ? null : 'secrets 的每一项要是 { name, description }，name 用小写字母开头，只用小写字母、数字和连字符')
    eachOf(p.secrets, 'secrets', wrong, secretWrong, (s) => (isObject(s) ? s.name : undefined))
  }
  for (const hook of Object.keys(HOOKS)) check(optional(p[hook], (v) => typeof v === 'function'), `${hook} 不是函数`)
  return wrong
}

function commandWrong(cmd: unknown, plugin: string): string | null {
  if (!isObject(cmd) || !isText(cmd.name)) return 'ownerCommands 的每一项要是带名字的主人命令'
  const name = cmd.name
  if (!name.startsWith(`${plugin} `)) return `主人命令「${name}」不以「${plugin} 」开头`
  if ((KERNEL_COMMAND_NAMES as readonly string[]).includes(name)) return `主人命令「${name}」是内核自己的`
  const typed = isText(cmd.summary) && isBoolean(cmd.destructive) && isBoolean(cmd.ownerOnly) && typeof cmd.run === 'function'
  const flags = optional(cmd.usage, isText) && optional(cmd.readOnly, isBoolean) && optional(cmd.setup, isBoolean)
  if (!typed || !flags) return `主人命令「${name}」要有文字的 summary、真假的 destructive 和 ownerOnly、函数 run，usage 是文字，readOnly 和 setup 是真假`
  if (cmd.params === undefined) return null
  if (cmd.usage !== undefined) return `主人命令「${name}」有 params 就不写 usage：用法由 params 生成`
  const wrong = paramsWrong(cmd.params)
  return wrong === null ? null : `主人命令「${name}」的 params：${wrong}`
}

const FLAG_NAME = /^[a-z][a-z0-9-]*$/

/** What is wrong with a command's `params`, in Chinese; null when nothing is. */
function paramsWrong(params: unknown): string | null {
  if (!isObject(params)) return '要是 { positional, flags }'
  const positional = params.positional ?? []
  const flags = params.flags ?? []
  if (!Array.isArray(positional) || !Array.isArray(flags)) return 'positional 和 flags 要是列表'
  const names = new Set<string>()
  const named = (p: unknown, what: string): string | null => {
    if (!isObject(p) || !isText(p.name) || p.name === '' || !isText(p.hint)) return `${what}的每一项要有文字的 name 和 hint`
    if (names.has(p.name)) return `${p.name} 写了两次`
    names.add(p.name)
    return optional(p.required, isBoolean) && optional(p.pattern, isPattern) ? null : `${p.name} 的 required 要是真假，pattern 要是正则表达式`
  }
  let optionalSeen = false
  for (const [i, p] of positional.entries()) {
    const wrong = named(p, '位置参数')
    if (wrong !== null) return wrong
    const a = p as Record<string, unknown>
    if (!optional(a.many, isBoolean)) return `${String(a.name)} 的 many 要是真假`
    if (a.many === true && i !== positional.length - 1) return `只有最后一个位置参数能是 many：${String(a.name)}`
    if (a.required === true && optionalSeen) return `必填的位置参数 ${String(a.name)} 不能在可省的后面`
    if (a.required !== true) optionalSeen = true
  }
  for (const f of flags) {
    const wrong = named(f, 'flags ')
    if (wrong !== null) return wrong
    const flag = f as Record<string, unknown>
    const id = String(flag.name)
    if (!FLAG_NAME.test(id)) return `--${id} 不是能用的名字：小写字母开头，只用小写字母、数字和连字符`
    if (GLOBAL_FLAG_NAMES.includes(id)) return `--${id} 是每条命令都有的，不能再声明`
    if (flag.kind !== 'value' && flag.kind !== 'list' && flag.kind !== 'boolean') return `--${id} 的 kind 只能是 value、list 或 boolean`
    if (flag.kind === 'boolean' && (flag.required !== undefined || flag.pattern !== undefined)) return `--${id} 是开关，不能 required，也没有 pattern`
    if (flag.options !== undefined) {
      const ok = flag.kind === 'value' && Array.isArray(flag.options) && flag.options.length > 0 && flag.options.every((o) => isObject(o) && isText(o.value) && isText(o.label))
      if (!ok) return `--${id} 的 options 只给 value，要是不空的 { value, label } 列表`
    }
  }
  return null
}

function viewWrong(view: unknown, plugin: string): string | null {
  if (!isObject(view) || !isText(view.id)) return 'views 的每一项要是带 id 的视图'
  if (!view.id.startsWith(`${plugin}.`)) return `视图 ${view.id} 不以 ${plugin}. 开头`
  return isText(view.title) && isText(view.icon) && typeof view.nav === 'boolean' && Array.isArray(view.filters) ? null : `视图 ${view.id} 要有文字的 title 和 icon、真假的 nav、列表 filters`
}
