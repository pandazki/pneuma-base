// The target as one side of a sync: the keys the library's rows and the baseline know, each looked at
// once (lstat) against the state the baseline kept; only one whose state differs, or that the baseline
// does not know, is hashed. Own content is the one part listed: other libraries' own files have no
// fact that names them.
import type { Fingerprint } from '@pneuma-base/kernel'
import type { BaseEntry } from './baseline.js'
import type { SideIO } from './execute.js'
import { ownOf, type Key } from './scope.js'
import type { Seen, TargetDir } from './target.js'

/** What the target held of each key looked at, by fingerprint, and the state each was in (null: nothing). */
export type TargetMap = { files: Map<Key, Fingerprint>; seen: Map<Key, Seen | null> }
export const targetMap = (): TargetMap => ({ files: new Map(), seen: new Map() })

function take(target: TargetDir, key: Key, seen: Seen | null, base: BaseEntry | undefined, map: TargetMap): void {
  map.seen.set(key, seen)
  if (seen === null) return
  map.files.set(key, base?.at === seen.at ? base.fp : target.fingerprint(key, seen.kind))
}

/** The things at `keys` in the target. */
export function targetThings(target: TargetDir, keys: Iterable<Key>, base: ReadonlyMap<Key, BaseEntry>, map: TargetMap): void {
  for (const key of keys) take(target, key, target.seen(key), base.get(key), map)
}

/** The own content of `place` in the target, its directories under `caches` left out, and the files of it the baseline knows. */
export function targetOwn(target: TargetDir, place: string, caches: readonly string[], base: ReadonlyMap<Key, BaseEntry>, map: TargetMap): void {
  const there = target.ownFiles(place, caches)
  for (const [key, at] of there) take(target, key, { kind: 'file', at }, base.get(key), map)
  for (const [key, entry] of base) if (ownOf(key)?.place === place && !there.has(key)) take(target, key, null, entry, map)
}

/** The target as a side the plan's steps use: what it writes and removes it first finds in the state the plan saw. */
export function targetSide(target: TargetDir, map: TargetMap): SideIO {
  const unchanged = (key: Key) => (target.seen(key)?.at ?? null) === (map.seen.get(key)?.at ?? null)
  const holds = (key: Key, fp: Fingerprint) => {
    const now = target.seen(key)
    return now !== null && target.fingerprint(key, now.kind) === fp
  }
  return {
    stage: async (key, fp) => target.stage(key, fp),
    async place(key, staged, fp) {
      if (unchanged(key)) target.put(key, staged)
      else if (!holds(key, fp)) return false
      map.seen.set(key, target.seen(key))
      return true
    },
    async remove(key, fp) {
      if (!unchanged(key) && !holds(key, fp)) return false
      target.remove(key)
      map.seen.set(key, null)
      return true
    },
  }
}
