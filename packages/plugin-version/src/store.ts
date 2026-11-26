// Content-addressed storage: objects/<first two hex>/<sha256>, each written once under its hash, so
// the same content is stored once across versions and across things.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fingerprint, LibraryPath, PluginContext } from '@pneuma-base/kernel'
import type { Manifest } from './facts.js'

const objectPath = (dir: string, fingerprint: Fingerprint) => join(dir, 'objects', fingerprint.slice(0, 2), fingerprint)
const scratch = (beside: string) => join(dirname(beside), `.tmp-${randomBytes(6).toString('hex')}`)
/** The sha256 of a file this plugin wrote outside the library, as a version's row records it. */
async function hashFile(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') as Fingerprint
}

const present = async (path: string) => (await stat(path).catch(() => null))?.isFile() === true

/** The thing at `path`, a file or a bundle, as a version records it; null when neither is there. */
export async function snapshot(ctx: PluginContext, path: LibraryPath): Promise<{ fingerprint: Fingerprint; manifest: Manifest } | null> {
  const thing = await ctx.tools.thing(path)
  if (thing === null) return null
  if (thing.kind === 'file') {
    const fingerprint = await ctx.tools.fingerprint(path)
    if (fingerprint === null) return null
    return { fingerprint, manifest: { kind: 'file', rows: [{ path: '', fingerprint, size: thing.size }] } }
  }
  const rows = await ctx.tools.manifest(path)
  if (rows === null) return null
  return { fingerprint: ctx.tools.fingerprintOfManifest(rows), manifest: { kind: 'bundle', rows } }
}

/**
 * Copies each file of the thing at `file` into the store, unless its content is there already. A
 * copy is checked against its row's sha256 before it takes its name; a mismatch means the thing
 * changed meanwhile, and throws.
 */
export async function store(ctx: PluginContext, file: string, manifest: Manifest): Promise<void> {
  const dir = ctx.dir
  for (const row of manifest.rows) {
    const target = objectPath(dir, row.fingerprint)
    if (await present(target)) continue
    await mkdir(dirname(target), { recursive: true })
    const tmp = scratch(target)
    try {
      await copyFile(join(file, row.path), tmp)
      if ((await ctx.tools.fingerprintOfFile(tmp)) !== row.fingerprint) throw new Error(`${row.path || '它'} 在记录时被改动了`)
      await link(tmp, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    } finally {
      await rm(tmp, { force: true })
    }
  }
}

/** Whether the store holds every file of this content. */
export async function complete(dir: string, manifest: Manifest): Promise<boolean> {
  for (const row of manifest.rows) if (!(await present(objectPath(dir, row.fingerprint)))) return false
  return true
}

/**
 * Writes a version's content to `target`, which must not exist: the file, or a directory of the
 * bundle's files without the marker. Written under a temporary name beside it, each file checked
 * against its sha256, then renamed into place.
 */
export async function writeOut(dir: string, manifest: Manifest, target: string): Promise<void> {
  const tmp = scratch(target)
  try {
    if (manifest.kind === 'bundle') await mkdir(tmp)
    for (const row of manifest.rows) {
      const to = join(tmp, row.path)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(objectPath(dir, row.fingerprint), to)
      if ((await hashFile(to)) !== row.fingerprint) throw new Error(`存放里的内容 ${row.fingerprint.slice(0, 8)} 坏了`)
    }
    await rename(tmp, target)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Deletes the stored content of these sha256s; how many files it deleted. */
export async function drop(dir: string, fingerprints: Iterable<Fingerprint>): Promise<number> {
  let deleted = 0
  for (const fingerprint of fingerprints) {
    const path = objectPath(dir, fingerprint)
    if (!(await present(path))) continue
    await rm(path)
    deleted++
  }
  return deleted
}
