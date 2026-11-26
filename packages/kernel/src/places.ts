// The three kinds of directory, derived from the records and stored nowhere (tmp/run-7 architecture.md
// section 4): open, when it holds something registered at some depth (the root always is); a thing,
// when the whole directory is registered as one; closed otherwise, one entry of the level above that
// nothing goes into. Storage is looked at only where these say.
import { createHash } from 'node:crypto'
import { eachPlugin } from './pipeline.js'
import { learn, recentChanges } from './changes.js'
import { storageOf, type Storage } from './storage.js'
import { DESCRIPTION_FILE, KERNEL_DIR, ARCHIVE_DIR } from './paths.js'
import { isDescribed, type Context, type LibraryPath, type Place } from '@pneuma-base/sdk'

export type DirKind = 'open' | 'thing' | 'closed'

/** What the records say is registered: each place, and whether it is a directory registered as one thing. */
export type Registered = { open: ReadonlySet<Place>; things: ReadonlySet<Place> }

/** The directories above `path`, the root (`''`) first and its parent last. */
export function dirsAbove(path: LibraryPath | Place): Place[] {
  const parts = path.split('/')
  const out: Place[] = ['']
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** The open directories of these registered places: the root and every directory above one of them. */
export function openDirsOf(places: Iterable<LibraryPath | Place>): Set<Place> {
  const open = new Set<Place>([''])
  for (const path of places) for (const dir of dirsAbove(path)) open.add(dir)
  return open
}

export function dirKind(dir: Place, registered: Registered): DirKind {
  if (dir === '' || registered.open.has(dir)) return 'open'
  return registered.things.has(dir) ? 'thing' : 'closed'
}

/** The kernel's own names at the root, which no listing of the content mentions as anything. */
export const KERNEL_ENTRIES: ReadonlySet<string> = new Set([KERNEL_DIR, DESCRIPTION_FILE, ARCHIVE_DIR])

/** The place of an entry of the directory `dir`. */
export const placeIn = (dir: Place, name: string): Place => (dir === '' ? name : `${dir}/${name}`)

/** The open directories every plugin's records make, and the root: where the management UI's change poll looks. */
export async function openDirectories(ctx: Context): Promise<Place[]> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.openDirs?.(pctx))
  return [...new Set<Place>(['', ...heard.values.flatMap(({ value }) => value)])].sort()
}

/** How many of the newest asks the page's stamp looks back over for a change it shows, and how many changed places it glances at. */
const STAMP_WINDOW = 64
const STAMP_GLANCES = 200

/**
 * A short stamp that changes when the management UI's page has something new to show: where each
 * plugin's facts end now, the tokens of the open directories (an entry come or gone), and the newest
 * change the kernel's cursor learned to a file in an open directory's level. A change in a directory
 * nobody looked into, or inside a thing, does not move it. Never a walk.
 */
export async function changeStamp(ctx: Context): Promise<string> {
  const store = storageOf(ctx.library.root)
  const ends = await Promise.all(ctx.library.plugins.map(async (p) => (await store.records(p.name).since(null, 0))?.cursor ?? ''))
  const open = await openDirectories(ctx)
  const tokens = (await store.glance(open)).map((g) => `${g.place}\0${isDescribed(g) ? (g.token ?? g.kind) : g.reason}`)
  const { seq, sure } = await learn(store)
  const newest = sure ? await newestShown(store, seq, new Set(open)) : null
  return createHash('sha1').update([...ends, ...tokens, ...(newest === null ? [] : [`changes ${newest}`])].join('\n')).digest('hex').slice(0, 16)
}

/** The newest ask that learned of a file in an open directory's level changing; null when none of the recent ones did. */
async function newestShown(store: Storage, seq: number, open: ReadonlySet<Place>): Promise<number | null> {
  let glances = 0
  for (const { seq: s, places } of await recentChanges(store, seq, STAMP_WINDOW)) {
    if (places === null) continue
    const near = places.filter((p) => open.has(parentOf(p)) && !open.has(p))
    if (near.length === 0) continue
    glances += near.length
    if (glances > STAMP_GLANCES) return s
    if ((await store.glance(near)).some((g) => !isDescribed(g) || g.kind !== 'dir')) return s
  }
  return null
}

const parentOf = (place: Place): Place => (place.includes('/') ? place.slice(0, place.lastIndexOf('/')) : '')
