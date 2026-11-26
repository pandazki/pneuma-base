// What `agent connect` wrote into other programs' folders and files, recorded on this machine under
// `$PNEUMA_BASE_HOME/connections/<grant name>/`, and how to tell whether it is still there and take it
// out again. Machine state, not the library's. ARCHITECTURE.md section 6.
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { canonical, jsonEntry, removeJsonEntry, removeToml, tomlState, type JsonAdded } from './config-edit.js'
import { exists, writeAtomic } from './machine-files.js'
import type { CommandLine } from './launcher.js'
import type { Way } from './products.js'
import type { Instant } from '@pneuma-base/sdk'

/**
 * One thing written. `dirs`: the folders written into being, outermost first, each taken away again
 * once empty. A skill is its SKILL.md; a JSON entry is located by key and name; a TOML table is the
 * exact text appended. A fingerprint is of what was written: the file, or the entry's value in canonical
 * form. `none`: nothing was written, for a product reached only by the local endpoint's address.
 */
export type Written =
  | { kind: 'skill'; file: string; fingerprint: string; dirs: string[] }
  | ({ kind: 'json'; file: string; key: string; name: string; fingerprint: string; dirs: string[] } & JsonAdded)
  | { kind: 'toml'; file: string; key: string; name: string; appended: string; createdFile: boolean; dirs: string[] }
  | { kind: 'none' }

export type Connection = {
  format: 1
  grant: string
  /** The grant's id, so a grant of the same name issued again later is not taken for this one. */
  grantId: string
  product: string
  library: string
  way: Way
  at: Instant
  wrote: Written
  /**
   * What the skill or the MCP entry runs: the launcher, by path. A record written before the launcher
   * has the node program and entry file its MCP entry ran, or null for a skill.
   */
  command: { launcher: string } | CommandLine | null
}

/** Whether what was written is still there as written, changed since, gone, or in a file that no longer reads. */
export type WrittenState = 'in-place' | 'changed' | 'gone' | 'unreadable'

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const connectionsDir = (home: string) => join(home, 'connections')
const connectionDir = (home: string, grant: string) => join(connectionsDir(home), grant)
const recordPath = (home: string, grant: string) => join(connectionDir(home, grant), 'connection.json')

export async function readConnection(home: string, grant: string): Promise<Connection | null> {
  try {
    const raw = JSON.parse(await readFile(recordPath(home, grant), 'utf8')) as Partial<Connection>
    return raw.format === 1 && raw.grant === grant && raw.wrote !== undefined ? (raw as Connection) : null
  } catch {
    return null
  }
}

/** Every connection recorded on this machine, by grant name. */
export async function allConnections(home: string): Promise<Connection[]> {
  const names = await readdir(connectionsDir(home)).catch(() => [] as string[])
  const out: Connection[] = []
  for (const name of names.sort()) {
    const c = await readConnection(home, name)
    if (c !== null) out.push(c)
  }
  return out
}

/** The folder holds a copy of another program's file, which can hold secrets: only the user reads it. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

export async function saveConnection(home: string, c: Connection): Promise<void> {
  const dir = connectionDir(home, c.grant)
  await privateDir(dir)
  await writeAtomic(recordPath(home, c.grant), `${JSON.stringify(c, null, 2)}\n`, dir)
}

export async function dropConnection(home: string, grant: string): Promise<void> {
  await rm(connectionDir(home, grant), { recursive: true, force: true })
}

/** Keeps a copy of `file` as it is now beside the record, once: before the first change this connection makes to it. Its path, or null when there is no file. */
export async function keepBefore(home: string, grant: string, file: string): Promise<string | null> {
  if (!(await exists(file))) return null
  const dir = join(connectionDir(home, grant), 'before')
  const copy = join(dir, basename(file))
  if (await exists(copy)) return copy
  await privateDir(dir)
  await copyFile(await realpath(file), copy)
  await chmod(copy, 0o600)
  return copy
}

/** A file's text, or null when there is none. A link is read where it leads. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Writes another program's file whole: a temporary name beside it, with its mode, then a rename onto
 * it, so the program never reads half a file. A link stays a link: the file it leads to is written.
 */
export async function writeBeside(path: string, text: string): Promise<void> {
  const target = (await exists(path)) ? await realpath(path) : path
  const mode = (await stat(target).catch(() => null))?.mode ?? 0o600
  await mkdir(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${basename(target)}.pneuma-base-${randomUUID()}`)
  try {
    await writeFile(tmp, text, { mode: mode & 0o777 })
    await chmod(tmp, mode & 0o777)
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** The folders on the way to `dir` that are not there yet, outermost first, never `home` or above it. */
export async function missingDirs(dir: string, home: string): Promise<string[]> {
  const missing: string[] = []
  for (let d = dir; d.startsWith(`${home}/`) && !(await exists(d)); d = dirname(d)) missing.unshift(d)
  return missing
}

async function removeEmpty(dirs: readonly string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) await rmdir(dir).catch(() => undefined)
}

export async function stateOf(w: Written): Promise<WrittenState> {
  if (w.kind === 'none') return 'in-place'
  const text = await readText(w.file)
  if (text === null) return 'gone'
  switch (w.kind) {
    case 'skill':
      return sha256(text) === w.fingerprint ? 'in-place' : 'changed'
    case 'json': {
      const found = jsonEntry(text, w.key, w.name)
      if (found.outcome === 'unreadable') return 'unreadable'
      if (found.outcome === 'absent') return 'gone'
      return sha256(canonical(found.value)) === w.fingerprint ? 'in-place' : 'changed'
    }
    case 'toml':
      return tomlState(text, w.name, w.appended)
  }
}

/**
 * Takes out what was written, only when it is still as written: a skill's file and the folders
 * written for it; a JSON entry, with the key or the file it came with when nothing else is in them
 * now; the TOML text appended. Answers the state it found: anything but `in-place` was left alone.
 */
export async function undo(w: Written): Promise<WrittenState> {
  const state = await stateOf(w)
  if (state !== 'in-place' || w.kind === 'none') return state
  const text = (await readText(w.file)) as string
  if (w.kind === 'skill') await unlink(w.file)
  else {
    const without = w.kind === 'json' ? removeJsonEntry(text, w.key, w.name, w) : removeToml(text, w.appended)
    if (without === null) return 'changed'
    const created = w.kind === 'json' ? w.created === 'file' && without === '{}\n' : w.createdFile && without === ''
    if (created) await unlink(await realpath(w.file))
    else await writeBeside(w.file, without)
  }
  await removeEmpty(w.dirs)
  return 'in-place'
}
