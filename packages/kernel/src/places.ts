// The three kinds of directory, derived from the records and stored nowhere (ARCHITECTURE.md「目录的三种」):
// open, when it holds something registered at some depth (the root always is); a thing,
// when the whole directory is registered as one; closed otherwise, one entry of the level above that
// nothing goes into. Storage is looked at only where these say.
import { createHash } from 'node:crypto'
import { eachPlugin } from './pipeline.js'
import { changesSince } from './changes.js'
import { storageOf, type Storage } from './storage.js'
import { DESCRIPTION_FILE, KERNEL_DIR, ARCHIVE_DIR } from './paths.js'
import { isDescribed, type Context, type Library, type LibraryPath, type Place, type Probe } from '@pneuma-base/sdk'

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

/**
 * What a budgeted look into a directory found, in words: how many files, at least that many when the
 * look stopped at its budget, and whether it looks like a project, by the well-known names at its top.
 */
export function probeWords(p: Probe): string {
  const files = p.exceeded ? (p.files > 0 ? `至少 ${p.files} 个文件` : `至少 ${p.dirs} 个目录`) : p.files > 0 ? `${p.files} 个文件` : p.dirs > 0 ? `没有文件，${p.dirs} 个目录` : '空的'
  return p.markers.length === 0 ? files : `${files}，像一个项目（${p.markers.join('、')}）`
}

/** The kernel's own names at the root, which no listing of the content mentions as anything. */
export const KERNEL_ENTRIES: ReadonlySet<string> = new Set([KERNEL_DIR, DESCRIPTION_FILE, ARCHIVE_DIR])

/** The place of an entry of the directory `dir`. */
export const placeIn = (dir: Place, name: string): Place => (dir === '' ? name : `${dir}/${name}`)

/** The open directories every plugin's records make, and the root: where the management UI's change poll looks. */
/** Whether a plugin of the library keeps records of what is registered; without one no directory is opened by them, and folders are only folders. */
export const keepsRecords = (library: Library): boolean => library.plugins.some((p) => p.openDirs !== undefined)

export async function openDirectories(ctx: Context): Promise<Place[]> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.openDirs?.(pctx))
  return [...new Set<Place>(['', ...heard.values.flatMap(({ value }) => value)])].sort()
}

/** How many changed places in open directories' levels the page's stamp glances at before it just says something changed. */
const STAMP_GLANCES = 200

/**
 * Per library, the cursor the stamp last asked storage from, and the cursor of the newest change it
 * saw to a file in an open directory's level. Kept by the long-lived process that polls, which is
 * the one that listens, so its asks are answered from what the subscription recorded.
 */
const stamps = new Map<string, { mark: string; shown: string }>()

/**
 * A short stamp that changes when the management UI's page has something new to show: where each
 * plugin's facts end now, the tokens of the open directories (an entry come or gone), and the newest
 * change storage reported to a file in an open directory's level. A change in a directory nobody
 * looked into, or inside a thing, does not move it. Never a walk.
 */
export async function changeStamp(ctx: Context): Promise<string> {
  const store = storageOf(ctx.library.root)
  const ends = await Promise.all(ctx.library.plugins.map(async (p) => (await store.records(p.name).since(null, 0))?.cursor ?? ''))
  const open = await openDirectories(ctx)
  const tokens = (await store.glance(open)).map((g) => `${g.place}\0${isDescribed(g) ? (g.token ?? g.kind) : g.reason}`)
  const shown = await newestShown(store, ctx.library.root, new Set(open))
  return createHash('sha1').update([...ends, ...tokens, shown].join('\n')).digest('hex').slice(0, 16)
}

/** The cursor of the newest change to a file in an open directory's level the stamp has seen; when storage cannot say, the last one seen. */
async function newestShown(store: Storage, root: string, open: ReadonlySet<Place>): Promise<string> {
  const known = stamps.get(root)
  const { places, mark } = await changesSince(store, known?.mark ?? null)
  let shown = known?.shown ?? ''
  if (places !== null) {
    const near = places.filter((p) => open.has(parentOf(p)) && !open.has(p))
    if (near.length > STAMP_GLANCES || (near.length > 0 && (await store.glance(near)).some((g) => !isDescribed(g) || g.kind !== 'dir'))) shown = mark
  }
  stamps.set(root, { mark, shown })
  return shown
}

const parentOf = (place: Place): Place => (place.includes('/') ? place.slice(0, place.lastIndexOf('/')) : '')
