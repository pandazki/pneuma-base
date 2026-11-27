// What the first look at the pages with real data showed, each in the browser: marks that tell
// agents apart, a marker only where an act departs from the ordinary, one row for one decision, files
// that were there first as a question, the panel's feed rows and tab names, a decision said once, the
// since part after 都看过了, and a scenes page that uses its width. Screenshots go to
// $PNEUMA_BASE_SHOTS, else tmp/run-6/p1-shots/, named by the item they show.
import { utimesSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, relay, shoot, tempDir, test, write, type Cli } from './support.ts'

const SHOTS = process.env.PNEUMA_BASE_SHOTS ?? fileURLToPath(new URL('../../../tmp/run-6/p1-shots/', import.meta.url))
const B = { env: { PNEUMA_BASE_SESSION: 'sess-b' } }
const WHY = '小店的页面做好了，客户等着看'
const LONG = '结账页先只接 Paddle：它替我们处理欧洲的增值税，退款流程也由它来做，等第二家支付服务的需求明确之后再说要不要接 Stripe'
const LONG_NAME = 'payments/integration-notes-for-the-checkout-page.md'

/** The relay library, with deploy, a site codex declared deployable and asked the owner to put online, and a long decision. */
function shop(pb: Cli): string {
  const lib = relay(pb)
  pb.run(['plugin', 'add', 'deploy', '--library', lib])
  pb.run(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-e2e-www-'), 'www'), '--library', lib])
  const dir = tempDir('pb-e2e-site-')
  write(dir, 'shop/index.html', '<h1>小店</h1>')
  write(dir, 'notes.md', '# 结账页的接入笔记\n')
  pb.run(['@codex', 'put', 'shop', '--to', 'sites/shop', '--made'], { cwd: dir, ...B })
  pb.run(['@codex', 'say', 'deployable', 'sites/shop'], { cwd: dir, ...B })
  pb.run(['@codex', 'put', 'notes.md', '--to', LONG_NAME, '--made', '--from', 'payments/recommendation.md'], { cwd: dir, ...B })
  pb.run(['@codex', 'say', 'decided', LONG, '--about', 'payments/integration-notes.md'], B)
  pb.run(['@codex', 'ask', WHY, 'deploy', 'on', 'sites/shop'], B)
  return lib
}

const marksOf = (rows: import('@playwright/test').Locator) =>
  rows.evaluateAll((els) => Object.fromEntries(els.map((el) => [el.querySelector('.feed-who')?.textContent ?? '', el.querySelector('.actor')?.textContent ?? ''])))

test('1: two agents whose names start with the same letter get marks that tell them apart, on every page', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.activity`)
  const rows = page.getByRole('main').locator('.feed-row')
  await expect(rows.first()).toBeVisible()
  expect(await marksOf(rows)).toMatchObject({ 'claude-code': 'CC', codex: 'Co' })
  await page.goto(`${url}#view=home`)
  await expect(page.getByRole('main').getByRole('region', { name: '等你决定' }).locator('.actor')).toHaveText('Co')
})

test('2: an agent acting on its own goes unmarked; the owner’s acts are marked; the text form says it on every row', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.activity`)
  const rows = page.getByRole('main').locator('.feed-row')
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole('main').getByText('自己做的')).toHaveCount(0)
  await expect(rows.filter({ hasText: '主人面的操作' }).first()).toContainText('主人做的')
  await shoot(page, '1-2-activity', SHOTS)
  expect(pb.run(['show', 'ledger.activity', '--library', lib]).stdout).toContain('[自己做的]')
})

test('1: two agents whose own letters are the same each take the first letter that sets them apart', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  for (const agent of ['codex', 'copilot', 'claude-code']) {
    pb.run(['--library', lib, '--as', agent, 'start', `${agent} 在整理笔记`], { env: { PNEUMA_BASE_SESSION: `s-${agent}` } })
  }
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.scenes`)
  const rows = page.getByRole('main').locator('.feed-row')
  await expect(rows).toHaveCount(4)
  const marks = await rows.evaluateAll((els) => els.map((el) => [el.querySelector('.feed-line')?.textContent ?? '', el.querySelector('.actor')?.textContent ?? '']))
  expect(Object.fromEntries(marks)).toMatchObject({ 'codex 在整理笔记': 'Cd', 'copilot 在整理笔记': 'Cp', 'claude-code 在整理笔记': 'CC' })
  await shoot(page, '1-collision', SHOTS)
})

test('3: an agent’s request for the act a plugin asks about is the one row; deciding it settles both', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const decide = page.getByRole('main').getByRole('region', { name: '等你决定' })
  await expect(decide).toContainText(WHY)
  await expect(decide.getByText('deploy on sites/shop', { exact: true })).toBeVisible()
  await expect(decide).not.toContainText('可以部署，还没上线')
  await expect(decide.getByRole('button', { name: '批准', exact: true })).toHaveCount(1)
  await shoot(page, '3-one-decision', SHOTS)
  await decide.getByRole('button', { name: '拒绝', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(decide.getByRole('status')).toContainText('拒绝')
  await page.reload()
  await expect(page.getByRole('main').getByRole('region', { name: '等你决定' })).toContainText('没有要你决定的事。')
})

// ARCHITECTURE.md「问主人」: asked per place. Each directory nothing registered is in is one question with three
// answers, and is never opened until one is chosen.
test('4: a folder that had files before it became a library asks about each directory; registering one’s files makes them the owner’s', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  const old = new Date('2026-01-01T00:00:00Z')
  for (const path of ['notes/2025-review.md', 'notes/ideas.txt', 'photos/shop-front.png', 'contracts/lease.pdf']) {
    write(lib, path, `${path}\n`)
    utimesSync(join(lib, path), old, old)
  }
  pb.run(['init', lib])
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  const decide = main.getByRole('region', { name: '等你决定' })
  for (const dir of ['contracts', 'notes', 'photos']) await expect(decide).toContainText(`${dir}/ 没登记：`)
  await expect(main.getByRole('region', { name: '需要留意' })).not.toContainText('没登记的目录')
  await shoot(page, '4-ask', SHOTS)
  // The questions come in the order of the root's listing: contracts/, notes/, photos/.
  await decide.getByRole('button', { name: '登记里面的文件' }).nth(1).click()
  // Registering everything inside is a named whole pass: it says first how many it will register.
  await expect(page.getByRole('dialog')).toContainText('要登记 notes/ 里任意深处的全部文件：2 个，不含噪音。')
  await page.getByRole('dialog').getByRole('button', { name: '登记里面的文件' }).click()
  await expect(decide.getByRole('status')).toContainText('已把 notes/里的 2 个文件记为主人带进来的')
  await shoot(page, '4-registered', SHOTS)
  expect(pb.run(['inspect', 'notes/ideas.txt', '--library', lib]).stdout).toContain('带进来的，主人给的')
})

