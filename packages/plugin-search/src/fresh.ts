// Whether the index is up to date with the library: one decision from what is on disk and what the
// index recorded. Pure.
import type { LibraryPath } from '@pneuma-base/kernel'

/**
 * One file as the index keys it: a thing's library path, and for a file inside a bundle its path
 * inside the bundle (`inner`), else ''. Size and modification time say whether it changed.
 */
export type Stamp = { path: LibraryPath; inner: string; size: number; modifiedAt: string }
export type FileKey = Pick<Stamp, 'path' | 'inner'>

/** What to read again and what to forget; files whose size and time match are not read. */
type Refresh = { read: Stamp[]; drop: FileKey[] }

const keyOf = (s: FileKey) => `${s.path}\0${s.inner}`

/**
 * | on disk | in the index | same size and time | do       |
 * | yes     | no           |                    | read     |
 * | yes     | yes          | yes                | nothing  |
 * | yes     | yes          | no                 | read     |
 * | no      | yes          |                    | drop     |
 */
export function freshness(disk: readonly Stamp[], indexed: readonly Stamp[]): Refresh {
  const known = new Map(indexed.map((s) => [keyOf(s), s]))
  const present = new Set(disk.map(keyOf))
  return {
    read: disk.filter((s) => {
      const was = known.get(keyOf(s))
      return was === undefined || was.size !== s.size || was.modifiedAt !== s.modifiedAt
    }),
    drop: indexed.filter((s) => !present.has(keyOf(s))).map(({ path, inner }) => ({ path, inner })),
  }
}
