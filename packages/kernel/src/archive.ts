import { mayWrite } from './access.js'
import { archivedPath, originalPath, parseLibraryPath, regionOf, withSuffix } from './paths.js'
import { eachPlugin, notesOf } from './pipeline.js'
import { storageOf, type Storage } from './storage.js'
import { enclosingBundle, fingerprintOf, whatIs, type At } from './things.js'
import { isFailure, type ArchiveRefusal, type ArchiveRequest, type ArchiveResult, type Context, type LibraryPath } from '@pneuma-base/sdk'

/** Where a path's thing is: in neither area, only the main area, only `_archive/`, or both. */
type ArchiveState = 'missing' | 'main' | 'archived' | 'both'
type ArchiveAction = 'move-in' | 'move-out' | 'stay' | { refuse: ArchiveRefusal }

/**
 * ARCHITECTURE "归档". "已在归档区" splits into `archived` (original path free) and `both`
 * (original path taken). Archiving with both present moves the main thing in, as from `main`.
 * A thing is a file or a bundle. For unarchive the original path is taken by anything there, a
 * directory without the marker included. Each move is storage's, with what it expects at both ends.
 */
export const ARCHIVE_TABLE = {
  archive: { missing: { refuse: 'no-such-file' }, main: 'move-in', archived: 'stay', both: 'move-in' },
  unarchive: { missing: { refuse: 'no-such-file' }, main: 'stay', archived: 'move-out', both: { refuse: 'original-path-taken' } },
} as const satisfies Record<ArchiveRequest['kind'], Record<ArchiveState, ArchiveAction>>

const isThing = (at: At) => at.kind === 'file' || at.kind === 'bundle'
const HOLD_MS = 120_000

export async function archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult> {
  const { root } = ctx.library
  const store = storageOf(root)
  const refused = (reason: ArchiveRefusal, subject = req.path): ArchiveResult => ({ outcome: 'refused', reason, subject, problems: [] })
  const original = originalOf(root, req.path)
  if (original === null) return refused('outside-library')
  if (!mayWrite(ctx, original)) return refused('outside-grant')
  const inArchive = archivedPath(original)
  const bundle = (await enclosingBundle(store, original)) ?? (await enclosingBundle(store, inArchive))
  if (bundle !== null) return refused('inside-bundle', bundle)

  const [atMain, atArchive] = (await whatIs(store, [original, inArchive])) as [At, At]
  if (atMain.failed === 'noise') return refused('noise')
  const main = req.kind === 'archive' ? isThing(atMain) : atMain.kind !== 'none'
  const archived = isThing(atArchive)
  const state: ArchiveState = main ? (archived ? 'both' : 'main') : archived ? 'archived' : 'missing'
  const action: ArchiveAction = ARCHIVE_TABLE[req.kind][state]
  if (typeof action === 'object') return refused(action.refuse)

  let from: LibraryPath
  let to: LibraryPath
  let hold: string | null = null
  try {
    if (action === 'stay') {
      from = original
      to = req.kind === 'archive' ? inArchive : original
    } else {
      const source = action === 'move-in' ? atMain : atArchive
      from = action === 'move-in' ? original : inArchive
      const slot = action === 'move-in' ? await archiveSlot(store, atMain, atArchive) : { to: original, expect: 'empty' }
      if (slot === null) return refused('busy')
      to = slot.to
      const held = await store.hold([from, to], HOLD_MS)
      if (isFailure(held)) return refused('busy')
      hold = held.hold
      const moved = await store.move(from, to, { from: source.entry?.token ?? '', to: slot.expect }, { hold })
      if (isFailure(moved)) return refused(moved.reason === 'noise' ? 'noise' : moved.reason === 'refused' && action === 'move-out' ? 'original-path-taken' : 'busy')
    }
    const moved = action !== 'stay'
    const heard = notesOf(await eachPlugin(ctx, (plugin, pctx) => plugin.onArchive?.({ kind: req.kind, from, to, moved }, pctx)))
    return { outcome: 'accepted', from, to, moved, notes: heard.notes, problems: heard.problems }
  } finally {
    if (hold !== null) await store.release(hold).catch(() => undefined)
  }
}

/** The original path a caller means, whether written as `a.md` or `_archive/a.md`; null when it is no content path. */
function originalOf(root: string, input: string): LibraryPath | null {
  const path = parseLibraryPath(root, input)
  if (path === null) return null
  const region = regionOf(path)
  if (region === 'kernel') return null
  if (region === 'content') return path
  const original = originalPath(path)
  return original !== null && regionOf(original) === 'content' ? original : null
}

/**
 * Where a thing goes in `_archive/`, and what the move expects there: its own path when free, or over
 * the same content there (the content of both read only then, to decide); otherwise the name with the
 * first eight of the newcomer's fingerprint, never over anything else. Null when nothing fits.
 */
async function archiveSlot(store: Storage, main: At, there: At): Promise<{ to: LibraryPath; expect: string } | null> {
  const first = archivedPath(main.path)
  if (there.kind === 'none' && there.failed === undefined) return { to: first, expect: 'empty' }
  const print = await fingerprintOf(store, main.path, main.kind)
  if (print === null) return null
  if (there.kind === main.kind && there.entry !== null && (await fingerprintOf(store, first, there.kind))?.fingerprint === print.fingerprint) return { to: first, expect: there.entry.token ?? '' }
  for (const slot of [withSuffix(first, print.fingerprint.slice(0, 8)), withSuffix(first, print.fingerprint)]) {
    const at = (await whatIs(store, [slot]))[0] as At
    if (at.kind === 'none' && at.failed === undefined) return { to: slot, expect: 'empty' }
    if (at.kind === main.kind && at.entry !== null && (await fingerprintOf(store, slot, at.kind))?.fingerprint === print.fingerprint) return { to: slot, expect: at.entry.token ?? '' }
  }
  return null
}
