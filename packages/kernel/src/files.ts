import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Fingerprint, Instant } from '@pneuma-base/sdk'

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

/** A lock not touched for this long was left by a process that died. */
const LOCK_STALE_MS = 10_000

/** Runs `body` alone among the processes on this machine that lock the directory `lock`. */
export async function alone<T>(lock: string, body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lock), { recursive: true })
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const held = await stat(lock).catch(() => null)
      if (held !== null && Date.now() - held.mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true })
      else await sleep(20)
    }
  }
  try {
    return await body()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/** Writes `text` to `target` whole, only if nothing is there yet; false when something is. */
export async function writeOnce(target: string, text: string): Promise<boolean> {
  const tmp = await scratchName(dirname(target))
  await writeFile(tmp, text)
  try {
    await link(tmp, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmp)
  }
}
