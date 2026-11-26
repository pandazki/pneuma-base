// What a library path holds as one thing: a regular file, or a directory with the marker (a bundle).
// ARCHITECTURE "一个目录算一样东西". The kernel owns the marker and the rule a bundle's content follows;
// storage is asked at the paths named, never walked.
import { createHash } from 'node:crypto'
import { isDescribed, isFailure, type Description, type Fingerprint, type Instant, type LibraryPath, type Level, type ManifestEntry, type Place, type StorageReason, type ThingAt, type ThingNow } from '@pneuma-base/sdk'
import type { ContentRule, Storage } from './storage.js'

/** The file that makes a directory one thing. */
export const BUNDLE_MARKER = '.pneuma-item'
const MARKER_TEXT = `${JSON.stringify({ format: 1 })}\n`

/** Which files of a bundle are its content: not the library's noise (storage's), not the marker, not what a `.gitignore` in it excludes. */
export const THING_RULE: ContentRule = { noise: [BUNDLE_MARKER], ignore_file: '.gitignore' }

/** A directory with more files than this is not copied in as one thing without asking first. */
export const THING_FILES = 5000

/** How many entries of a directory's level one look gives. */
export const LEVEL = 200

export type At = ThingAt & { failed?: StorageReason }

const markerOf = (path: Place) => `${path}/${BUNDLE_MARKER}`
const described = (g: unknown): Description | null => (g !== undefined && isDescribed(g as Description) && (g as Description).kind !== 'none' ? (g as Description) : null)

/**
 * What each path holds as a thing, from one glance at the paths and at where their markers would be:
 * a file, a bundle, a folder, something else, or nothing. A place storage refuses (noise, below a link)
 * holds nothing, with the reason.
 */
export async function whatIs(store: Storage, paths: readonly LibraryPath[]): Promise<At[]> {
  if (paths.length === 0) return []
  const glanced = await store.glance([...paths, ...paths.map(markerOf)])
  return paths.map((path, i) => {
    const g = glanced[i]
    if (g !== undefined && !isDescribed(g)) return { path, kind: 'none', entry: null, failed: g.reason }
    const entry = described(g)
    if (entry === null) return { path, kind: 'none', entry: null }
    if (entry.kind === 'file') return { path, kind: 'file', entry }
    if (entry.kind !== 'dir') return { path, kind: 'other', entry }
    return { path, kind: described(glanced[paths.length + i])?.kind === 'file' ? 'bundle' : 'folder', entry }
  })
}

export async function whatIsOne(store: Storage, path: LibraryPath): Promise<At> {
  return (await whatIs(store, [path]))[0] as At
}

/** The bundle a library path lies strictly inside, the outermost one, or null: one glance at the markers above it. */
export async function enclosingBundle(store: Storage, path: LibraryPath): Promise<LibraryPath | null> {
  const parts = path.split('/')
  const above: LibraryPath[] = []
  for (let i = 1; i < parts.length; i++) above.push(parts.slice(0, i).join('/') as LibraryPath)
  if (above.length === 0) return null
  const glanced = await store.glance(above.map(markerOf))
  const at = glanced.findIndex((g) => described(g)?.kind === 'file')
  return at === -1 ? null : (above[at] as LibraryPath)
}

/** Writes the marker into `dir`, making it a bundle; refused when one is there already. */
export async function markBundle(store: Storage, dir: LibraryPath, hold?: string) {
  return store.write(markerOf(dir), { data: MARKER_TEXT }, 'empty', hold === undefined ? {} : { hold })
}

/** What storage says a thing is now, from its description; a bundle's bytes and files only when the content passed through. */
export function nowOf(entry: Description, kind: ThingAt['kind'], passed?: { bytes: number; files?: number }): ThingNow {
  const bundle = kind === 'bundle'
  return {
    token: entry.token ?? '',
    kind: bundle ? 'bundle' : 'file',
    size: bundle ? (passed?.bytes ?? null) : (entry.size ?? 0),
    files: bundle ? (passed?.files ?? null) : 1,
    modifiedAt: (entry.modified ?? new Date(0).toISOString()) as Instant,
  }
}

/** The first entries of a directory's level, at most `limit`, and at least how many follow; the marker is not one of them. */
export async function levelOf(store: Storage, dir: Place, limit = LEVEL): Promise<Level | null> {
  const page = await store.overview(dir, { limit })
  if (isFailure(page)) return null
  const entries = page.entries
    .filter((e) => !(e.kind === 'file' && e.place === markerOf(dir)))
    .map((e) => ({ name: e.place.slice(e.place.lastIndexOf('/') + 1), kind: e.kind === 'file' || e.kind === 'dir' ? e.kind : ('other' as const), size: e.size ?? null }))
  return { entries, more: page.more?.at_least ?? 0 }
}

/** The fingerprint of the thing at `path`, read now because asked; null when no file or bundle is there or it cannot be read. */
export async function fingerprintOf(store: Storage, path: LibraryPath, kind?: ThingAt['kind']): Promise<{ fingerprint: Fingerprint; token: string } | null> {
  const k = kind ?? (await whatIsOne(store, path)).kind
  if (k !== 'file' && k !== 'bundle') return null
  const answer = await store.content(path, k === 'bundle' ? { rule: THING_RULE, limit: 10_000_000 } : {})
  return isFailure(answer) ? null : { fingerprint: answer.fingerprint, token: answer.token }
}

const byBytes = (a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))

/** A bundle's fingerprint: the sha256 of `<path>\0<sha256 of content>\n` for each file, sorted by the UTF-8 bytes of the path. Storage computes the same. */
export function fingerprintOfManifest(entries: readonly Pick<ManifestEntry, 'path' | 'fingerprint'>[]): Fingerprint {
  const hash = createHash('sha256')
  for (const e of [...entries].sort(byBytes)) hash.update(`${e.path}\0${e.fingerprint}\n`)
  return hash.digest('hex') as Fingerprint
}

/**
 * Every thing under `dir`: its files outside bundles, and its bundles, not entered. A walk, one level of
 * one directory at a time through storage: only for a named whole act the owner chose, such as purging
 * the archive, and for contract 1's `things`.
 */
export async function thingsUnder(store: Storage, dir: Place): Promise<{ path: LibraryPath; kind: 'file' | 'bundle' }[]> {
  const out: { path: LibraryPath; kind: 'file' | 'bundle' }[] = []
  const queue: Place[] = [dir]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let after: string | undefined
    for (;;) {
      const page = await store.overview(next, { limit: 1000, ...(after === undefined ? {} : { after }) })
      if (isFailure(page)) break
      const dirs = page.entries.filter((e) => e.kind === 'dir')
      const marks = await store.glance(dirs.map((d) => markerOf(d.place)))
      for (const e of page.entries) {
        if (e.kind === 'file' && !e.place.endsWith(`/${BUNDLE_MARKER}`) && e.place !== BUNDLE_MARKER) out.push({ path: e.place as LibraryPath, kind: 'file' })
      }
      dirs.forEach((d, i) => {
        if (described(marks[i])?.kind === 'file') out.push({ path: d.place as LibraryPath, kind: 'bundle' })
        else queue.push(d.place)
      })
      if (page.more === null) break
      after = page.more.after
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
