// C3: a library that went through the relay of packages/cli/test/relay.test.ts. The items page lists
// each thing's path, origin, who, what was being done and its state; a made thing's panel gives its
// provenance, basis with states, dependents, decisions and versions; following the basis links leads
// back to the brought-in sources.
import { cutTexts, DECIDED, DOING, expect, SOURCES, test } from './support.ts'

test('the items page and the provenance chain of a relayed library', async ({ page, relayUrl: url }) => {
  await page.goto(url)

  // The app opens on the home page; the ledger's library page is next in the navigation.
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '库' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '库' })).toBeVisible()
  const shows = main.getByRole('radiogroup', { name: '显示' })
  await expect(shows.getByRole('radio', { name: /^全部/ })).toHaveText('全部7')
  // Rows stand under their folder, so a row names the thing alone; made and consistent are the usual and go unsaid, who is a mark.
  const row = (path: string) => main.getByRole('row', { name: new RegExp(`^${path.slice(path.lastIndexOf('/') + 1).replaceAll('.', '\\.')}\\b`) })
  await expect(main.getByRole('row', { name: /^payments\/sources$/ })).toBeVisible()
  await expect(row('payments/integration-notes.md')).not.toContainText('带进来的')
  await expect(row('payments/integration-notes.md').getByRole('img', { name: /^codex/ })).toBeVisible()
  await expect(row('payments/comparison.md').getByRole('img', { name: /^claude-code/ })).toBeVisible()
  await expect(row('payments/comparison.md')).not.toContainText('一致')
  await expect(row('payments/sources/stripe-pricing.html')).toContainText('带进来的')
  // With room, nothing in the table is cut short.
  const items = main.getByRole('table')
  expect(await cutTexts(items)).toEqual([])

  // The basis chain, one panel at a time.
  const panel = page.getByRole('complementary', { name: '详情' })
  const title = panel.getByTestId('panel-title')
  const provenance = panel.getByRole('region', { name: '来历', exact: true })
  await row('payments/integration-notes.md').click()
  await expect(title).toHaveText('integration-notes.md')
  await expect(provenance).toContainText('做出来的')
  await expect(provenance).toContainText('codex')
  const basis = provenance.getByRole('region', { name: /^依据/ })
  // A source consistent with its record is the usual case: no state is said beside it.
  await expect(basis.getByRole('listitem').filter({ hasText: 'payments/recommendation.md' }).locator('.tag')).toHaveCount(0)

  await basis.getByRole('button', { name: /payments\/recommendation\.md/ }).click()
  await expect(title).toHaveText('recommendation.md')
  await expect(provenance.getByRole('region', { name: '被什么依据' })).toContainText('payments/integration-notes.md')
  await basis.getByRole('button', { name: /payments\/comparison\.md/ }).click()

  await expect(title).toHaveText('comparison.md')
  await expect(provenance).toContainText(DOING)
  const happened = provenance.getByRole('region', { name: '发生过什么' })
  await expect(happened).toContainText(DECIDED)
  await expect(basis).toContainText('主人在对话里说：客户主要在欧洲')
  for (const source of Object.keys(SOURCES)) await expect(basis.getByRole('listitem').filter({ hasText: source }).locator('.tag')).toHaveCount(0)
  await expect(happened).toContainText('放进来')
  await expect(row('payments/comparison.md')).toHaveAttribute('aria-selected', 'true')
  // With the panel open, the paths keep their width; other columns give way.
  expect(await cutTexts(items, 'td:first-child')).toEqual([])

  await basis.getByRole('button', { name: /payments\/sources\/stripe-pricing\.html/ }).click()
  await expect(title).toHaveText('stripe-pricing.html')
  await expect(provenance).toContainText('带进来的')
  await expect(provenance).toContainText('https://stripe.com/pricing')
  await expect(panel.getByRole('figure', { name: '预览' })).toContainText('Stripe pricing')

  // Back goes up the chain again.
  await panel.getByRole('button', { name: '返回' }).click()
  await expect(title).toHaveText('comparison.md')

  // Filters narrow the table.
  await shows.getByRole('radio', { name: /^带进来的/ }).click()
  await expect(items.locator('tbody tr:not(.group-row)')).toHaveCount(4)
  await expect(row('payments/comparison.md')).toHaveCount(0)

  // The config page of a library with the ledger and two grants.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '配置' }).click()
  await expect(page.getByRole('region', { name: '授权与技能' }).getByRole('row', { name: /codex/ })).toBeVisible()
  await panel.getByRole('button', { name: '关闭详情' }).click()

  // By keyboard: a row opens its panel with Enter; Escape closes it.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '库' }).click()
  await row('payments/comparison.md').focus()
  await page.keyboard.press('Enter')
  await expect(title).toHaveText('comparison.md')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})
