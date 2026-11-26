// Code taken from affectUI Pro is under its own license, not this project's. It lives in one folder
// of the management UI, every file there opens with the notice, and no file carrying the notice is
// anywhere else, least of all in what plugin authors receive.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FOLDER = join('packages', 'viewer', 'web', 'src', 'aui')
const NOTICE = "affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project."
/** The first line of a file that carries the notice, as a line comment or a block comment. */
const OPENINGS = [`// ${NOTICE}`, `/* ${NOTICE} */`]
const SKIPPED = new Set(['node_modules', 'dist', 'dist-packages', '.git', 'tmp'])

/** Every file of the repository, as a path from its root, without what is built or installed. */
function files(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIPPED.has(e.name)) return []
    const path = join(dir, e.name)
    // A symbolic link is neither: a build leaves some that point at folders.
    return e.isDirectory() ? files(path) : e.isFile() ? [relative(ROOT, path)] : []
  })
}

const firstLine = (path: string) => readFileSync(join(ROOT, path), 'utf8').split('\n', 1)[0] ?? ''
const inFolder = (path: string) => path.startsWith(`${FOLDER}${sep}`)

describe('code taken from affectUI Pro', () => {
  it('opens every file of its folder with the notice, exactly', () => {
    const own = files().filter(inFolder)
    expect(own.length).toBeGreaterThan(0)
    for (const path of own) expect(OPENINGS, path).toContain(firstLine(path))
  })

  it('is nowhere else: no file outside the folder opens with the notice', () => {
    const outside = files().filter((path) => !inFolder(path) && firstLine(path).includes(NOTICE))
    expect(outside).toEqual([])
  })
})
