// What a sync carries, named by one kind of key: a registered thing by its library path, a file of a
// record place's own content by `.pneuma-base/<place>/<own place>`. Each key has one place in the
// library and one path in the target.
import { posix } from 'node:path'
import type { LibraryPath, Place, Plugin } from '@pneuma-base/kernel'

/** A thing's library path, or `.pneuma-base/<place>/<own place>` for a file of a record place's own content. */
export type Key = LibraryPath

/** The sync's own folder in a target: the target's id, its temporary files, the record places' facts and own content. */
export const TARGET_DIR = '.pneuma-sync'

const RECORDS = '.pneuma-base'

/** A record place's name as storage takes it, and not one of storage's own directories. */
const PLACE_NAME = /^[a-z0-9][a-z0-9-]*$/
const STORAGE_DIRS: ReadonlySet<string> = new Set(['cache', 'holds', 'tmp', 'trash'])
export const isPlaceName = (name: string) => PLACE_NAME.test(name) && !STORAGE_DIRS.has(name)

export const ownKey = (place: string, own: Place): Key => (own === '' ? `${RECORDS}/${place}` : `${RECORDS}/${place}/${own}`) as Key

/** The record place and own place a key names; null for a thing's key. */
export function ownOf(key: Key): { place: string; own: Place } | null {
  if (!key.startsWith(`${RECORDS}/`)) return null
  const rest = key.slice(RECORDS.length + 1)
  const slash = rest.indexOf('/')
  return slash === -1 ? { place: rest, own: '' } : { place: rest.slice(0, slash), own: rest.slice(slash + 1) }
}

/** Whether a registered thing's path is carried: anything in the content or the archive, not the target's own folder. */
export const carried = (path: LibraryPath) => !path.startsWith(`${RECORDS}/`) && path !== RECORDS && path.split('/')[0] !== TARGET_DIR

/**
 * The directories of a record place's own content that are not carried: those its plugin, when
 * installed here, declares as a cache. Relative to the place's own content.
 */
export const cacheDirsOf = (plugins: readonly Plugin[], place: string): string[] =>
  plugins.filter((p) => p.name === place).flatMap((p) => p.storage.filter((s) => s.kind === 'cache').map((s) => posix.normalize(s.dir)))

export const inCache = (own: Place, caches: readonly string[]) => caches.some((c) => own === c || own.startsWith(`${c}/`))
