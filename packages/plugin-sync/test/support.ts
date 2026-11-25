// Drives the real built command line, as packages/cli/test does: temp libraries, temp home.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

/** The command line as bin.js runs it, with a person who answers yes when it asks to confirm a destructive command. */
const CONFIRMING = `
import { main, processIo } from ${JSON.stringify(new URL('../../cli/dist/main.js', import.meta.url).href)}
import { builtinPlugins } from ${JSON.stringify(new URL('../../cli/dist/plugins.js', import.meta.url).href)}
process.exitCode = await main(process.argv.slice(1), builtinPlugins, { ...processIo(), confirm: async () => true })
`

export function tempDir(prefix = 'pb-sync-'): string {
  return realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
}

export type Run = { code: number; stdout: string; stderr: string; json: () => any }

/**
 * One machine: a temp home, and the real `pneuma-base` run with no agent session variable unless
 * `env` adds one. `confirm`: the person confirms a destructive command in person.
 */
export function machine() {
  const home = tempDir('pb-sync-home-')
  const run = (args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string; confirm?: boolean } = {}): Run => {
    const r = spawnSync(process.execPath, opts.confirm ? ['--input-type=module', '-e', CONFIRMING, ...args] : [BIN, ...args], {
      cwd: opts.cwd ?? home,
      env: { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...opts.env },
      input: opts.input ?? '',
      encoding: 'utf8',
    })
    if (r.error) throw r.error
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
  }
  return { home, run }
}

export function ok(r: Run): Run {
  if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`)
  return r
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

export const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules'])

/** The synced files under `root` and their text: the machine's configuration, temporary files, OS junk and the target's own folder left out. */
export function contents(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const skip = new Set(['.pneuma-base/config.json', 'PNEUMA-BASE.md', '.pneuma-base/tmp', '.pneuma-base/sync/tmp', '.pneuma-sync'])
  const walk = (rel: string) => {
    for (const e of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (skip.has(path) || JUNK.has(e.name) || e.name.startsWith('.tmp-')) continue
      if (e.isDirectory()) walk(path)
      else if (e.isFile()) out.set(path, readFileSync(join(root, path), 'utf8'))
    }
  }
  walk('')
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)))
}
