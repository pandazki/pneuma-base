// A put in progress, visible to whoever looks at the library: a mark in the kernel's scratch area,
// written before the put touches anything and removed once it and every plugin's hook are done.
// ARCHITECTURE "放".
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from './paths.js'
import type { LibraryPath } from '@pneuma-base/sdk'

/**
 * A mark not refreshed for this long is stale: its put died. A running put refreshes its mark every
 * `PUT_MARK_REFRESH_MS`, however long it takes, so the limit only has to outlast one refresh and a
 * stall of the event loop; and it bounds how long a killed put's file stays hidden from check.
 */
const PUT_MARK_STALE_MS = 10_000
const PUT_MARK_REFRESH_MS = 2_000

const marksDir = (root: string) => join(scratchDir(root), 'putting')

/** Runs `body` with `paths` marked as being put. A writer clears the stale marks a killed put left. */
export async function whilePutting<T>(root: string, paths: readonly LibraryPath[], body: () => Promise<T>): Promise<T> {
  if (paths.length === 0) return body()
  const dir = marksDir(root)
  await mkdir(dir, { recursive: true })
  for (const stale of await marks(dir, Date.now(), 'stale')) await rm(stale, { force: true })
  const mark = join(dir, `${randomUUID()}.json`)
  const partial = `${mark}.partial`
  await writeFile(partial, `${JSON.stringify({ paths })}\n`)
  await rename(partial, mark)
  const refresh = setInterval(() => {
    const now = new Date()
    utimes(mark, now, now).catch(() => undefined)
  }, PUT_MARK_REFRESH_MS)
  refresh.unref()
  try {
    return await body()
  } finally {
    clearInterval(refresh)
    await rm(mark, { force: true })
  }
}

/** The library paths being put right now, sorted: those of every mark that is not stale. */
export async function puttingNow(root: string): Promise<LibraryPath[]> {
  const out = new Set<LibraryPath>()
  for (const mark of await marks(marksDir(root), Date.now(), 'live')) {
    const parsed = (await readFile(mark, 'utf8').then(JSON.parse).catch(() => null)) as { paths?: unknown } | null
    const paths = Array.isArray(parsed?.paths) ? parsed.paths : []
    for (const path of paths) if (typeof path === 'string') out.add(path as LibraryPath)
  }
  return [...out].sort()
}

async function marks(dir: string, now: number, which: 'live' | 'stale'): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const s = await stat(join(dir, name)).catch(() => null)
    const stale = s !== null && now - s.mtimeMs > PUT_MARK_STALE_MS
    if (s !== null && stale === (which === 'stale')) out.push(join(dir, name))
  }
  return out
}
