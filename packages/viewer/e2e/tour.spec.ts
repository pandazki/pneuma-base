// A tour for people to look at, not a check: every page of four libraries, light and dark, at a wide
// and a narrow window, plus the panels and notices that only show on a click. It runs only when
// $PNEUMA_BASE_TOUR_SHOTS names the folder for the screenshots.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { writeHistory } from './month.ts'
import { expect, relay, shoot, tempDir, test, write, type Cli } from './support.ts'

const SHOTS = process.env.PNEUMA_BASE_TOUR_SHOTS
const SIZES = [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
] as const

test.skip(!SHOTS, 'a tour for people to look at; set PNEUMA_BASE_TOUR_SHOTS to take it')
test.describe.configure({ timeout: 600_000 })

function bare(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  for (let i = 1; i <= 64; i++) write(lib, `notes/n${String(i).padStart(2, '0')}.md`, `# ${i}\n`)
  write(lib, 'photos/a.png', 'png')
  write(lib, 'readme.txt', '自己放的\n')
  pb.run(['init', lib, '--bare'])
  return lib
}

function month(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) pb.run(['--library', lib, 'grant', 'create', grant as string, '--agent', agent as string])
  writeHistory(lib, { days: 29, sessions: 2.2, seed: 11 })
  return lib
}

/** Apple's binary property list of a list of strings, as the extended attributes hold it. */
function bplist(strings: string[]): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${strings.map((s) => `<string>${s}</string>`).join('')}</array></plist>`
  return execFileSync('plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: xml }).toString('hex')
}

/** A project directory nobody registered, 500 loose files at the root, and a download with its facets. */
function unregistered(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  write(lib, 'app/package.json', '{"name":"app"}\n')
  write(lib, 'app/.git/HEAD', 'ref: refs/heads/main\n')
  for (let i = 1; i <= 40; i++) write(lib, `app/src/page-${i}.tsx`, `export default () => ${i}\n`)
  for (let i = 1; i <= 500; i++) write(lib, `loose-${String(i).padStart(3, '0')}.txt`, `${i}\n`)
  pb.run(['init', lib])
  write(lib, 'downloads/report.pdf', '%PDF-1.4 report\n')
  const file = join(lib, 'downloads/report.pdf')
  execFileSync('xattr', ['-wx', 'com.apple.metadata:kMDItemWhereFroms', bplist(['https://example.com/files/report.pdf', 'https://example.com/']), file])
  execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;6aee14ed;Safari;0A1B2C3D-0000-0000-0000-000000000000', file])
  execFileSync('xattr', ['-wx', 'com.apple.metadata:_kMDItemUserTags', bplist(['工作\n6', '要看\n2']), file])
  pb.run(['--library', lib, 'ledger', 'register', 'downloads', '--recursive'])
  return lib
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
  await page.waitForTimeout(500)
}

/** Every page in the navigation, at each size, light and dark. */
async function everyPage(page: Page, pb: Cli, lib: string, name: string): Promise<string> {
  const { url } = await pb.view(lib)
  const views = (JSON.parse(pb.run(['--library', lib, 'show', '--json']).stdout) as { views: { id: string; nav: boolean }[] }).views.filter((v) => v.nav)
  for (const size of SIZES) {
    await page.setViewportSize(size)
    for (const view of views) {
      await page.goto(`${url}#view=${view.id}`)
      await settle(page)
      await shoot(page, `${name}-${view.id}-${size.width}`, SHOTS)
    }
  }
  return url
}

/** One more state of a page, at each size. */
async function extra(page: Page, at: string, name: string, then?: () => Promise<void>): Promise<void> {
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto('about:blank')
    await page.goto(at)
    await settle(page)
    await then?.()
    await shoot(page, `${name}-${size.width}`, SHOTS)
  }
}

test.beforeAll(() => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
})

test('bare library', async ({ page, pb }) => {
  const lib = bare(pb)
  const url = await everyPage(page, pb, lib, 'bare')
  await extra(page, `${url}#view=files&view.dir=notes`, 'bare-files-notes')
  await extra(page, `${url}#view=files&view.dir=notes&panel=item&panel.path=notes/n01.md`, 'bare-item')
})

