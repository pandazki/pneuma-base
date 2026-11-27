// What the server reads from disk itself, none of it a library's: a plugin's page files, and a cheap
// stamp of what changed in a folder of this machine's state.
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

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
