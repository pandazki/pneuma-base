// A local directory as one side of a sync: the library itself, or the built-in `dir` target, which
// stands in for object storage.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fingerprintOfFile, type Fingerprint, type LibraryPath } from '@pneuma-base/kernel'
import type { SyncTarget } from './execute.js'
import { TARGET_DIR } from './scope.js'

/** The regular files under `root` that `keep` lets in, by path relative to it; symbolic links are not followed. */
export async function filesUnder(root: string, keep: (path: string) => boolean): Promise<LibraryPath[]> {
  const out: LibraryPath[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (!keep(path)) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path as LibraryPath)
    }
  }
  await walk('')
  return out
}

/** The directory `root` as a side. A write goes to a temporary name in `scratch`, then is renamed into place. */
export function dirSide(root: string, scratch: string, keep: (path: string) => boolean): SyncTarget {
  const at = (path: LibraryPath) => join(root, ...path.split('/'))
  return {
    async list() {
      const out = new Map<LibraryPath, Fingerprint>()
      for (const path of await filesUnder(root, keep)) out.set(path, await fingerprintOfFile(at(path)))
      return out
    },
    read: (path) => readFile(at(path)),
    async write(path, bytes) {
      await mkdir(scratch, { recursive: true })
      const tmp = join(scratch, `${randomUUID()}.partial`)
      await writeFile(tmp, bytes)
      try {
        await mkdir(dirname(at(path)), { recursive: true })
        await rename(tmp, at(path))
      } catch (error) {
        await rm(tmp, { force: true })
        throw error
      }
    },
    /** Removes the file and the folders it leaves empty, up to the root. */
    async remove(path) {
      await unlink(at(path))
      for (let dir = dirname(at(path)); dir.startsWith(`${root}/`); dir = dirname(dir)) {
        if (!(await rmdir(dir).then(() => true, () => false))) break
      }
    },
  }
}

const ID = `${TARGET_DIR}/id` as LibraryPath

/** The target's id: a new or emptied storage has none, so no baseline of an earlier storage applies to it. */
export async function targetId(target: SyncTarget): Promise<string | null> {
  try {
    return Buffer.from(await target.read(ID)).toString('utf8').trim() || null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function giveTargetId(target: SyncTarget): Promise<string> {
  const id = randomUUID()
  await target.write(ID, Buffer.from(`${id}\n`))
  return id
}
