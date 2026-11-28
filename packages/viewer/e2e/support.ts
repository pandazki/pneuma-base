// What the end-to-end tests stand on: temporary folders, the real command line, and its view server.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, crc32 } from 'node:zlib'
import { test as base, expect, type Locator, type Page } from '@playwright/test'

const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const BIN_WITH_TEST_PLUGINS = fileURLToPath(new URL('../../cli/test/fixtures/bin-with-test-plugins.ts', import.meta.url))

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
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string; testPlugins?: boolean; codes?: number[] }): { code: number; stdout: string; stderr: string }
  /** Starts `pneuma-base view <dir> --no-open` and resolves with its address once it printed it. `env` adds to its environment. */
  view(dir: string, opts?: { testPlugins?: boolean; env?: Record<string, string> }): Promise<{ url: string; stop(): Promise<void> }>
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
      if (!(opts.codes ?? [0]).includes(r.status ?? -1)) throw new Error(`pneuma-base ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`)
      return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
    },
    view(dir, opts = {}) {
      const child = spawn(process.execPath, [opts.testPlugins ? BIN_WITH_TEST_PLUGINS : BIN, 'view', dir, '--no-open', '--port', '0'], { cwd: home, env: env(opts.env) })
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

/** A library built once for every test of a worker that asks for it, and the address of its page. */
export function shared(build: (pb: Cli) => string): [(args: object, use: (url: string) => Promise<void>) => Promise<void>, { scope: 'worker' }] {
  return [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; this one has none.
    async ({}, use) => {
      const pb = cli()
      const server = await pb.view(build(pb))
      await use(server.url)
      await server.stop()
    },
    { scope: 'worker' },
  ]
}

/**
 * Each test gets its own command line and home; servers it started are stopped afterwards. A test that
 * only looks at the relay library takes `relayUrl`, its page, built once per worker; one that changes
 * the library builds its own with relay(pb).
 */
export const test = base.extend<{ pb: Cli }, { relayUrl: string }>({
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
  relayUrl: shared(relay),
})

export { expect } from '@playwright/test'

/** An outside service stood in for by a fetch handler, served from the test's own process on a loopback port. */
export async function standIn(handler: (request: Request) => Promise<Response>): Promise<{ url: string; stop(): Promise<void> }> {
  let origin = ''
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) for (const one of [value ?? []].flat()) headers.append(name, one)
    const body = chunks.length === 0 ? null : new Uint8Array(Buffer.concat(chunks))
    const answer = await handler(new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers, body }))
    res.writeHead(answer.status, Object.fromEntries(answer.headers))
    res.end(Buffer.from(await answer.arrayBuffer()))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const stop = () =>
    new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
  return { url: origin, stop }
}

/** Two frames of the page: what its timers or its last answer set going has rendered, and any fetch it led to has started. */
export async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

/** The navigation's entries, in order, once the navigation has rendered. */
export async function navTitles(page: Page): Promise<string[]> {
  const buttons = page.getByRole('navigation', { name: '导航' }).getByRole('button')
  await buttons.first().waitFor()
  return buttons.allInnerTexts()
}

