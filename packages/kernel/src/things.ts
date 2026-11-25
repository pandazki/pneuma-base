// What a library path holds as one thing: a regular file, or a directory with the marker (a
// bundle). ARCHITECTURE "一个目录算一样东西". The kernel owns the marker and the fingerprint.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fingerprintOfFile } from './files.js'
import { abs } from './paths.js'
import type { Fingerprint, Instant, LibraryPath, ThingKind } from './types.js'

/** The file that makes a directory one thing. */
export const BUNDLE_MARKER = '.pneuma-item'
const MARKER_TEXT = `${JSON.stringify({ format: 1 })}\n`

/** Names a bundle's fingerprint never counts and a put never copies in, at any depth. */
const LEFT_OUT: ReadonlySet<string> = new Set([BUNDLE_MARKER, '.git', 'node_modules', '.DS_Store'])

/** What is at a path on disk: a thing, a directory without the marker, something else, or nothing. */
export async function kindAt(path: string): Promise<ThingKind | 'folder' | 'other' | null> {
  const s = await stat(path).catch(() => null)
  if (s === null) return null
  if (s.isFile()) return 'file'
  if (!s.isDirectory()) return 'other'
  return (await stat(join(path, BUNDLE_MARKER)).catch(() => null))?.isFile() ? 'bundle' : 'folder'
}

/** A thing's facts that need no hashing. A file counts as one file. */
export type Thing = { kind: ThingKind; size: number; files: number; modifiedAt: Instant }

/** The thing at `path`; null when there is no regular file and no bundle there. */
export async function thingAt(path: string): Promise<Thing | null> {
  const kind = await kindAt(path)
  if (kind === 'file') {
    const s = await stat(path)
    return { kind, size: s.size, files: 1, modifiedAt: s.mtime.toISOString() as Instant }
  }
  if (kind !== 'bundle') return null
  const files = await bundleFiles(path)
  const latest = files.reduce((at, f) => (f.modifiedAt > at ? f.modifiedAt : at), '')
  return {
    kind,
    size: files.reduce((sum, f) => sum + f.size, 0),
    files: files.length,
    modifiedAt: (latest || (await stat(path)).mtime.toISOString()) as Instant,
  }
}

/** A file a bundle counts: its path relative to the bundle, '/'-separated. */
export type BundleFile = { path: string; size: number; modifiedAt: Instant }

const byBytes = (a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))

/** The regular files of a bundle, without the names left out, sorted by the UTF-8 bytes of their paths. */
export async function bundleFiles(dir: string): Promise<BundleFile[]> {
  const out: BundleFile[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(rel === '' ? dir : join(dir, rel), { withFileTypes: true })) {
      if (LEFT_OUT.has(entry.name)) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const s = await stat(join(dir, path))
        out.push({ path, size: s.size, modifiedAt: s.mtime.toISOString() as Instant })
      }
    }
  }
  await walk('')
  return out.sort(byBytes)
}

export type ManifestEntry = { path: string; fingerprint: Fingerprint; size: number }

/** Each counted file of a bundle with the sha256 of its content, in fingerprint order. */
export async function bundleManifest(dir: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = []
  for (const f of await bundleFiles(dir)) out.push({ path: f.path, fingerprint: await fingerprintOfFile(join(dir, f.path)), size: f.size })
  return out
}

/** A bundle's fingerprint: the sha256 of `<path>\0<sha256 of content>\n` for each file, sorted by the UTF-8 bytes of the path. */
export function fingerprintOfManifest(entries: readonly Pick<ManifestEntry, 'path' | 'fingerprint'>[]): Fingerprint {
  const hash = createHash('sha256')
  for (const e of [...entries].sort(byBytes)) hash.update(`${e.path}\0${e.fingerprint}\n`)
  return hash.digest('hex') as Fingerprint
}

/** The fingerprint of the thing at `path`, a file or a bundle. Throws when neither is there. */
export async function fingerprintOf(path: string): Promise<Fingerprint> {
  const kind = await kindAt(path)
  if (kind === 'file') return fingerprintOfFile(path)
  if (kind === 'bundle') return fingerprintOfManifest(await bundleManifest(path))
  throw new Error(`no file or bundle at ${path}`)
}

/** Writes the marker into `dir`, making it a bundle. */
export async function markBundle(dir: string): Promise<void> {
  await writeFile(join(dir, BUNDLE_MARKER), MARKER_TEXT)
}

/**
 * Copies the counted files of the directory `from` into `to`, which must not exist, and writes the
 * marker there. Callers copy to a temporary name and rename it into place.
 */
export async function copyBundle(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: false })
  for (const f of await bundleFiles(from)) {
    await mkdir(dirname(join(to, f.path)), { recursive: true })
    await copyFile(join(from, f.path), join(to, f.path))
  }
  await markBundle(to)
}

/**
 * The things under `root`, by path relative to it: every regular file outside bundles, and every
 * bundle, not descended into. Top-level names in `skip` are left out.
 */
export async function listThings(root: string, skip: ReadonlySet<string>): Promise<{ path: string; kind: ThingKind }[]> {
  const out: { path: string; kind: ThingKind }[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      if (rel === '' && skip.has(entry.name)) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isFile()) out.push({ path, kind: 'file' })
      else if (!entry.isDirectory()) continue
      else if ((await kindAt(join(root, path))) === 'bundle') out.push({ path, kind: 'bundle' })
      else await walk(path)
    }
  }
  await walk('')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The bundle a library path lies strictly inside, or null. */
export async function enclosingBundle(root: string, path: LibraryPath): Promise<LibraryPath | null> {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join('/') as LibraryPath
    if ((await kindAt(abs(root, ancestor))) === 'bundle') return ancestor
  }
  return null
}
