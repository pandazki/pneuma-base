// What the server reads from disk itself, none of it a library's: a plugin's page files, and a cheap
// stamp of what changed in a folder of this machine's state.
import { realpath, stat } from 'node:fs/promises'
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

/**
 * A stamp of a folder whose files are only added, each written once: the folder's own modification
 * time, which moves whenever an entry is added or removed. One look, however many files it holds.
 */
export async function addedStamp(dir: string): Promise<string> {
  const s = await stat(dir, { bigint: true }).catch(() => null)
  return s === null ? 'none' : String(s.mtimeNs)
}
