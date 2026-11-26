// The page 统计: a month of use by three agents and the owner, answered as four questions, each a
// sentence with its numbers over a chart; the period changes what is counted; a chart gives every
// series' value on hover and from the keyboard; and the page says what `ledger stats` says.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeHistory } from './month.ts'
import { expect, tempDir, test, type Cli } from './support.ts'

/** Where these screenshots go: $PNEUMA_BASE_SHOTS, else tmp/run-6/s1-shots/. */
const SHOTS = process.env.PNEUMA_BASE_SHOTS ?? fileURLToPath(new URL('../../../tmp/run-6/s1-shots/', import.meta.url))

function month(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) pb.run(['--library', lib, 'grant', 'issue', grant as string, '--agent', agent as string])
  writeHistory(lib, { days: 29, sessions: 2.2, seed: 11 })
  return lib
}

test('the statistics page answers the four questions for a month of use, by the period chosen', async ({ page, pb }) => {
  const lib = month(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '统计' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '统计' })).toBeVisible()
  const section = (name: string) => main.getByRole('region', { name, exact: true })
  for (const name of ['用起来了吗', '以前的东西被接着用了吗', '谁做了什么', '库收拾得怎么样']) await expect(section(name)).toBeVisible()

  // Every sentence on the page is one ledger stats prints for the same period.
  const said = pb.run(['--library', lib, 'ledger', 'stats']).stdout
  const captions = await main.locator('figcaption').allInnerTexts()
  expect(captions).toHaveLength(4)
  for (const caption of captions) expect(said).toContain(caption)
  expect(captions[0]).toMatch(/^这 30 天放进 \d+ 样东西：带进来 \d+ 样，做出来 \d+ 样。$/)
  for (const agent of ['claude-code', 'codex', 'gemini']) await expect(section('谁做了什么').getByRole('listitem').filter({ hasText: agent })).toContainText('次会话')
  await expect(section('谁做了什么').getByRole('listitem').filter({ hasText: '次操作' })).toContainText('主人')

  // A chart read from the keyboard: the last day, each series with its unit, and the total of a stack.
  const plot = main.getByRole('group', { name: /^这 30 天放进/ })
  await plot.focus()
  await page.keyboard.press('End')
  const tip = main.getByRole('status').filter({ hasText: '合计' }).first()
  await expect(tip).toBeVisible()
  const last = await main.locator('.chart-tip-head').first().innerText()
  expect(last).toMatch(/^\d+月\d+日$/)
  await expect(tip).toContainText(/带进来的\s*\d+ 样/)

  for (const [w, h] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.keyboard.press('Escape')
    await main.click({ position: { x: 5, y: 5 } })
    await shoot(page, `stats__30d`, w)
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  // The period: 7 days and all change what is counted, and the address keeps it.
  const period = main.getByRole('radiogroup', { name: '时间' })
  await period.getByRole('radio', { name: '7 天' }).click()
  await expect(main.locator('figcaption').first()).toHaveText(/^这 7 天放进/)
  expect(page.url()).toContain('view.period=7d')
  expect(pb.run(['--library', lib, 'ledger', 'stats', '--period', '7d']).stdout).toContain(await main.locator('figcaption').first().innerText())
  await shoot(page, 'stats__7d', 1440)
  await period.getByRole('radio', { name: '全部' }).click()
  await expect(main.locator('figcaption').first()).toHaveText(/以来放进/)
  await page.reload()
  await expect(main.locator('figcaption').first()).toHaveText(/以来放进/)
})

test('a library with nothing recorded says so in one sentence; a week with nothing in it says it in words, without empty charts', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  rmSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.stats`)
  const main = page.getByRole('main')
  await expect(main.getByText('还没有可以统计的记录')).toBeVisible()

  // Weeks of use that ended a month ago: the last 7 days have nothing, and say so.
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) pb.run(['--library', lib, 'grant', 'issue', grant as string, '--agent', agent as string])
  rmSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
  writeHistory(lib, { days: 20, sessions: 2, seed: 3, now: new Date(Date.now() - 40 * 86_400_000) })
  await page.goto(`${url}#view=ledger.stats&view.period=7d`)
  await expect(main.getByText('这 7 天没有放进新东西。')).toBeVisible()
  await expect(main.getByText('这 7 天没有 agent 来过。')).toBeVisible()
  await expect(main.getByText('这 7 天没有做出来新东西。')).toBeVisible()
  await expect(main.locator('.chart')).toHaveCount(0)
  await main.getByRole('radiogroup', { name: '时间' }).getByRole('radio', { name: '全部' }).click()
  await expect(main.locator('.chart')).toHaveCount(4)
})

async function shoot(page: import('@playwright/test').Page, name: string, width: number): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(SHOTS, `${name}__${scheme}__w${width}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
