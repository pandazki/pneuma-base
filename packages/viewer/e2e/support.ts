// What the end-to-end tests stand on: temporary folders, the real command line, and its view server.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, crc32 } from 'node:zlib'
import { test as base, type Page } from '@playwright/test'

const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const BIN_WITH_TEST_PLUGINS = fileURLToPath(new URL('../../cli/test/fixtures/bin-with-test-plugins.ts', import.meta.url))
export const SHOTS = fileURLToPath(new URL('../../../tmp/run-2/shots/', import.meta.url))

export function tempDir(prefix = 'pb-e2e-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function write(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A PNG of one colour, made here so the test needs no image file. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export type Cli = {
  home: string
  /** Runs the built `pneuma-base`, or with `testPlugins` the same command line with the test-only plugins added. */
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string; testPlugins?: boolean }): { code: number; stdout: string; stderr: string }
  /** Starts `pneuma-base view <dir> --no-open` and resolves with its address once it printed it. */
  view(dir: string, opts?: { testPlugins?: boolean }): Promise<{ url: string; stop(): Promise<void> }>
}

export function cli(): Cli {
  const home = tempDir('pb-e2e-home-')
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...extra })
  const children: ChildProcess[] = []
  return {
    home,
    run(args, opts = {}) {
      const r = spawnSync(process.execPath, [opts.testPlugins ? BIN_WITH_TEST_PLUGINS : BIN, ...args], { cwd: opts.cwd ?? home, env: env(opts.env), input: opts.input ?? '', encoding: 'utf8' })
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error(`pneuma-base ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`)
      return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
    },
    view(dir, opts = {}) {
      const child = spawn(process.execPath, [opts.testPlugins ? BIN_WITH_TEST_PLUGINS : BIN, 'view', dir, '--no-open'], { cwd: home, env: env() })
      children.push(child)
      return new Promise((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
          const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/.exec(out)
          if (match) {
            const stop = () =>
              new Promise<void>((done) => {
                if (child.exitCode !== null) return done()
                child.once('exit', () => done())
                child.kill('SIGINT')
              })
            resolve({ url: match[0], stop })
          }
        })
        child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        child.once('exit', (code) => reject(new Error(`view exited with ${code}: ${out}`)))
      })
    },
  }
}

/** Each test gets its own command line and home; servers it started are stopped afterwards. */
export const test = base.extend<{ pb: Cli }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; this one has none.
  pb: async ({}, use) => {
    const started: { stop(): Promise<void> }[] = []
    const c = cli()
    const view = c.view.bind(c)
    c.view = async (dir, opts) => {
      const server = await view(dir, opts)
      started.push(server)
      return server
    }
    await use(c)
    await Promise.all(started.map((s) => s.stop()))
  },
})

export { expect } from '@playwright/test'

/** The navigation's entries, in order. */
export async function navTitles(page: Page): Promise<string[]> {
  return page.getByRole('navigation', { name: '导航' }).getByRole('button').allInnerTexts()
}

/** Saves the page in the light and the dark scheme under tmp/run-2/shots/. */
export async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
