import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path'
import type { LibraryPath, Region } from '@pneuma-base/sdk'

export const KERNEL_DIR = '.pneuma-base'
export const ARCHIVE_DIR = '_archive'
export const DESCRIPTION_FILE = 'PNEUMA-BASE.md'

/**
 * Parses what a caller wrote into a library path: relative to the library root, or absolute and
 * inside it. Null when it names the root itself or anything outside. Like every listing of the
 * library, it follows no symbolic link inside the library: only the links on the way to the root.
 */
export function parseLibraryPath(root: string, input: string): LibraryPath | null {
  if (input.trim() === '') return null
  let rel = input
  if (isAbsolute(input)) {
    rel = relative(root, belowRoot(root, normalize(input)))
    if (isAbsolute(rel)) return null
    rel = rel.split(sep).join('/')
  }
  const normalized = posix.normalize(rel).replace(/\/+$/, '')
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null
  }
  return normalized as LibraryPath
}

export function regionOf(path: LibraryPath): Region {
  const slash = path.indexOf('/')
  const first = slash === -1 ? path : path.slice(0, slash)
  if (first === KERNEL_DIR || path === DESCRIPTION_FILE) return 'kernel'
  if (first === ARCHIVE_DIR) return 'archive'
  return 'content'
}

export function archivedPath(path: LibraryPath): LibraryPath {
  return `${ARCHIVE_DIR}/${path}` as LibraryPath
}

/** The original path of something under `_archive/`, or null for `_archive` itself. */
export function originalPath(path: LibraryPath): LibraryPath | null {
  const rest = path.slice(ARCHIVE_DIR.length + 1)
  return rest === '' ? null : (rest as LibraryPath)
}

/** `a/b.md` with suffix `1a2b3c4d` becomes `a/b.1a2b3c4d.md`. */
export function withSuffix(path: LibraryPath, suffix: string): LibraryPath {
  const name = posix.basename(path)
  const dot = name.lastIndexOf('.')
  const renamed = dot > 0 ? `${name.slice(0, dot)}.${suffix}${name.slice(dot)}` : `${name}.${suffix}`
  const dir = posix.dirname(path)
  return (dir === '.' ? renamed : `${dir}/${renamed}`) as LibraryPath
}

export function isWithin(path: LibraryPath, area: LibraryPath): boolean {
  return path === area || path.startsWith(`${area}/`)
}

/**
 * A directory as people read it: the home directory as ~, and when longer than `max` characters,
 * only its last `max - 3` after …. Text answers use the default; a narrow place in the UI, less.
 */
export function shortDir(dir: string, max = 48, home = homedir()): string {
  const tilde = dir === home ? '~' : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
  const chars = [...tilde]
  return chars.length > max ? `…${chars.slice(-(max - 3)).join('')}` : tilde
}

/**
 * `path` with the part up to the library root resolved, when an ancestor of it is the root by its
 * real path, and the rest as written; else the real path of `path`, for one that reaches the
 * library only through a link outside it.
 */
function belowRoot(root: string, path: string): string {
  if (path === root || path.startsWith(`${root}${sep}`)) return path
  const rest: string[] = []
  for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
    if (canonical(dir) === root) return join(root, ...rest)
    rest.unshift(basename(dir))
  }
  return canonical(path)
}

/** The real path of `path`, resolving symbolic links in the part of it that exists. */
export function canonical(path: string): string {
  const rest: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      rest.unshift(basename(current))
      current = parent
    }
  }
}
