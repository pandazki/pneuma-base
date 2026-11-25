import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { assembleDescription } from './cognition.js'
import { writeAtomic } from './files.js'
import { DESCRIPTION_FILE, KERNEL_DIR, pluginDir, scratchDir } from './paths.js'
import { PLUGIN_NAME, type Grant, type GrantId, type LibraryConfig, type Library, type LibraryPath, type Plugin, type PluginName, type PluginTable } from '@pneuma-base/sdk'

export const CONFIG_FILE = join(KERNEL_DIR, 'config.json')

/** A library id is one segment of a path under the cache directory, so it stays plain. */
const LIBRARY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

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
  // A plugin's directory exists whenever its hooks run, also when a synced configuration came without
  // it. A library this caller cannot write still opens; the hook that writes there reports the problem.
  await Promise.all(plugins.map((p) => mkdir(pluginDir(root, p.name), { recursive: true }).catch(() => undefined)))
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
  if (typeof r.id !== 'string' || !LIBRARY_ID.test(r.id)) return fail('id is not a library id (letters, digits, hyphens, underscores)')
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
