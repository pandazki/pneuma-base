// The ledger's reads of the disk: the facts, the files of the library, what an input names.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { abs, archivedPath, bundleFiles, fingerprintOf, libraryFiles, parseLibraryPath, regionOf, thingAt, type Fingerprint, type LibraryPath, type PluginContext } from '@pneuma-base/kernel'
import { readFacts, type ItemId } from './facts.js'
import { fold, type ItemRecord, type Ledger } from './fold.js'
import { classify, confirm, findsAnything, reconcile, unownedOf, type Files, type ItemState, type Standing } from './reconcile.js'

const TEXT_LIMIT = 1024 * 1024

export async function load(ctx: PluginContext): Promise<Ledger> {
  return fold(await readFacts(ctx.dir))
}

export type Disk = { fingerprint: Fingerprint; size: number; bundle: boolean }

/** The fingerprint and size of the thing at `path`, a file or a bundle; null when there is none. */
export async function onDisk(root: string, path: LibraryPath): Promise<Disk | null> {
  const file = abs(root, path)
  const thing = await thingAt(file)
  return thing ? { fingerprint: await fingerprintOf(file), size: thing.size, bundle: thing.kind === 'bundle' } : null
}

async function decodeUtf8(file: string): Promise<string> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
    return text.includes('\u0000') ? '' : text
  } catch {
    return ''
  }
}

/**
 * The thing's text for find: a file's content when it is UTF-8 and at most 1 MB; for a bundle the
 * relative path of every file in it, and the text of its files, smallest first, until 1 MB has been
 * read. Every file read counts, text or not: a site's text is small beside its images, and a find
 * reads no more than the limit of any one thing.
 */
export async function textOf(root: string, path: LibraryPath): Promise<string> {
  const file = abs(root, path)
  const thing = await thingAt(file)
  if (!thing) return ''
  if (thing.kind === 'file') return thing.size > TEXT_LIMIT ? '' : decodeUtf8(file)
  const inner = await bundleFiles(file)
  const parts = inner.map((f) => f.path)
  let budget = TEXT_LIMIT
  for (const f of [...inner].sort((a, b) => a.size - b.size)) {
    if (f.size > budget) break
    budget -= f.size
    const text = await decodeUtf8(join(file, f.path))
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** The library's things outside the kernel's own, with sizes; fingerprints taken once each, on demand. */
export async function snapshot(root: string): Promise<Files> {
  const sizes = new Map<LibraryPath, number>()
  for (const path of await libraryFiles(root)) {
    const thing = await thingAt(abs(root, path))
    if (thing) sizes.set(path, thing.size)
  }
  const prints = new Map<LibraryPath, Promise<Fingerprint | null>>()
  const fingerprint = (path: LibraryPath) => {
    const known = prints.get(path) ?? onDisk(root, path).then((disk) => disk?.fingerprint ?? null)
    prints.set(path, known)
    return known
  }
  return { sizes, fingerprint }
}

/** Each item's state from its own file only; no search for moved files. */
export async function statesOf(root: string, ledger: Ledger, ids: ItemId[]): Promise<Map<ItemId, ItemState>> {
  const states = new Map<ItemId, ItemState>()
  for (const id of ids) {
    const item = ledger.items.get(id)
    if (item) states.set(id, classify(item, item.removed ? null : ((await onDisk(root, item.path))?.fingerprint ?? null), null))
  }
  return states
}

/** The item an input names: its id, its path, or the path it had before it was archived. */
export function itemNamed(ledger: Ledger, root: string, input: string): ItemRecord | undefined {
  const byId = ledger.items.get(input as ItemId)
  if (byId) return byId
  const path = parseLibraryPath(root, input)
  if (path === null) return undefined
  const id = ledger.pathIndex.get(path) ?? (regionOf(path) === 'content' ? ledger.pathIndex.get(archivedPath(path)) : undefined)
  return id === undefined ? undefined : ledger.items.get(id)
}

/**
 * check's reconciliation. A put lands its file before its record, so whatever the first look finds is
 * confirmed: against the paths being put, read after the files were looked at, and the facts read
 * once more after that.
 */
export async function standingNow(ctx: PluginContext): Promise<{ ledger: Ledger; standing: Standing }> {
  const ledger = await load(ctx)
  const standing = await reconcile(ledger, await snapshot(ctx.library.root))
  if (!findsAnything(standing)) return { ledger, standing }
  const putting = new Set(await ctx.tools.putting())
  return { ledger, standing: confirm(ledger, standing, await load(ctx), putting) }
}


/**
 * The things nobody registered, as check would find them but without the fingerprint of every item:
 * a path being put now, and one a fact read after the files were looked at gave an item, are left out.
 */
export async function unownedNow(ctx: PluginContext): Promise<{ ledger: Ledger; unowned: LibraryPath[] }> {
  const ledger = await load(ctx)
  const found = await unownedOf(ledger, await snapshot(ctx.library.root))
  if (found.length === 0) return { ledger, unowned: found }
  const putting = new Set(await ctx.tools.putting())
  const later = await load(ctx)
  return { ledger, unowned: found.filter((path) => !putting.has(path) && !later.pathIndex.has(path)) }
}
