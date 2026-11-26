import { randomUUID } from 'node:crypto'
import { resolveAddress } from './address.js'
import { settle } from './claims.js'
import { assembleDescription } from './cognition.js'
import { makeV1Dirs } from './contract-v1.js'
import { DESCRIPTION_FILE } from './paths.js'
import { storageOf, type Storage } from './storage.js'
import { isDescribed, isFailure, PLUGIN_NAME, type Grant, type GrantId, type LibraryConfig, type Library, type LibraryPath, type Plugin, type PluginName, type PluginTable } from '@pneuma-base/sdk'

/** Where storage keeps the declaration, for messages: the file other programs (the app) look for. */
export const CONFIG_FILE = '.pneuma-base/config.json'

/** A library id is one segment of a path under the cache directory, so it stays plain. */
const LIBRARY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function newConfig(plugins: PluginName[]): LibraryConfig {
  return { format: 1, id: randomUUID(), plugins, grants: [] }
}

/**
 * The library a directory is: its real path, which is how the library's address is resolved, and the
 * declaration storage keeps at its root. Null when `dir` is not there or holds no declaration.
 */
export async function openLibrary(dir: string, table: PluginTable): Promise<Library | null> {
  const root = await resolveAddress(dir)
  if (root === null) return null
  const { declaration } = await storageOf(root).declaration.read().catch(() => ({ declaration: null }))
  if (declaration === null) return null
  const library = libraryOf(root, parseConfig(declaration), table)
  await makeV1Dirs(storageOf(root), root, library.plugins)
  return library
}

function libraryOf(root: string, config: LibraryConfig, table: PluginTable): Library {
  const plugins: Plugin[] = []
  const unavailable: PluginName[] = []
  for (const name of config.plugins) {
    const plugin = table.get(name)
    if (plugin) plugins.push(plugin)
    else unavailable.push(name)
  }
  return { root, config, ...settle(plugins), unavailable }
}

/**
 * Writes the configuration into the declaration and regenerates the description from it. Every
 * configuration change goes through here, so the description never lags the configuration (K6). Fields
 * this version does not know are kept. Each write expects what it read; one that finds another writer
 * came between reads again and writes again.
 */
export async function saveConfig(root: string, config: LibraryConfig, table: PluginTable): Promise<Library> {
  const store = storageOf(root)
  for (let tries = 0; ; tries++) {
    const { declaration, token } = await store.declaration.read()
    const written = await store.declaration.write({ ...(declaration ?? {}), ...config }, token ?? 'empty')
    if ('token' in written) break
    if (tries > 5) throw new Error(`库的声明一直在被别的进程改写，没能写进去：${root}`)
  }
  const library = libraryOf(root, config, table)
  await writeDescription(store, assembleDescription(library))
  await makeV1Dirs(store, root, library.plugins)
  return library
}

/** Writes the description at the root, over what is there now; another writer coming between makes it try again. */
async function writeDescription(store: Storage, text: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const [there] = await store.glance([DESCRIPTION_FILE])
    const expect = there !== undefined && isDescribed(there) && there.kind !== 'none' ? (there.token ?? 'empty') : 'empty'
    const written = await store.write(DESCRIPTION_FILE, { data: text }, expect)
    if (!isFailure(written)) return
    if (written.reason !== 'refused' || tries > 5) throw new Error(`没能写说明 ${DESCRIPTION_FILE}（${written.reason}）`)
  }
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
