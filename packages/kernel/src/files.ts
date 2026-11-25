import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fingerprint, Instant } from './types.js'

export async function fingerprintOfFile(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') as Fingerprint
}

export type RegularFile = { size: number; modifiedAt: Instant }

/** The file's facts when `path` is a regular file; null when it is missing or anything else. */
export async function regularFile(path: string): Promise<RegularFile | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? { size: s.size, modifiedAt: s.mtime.toISOString() as Instant } : null
  } catch {
    return null
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A fresh, unique name in `dir` for a file being written. */
export async function scratchName(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return join(dir, `${randomUUID()}.partial`)
}

/** Writes `bytes` to a temporary name in `scratch`, then renames it onto `target`. */
export async function writeAtomic(target: string, bytes: Uint8Array | string, scratch: string): Promise<void> {
  const tmp = await scratchName(scratch)
  await writeFile(tmp, bytes)
  await moveInto(tmp, target)
}

export async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
}

/** Removes a scratch file or directory, if it is there. */
export async function discard(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * Renames `from` onto `to`, replacing what is there. A rename cannot replace a directory that holds
 * files, so a directory at `to` is renamed aside into `scratch` first and removed after.
 */
export async function replaceWith(from: string, to: string, scratch: string): Promise<void> {
  if (!(await stat(to).catch(() => null))?.isDirectory()) return moveInto(from, to)
  const aside = await scratchName(scratch)
  await rename(to, aside)
  try {
    await rename(from, to)
  } catch (error) {
    await rename(aside, to)
    throw error
  }
  await discard(aside)
}
