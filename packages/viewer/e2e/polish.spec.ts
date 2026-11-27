// What the first look at the pages with real data showed, each in the browser: marks that tell
// agents apart, the panel's feed rows and tab names, and a scenes page that uses its width.
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, frames, relay, shared, tempDir, test, write, type Cli } from './support.ts'

const B = { env: { PNEUMA_BASE_SESSION: 'sess-b' } }
const LONG = '结账页先只接 Paddle：它替我们处理欧洲的增值税，退款流程也由它来做，等第二家支付服务的需求明确之后再说要不要接 Stripe'
const LONG_NAME = 'payments/integration-notes-for-the-checkout-page.md'

/** The relay library, with a thing of a long name codex made and a long decision of codex's. */
function notes(pb: Cli): string {
  const lib = relay(pb)
  const dir = tempDir('pb-e2e-notes-')
  write(dir, 'notes.md', '# 结账页的接入笔记\n')
  pb.run(['@codex', 'put', 'notes.md', '--to', LONG_NAME, '--made', '--from', 'payments/recommendation.md'], { cwd: dir, ...B })
  pb.run(['@codex', 'say', 'decided', LONG, '--about', 'payments/integration-notes.md'], B)
  return lib
}

/** Each row's line, or who its mark says it is (the mark's name, before the grant), and the letters of its mark. */
const marksOf = (rows: Locator, by: '.feed-line' | 'who') =>
  rows.evaluateAll(
    (els, key) =>
      Object.fromEntries(
        els.map((el) => {
          const mark = el.querySelector('.actor')
          return [key === 'who' ? (mark?.getAttribute('aria-label') ?? '').split(' · ')[0] : (el.querySelector(key)?.textContent ?? ''), mark?.textContent ?? '']
        }),
      ),
    by,
  )

test('agents get marks that tell them apart: two from the name, or the first later letter that sets them apart, the same on every page', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  for (const agent of ['codex', 'copilot', 'claude-code', 'gemini']) {
    pb.run(['--library', lib, '--as', agent, 'start', `${agent} 在整理笔记`], { env: { PNEUMA_BASE_SESSION: `s-${agent}` } })
  }
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.scenes`)
  const rows = page.getByRole('main').locator('.feed-row')
  await expect(rows).toHaveCount(5)
  const marks = { 'codex 在整理笔记': 'Cd', 'copilot 在整理笔记': 'Cp', 'claude-code 在整理笔记': 'CC', 'gemini 在整理笔记': 'Ge' }
  expect(await marksOf(rows, '.feed-line')).toMatchObject(marks)
  await page.goto(`${url}#view=home`)
  const since = page.getByRole('main').getByRole('region', { name: '自上次以来' }).locator('.feed-row')
  await expect(since).toHaveCount(4)
  expect(await marksOf(since, 'who')).toMatchObject({ codex: 'Cd', copilot: 'Cp', 'claude-code': 'CC', gemini: 'Ge' })
})

// The two tests that only look at it share one, built once per worker.
const withNotes = test.extend<object, { notesUrl: string }>({ notesUrl: shared(notes) })

withNotes('in the panel a feed row keeps its moment, in the grey line, and its whole sentence', async ({ page, notesUrl: url }) => {
  const panel = page.getByRole('complementary', { name: '详情' })
  await page.goto(`${url}#view=home&panel=ledger.scene&panel.scene=sess-b`)
  const rows = panel.locator('.feed-row')
  await expect(rows.first()).toBeVisible()
  for (const row of await rows.all()) await expect(row.locator('.feed-meta-time')).toBeVisible()
  const long = panel.locator('.feed-line', { hasText: LONG })
  const box = await long.evaluate((el) => ({ shown: el.clientHeight, whole: el.scrollHeight, lines: Math.round(el.clientHeight / 20) }))
  expect(box.whole).toBeLessThanOrEqual(box.shown + 1)
  expect(box.lines).toBeGreaterThan(2)
})

withNotes('a panel tab keeps a name whole when it fits and cuts a long one in the middle, the extension kept, the whole name on hover', async ({ page, notesUrl: url }) => {
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

test('the scenes page opens its newest scene beside the list when the window has room, and not when it has none', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  pb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', 'start', '整理笔记'])
  pb.run(['--library', lib, '--as', 'codex', '--session', 's2', 'start', '写周报'])
  const { url } = await pb.view(lib)
  const panel = page.getByRole('complementary', { name: '详情' })
  const lines = page.getByRole('main').locator('.feed-line')
  await page.goto(`${url}#view=ledger.scenes`)
  const first = await lines.first().textContent()
  await expect(panel.getByTestId('panel-title')).toHaveText(first ?? '')
  // Closed, it stays closed while the page is open, even when the page fetches a newer scene.
  await panel.getByRole('button', { name: '关闭详情' }).click()
  pb.run(['--library', lib, '--as', 'codex', '--session', 's3', 'start', '又开了一次会话'])
  await expect(lines.first()).toHaveText('又开了一次会话')
  await frames(page)
  await expect(panel).toHaveCount(0)
  // Back on the page later, it opens again; a narrow window keeps the list alone.
  await page.goto(`${url}#view=home`)
  await page.goto(`${url}#view=ledger.scenes`)
  await expect(panel.getByTestId('panel-title')).toHaveText('又开了一次会话')
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`${url}#view=home`)
  await page.goto(`${url}#view=ledger.scenes`)
  await expect(lines.first()).toHaveText('又开了一次会话')
  // The page opens its panel, if at all, right after the list arrives.
  await frames(page)
  await expect(panel).toHaveCount(0)
  expect(new URL(page.url()).hash).not.toContain('panel=')
})
