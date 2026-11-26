// A put's source outside the library: a file or a directory on this machine that is no library's, read
// here only for what storage cannot say of it (its kind, its size, a file's sha256 when a replacement
// must be decided). Nothing here reads or writes a library's folder or record area: that is storage's.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Fingerprint } from '@pneuma-base/sdk'
import { canonical } from './paths.js'

/** The size of the regular file at `path`; null when there is none. */
export async function outsideFile(path: string): Promise<{ path: string; size: number } | null> {
  const s = await stat(path).catch(() => null)
  return s?.isFile() ? { path: resolve(path), size: s.size } : null
}

/** The real path of the directory at `path`; null when there is none. */
export async function outsideDir(path: string): Promise<string | null> {
  const dir = canonical(resolve(path))
  return (await stat(dir).catch(() => null))?.isDirectory() ? dir : null
}

/** The sha256 of a file outside the library. */
export async function hashOutside(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') as Fingerprint
}
