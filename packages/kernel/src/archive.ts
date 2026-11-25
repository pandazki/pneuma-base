import { mayWrite } from './access.js'
import { moveInto, replaceWith } from './files.js'
import { abs, archivedPath, originalPath, parseLibraryPath, regionOf, scratchDir, withSuffix } from './paths.js'
import { eachPlugin } from './pipeline.js'
import { enclosingBundle, fingerprintOf, kindAt } from './things.js'
import type { ArchiveRefusal, ArchiveRequest, ArchiveResult, Context, LibraryPath } from '@pneuma-base/sdk'

/** Where a path's thing is: in neither area, only the main area, only `_archive/`, or both. */
type ArchiveState = 'missing' | 'main' | 'archived' | 'both'
type ArchiveAction = 'move-in' | 'move-out' | 'stay' | { refuse: ArchiveRefusal }

/**
 * ARCHITECTURE "归档". "已在归档区" splits into `archived` (original path free) and `both`
 * (original path taken). Archiving with both present moves the main thing in, as from `main`.
 * A thing is a file or a bundle. For unarchive the original path is taken by anything there, a
 * directory without the marker included.
 */
export const ARCHIVE_TABLE = {
  archive: { missing: { refuse: 'no-such-file' }, main: 'move-in', archived: 'stay', both: 'move-in' },
  unarchive: { missing: { refuse: 'no-such-file' }, main: 'stay', archived: 'move-out', both: { refuse: 'original-path-taken' } },
} as const satisfies Record<ArchiveRequest['kind'], Record<ArchiveState, ArchiveAction>>

const isThing = (kind: Awaited<ReturnType<typeof kindAt>>) => kind === 'file' || kind === 'bundle'

export async function archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult> {
  const { root } = ctx.library
  const refused = (reason: ArchiveRefusal, subject = req.path): ArchiveResult => ({ outcome: 'refused', reason, subject, problems: [] })
  const original = originalOf(root, req.path)
  if (original === null) return refused('outside-library')
  if (!mayWrite(ctx, original)) return refused('outside-grant')
  const inArchive = archivedPath(original)
  const bundle = (await enclosingBundle(root, original)) ?? (await enclosingBundle(root, inArchive))
  if (bundle !== null) return refused('inside-bundle', bundle)

  const atMain = await kindAt(abs(root, original))
  const main = req.kind === 'archive' ? isThing(atMain) : atMain !== null
  const archived = isThing(await kindAt(abs(root, inArchive)))
  const state: ArchiveState = main ? (archived ? 'both' : 'main') : archived ? 'archived' : 'missing'
  const action: ArchiveAction = ARCHIVE_TABLE[req.kind][state]
  if (typeof action === 'object') return refused(action.refuse)

  let from: LibraryPath
  let to: LibraryPath
  if (action === 'move-in') {
    from = original
    to = await archiveSlot(root, original)
    await replaceWith(abs(root, from), abs(root, to), scratchDir(root))
  } else if (action === 'move-out') {
    from = inArchive
    to = original
    await moveInto(abs(root, from), abs(root, to))
  } else {
    from = original
    to = req.kind === 'archive' ? inArchive : original
  }
  const moved = action !== 'stay'
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onArchive?.({ kind: req.kind, from, to, moved }, pctx))
  return {
    outcome: 'accepted',
    from,
    to,
    moved,
    notes: heard.values.map(({ plugin, value }) => ({ ...value, plugin })),
    problems: heard.problems,
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
 * Where `original` goes in `_archive/`: its own path when free or holding the same thing;
 * otherwise the name with the first eight of the newcomer's fingerprint, never over anything else.
 */
async function archiveSlot(root: string, original: LibraryPath): Promise<LibraryPath> {
  const kind = await kindAt(abs(root, original))
  const fingerprint = await fingerprintOf(abs(root, original))
  for (const slot of [archivedPath(original), withSuffix(archivedPath(original), fingerprint.slice(0, 8)), withSuffix(archivedPath(original), fingerprint)]) {
    const there = abs(root, slot)
    const taken = await kindAt(there)
    if (taken === null || (taken === kind && (await fingerprintOf(there)) === fingerprint)) return slot
  }
  throw new Error(`no free place in _archive/ for ${original}`)
}
