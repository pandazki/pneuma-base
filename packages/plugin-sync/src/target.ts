// The built-in `dir` target: a directory outside the library, read and written with node:fs here and
// nowhere else in the plugin. Its layout is the sync's own:
//   <target>/<library path>                             things; a directory thing with its marker
//   <target>/.pneuma-sync/id                            the target's id
//   <target>/.pneuma-sync/tmp/                          temporary names, renamed into place
//   <target>/.pneuma-sync/own/<place>/<own place>       each record place's own content
//   <target>/.pneuma-sync/facts/<place>/<library>/<seq>.jsonl   each library's facts, a new file per run
// The target has no storage of its own: a path's state is its lstat (size, modification time, inode),
// kept in the baseline, and its content is hashed only when that state differs.
import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { BUNDLE_MARKER, type Fingerprint } from '@pneuma-base/kernel'
import { inCache, isPlaceName, ownKey, ownOf, TARGET_DIR, type Key } from './scope.js'

/** What a target path holds: a file or a directory, and its state. */
export type Seen = { kind: 'file' | 'dir'; at: string }
/** A copy taken out of one side, at `path` in the target's temporary folder, to be placed on either side. */
export type Staged = { path: string; dir: boolean }
/** The library's noise: names left out at any depth, and library paths left out with what lies below. */
export type Noise = { names: ReadonlySet<string>; paths: readonly string[] }

const MARKER_TEXT = `${JSON.stringify({ format: 1 })}\n`
const STREAM_FILE = /^\d{10}\.jsonl$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex') as Fingerprint
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