/** Opens a page that shares a navigation entry: the entry first, then the page from the head's switch. */
export async function openShared(page: Page, entry: string, view: string): Promise<void> {
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: entry, exact: true }).click()
  await page.getByRole('navigation', { name: '本组页面' }).getByRole('button', { name: view, exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^${view}`))
}

/** Chooses `action` from the 「···」 menu inside `region`. */
export async function fromMenu(region: Locator, action: string): Promise<void> {
  // A refresh that lands just after the menu opens redraws the row and closes it: open it again.
  await expect(async () => {
    const item = region.page().getByRole('menu').getByRole('menuitem', { name: action })
    if (!(await item.isVisible())) await region.getByRole('button', { name: '更多' }).first().click({ timeout: 2_000 })
    await item.click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/** The texts inside `table` matching `cells` that are cut short on screen. */
export function cutTexts(table: Locator, cells = 'td'): Promise<string[]> {
  return table.evaluate(
    (t, sel) => [...t.querySelectorAll(`${sel} .truncate`)].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent ?? ''),
    cells,
  )
}

/** Saves the page in the light and the dark scheme under `dir`: the tour's pictures, which only it takes. */
export async function shoot(page: Page, name: string, dir = join(tmpdir(), 'pneuma-base-shots')): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(dir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

// ---- the relay of packages/cli/test/relay.test.ts, as a library to look at ----

export const DOING = '给电子书小店选支付服务'
export const DECIDED = '主人决定用 Paddle，因为它替他处理欧洲的税'
export const SOURCES = {
  'payments/sources/stripe-pricing.html': 'https://stripe.com/pricing',
  'payments/sources/paddle-pricing.html': 'https://www.paddle.com/pricing',
  'payments/sources/lemonsqueezy-pricing.html': 'https://www.lemonsqueezy.com/pricing',
}

/** Session A (claude-code) brings four sources and makes two things; session B (codex) makes one from A's output. */
export function relay(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  const dirA = tempDir('pb-e2e-a-')
  const dirB = tempDir('pb-e2e-b-')
  pb.run(['init', lib])
  pb.run(['grant', 'create', 'claude', '--library', lib, '--agent', 'claude-code'])
  pb.run(['grant', 'create', 'codex', '--library', lib, '--agent', 'codex'])
  writeFileSync(join(dirA, 'stripe.html'), '<html>Stripe pricing: 2.9% + 30c</html>')
  writeFileSync(join(dirA, 'paddle.html'), '<html>Paddle pricing: 5% + 50c, merchant of record</html>')
  writeFileSync(join(dirA, 'eu-vat.txt'), 'EU VAT applies to e-books sold to EU customers.')
  writeFileSync(join(dirA, 'comparison.md'), '# 支付服务对比\n\nStripe、Paddle、Lemon Squeezy 的费率和欧洲增值税的处理。\n')
  writeFileSync(join(dirA, 'recommendation.md'), '# 建议\n\n电子书小店的支付用 Paddle。\n')
  writeFileSync(join(dirB, 'integration.md'), '# 接入 Paddle\n')
  const A = (args: string[], input?: string) => pb.run(['@claude', ...args, '--session', 'sess-a'], { cwd: dirA, ...(input === undefined ? {} : { input }) })
  const B = (args: string[]) => pb.run(['@codex', ...args], { cwd: dirB, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  A(['start', DOING])
  A(['put', 'stripe.html', '--to', 'payments/sources/stripe-pricing.html', '--imported', '--source', SOURCES['payments/sources/stripe-pricing.html']])
  A(['put', 'paddle.html', '--to', 'payments/sources/paddle-pricing.html', '--imported', '--source', SOURCES['payments/sources/paddle-pricing.html']])
  A(['put', '-', '--to', 'payments/sources/lemonsqueezy-pricing.html', '--imported', '--source', SOURCES['payments/sources/lemonsqueezy-pricing.html']], '<html>Lemon Squeezy: 5% + 50c</html>')
  A(['put', 'eu-vat.txt', '--to', 'payments/sources/eu-vat-note.txt', '--imported', '--by', 'owner'])
  A(['put', 'comparison.md', '--to', 'payments/comparison.md', '--generated', '--from', ...Object.keys(SOURCES), '--from-external', '主人在对话里说：客户主要在欧洲'])
  A(['put', 'recommendation.md', '--to', 'payments/recommendation.md', '--generated', '--from', 'payments/comparison.md', 'payments/sources/eu-vat-note.txt'])
  A(['say', 'decision', DECIDED])
  B(['start', '把支付服务接进电子书小店'])
  B(['put', 'integration.md', '--to', 'payments/integration-notes.md', '--generated', '--from', 'payments/recommendation.md'])
  return lib
}
