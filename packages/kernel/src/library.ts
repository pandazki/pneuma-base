import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { assembleDescription } from './cognition.js'
import { writeAtomic } from './files.js'
import { DESCRIPTION_FILE, KERNEL_DIR, pluginDir, scratchDir } from './paths.js'
import type { Grant, GrantId, LibraryConfig, Library, LibraryPath, Plugin, PluginName, PluginTable } from './types.js'

export const CONFIG_FILE = join(KERNEL_DIR, 'config.json')

/** A plugin's name is also the name of its directory under `.pneuma-base/`. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,40}$/

export function pluginName(name: string): PluginName {
  if (!PLUGIN_NAME.test(name)) throw new Error(`not a plugin name (lowercase letters, digits, hyphens): ${name}`)
  return name as PluginName
}

export function newConfig(plugins: PluginName[]): LibraryConfig {
  return { format: 1, id: randomUUID(), plugins, grants: [] }
}

/** Opens the library at `dir`; null when `dir` holds no library configuration. */
export async function openLibrary(dir: string, table: PluginTable): Promise<Library | null> {
  let root: string
  let text: string
  try {
    root = await realpath(dir)
    text = await readFile(join(root, CONFIG_FILE), 'utf8')
  } catch {
    return null
  }
  const config = parseConfig(JSON.parse(text))
  const plugins: Plugin[] = []
  const unavailable: PluginName[] = []
  for (const name of config.plugins) {
    const plugin = table.get(name)
    if (plugin) plugins.push(plugin)
    else unavailable.push(name)
  }
  return { root, config, plugins, unavailable }
}

/**
 * Writes the configuration and regenerates the description from it. Every configuration change
 * goes through here, so the description never lags the configuration (K6). Fields this version
 * does not know are kept.
 */
export async function saveConfig(root: string, config: LibraryConfig, table: PluginTable): Promise<Library> {
  const path = join(root, CONFIG_FILE)
  const kept = await readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as Record<string, unknown>,
    () => ({}),
  )
  await mkdir(join(root, KERNEL_DIR), { recursive: true })
  for (const name of config.plugins) await mkdir(pluginDir(root, name), { recursive: true })
  await writeAtomic(path, `${JSON.stringify({ ...kept, ...config }, null, 2)}\n`, scratchDir(root))
  const library = await openLibrary(root, table)
  if (!library) throw new Error(`could not reopen the library at ${root}`)
  await writeAtomic(join(root, DESCRIPTION_FILE), assembleDescription(library), scratchDir(root))
  return library
}

function parseConfig(raw: unknown): LibraryConfig {
  const fail = (what: string): never => {
    throw new Error(`${CONFIG_FILE} is not a valid Pneuma Base configuration: ${what}`)
  }
  if (typeof raw !== 'object' || raw === null) return fail('not an object')
  const r = raw as Record<string, unknown>
  if (r.format !== 1) return fail('format is not 1')
  if (typeof r.id !== 'string') return fail('id is not a string')
  if (!Array.isArray(r.plugins) || !r.plugins.every((p) => typeof p === 'string' && PLUGIN_NAME.test(p))) return fail('plugins is not a list of plugin names')
  if (!Array.isArray(r.grants)) return fail('grants is not a list')
  const grants = r.grants.map((g: unknown): Grant => {
    const x = (typeof g === 'object' && g !== null ? g : {}) as Record<string, unknown>
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || typeof x.agent !== 'string') return fail('a grant lacks id, name or agent')
    if (x.area !== null && typeof x.area !== 'string') return fail(`grant ${x.name} has a bad area`)
    return { id: x.id as GrantId, name: x.name, agent: x.agent, area: x.area as LibraryPath | null, readOnly: x.readOnly === true }
  })
  return { format: 1, id: r.id, plugins: r.plugins as PluginName[], grants }
}
