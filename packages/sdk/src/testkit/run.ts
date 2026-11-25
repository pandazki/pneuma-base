// Running the real `pneuma-base` command line from a test: where it is, a clean environment, and a
// time limit on every call.
import { spawn } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** What one call printed and how it ended. `json` is standard output parsed, when the call was given `--json`; otherwise null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the shape it asked for; the command line's JSON has no single type
export type Result = { code: number; stdout: string; stderr: string; json: any }

export type CallOptions = {
  /** The working directory; the sandbox's `work` when not given. */
  cwd?: string
  /** Added to the call's environment. */
  env?: Record<string, string>
  /** Standard input; closed and empty when not given. */
  input?: string
}

export const DEFAULT_TIMEOUT = 60_000

/**
 * The `bin.js` of the command line: `cli` when given, else `$PNEUMA_BASE_CLI`, else the `pneuma-base`
 * package the plugin project depends on.
 */
export function findCli(cli?: string): string {
  const given = cli ?? process.env.PNEUMA_BASE_CLI
  if (given !== undefined && given !== '') return resolve(given)
  for (const from of [import.meta.url, pathToFileURL(join(process.cwd(), 'package.json')).href]) {
    let manifest: string
    try {
      manifest = createRequire(from).resolve('pneuma-base/package.json')
    } catch {
      continue
    }
    const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> }).bin
    const entry = typeof bin === 'string' ? bin : bin?.['pneuma-base']
    if (entry !== undefined) return join(dirname(manifest), entry)
  }
  throw new Error('找不到 pneuma-base 命令行。把它装进插件项目（npm install <pneuma-base 的包文件>），或把 PNEUMA_BASE_CLI 设成它的 bin.js。')
}

/** A new empty directory under `$PNEUMA_BASE_TEST_TMP` or the system's temporary directory, by its real path. */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
}

/** What a call may see of the test's environment. Nothing else passes, so no agent product's session variable ever does. */
const PASSED = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'LANG', 'LC_ALL']

/** The environment of a call made in the temporary home `home`: the owner's, with `extra` added. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const passed = Object.fromEntries(PASSED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]])))
  return { ...passed, HOME: home, USERPROFILE: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...extra }
}

type RunOptions = { cwd: string; env: Record<string, string>; input?: string; timeout: number }

/** Runs `node <cli> ...args`; rejects when it has not ended after `timeout` milliseconds, and stops it. */
export function runCli(cli: string, args: readonly string[], opts: RunOptions): Promise<Result> {
  return runProcess(process.execPath, [cli, ...args], opts)
}

/** Runs `command ...args` with standard input closed after `opts.input`; rejects when it has not ended after `timeout` milliseconds, and stops it. */
export function runProcess(command: string, args: readonly string[], opts: RunOptions): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`${command === process.execPath ? 'pneuma-base' : command} ${args.slice(command === process.execPath ? 1 : 0).join(' ')} 过了 ${opts.timeout / 1000} 秒还没结束，已经停掉。`))
    }, opts.timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      done({ code: code ?? -1, stdout, stderr: Buffer.concat(err).toString('utf8'), json: args.includes('--json') ? parseJson(stdout) : null })
    })
    child.stdin.end(opts.input ?? '')
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
