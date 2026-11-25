// What the server reads from disk directly: a library file to show, and a cheap stamp of what changed.
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { abs, parseLibraryPath, regionOf, type LibraryPath } from '@pneuma-base/kernel'

export type LibraryFile = { path: string; type: string; size: number }

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

const SNIFF = 8192

/** An image by its extension; otherwise text when the first bytes are UTF-8 without NUL, else bytes. Never HTML. */
async function typeOf(path: string): Promise<string> {
  const image = IMAGES[extname(path).toLowerCase()]
  if (image) return image
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.includes(0)) return 'application/octet-stream'
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return 'text/plain; charset=utf-8'
  } catch {
    return 'application/octet-stream'
  } finally {
    await handle.close()
  }
}

/**
 * The file a library path names, when it lies in the content or the archive and resolves, links
 * followed, to a regular file inside the library that is not the kernel's. Null for anything else.
 */
export async function libraryFile(root: string, input: string): Promise<LibraryFile | null> {
  const path = parseLibraryPath(root, input)
  if (path === null) return null
  const real = await realpath(abs(root, path)).catch(() => null)
  if (real === null || !real.startsWith(`${root}${sep}`)) return null
  if (regionOf(real.slice(root.length + 1).split(sep).join('/') as LibraryPath) === 'kernel') return null
  const s = await stat(real)
  return s.isFile() ? { path: real, type: await typeOf(real), size: s.size } : null
}

/**
 * The regular file `rest` names inside a plugin's `ui` directory, links followed and still inside it.
 * `rest` is the URL path after the plugin's name, still percent-encoded; a segment that is empty, a
 * dot segment or holds a slash once decoded is refused. Null for anything else.
 */
export async function pluginUiFile(ui: string, rest: string): Promise<string | null> {
  const segments = rest.split('/').map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return ''
    }
  })
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s))) return null
  const base = await realpath(ui).catch(() => null)
  if (base === null) return null
  const real = await realpath(join(base, ...segments)).catch(() => null)
  if (real === null || !real.startsWith(`${base}${sep}`)) return null
  return (await stat(real)).isFile() ? real : null
}

/** A short stamp of every name, size and modification time under `dir`. It changes when anything there changes. */
export async function revision(dir: string): Promise<string> {
  const hash = createHash('sha1')
  const walk = async (folder: string, rel: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`${name}/\n`)
        await walk(join(folder, entry.name), name)
      } else {
        const s = await lstat(join(folder, entry.name)).catch(() => null)
        if (s) hash.update(`${name}\0${s.size}\0${s.mtimeMs}\n`)
      }
    }
  }
  await walk(dir, '')
  return hash.digest('hex').slice(0, 16)
}
