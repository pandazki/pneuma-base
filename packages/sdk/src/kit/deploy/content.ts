// What a deploy plugin reads of a thing in the library, through storage: its files as a site serves
// them, copied out to a directory outside the library, and what identifies its content. Listing a
// bundle's files is a whole act the owner chose by deploying it: every level of the bundle, a page at
// a time, the content rule applied as storage applies it (no marker, no noise, nothing a `.gitignore`
// in it leaves out).
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { isFailure, type Description, type Place, type PluginStorage } from '../../storage.js'
import type { Fingerprint, LibraryPath } from '../../types.js'
import { ignored, ignoreRules, type IgnoreLevel } from './gitignore.js'
import type { SiteFile } from './target.js'

const MARKER = '.pneuma-item'
const IGNORE_FILE = '.gitignore'
/** As much of an ignore file as storage reads. */
const IGNORE_BYTES = 1 << 20
const PAGE = 1000
/** The most files a bundle's fingerprint counts when a deploy asks for it, as many as storage takes. */
const CONTENT_FILES = 10_000_000

/** A thing as storage holds it: a file, or a bundle (a directory with the marker). */
export type ThingKind = 'file' | 'bundle'

/**
 * A thing's content files, by their path in the site (sorted by its UTF-8 bytes) and their place;
 * `others`, what storage does not take as files (links, devices), which no copy has; `ignoring`, an
 * ignore file had a say.
 */
type Listing = { files: { path: string; place: Place }[]; others: string[]; ignoring: boolean }

const nameOf = (place: Place) => place.slice(place.lastIndexOf('/') + 1)
const byBytes = (a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))

/** One level of a directory, every page of it. */
async function level(storage: PluginStorage, place: Place): Promise<Description[]> {
  const out: Description[] = []
  let after: string | undefined
  for (;;) {
    const page = await storage.overview(place, { limit: PAGE, ...(after === undefined ? {} : { after }) })
    if (isFailure(page)) throw new Error(`${place} 列不出来：${page.reason}`)
    out.push(...page.entries)
    if (page.more === null) return out
    after = page.more.after
  }
}

/** The rules of an ignore file, read as storage reads it: its first MiB, as UTF-8 text, or no rules. */
async function rulesAt(storage: PluginStorage, place: Place): Promise<IgnoreLevel['rules']> {
  const read = await storage.read(place, { length: IGNORE_BYTES })
  if (isFailure(read) || read.data === null) return []
  try {
    return ignoreRules(new TextDecoder('utf-8', { fatal: true }).decode(read.data))
  } catch {
    return []
  }
}

/** Every level of a bundle, outermost first, each under the ignore files in effect there. */
async function listBundle(storage: PluginStorage, bundle: LibraryPath): Promise<Listing> {
  const out: Listing = { files: [], others: [], ignoring: false }
  const queue: { place: Place; rel: string; levels: IgnoreLevel[] }[] = [{ place: bundle, rel: '', levels: [] }]
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    const entries = await level(storage, dir.place)
    const ignore = entries.find((e) => e.kind === 'file' && nameOf(e.place) === IGNORE_FILE)
    const rules = ignore === undefined ? [] : await rulesAt(storage, ignore.place)
    const levels = rules.length === 0 ? dir.levels : [...dir.levels, { base: dir.rel, rules }]
    if (rules.length > 0) out.ignoring = true
    for (const e of entries) {
      const name = nameOf(e.place)
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`
      if (name === MARKER || ignored(levels, rel, e.kind === 'dir')) continue
      if (e.kind === 'file') out.files.push({ path: rel, place: e.place })
      else if (e.kind === 'dir') queue.push({ place: e.place, rel, levels })
      else if (e.kind === 'other') out.others.push(rel)
    }
  }
  out.files.sort(byBytes)
  out.others.sort()
  return out
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A bundle's fingerprint as storage computes it: the sha256 of `<path>\0<sha256 of content>\n` for each file, by the UTF-8 bytes of the path. */
function manifestFingerprint(entries: readonly { path: string; fingerprint: string }[]): Fingerprint {
  const hash = createHash('sha256')
  for (const e of [...entries].sort(byBytes)) hash.update(`${e.path}\0${e.fingerprint}\n`)
  return hash.digest('hex') as Fingerprint
}

/**
 * A thing's content copied out: the directory, its files as `identify` and `publish` take them (sorted
 * by the UTF-8 bytes of their paths), the fingerprint of what was copied, what storage does not take
 * as files, and whether an ignore file had a say.
 */
export type Staged = { dir: string; files: SiteFile[]; fingerprint: Fingerprint; others: string[]; ignoring: boolean }

/**
 * Copies a thing's content to a new directory under `root`, outside the library (a single file keeps
 * its name), runs `body` on it, and removes the directory, also when `body` throws.
 */
export async function withStaged<T>(storage: PluginStorage, path: LibraryPath, kind: ThingKind, root: string, body: (staged: Staged) => Promise<T>): Promise<T> {
  const dir = join(root, randomUUID())
  try {
    await mkdir(dir, { recursive: true })
    const listing: Listing = kind === 'file' ? { files: [{ path: posix.basename(path), place: path }], others: [], ignoring: false } : await listBundle(storage, path)
    const files: SiteFile[] = []
    const sums: { path: string; fingerprint: string }[] = []
    for (const f of listing.files) {
      const abs = join(dir, ...f.path.split('/'))
      await mkdir(dirname(abs), { recursive: true })
      const read = await storage.read(f.place, { to: abs })
      if (isFailure(read)) throw new Error(`没读到 ${f.place}：${read.reason}`)
      files.push({ path: f.path, abs })
      sums.push({ path: f.path, fingerprint: await sha256Of(abs) })
    }
    const fingerprint = kind === 'file' ? ((sums[0]?.fingerprint ?? '') as Fingerprint) : manifestFingerprint(sums)
    return await body({ dir, files, fingerprint, others: listing.others, ignoring: listing.ignoring })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The fingerprint storage gives of a thing's content, read now: null when it cannot. */
export async function fingerprintOf(storage: PluginStorage, path: LibraryPath): Promise<Fingerprint | null> {
  const answer = await storage.content(path, { limit: CONTENT_FILES })
  return isFailure(answer) ? null : answer.fingerprint
}