test('relay library', async ({ page, pb }) => {
  const lib = relay(pb)
  const url = await everyPage(page, pb, lib, 'relay')
  await extra(page, `${url}#view=ledger.items&panel=item&panel.path=payments/comparison.md`, 'relay-item')
  write(lib, 'payments/comparison.md', '# 支付服务对比，主人手改过\n')
  await page.waitForTimeout(2500)
  await extra(page, `${url}#view=ledger.status&panel=item&panel.path=payments/comparison.md`, 'relay-changed')
})

test('month library', async ({ page, pb }) => {
  const lib = month(pb)
  await everyPage(page, pb, lib, 'month')
})

test('unregistered project and 500 loose files', async ({ page, pb }) => {
  const lib = unregistered(pb)
  const url = await everyPage(page, pb, lib, 'loose')
  await extra(page, `${url}#view=files&view.after=loose-050.txt`, 'loose-files-page2')
  await extra(page, `${url}#view=files&view.after=loose-050.txt`, 'loose-files-foot', async () => {
    await page.getByRole('main').getByRole('navigation', { name: '分页' }).scrollIntoViewIfNeeded()
  })
  await extra(page, `${url}#view=ledger.items`, 'loose-items-closed')
  // A provider installed from a repository beside the built-in one, as storage install leaves its entry.
  write(pb.home, '.pneuma-base/storage/providers/acme-folder/v1.0.0/acme-folder', '#!/bin/sh\n')
  write(
    pb.home,
    '.pneuma-base/storage/providers/acme-folder/provider.json',
    JSON.stringify({ format: 1, name: 'acme-folder', version: 'v1.0.0', contract: 1, addresses: ['acme'], executable: 'v1.0.0/acme-folder', sha256: '0'.repeat(64), official: false, installed: '2026-11-27T00:00:00.000Z', from: { repository: 'acme/acme-folder', tag: 'v1.0.0' } }),
  )
  await extra(page, `${url}#view=settings`, 'loose-config-storage', async () => {
    // Its heading just under the page's own, which stays at the top.
    await page.getByRole('main').getByRole('region', { name: '存储', exact: true }).evaluate((el) => {
      let pane = el.parentElement
      while (pane && !(pane.scrollHeight > pane.clientHeight && getComputedStyle(pane).overflowY !== 'visible')) pane = pane.parentElement
      if (pane) pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 64
    })
  })
  await extra(page, `${url}#view=files&panel=item&panel.path=app`, 'loose-closed-panel')
  await extra(page, `${url}#view=files&view.dir=downloads&panel=item&panel.path=downloads/report.pdf`, 'loose-facets')
  await extra(page, `${url}#view=files&view.dir=downloads&panel=item&panel.path=downloads/report.pdf`, 'loose-facets-file', async () => {
    await page.getByRole('complementary', { name: '详情' }).getByRole('region', { name: '文件', exact: true }).scrollIntoViewIfNeeded()
  })
  await extra(page, `${url}#view=files`, 'loose-confirm', async () => {
    await page.getByRole('main').getByRole('row', { name: /^app\// }).getByRole('button', { name: '登记目录内的文件' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.waitForTimeout(300)
  })
})

test('a named pass under way and stopped', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  for (let i = 0; i < 40000; i++) write(lib, `scans-2019/d${Math.floor(i / 2000)}/f${i}.txt`, `${i}\n`)
  pb.run(['init', lib])
  pb.run(['--library', lib, 'ledger', 'register', 'scans-2019', '--recursive'])
  const { url } = await pb.view(lib)
  const notices = page.getByRole('status')
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${url}#view=ledger.status`)
    await settle(page)
    await page.getByRole('main').getByRole('button', { name: '深度检查' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '深度检查' }).click()
    await expect(notices).toContainText(/已检查 [1-9]\d* \/ 40000 个/)
    await page.mouse.move(0, 0)
    await shoot(page, `pass-running-${size.width}`, SHOTS)
    await notices.getByRole('button', { name: '停止' }).click()
    await expect(notices).toContainText('已停止', { timeout: 30_000 })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await shoot(page, `pass-stopped-${size.width}`, SHOTS)
  }
})
