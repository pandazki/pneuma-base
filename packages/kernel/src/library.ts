import { randomUUID } from 'node:crypto'
import { resolveAddress } from './address.js'
import { settle } from './claims.js'
import { describeLibrary } from './cognition.js'
import { DESCRIPTION_FILE } from './paths.js'
import { storageOf, type Storage } from './storage.js'
import { isDescribed, isFailure, PLUGIN_NAME, type Context, type Grant, type GrantId, type LibraryConfig, type Library, type LibraryPath, type Plugin, type PluginName, type PluginProblem, type PluginTable } from '@pneuma-base/sdk'

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
  return libraryOf(root, parseConfig(declaration), table)
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
 * Writes the configuration into the declaration and writes the description for it. Every
 * configuration change goes through here, so the description never lags the configuration (K6). Fields
 * this version does not know are kept. Each write expects what it read; one that finds another writer
 * came between reads again and writes again. `at`: who acts, in which session, on this machine: the
 * context the plugins' paragraphs are asked in, with the library as it is now configured.
 */
export async function saveConfig(root: string, config: LibraryConfig, table: PluginTable, at: Omit<Context, 'library'>): Promise<{ library: Library; problems: PluginProblem[] }> {
  const store = storageOf(root)
  for (let tries = 0; ; tries++) {
    const { declaration, token } = await store.declaration.read()
    const written = await store.declaration.write({ ...(declaration ?? {}), ...config }, token ?? 'empty')
    if ('token' in written) break
    if (tries > 5) throw new Error(`资料库声明持续被其他进程改写，写入失败：${root}`)
  }
  const library = libraryOf(root, config, table)
  return { library, problems: await writeDescription({ ...at, library }) }
}

/**
 * Writes the description at the root as the library's plugins describe it now, only when its text
 * differs from what is there; another writer coming between makes it look again. Every write of the
 * description goes through here. Answers the problems of the plugins whose paragraph failed.
 */
export async function writeDescription(ctx: Context): Promise<PluginProblem[]> {
  const store = storageOf(ctx.library.root)
  const { text, problems } = await describeLibrary(ctx)
  for (let tries = 0; ; tries++) {
    const there = await store.read(DESCRIPTION_FILE)
    if (!isFailure(there) && there.data !== null && Buffer.from(there.data).toString('utf8') === text) return problems
    const expect = isFailure(there) ? await tokenThere(store) : there.token
    const written = await store.write(DESCRIPTION_FILE, { data: text }, expect)
    if (!isFailure(written)) return problems
    if (written.reason !== 'refused' || tries > 5) throw new Error(`写入资料库说明 ${DESCRIPTION_FILE} 失败（${written.reason}）`)
  }
}

/** What a write over the description expects when its bytes could not be read, such as when none is there. */
async function tokenThere(store: Storage): Promise<string> {
  const [there] = await store.glance([DESCRIPTION_FILE])
  return there !== undefined && isDescribed(there) && there.kind !== 'none' ? (there.token ?? 'empty') : 'empty'
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
