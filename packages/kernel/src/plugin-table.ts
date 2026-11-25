// The plugin table of this machine: the built-in plugins, and the owner's own plugins in
// `<home>/plugins/<name>/index.js`. ARCHITECTURE "库外的插件".
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exists, regularFile } from './files.js'
import { PLUGIN_NAME, type Plugin, type PluginTable } from '@pneuma-base/sdk'

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
  if (!(await regularFile(file))) return (await exists(dir)) ? { failed: `no index.js in ${dir}` } : null
  try {
    // A module that threw is cached as failed, so asking again gives the same reason.
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
    return parsePlugin(module.default, name)
  } catch (error) {
    return { failed: `failed to load ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The default export, checked as far as the kernel relies on it. Throws saying what is wrong. */
function parsePlugin(value: unknown, name: string): Plugin {
  const fail = (what: string): never => {
    throw new Error(`the default export is not a plugin: ${what}`)
  }
  if (typeof value !== 'object' || value === null) return fail('not an object')
  const p = value as Record<string, unknown>
  if (p.name !== name) return fail(`its name is ${JSON.stringify(p.name)}, not the directory's name ${name}`)
  for (const list of ['storage', 'statements', 'ownerCommands'] as const) if (!Array.isArray(p[list])) fail(`${list} is not a list`)
  const cognition = p.cognition as { title?: unknown; text?: unknown } | null | undefined
  if (cognition !== null && (typeof cognition?.title !== 'string' || typeof cognition.text !== 'string')) fail('cognition is neither null nor { title, text }')
  return value as Plugin
}
