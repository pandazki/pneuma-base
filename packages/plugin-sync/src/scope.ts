// Which files of a library are synced: all of it, records under .pneuma-base/ included, except
// this machine's configuration, caches, temporary files and what is not content.
import { posix } from 'node:path'
import type { Plugin } from '@pneuma-base/kernel'

/** The sync's own folder in a target: the target's id and its temporary files. Never synced. */
export const TARGET_DIR = '.pneuma-sync'

/**
 * The configuration names this machine's grants and the library id that keys this machine's
 * caches, and the description is assembled from it, so each machine keeps its own.
 */
const MACHINE_FILES: ReadonlySet<string> = new Set(['.pneuma-base/config.json', 'PNEUMA-BASE.md'])

/** Names never synced at any depth: OS junk, and what the kernel already leaves out of every thing. */
const NOT_CONTENT: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules'])
const notContent = (name: string) => NOT_CONTENT.has(name) || name.startsWith('._') || name.startsWith('.tmp-')

/**
 * Whether a path, of a file or a folder, is synced, given the installed plugins: their folders
 * declared as caches are not, nor the kernel's temporary folder. A folder that is not synced holds
 * nothing that is.
 */
export function scopeOf(plugins: readonly Plugin[]): (path: string) => boolean {
  const caches = plugins.flatMap((p) => p.storage.filter((s) => s.kind === 'cache').map((s) => posix.join('.pneuma-base', p.name, s.dir)))
  const folders = ['.pneuma-base/tmp', TARGET_DIR, ...caches]
  return (path) => !MACHINE_FILES.has(path) && !folders.some((f) => path === f || path.startsWith(`${f}/`)) && !path.split('/').some(notContent)
}
