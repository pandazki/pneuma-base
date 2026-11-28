// The versions' content, in the plugin's own place, addressed by content: a file at
// objects/<first two hex>/<sha256>, a directory thing whole at trees/<first two hex>/<fingerprint>, each
// written once, so the same content is stored once across versions and across things. A copy is one
// write from the thing's place into pending/, fingerprinted in the same pass, then moved to its address.
import { randomBytes } from 'node:crypto'
import { isDescribed, isFailure, type Fingerprint, type Instant, type LibraryPath, type Place, type PluginContext } from '@pneuma-base/kernel'
import { objectPlace, treePlace } from './model.js'

/** A copy of a thing's content in pending/, and what it is. */
export type Shot = { fingerprint: Fingerprint; kind: 'file' | 'tree'; bytes: number; files: number; pending: { place: Place; token: string } }

/** Copies the thing at `path` into pending/. Null when nothing is there; a failure when it could not be copied now. */
export async function snapshot(ctx: PluginContext, path: LibraryPath): Promise<Shot | null | { failed: string }> {
  const own = ctx.tools.storage.own
  const place = `pending/${randomBytes(8).toString('hex')}`
  const written = await own.write(place, { place: path }, 'empty')
  if (isFailure(written)) return written.side === 'from' && written.reason === 'no_such_place' ? null : { failed: written.reason }
  const kind = written.entry.kind === 'dir' ? 'tree' : 'file'
  return { fingerprint: written.fingerprint, kind, bytes: written.bytes, files: written.files ?? 1, pending: { place, token: written.entry.token ?? '' } }
}

export async function discard(ctx: PluginContext, shot: Shot): Promise<void> {
  await ctx.tools.storage.own.remove(shot.pending.place, shot.pending.token)
}

/** Moves the copy to its address; where the same content is stored already, drops the copy. */
export async function keep(ctx: PluginContext, shot: Shot): Promise<void> {
  const own = ctx.tools.storage.own
  const to = shot.kind === 'file' ? objectPlace(shot.fingerprint) : treePlace(shot.fingerprint)
  const moved = await own.move(shot.pending.place, to, { from: shot.pending.token, to: 'empty' })
  if (!isFailure(moved)) return
  const there = (moved.actual as { to?: { kind?: string } } | undefined)?.to?.kind
  if (moved.reason !== 'refused' || there === undefined || there === 'none') throw new Error(`无法将内容写入版本存储（${moved.reason}）`)
  await discard(ctx, shot)
}

/** How many places one glance asks about. */
const GLANCE = 500

/** What is at these places of the plugin's own place, each one present with its token. */
export async function present(ctx: PluginContext, places: readonly Place[]): Promise<Map<Place, string>> {
  const out = new Map<Place, string>()
  for (let i = 0; i < places.length; i += GLANCE) {
    for (const g of await ctx.tools.storage.own.glance(places.slice(i, i + GLANCE))) if (isDescribed(g) && g.kind !== 'none') out.set(g.place, g.token ?? '')
  }
  return out
}

/** Deletes the content at these places; how many it deleted. */
export async function drop(ctx: PluginContext, places: readonly Place[]): Promise<number> {
  let deleted = 0
  for (const [place, token] of await present(ctx, places)) if (!isFailure(await ctx.tools.storage.own.remove(place, token))) deleted++
  return deleted
}

/** A copy in pending/ older than this was left by a write that never finished. */
const ABANDONED_MS = 60 * 60 * 1000

/** Removes the copies in pending/ older than an hour at `now`, one page of it; how many it removed. */
export async function sweepPending(ctx: PluginContext, now: Instant): Promise<number> {
  const own = ctx.tools.storage.own
  const page = await own.overview('pending')
  if (isFailure(page)) return 0
  const before = Date.parse(now) - ABANDONED_MS
  let removed = 0
  for (const e of page.entries) {
    if (e.modified === undefined || Date.parse(e.modified) >= before) continue
    if (!isFailure(await own.remove(e.place, e.token ?? ''))) removed++
  }
  return removed
}

