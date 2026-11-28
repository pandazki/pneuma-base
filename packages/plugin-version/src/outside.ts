// The one place this plugin touches files itself: outside the library, where a version is exported
// to (a destination the owner names, or a temporary folder a restore puts back from). Each file comes
// out of the plugin's own place through storage (`read` with `to`) and is checked against its sha256.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { isFailure, type Fingerprint, type Place, type PluginContext } from '@pneuma-base/kernel'
import { objectPlace, treePlace, type Version } from './model.js'

const exists = async (path: string) => (await stat(path).catch(() => null)) !== null

async function hashFile(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') as Fingerprint
}

/** Where an export to `to` lands: `to` itself, or the thing's name under it when it is a directory, as cp does; `taken` when something is there already. */
export async function exportTarget(cwd: string, to: string, thingPath: string): Promise<{ target: string; taken: boolean }> {
  let target = resolve(cwd, to)
  if ((await stat(target).catch(() => null))?.isDirectory()) target = join(target, posix.basename(thingPath))
  return { target, taken: await exists(target) }
}

/** Copies one file of the own place to `to`, checked against its sha256. */
async function copyOut(ctx: PluginContext, place: Place, fingerprint: Fingerprint, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  const read = await ctx.tools.storage.own.read(place, { to })
  if (isFailure(read) || (await hashFile(to)) !== fingerprint) throw new Error(`存储中的内容 ${fingerprint.slice(0, 8)} 已损坏`)
}

/** How many files one page of a tree's manifest lists; a thing has at most 5000. */
const MANIFEST_PAGE = 10000

/** Copies each file of a tree in the own place under `to`, a page of its manifest at a time. */
async function treeOut(ctx: PluginContext, v: Version, to: string): Promise<void> {
  const tree = treePlace(v.fingerprint)
  await mkdir(to, { recursive: true })
  for (let after: string | undefined; ; ) {
    const page = await ctx.tools.storage.own.content(tree, { manifest: { limit: MANIFEST_PAGE, ...(after === undefined ? {} : { after }) } })
    if (isFailure(page) || page.kind !== 'dir' || page.fingerprint !== v.fingerprint) throw new Error(`存储中的内容 ${v.fingerprint.slice(0, 8)} 已损坏`)
    for (const e of page.manifest?.entries ?? []) await copyOut(ctx, posix.join(tree, e.path), e.fingerprint, join(to, e.path))
    const more = page.manifest?.more ?? null
    if (more === null) return
    after = more.after
  }
}

/**
 * Writes a version's content to `target`, which must not exist: the file, or a directory of the
 * thing's files without the marker. Written under a temporary name beside it, then renamed into place.
 */
export async function writeOut(ctx: PluginContext, v: Version, target: string): Promise<void> {
  const tmp = join(dirname(target), `.tmp-${randomBytes(6).toString('hex')}`)
  await mkdir(dirname(target), { recursive: true })
  try {
    if (v.kept.kind === 'file') await copyOut(ctx, objectPlace(v.fingerprint), v.fingerprint, tmp)
    else if (v.kept.kind === 'tree') await treeOut(ctx, v, tmp)
    else {
      await mkdir(tmp)
      for (const row of v.kept.rows) await copyOut(ctx, objectPlace(row.fingerprint), row.fingerprint, join(tmp, row.path))
    }
    await rename(tmp, target)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Runs `work` with a new folder in the system's temporary directory, removed afterwards. */
export async function inScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pneuma-base-version-'))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
