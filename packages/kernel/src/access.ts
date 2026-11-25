import { isWithin, parseLibraryPath, regionOf } from './paths.js'
import type { Context, LibraryPath } from '@pneuma-base/sdk'

export type Writable = { ok: true; path: LibraryPath } | { ok: false; reason: 'outside-library' | 'outside-grant' }

/**
 * The gate for agent-face writes. A path must lie in the library's content (not the kernel's files,
 * not the archive) and inside the caller's grant: its area, and not read-only. A call without a
 * grant may write the whole library.
 */
export function writableContent(ctx: Context, input: string): Writable {
  const path = parseLibraryPath(ctx.library.root, input)
  if (path === null || regionOf(path) !== 'content') return { ok: false, reason: 'outside-library' }
  return mayWrite(ctx, path) ? { ok: true, path } : { ok: false, reason: 'outside-grant' }
}

export function mayWrite(ctx: Context, path: LibraryPath): boolean {
  const { actor } = ctx
  if (actor.kind !== 'agent' || actor.grant === null) return true
  const grant = ctx.library.config.grants.find((g) => g.id === actor.grant)
  if (!grant || grant.readOnly) return false
  return grant.area === null || isWithin(path, grant.area)
}
