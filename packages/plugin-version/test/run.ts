// Drives the real built `pneuma-base` with a temp PNEUMA_BASE_HOME. The command line is run by its
// path, not imported: a plugin package imports only the kernel.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
/** The real command line with the test-only plugins `recorder` and `thrower` added to its table. */
const BIN_WITH_TEST_PLUGINS = fileURLToPath(new URL('../../cli/test/fixtures/bin-with-test-plugins.ts', import.meta.url))

export function tempDir(prefix = 'pb-v-'): string {
  return realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
}

export type Run = { code: number; stdout: string; stderr: string; json: () => any }
type Opts = { cwd?: string; env?: Record<string, string>; input?: string | Buffer }

export type Sandbox = {
  home: string
  run(args: string[], opts?: Opts): Run
  runWithTestPlugins(args: string[], opts?: Opts): Run
}

/** The environment holds no agent session variable unless `env` adds one. */
export function sandbox(): Sandbox {
  const home = tempDir('pb-v-home-')
  const runSync = (entry: string, args: string[], opts: Opts = {}): Run => {
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: opts.cwd ?? home,
      env: { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...opts.env },
      input: opts.input ?? '',
      encoding: 'utf8',
    })
    if (r.error) throw r.error
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
  }
  return { home, run: (args, opts) => runSync(BIN, args, opts), runWithTestPlugins: (args, opts) => runSync(BIN_WITH_TEST_PLUGINS, args, opts) }
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** Every regular file under `root` by '/'-separated relative path, with its text; names in `skip` left out at any depth. */
export function readTree(root: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const entry of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out[path] = readFileSync(join(root, path), 'utf8')
    }
  }
  walk('')
  return out
}
