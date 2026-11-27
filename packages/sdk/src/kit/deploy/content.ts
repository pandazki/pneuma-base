// What a deploy plugin reads of a thing in the library, through storage: its files as a site serves
// them, copied out to a directory outside the library, and what identifies its content. A bundle's
// files are the pages of its manifest, which storage computes by the content rule (no marker, no
// noise, nothing a `.gitignore` in it leaves out); nothing walks it. `node:fs` here touches only the
// stage folder, in the plugin's cache.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { isFailure, type ContentAnswer, type Manifest, type Place, type PluginStorage, type StorageFailure } from '../../storage.js'
import type { Fingerprint, LibraryPath } from '../../types.js'
import type { SiteFile } from './target.js'

/** A thing as storage holds it: a file, or a bundle (a directory with the marker). */
export type ThingKind = 'file' | 'bundle'

/** The most files storage counts as one thing's content, as the kernel asks it: past it, `too_many`. */
const THING_FILES = 5000
/** As many manifest entries as one answer gives: a bundle's whole manifest, in one page. */
const MANIFEST_PAGE = 10_000

/** Why a thing's content is not copied out now, as a sentence for people: it has more files than one thing takes, or it changed while it was read. */
export class NotStaged extends Error {}

export const changing = (path: LibraryPath) => new NotStaged(`${path} 正在被改动，没有发布`)

/** A failed answer about a thing's content, as what to throw. */
function failed(path: LibraryPath, answer: StorageFailure): Error {
  if (answer.reason === 'too_many') return new NotStaged(`${path} 至少有 ${answer.at_least ?? THING_FILES + 1} 个文件，超过一样东西能有的 ${THING_FILES} 个，没有发布`)
  return new Error(`没读到 ${path}：${answer.reason}`)
}

/** A thing's content files, by their path in the site (sorted by its UTF-8 bytes), with their place and fingerprint; and the content's fingerprint. */
type Listing = { files: (Manifest['entries'][number] & { place: Place })[]; fingerprint: Fingerprint }

/** A file is its own one entry; a bundle's entries are its manifest's, every page taken of the same content. */
async function listing(storage: PluginStorage, path: LibraryPath, kind: ThingKind): Promise<Listing> {
  if (kind === 'file') {
    const answer = await storage.content(path)
    if (isFailure(answer)) throw failed(path, answer)
    if (answer.kind !== 'file') throw changing(path)
    return { files: [{ path: posix.basename(path), place: path, fingerprint: answer.fingerprint, size: answer.size }], fingerprint: answer.fingerprint }
  }
  const out: Listing['files'] = []
  let first: Fingerprint | null = null
  let after: string | undefined
  do {
    const answer: ContentAnswer | StorageFailure = await storage.content(path, { manifest: { limit: MANIFEST_PAGE, ...(after === undefined ? {} : { after }) } })
    if (isFailure(answer)) throw failed(path, answer)
    if (answer.kind !== 'dir' || answer.manifest === undefined || (first !== null && answer.fingerprint !== first)) throw changing(path)
    first = answer.fingerprint
    out.push(...answer.manifest.entries.map((e) => ({ ...e, place: `${path}/${e.path}` })))
    after = answer.manifest.more?.after
  } while (after !== undefined)
  return { files: out, fingerprint: first }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A thing's content copied out: the directory, its files as `identify` and `publish` take them (sorted by the UTF-8 bytes of their paths), and its fingerprint. */
export type Staged = { dir: string; files: SiteFile[]; fingerprint: Fingerprint }

/**
 * Copies a thing's content to a new directory under `root`, outside the library (a single file keeps
 * its name), runs `body` on it, and removes the directory, also when `body` throws. Each file is read
 * into it and checked against the fingerprint its manifest entry gives; a file that differs changed
 * while it was read, and `body` does not run. A bundle with more files than one thing takes is refused.
 */
export async function withStaged<T>(storage: PluginStorage, path: LibraryPath, kind: ThingKind, root: string, body: (staged: Staged) => Promise<T>): Promise<T> {
  const dir = join(root, randomUUID())
  try {
    await mkdir(dir, { recursive: true })
    const listed = await listing(storage, path, kind)
    const files: SiteFile[] = []
    for (const f of listed.files) {
      const abs = join(dir, ...f.path.split('/'))
      await mkdir(dirname(abs), { recursive: true })
      const read = await storage.read(f.place, { to: abs })
      if (isFailure(read)) throw new Error(`没读到 ${f.place}：${read.reason}`)
      if ((await sha256Of(abs)) !== f.fingerprint) throw changing(path)
      files.push({ path: f.path, abs })
    }
    return await body({ dir, files, fingerprint: listed.fingerprint })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The fingerprint storage gives of a thing's content, read now: null when nothing can be read there. A bundle with more files than one thing takes is refused. */
export async function fingerprintOf(storage: PluginStorage, path: LibraryPath): Promise<Fingerprint | null> {
  const answer = await storage.content(path)
  if (isFailure(answer) && answer.reason === 'too_many') throw failed(path, answer)
  return isFailure(answer) ? null : answer.fingerprint
}