test('5: in the panel a feed row keeps its moment, in the grey line, and its whole sentence', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  const panel = page.getByRole('complementary', { name: '详情' })
  await page.goto(`${url}#view=home&panel=ledger.scene&panel.scene=sess-b`)
  const rows = panel.locator('.feed-row')
  await expect(rows.first()).toBeVisible()
  for (const row of await rows.all()) await expect(row.locator('.feed-meta-time')).toBeVisible()
  const long = panel.locator('.feed-line', { hasText: LONG })
  const box = await long.evaluate((el) => ({ shown: el.clientHeight, whole: el.scrollHeight, lines: Math.round(el.clientHeight / 20) }))
  expect(box.whole).toBeLessThanOrEqual(box.shown + 1)
  expect(box.lines).toBeGreaterThan(2)
  await shoot(page, '5-panel-feed', SHOTS)
})

test('6: a panel tab keeps a name whole when it fits and cuts a long one in the middle, the extension kept, the whole name on hover', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  const panel = page.getByRole('complementary', { name: '详情' })
  // One tab at the default width: comparison.md whole, its end clear of the close button.
  await page.goto(`${url}#view=home&panel=item&panel.path=payments%2Fcomparison.md`)
  const whole = panel.getByRole('tab')
  await expect(whole.locator('.tab-name-end')).toHaveText('son.md')
  expect(await whole.locator('.tab-name-start').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const inside = await whole.evaluate((tab) => {
    const end = tab.querySelector('.tab-name-end')?.getBoundingClientRect()
    const own = tab.getBoundingClientRect()
    return end !== undefined && end.right <= own.right - 20
  })
  expect(inside).toBe(true)
  // Two tabs: a long name is cut in the middle.
  await page.goto(`${url}#view=home&panel=item&panel.path=${encodeURIComponent(LONG_NAME)}&panel2=item&panel2.path=payments%2Fintegration-notes.md&tab=2`)
  const tabs = panel.getByRole('tab')
  await expect(tabs).toHaveCount(2)
  const cut = tabs.nth(0)
  await expect(cut).toHaveAttribute('title', 'integration-notes-for-the-checkout-page.md')
  await expect(cut.locator('.tab-name-end')).toHaveText('age.md')
  expect(await cut.locator('.tab-name-start').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
})

test('7: a decision in a thing’s timeline says 决定 once, in its tag', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  const panel = page.getByRole('complementary', { name: '详情' })
  await page.goto(`${url}#view=home&panel=item&panel.path=${encodeURIComponent(LONG_NAME)}&panel2=item&panel2.path=payments%2Fintegration-notes.md&tab=2`)
  const decision = panel.locator('.timeline > li', { hasText: LONG.slice(0, 12) })
  await expect(decision.locator('.tag')).toHaveText('决定')
  await expect(decision.locator('.timeline-line')).not.toContainText('决定')
  await decision.scrollIntoViewIfNeeded()
  await shoot(page, '6-7-tabs-and-decision', SHOTS)
})

test('9: after 都看过了 the since part says when the owner last looked and leads to the activity page', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  const since = main.getByRole('region', { name: '自上次以来' })
  await since.getByRole('button', { name: '都看过了' }).click()
  await expect(since).toContainText('上次看过：刚刚')
  await expect(since).toContainText('那之后还没有谁做过什么。')
  await shoot(page, '9-seen-all', SHOTS)
  await since.getByRole('button', { name: '看全部活动' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '活动' })).toBeVisible()
})

test('10: the scenes page opens its newest scene beside the list when the window has room, and not when it has none', async ({ page, pb }) => {
  const lib = shop(pb)
  const { url } = await pb.view(lib)
  const panel = page.getByRole('complementary', { name: '详情' })
  await page.goto(`${url}#view=ledger.scenes`)
  const first = await page.getByRole('main').locator('.feed-line').first().textContent()
  await expect(panel.getByTestId('panel-title')).toHaveText(first ?? '')
  await shoot(page, '10-scenes', SHOTS)
  // Closed, it stays closed while the page is open.
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await page.waitForTimeout(2500)
  await expect(panel).toHaveCount(0)
  // Back on the page later, it opens again; a narrow window keeps the list alone.
  await page.goto(`${url}#view=home`)
  await page.goto(`${url}#view=ledger.scenes`)
  await expect(panel.getByTestId('panel-title')).toHaveText(first ?? '')
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`${url}#view=home`)
  await page.goto(`${url}#view=ledger.scenes`)
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: '场景' })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(panel).toHaveCount(0)
})