function seenAt(path: string): Seen | null {
  const s = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (s === undefined || !(s.isFile() || s.isDirectory())) return null
  return { kind: s.isFile() ? 'file' : 'dir', at: `${s.size}:${s.mtimeNs}:${s.ino}` }
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export class TargetDir {
  private readonly sync: string

  constructor(
    readonly root: string,
    private readonly noise: Noise,
  ) {
    this.sync = join(root, TARGET_DIR)
  }

  pathOf(key: Key): string {
    const own = ownOf(key)
    return own === null ? join(this.root, ...key.split('/')) : join(this.sync, 'own', own.place, ...(own.own === '' ? [] : own.own.split('/')))
  }

  seen(key: Key): Seen | null {
    return seenAt(this.pathOf(key))
  }

  // ---- content ----

  /**
   * The files a directory thing's fingerprint counts, by path relative to it, sorted by their bytes: its
   * regular files but the marker and the library's noise. Own content has no noise and no marker.
   */
  private filesOf(key: Key): string[] {
    const thing = ownOf(key) === null
    const out: string[] = []
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = rel === '' ? e.name : `${rel}/${e.name}`
        if (thing && (this.noise.names.has(e.name) || this.noise.paths.some((p) => `${key}/${path}` === p || `${key}/${path}`.startsWith(`${p}/`)))) continue
        if (e.isDirectory()) walk(join(dir, e.name), path)
        else if (e.isFile() && !(thing && path === BUNDLE_MARKER)) out.push(path)
      }
    }
    walk(this.pathOf(key), '')
    return out.sort(byBytes)
  }

  /** The fingerprint of what `key` holds: a file's sha256, or a directory's manifest as storage computes it. */
  fingerprint(key: Key, kind: Seen['kind']): Fingerprint {
    const at = this.pathOf(key)
    if (kind === 'file') return sha256(readFileSync(at))
    return sha256(this.filesOf(key).map((p) => `${p}\0${sha256(readFileSync(join(at, ...p.split('/'))))}\n`).join(''))
  }

  // ---- copies in and out ----

  /** A new path in the target's temporary folder. */
  scratch(): string {
    const tmp = join(this.sync, 'tmp')
    mkdirSync(tmp, { recursive: true })
    return join(tmp, randomUUID())
  }

  /** Copies what `key` holds into the temporary folder while it is still `fp`; a directory thing gets its marker. Null when it is not. */
  stage(key: Key, fp: Fingerprint): Staged | null {
    const seen = this.seen(key)
    if (seen === null) return null
    const from = this.pathOf(key)
    const to = this.scratch()
    try {
      if (seen.kind === 'file') {
        copyFileSync(from, to, constants.COPYFILE_FICLONE)
        if (sha256(readFileSync(to)) === fp) return { path: to, dir: false }
      } else {
        const lines: string[] = []
        for (const p of this.filesOf(key)) {
          const dest = join(to, ...p.split('/'))
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(join(from, ...p.split('/')), dest, constants.COPYFILE_FICLONE)
          lines.push(`${p}\0${sha256(readFileSync(dest))}\n`)
        }
        mkdirSync(to, { recursive: true })
        if (sha256(lines.join('')) === fp) {
          const staged = { path: to, dir: true }
          if (ownOf(key) === null) this.mark(staged)
          return staged
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        rmSync(to, { recursive: true, force: true })
        throw error
      }
    }
    rmSync(to, { recursive: true, force: true })
    return null
  }

  /** Puts a staged copy at `key`, taking it: a file by one rename, a directory swapped whole. */
  put(key: Key, staged: Staged): void {
    const dest = this.pathOf(key)
    mkdirSync(dirname(dest), { recursive: true })
    const there = seenAt(dest)
    if (there !== null && (staged.dir || there.kind === 'dir')) {
      const aside = this.scratch()
      renameSync(dest, aside)
      renameSync(staged.path, dest)
      rmSync(aside, { recursive: true, force: true })
    } else renameSync(staged.path, dest)
  }

  /** Removes what `key` holds, and the folders that leaves empty, up to the target. */
  remove(key: Key): void {
    const dest = this.pathOf(key)
    if (seenAt(dest)?.kind === 'dir') {
      const aside = this.scratch()
      renameSync(dest, aside)
      rmSync(aside, { recursive: true, force: true })
    } else unlinkSync(dest)
    for (let dir = dirname(dest); dir.startsWith(`${this.root}/`) && dir !== this.sync; dir = dirname(dir)) {
      try {
        rmdirSync(dir)
      } catch {
        break
      }
    }
  }

  // ---- the target's id ----

  id(): string | null {
    try {
      return readFileSync(join(this.sync, 'id'), 'utf8').trim() || null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  giveId(): string {
    const id = randomUUID()
    const tmp = this.scratch()
    writeFileSync(tmp, `${id}\n`)
    renameSync(tmp, join(this.sync, 'id'))
    return id
  }

  // ---- own content ----

  /** The record places whose own content is in the target. */
  ownPlaces(): string[] {
    return names(join(this.sync, 'own')).filter(isPlaceName)
  }

  /** Every file of a record place's own content in the target and its state, the directories under `caches` left out. */
  ownFiles(place: string, caches: readonly string[]): Map<Key, string> {
    const out = new Map<Key, string>()
    const walk = (dir: string, rel: string) => {
      for (const name of names(dir)) {
        const own = rel === '' ? name : `${rel}/${name}`
        if (inCache(own, caches)) continue
        const s = seenAt(join(dir, name))
        if (s?.kind === 'dir') walk(join(dir, name), own)
        else if (s?.kind === 'file') out.set(ownKey(place, own), s.at)
      }
    }
    walk(join(this.sync, 'own', place), '')
    return out
  }

  // ---- copies the library side takes out through storage ----

  /** Makes the folders a staged file at `path` goes into. */
  prepare(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
  }

  /** The fingerprint of a staged copy, as storage computes it for the content: a directory's marker left out. */
  fingerprintOf(staged: Staged): Fingerprint {
    if (!staged.dir) return sha256(readFileSync(staged.path))
    const files = readdirSync(staged.path, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(staged.path.length + 1).split(sep).join('/'))
      .filter((p) => p !== BUNDLE_MARKER)
      .sort(byBytes)
    return sha256(files.map((p) => `${p}\0${sha256(readFileSync(join(staged.path, ...p.split('/'))))}\n`).join(''))
  }

  /** Gives a staged directory the marker that makes it one thing. */
  mark(staged: Staged): void {
    mkdirSync(staged.path, { recursive: true })
    writeFileSync(join(staged.path, BUNDLE_MARKER), MARKER_TEXT)
  }

  discard(staged: Staged): void {
    rmSync(staged.path, { recursive: true, force: true })
  }

  // ---- facts ----

  private streamDir(place: string, library: string) {
    return join(this.sync, 'facts', place, library)
  }

  /** The record places whose facts are in the target. */
  factPlaces(): string[] {
    return names(join(this.sync, 'facts')).filter(isPlaceName)
  }

  /** The libraries that wrote facts of `place`. */
  streams(place: string): string[] {
    return names(join(this.sync, 'facts', place)).filter((n) => SAFE_NAME.test(n))
  }

  /** The files of one library's stream, in the order it wrote them. */
  streamFiles(place: string, library: string): string[] {
    return names(this.streamDir(place, library)).filter((n) => STREAM_FILE.test(n)).sort()
  }

  /** The facts of one file of a stream; a line that is not a JSON object is left out. */
  readStream(place: string, library: string, file: string): unknown[] {
    return readFileSync(join(this.streamDir(place, library), file), 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (line.trim() === '') return []
        try {
          const fact: unknown = JSON.parse(line)
          return typeof fact === 'object' && fact !== null && !Array.isArray(fact) ? [fact] : []
        } catch {
          return []
        }
      })
  }

  /** Where one file of a stream is: a facts file a library carries in whole. */
  streamPath(place: string, library: string, file: string): string {
    return join(this.streamDir(place, library), file)
  }

  /**
   * The name a stream file is carried in under, `<YYYY-MM-DD>/<moment>-<library>-<number>.jsonl`:
   * the moment it was written here (UTC), the library that wrote it and its number in that stream,
   * the same each time it is asked.
   */
  carriedName(place: string, library: string, file: string): string {
    const at = new Date(lstatSync(this.streamPath(place, library, file)).mtimeMs).toISOString()
    return `${at.slice(0, 10)}/${at.replace(/\D/g, '').slice(0, 17)}-${library}-${file.slice(0, 10)}.jsonl`
  }

  /** Writes the facts as the next file of this library's stream, never replacing one. */
  writeStream(place: string, library: string, facts: readonly unknown[]): void {
    const dir = this.streamDir(place, library)
    mkdirSync(dir, { recursive: true })
    const tmp = this.scratch()
    writeFileSync(tmp, facts.map((f) => `${JSON.stringify(f)}\n`).join(''))
    try {
      const last = this.streamFiles(place, library).at(-1)
      for (let seq = last === undefined ? 1 : Number(last.slice(0, 10)) + 1; ; seq++) {
        try {
          linkSync(tmp, join(dir, `${String(seq).padStart(10, '0')}.jsonl`))
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    } finally {
      unlinkSync(tmp)
    }
  }
}


/** Whether `path` is a directory on this machine: a target on a disk that is not mounted is not. */
export const isDirectory = (path: string) => seenAt(path)?.kind === 'dir'

/** Makes the directory a target is set to and answers its real path; or why it cannot be made. */
export function makeTarget(path: string): { path: string } | { error: string } {
  try {
    mkdirSync(path, { recursive: true })
    return { path: realpathSync(path) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
