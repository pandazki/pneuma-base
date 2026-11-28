// The page 统计: a month of use by three agents and the owner, answered as four questions, each a
// sentence with its numbers over a chart; the period changes what is counted; a chart gives every
// series' value on hover and from the keyboard; and the page says what `ledger stats` says.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeHistory } from './month.ts'
import { expect, openShared, tempDir, test, type Cli } from './support.ts'

function month(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) pb.run(['--library', lib, 'grant', 'create', grant as string, '--agent', agent as string])
  writeHistory(lib, { days: 29, sessions: 2.2, seed: 11 })
  return lib
}

test('the statistics page answers the four questions for a month of use, by the period chosen', async ({ page, pb }) => {
  const lib = month(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  await openShared(page, '活动', '统计')
  await expect(main.getByRole('heading', { level: 1, name: '统计' })).toBeVisible()
  const section = (name: string) => main.getByRole('region', { name, exact: true })
  for (const name of ['使用情况', '复用情况', '操作分布', '资料库健康度']) await expect(section(name)).toBeVisible()

  // Every sentence on the page is one ledger stats prints for the same period.
  const said = pb.run(['--library', lib, 'ledger', 'stats']).stdout
  const captions = await main.locator('figcaption').allInnerTexts()
  expect(captions).toHaveLength(4)
  for (const caption of captions) expect(said).toContain(caption)
  expect(captions[0]).toMatch(/^近 30 天新增 \d+ 个条目：导入 \d+ 个，生成 \d+ 个。$/)
  for (const agent of ['claude-code', 'codex', 'gemini']) await expect(section('操作分布').getByRole('listitem').filter({ hasText: agent })).toContainText('次会话')
  await expect(section('操作分布').getByRole('listitem').filter({ hasText: '次操作' })).toContainText('我')

  // A chart read from the keyboard: the last day, each series with its unit, and the total of a stack.
  const plot = main.getByRole('group', { name: /^近 30 天新增/ })
  await plot.focus()
  await page.keyboard.press('End')
  const tip = main.getByRole('status').filter({ hasText: '合计' }).first()
  await expect(tip).toBeVisible()
  const last = await main.locator('.chart-tip-head').first().innerText()
  expect(last).toMatch(/^\d+月\d+日$/)
  await expect(tip).toContainText(/导入\s*\d+ 个/)

  // The period: 7 days and all change what is counted, and the address keeps it.
  const period = main.getByRole('radiogroup', { name: '时间' })
  await period.getByRole('radio', { name: '7 天' }).click()
  await expect(main.locator('figcaption').first()).toHaveText(/^近 7 天新增/)
  expect(page.url()).toContain('view.period=7d')
  expect(pb.run(['--library', lib, 'ledger', 'stats', '--period', '7d']).stdout).toContain(await main.locator('figcaption').first().innerText())
  await period.getByRole('radio', { name: '全部' }).click()
  await expect(main.locator('figcaption').first()).toHaveText(/以来新增/)
  await page.reload()
  await expect(main.locator('figcaption').first()).toHaveText(/以来新增/)
})

test('a library with nothing recorded says so in one sentence; a week with nothing in it says it in words, without empty charts', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  rmSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.stats`)
  const main = page.getByRole('main')
  await expect(main.getByText('暂无可统计的记录')).toBeVisible()

  // Weeks of use that ended a month ago: the last 7 days have nothing, and say so.
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) pb.run(['--library', lib, 'grant', 'create', grant as string, '--agent', agent as string])
  rmSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
  writeHistory(lib, { days: 20, sessions: 2, seed: 3, now: new Date(Date.now() - 40 * 86_400_000) })
  await page.goto(`${url}#view=ledger.stats&view.period=7d`)
  await expect(main.getByText('近 7 天无新增条目。')).toBeVisible()
  await expect(main.getByText('近 7 天无 Agent 访问。')).toBeVisible()
  await expect(main.getByText('近 7 天无新生成的条目。')).toBeVisible()
  await expect(main.locator('.chart')).toHaveCount(0)
  await main.getByRole('radiogroup', { name: '时间' }).getByRole('radio', { name: '全部' }).click()
  await expect(main.locator('.chart')).toHaveCount(4)
})
