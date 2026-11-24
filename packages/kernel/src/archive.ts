import { mayWrite } from './access.js'
import { fingerprintOfFile, moveInto, regularFile } from './files.js'
import { abs, archivedPath, originalPath, parseLibraryPath, regionOf, withSuffix } from './paths.js'
import { eachPlugin } from './pipeline.js'
import type { ArchiveRefusal, ArchiveRequest, ArchiveResult, Context, LibraryPath } from './types.js'

/** Where a path's file is: in neither area, only the main area, only `_archive/`, or both. */
type ArchiveState = 'missing' | 'main' | 'archived' | 'both'
type ArchiveAction = 'move-in' | 'move-out' | 'stay' | { refuse: ArchiveRefusal }

/**
 * ARCHITECTURE "归档". "已在归档区" splits into `archived` (original path free) and `both`
 * (original path taken). Archiving with both present moves the main file in, as from `main`.
 */
export const ARCHIVE_TABLE = {
  archive: { missing: { refuse: 'no-such-file' }, main: 'move-in', archived: 'stay', both: 'move-in' },
  unarchive: { missing: { refuse: 'no-such-file' }, main: 'stay', archived: 'move-out', both: { refuse: 'original-path-taken' } },
} as const satisfies Record<ArchiveRequest['kind'], Record<ArchiveState, ArchiveAction>>

export async function archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult> {
  const { root } = ctx.library
  const refused = (reason: ArchiveRefusal): ArchiveResult => ({ outcome: 'refused', reason, subject: req.path, problems: [] })
  const original = originalOf(root, req.path)
  if (original === null) return refused('outside-library')
  if (!mayWrite(ctx, original)) return refused('outside-grant')

  const inArchive = archivedPath(original)
  const main = (await regularFile(abs(root, original))) !== null
  const archived = (await regularFile(abs(root, inArchive))) !== null
  const state: ArchiveState = main ? (archived ? 'both' : 'main') : archived ? 'archived' : 'missing'
  const action: ArchiveAction = ARCHIVE_TABLE[req.kind][state]
  if (typeof action === 'object') return refused(action.refuse)

  let from: LibraryPath
  let to: LibraryPath
  if (action === 'move-in') {
    from = original
    to = await archiveSlot(root, original)
    await moveInto(abs(root, from), abs(root, to))
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
 * Where `original` goes in `_archive/`: its own path when free or holding the same content;
 * otherwise the name with the first eight of the newcomer's fingerprint, never over different content.
 */
async function archiveSlot(root: string, original: LibraryPath): Promise<LibraryPath> {
  const fingerprint = await fingerprintOfFile(abs(root, original))
  for (const slot of [archivedPath(original), withSuffix(archivedPath(original), fingerprint.slice(0, 8)), withSuffix(archivedPath(original), fingerprint)]) {
    const there = abs(root, slot)
    if (!(await regularFile(there)) || (await fingerprintOfFile(there)) === fingerprint) return slot
  }
  throw new Error(`no free place in _archive/ for ${original}`)
}
