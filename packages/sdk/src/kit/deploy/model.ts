// The deploy kit's one decision and what follows from it, as pure functions. README.md "一个决定",
// "状态" and "状态 × 操作": every operation changes one of the three inputs to `want`, then the
// reconciler runs `plan` for the affected thing. test/kit-model.test.ts runs the table cell by cell.
import { createHash } from 'node:crypto'
import type { LibraryPath } from '../../types.js'

/** A site's name on the target: derived from the library path, unchanged by content changes. */
export type SiteName = string & { readonly __brand: 'SiteName' }
/** What identifies a site's content: the kernel fingerprint, or the target's own id. */
export type ContentId = string & { readonly __brand: 'ContentId' }

/**
 * What the library says about a declared thing now. `content` is the id of what is at its path; null
 * when nothing is there, or when it cannot matter because the switch is off or the thing is archived.
 */
export type Standing = { on: boolean; archived: boolean; content: ContentId | null }

/** What the target should hold for a thing: its current content under its site name, or nothing. */
type Want = { site: SiteName; content: ContentId } | null

/** What the target holds for one thing, by site name. */
export type Held = ReadonlyMap<SiteName, ContentId>

export type Step = { kind: 'publish'; site: SiteName; content: ContentId } | { kind: 'unpublish'; site: SiteName }

/** The decision: on, not archived and present means online with the current content under `site`; anything else means nothing on the target. */
export function want(site: SiteName | null, s: Standing): Want {
  return s.on && !s.archived && s.content !== null && site !== null ? { site, content: s.content } : null
}

/**
 * The steps that make the target hold what is wanted: publish the wanted content when the target
 * lacks it, then take down the thing's other sites. Publishing comes first so a moved site is never
 * offline in between; the reconciler stops at the first failed step. Empty when the target already
 * matches, so running it again changes nothing.
 */
export function plan(w: Want, held: Held): Step[] {
  const publish: Step[] = w !== null && held.get(w.site) !== w.content ? [{ kind: 'publish', site: w.site, content: w.content }] : []
  const stale = [...held.keys()].filter((site) => site !== w?.site).sort()
  return [...publish, ...stale.map((site): Step => ({ kind: 'unpublish', site }))]
}

/** 在线, 待发布, 离线, 待下线, 已归档, 不在. */
export type State = 'online' | 'pending' | 'offline' | 'retiring' | 'archived' | 'missing'

/** Settled: named by why the target holds what it holds. Not settled: pending when something should be online, retiring when nothing should. */
export function statusOf(site: SiteName | null, s: Standing, held: Held): State {
  const w = want(site, s)
  if (plan(w, held).length > 0) return w === null ? 'retiring' : 'pending'
  if (s.archived) return 'archived'
  if (!s.on) return 'offline'
  return s.content === null ? 'missing' : 'online'
}

/** A path that is already lower-case letters and digits joined by single dashes and slashes. */
const CLEAN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/
const MAX_NAME = 58

/**
 * The default site name: the path lower-cased with each run of other characters as one dash. A path
 * the slug renders faithfully keeps it as it is; any other gets six characters of the path's sha256,
 * so two paths that differ only in case or in non-Latin characters do not share a name. At most 58
 * characters, always a DNS label.
 */
export function siteName(path: LibraryPath): SiteName {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (CLEAN.test(path) && slug.length <= MAX_NAME) return slug as SiteName
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 6)
  return `${(slug || 'site').slice(0, MAX_NAME - 7).replace(/-+$/, '')}-${hash}` as SiteName
}
