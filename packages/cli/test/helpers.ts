import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const BIN_WITH_TEST_PLUGINS = fileURLToPath(new URL('./fixtures/bin-with-test-plugins.ts', import.meta.url))

export function tempDir(prefix = 'pb-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export type Run = { code: number; stdout: string; stderr: string; json: () => any }

export type Sandbox = {
  home: string
  /** Runs the real built `pneuma-base`. The environment holds no agent session variable unless `env` adds one. */
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string | Buffer }): Run
  /** Same as `run`, with the test-only plugins `recorder` and `thrower` added to the built-in table. */
  runWithTestPlugins(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string | Buffer }): Run
  /** Starts the real built `pneuma-base` without waiting for it. */
  start(args: string[]): ChildProcessWithoutNullStreams
}

export function sandbox(): Sandbox {
  const home = tempDir('pb-home-')
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...extra })
  const runSync = (entry: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string | Buffer } = {}): Run => {
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: opts.cwd ?? home,
      env: env(opts.env),
      input: opts.input ?? '',
      encoding: 'utf8',
    })
    if (r.error) throw r.error
    const stdout = r.stdout
    return { code: r.status ?? -1, stdout, stderr: r.stderr, json: () => JSON.parse(stdout) }
  }
  return {
    home,
    run: (args, opts) => runSync(BIN, args, opts),
    runWithTestPlugins: (args, opts) => runSync(BIN_WITH_TEST_PLUGINS, args, opts),
    start: (args) => spawn(process.execPath, [BIN, ...args], { cwd: home, env: env() }),
  }
}
