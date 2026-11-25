// The plugin table of this machine: the built-in plugins, and the owner's own plugins in
// `<home>/plugins/<name>/index.js`. ARCHITECTURE "库外的插件".
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT, PLUGIN_NAME, type Plugin, type PluginTable } from '@pneuma-base/sdk'
import { KERNEL_COMMAND_NAMES } from './claims.js'
import { exists, regularFile } from './files.js'

/** The plugin contract versions this kernel runs. */
export const SUPPORTED_CONTRACTS: readonly number[] = [CONTRACT]

/**
 * The built-in plugins, then each plugin in `<home>/plugins/` whose `index.js` loads and default-exports
 * a plugin of the directory's name. A built-in name is never taken by one of these. One that fails to
 * load is left out, so a library that installed it reports it as unavailable, with `whyNotLoaded`.
 */
export async function loadPlugins(home: string, builtins: PluginTable): Promise<PluginTable> {
  const table = new Map(builtins)
  for (const name of (await readdir(join(home, 'plugins')).catch(() => [] as string[])).sort()) {
    if (table.has(name)) continue
    const loaded = await loadExternal(home, name)
    if (loaded !== null && !('failed' in loaded)) table.set(name, loaded)
  }
  return table
}

/** Why the plugin `name` in this machine's plugin directory did not load; null when it loads or is not there. */
export async function whyNotLoaded(home: string, name: string): Promise<string | null> {
  const loaded = await loadExternal(home, name)
  return loaded !== null && 'failed' in loaded ? loaded.failed : null
}

async function loadExternal(home: string, name: string): Promise<Plugin | { failed: string } | null> {
  if (!PLUGIN_NAME.test(name)) return null
  const dir = join(home, 'plugins', name)
  const file = join(dir, 'index.js')
  if (!(await regularFile(file))) return (await exists(dir)) ? { failed: `${dir} 里没有 index.js` } : null
  let module: { default?: unknown }
  try {
    // A module that threw is cached as failed, so asking again gives the same reason.
    module = (await import(pathToFileURL(file).href)) as { default?: unknown }
  } catch (error) {
    return { failed: `加载 ${file} 时出错：${error instanceof Error ? error.message : String(error)}` }
  }
  const wrong = whatIsWrong(module.default, name)
  return wrong.length === 0 ? (module.default as Plugin) : { failed: `${file} 的缺省导出不是能用的插件：${wrong.join('；')}` }
}

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
  onView: true,
  onItemView: true,
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isText = (v: unknown): v is string => typeof v === 'string'
const optional = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v)

/**
 * What the loader finds wrong with a default export, in Chinese; empty when it is a plugin it runs.
 * Checked here, at load, is everything that needs no hook called: the contract version, the name,
 * the optional fields' types, the cognition section, the lists and each entry's shape, each `say`
 * kind, command name and view id given once, command names starting with `<name> ` and none of them
 * the kernel's own, view ids starting with `<name>.`, and every hook given being a function. The
 * kernel hears no `say` kind itself, so a kind can clash only with another plugin's, which
 * `plugin add` refuses. Left to call time: what a hook or a command's `run` answers and whether it
 * throws (K8), and where the plugin writes.
 */
function whatIsWrong(value: unknown, name: string): string[] {
  if (!isObject(value)) return ['它不是一个对象']
  const p = value
  const wrong: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) wrong.push(what)
  }
  const supported = `第 ${SUPPORTED_CONTRACTS.join('、')} 版`
  if (p.contract === undefined) wrong.push(`没有写 contract，即它按哪一版插件契约写的；这个 pneuma-base 认识${supported}`)
  else check(SUPPORTED_CONTRACTS.includes(p.contract as number), `contract 是 ${JSON.stringify(p.contract)}，这个 pneuma-base 只认识${supported}插件契约`)
  check(p.name === name, `名字是 ${JSON.stringify(p.name)}，不是目录名 ${name}`)
  for (const key of ['version', 'summary']) check(optional(p[key], isText), `${key} 不是文字`)
  check(optional(p.keeps, (v) => v === 'every' || v === 'some'), 'keeps 只能是 every 或 some')
  const c = p.cognition
  check(c === null || (isObject(c) && isText(c.title) && isText(c.text)), 'cognition 既不是 null 也不是 { title, text }')
  /** Checks the list `key` entry by entry; `id` gives the name an entry claims, which may appear once. */
  const list = (key: string, entry: (v: unknown) => string | null, id: (v: unknown) => unknown = () => undefined): void => {
    const items = p[key]
    if (key === 'views' && items === undefined) return
    if (!Array.isArray(items)) {
      wrong.push(`${key} 不是列表`)
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
  list('storage', (d) => (isObject(d) && isText(d.dir) && (d.kind === 'body' || d.kind === 'cache') ? null : `storage 的每一项要是 { dir, kind: 'body' | 'cache' }`))
  list('statements', (k) => (isText(k) && k !== '' ? null : 'statements 的每一项要是不空的文字'), (k) => k)
  list('ownerCommands', (cmd) => commandWrong(cmd, name), (cmd) => (isObject(cmd) ? cmd.name : undefined))
  list('views', (v) => viewWrong(v, name), (v) => (isObject(v) ? v.id : undefined))
  for (const hook of Object.keys(HOOKS)) check(optional(p[hook], (v) => typeof v === 'function'), `${hook} 不是函数`)
  return wrong
}

function commandWrong(cmd: unknown, plugin: string): string | null {
  if (!isObject(cmd) || !isText(cmd.name)) return 'ownerCommands 的每一项要是带名字的主人命令'
  const name = cmd.name
  if (!name.startsWith(`${plugin} `)) return `主人命令「${name}」不以「${plugin} 」开头`
  if ((KERNEL_COMMAND_NAMES as readonly string[]).includes(name)) return `主人命令「${name}」是内核自己的`
  const typed = isText(cmd.summary) && typeof cmd.destructive === 'boolean' && typeof cmd.ownerOnly === 'boolean' && typeof cmd.run === 'function'
  const flags = optional(cmd.usage, isText) && optional(cmd.readOnly, (v) => typeof v === 'boolean') && optional(cmd.setup, (v) => typeof v === 'boolean')
  return typed && flags ? null : `主人命令「${name}」要有文字的 summary、真假的 destructive 和 ownerOnly、函数 run，usage 是文字，readOnly 和 setup 是真假`
}

function viewWrong(view: unknown, plugin: string): string | null {
  if (!isObject(view) || !isText(view.id)) return 'views 的每一项要是带 id 的视图'
  if (!view.id.startsWith(`${plugin}.`)) return `视图 ${view.id} 不以 ${plugin}. 开头`
  return isText(view.title) && isText(view.icon) && typeof view.nav === 'boolean' && Array.isArray(view.filters) ? null : `视图 ${view.id} 要有文字的 title 和 icon、真假的 nav、列表 filters`
}
