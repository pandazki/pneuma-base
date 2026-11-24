// The ledger's reads of the disk: the facts, the files of the library, what an input names.
import { readFile, stat } from 'node:fs/promises'
import { abs, archivedPath, fingerprintOfFile, libraryFiles, parseLibraryPath, regionOf, type Fingerprint, type LibraryPath, type PluginContext } from '@pneuma-base/kernel'
import { readFacts, type ItemId } from './facts.js'
import { fold, type ItemRecord, type Ledger } from './fold.js'
import { classify, type Files, type ItemState } from './reconcile.js'

const TEXT_LIMIT = 1024 * 1024

export async function load(ctx: PluginContext): Promise<Ledger> {
  return fold(await readFacts(ctx.dir))
}

export type Disk = { fingerprint: Fingerprint; size: number }

/** The fingerprint and size of the regular file at `path`; null when there is none. */
export async function onDisk(root: string, path: LibraryPath): Promise<Disk | null> {
  const file = abs(root, path)
  const s = await stat(file).catch(() => null)
  return s?.isFile() ? { fingerprint: await fingerprintOfFile(file), size: s.size } : null
}

/** The file's text when it is UTF-8 and at most 1 MB; otherwise empty. */
export async function textOf(root: string, path: LibraryPath): Promise<string> {
  const file = abs(root, path)
  const s = await stat(file).catch(() => null)
  if (!s?.isFile() || s.size > TEXT_LIMIT) return ''
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
    return text.includes('\u0000') ? '' : text
  } catch {
    return ''
  }
}

/** The library's files outside the kernel's own, with sizes; fingerprints taken once each, on demand. */
export async function snapshot(root: string): Promise<Files> {
  const sizes = new Map<LibraryPath, number>()
  for (const path of await libraryFiles(root)) {
    const s = await stat(abs(root, path)).catch(() => null)
    if (s?.isFile()) sizes.set(path, s.size)
  }
  const prints = new Map<LibraryPath, Promise<Fingerprint>>()
  const fingerprint = (path: LibraryPath) => {
    const known = prints.get(path) ?? fingerprintOfFile(abs(root, path))
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
