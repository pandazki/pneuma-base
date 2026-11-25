// C3: a library that went through the relay of packages/cli/test/relay.test.ts. The items page lists
// each thing's path, origin, who, what was being done and its state; a made thing's panel gives its
// provenance, basis with states, dependents, decisions and versions; following the basis links leads
// back to the brought-in sources.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, shoot, tempDir, test, type Cli } from './support.ts'

const DOING = '给电子书小店选支付服务'
const DECIDED = '主人决定用 Paddle，因为它替他处理欧洲的税'
const SOURCES = {
  'payments/sources/stripe-pricing.html': 'https://stripe.com/pricing',
  'payments/sources/paddle-pricing.html': 'https://www.paddle.com/pricing',
  'payments/sources/lemonsqueezy-pricing.html': 'https://www.lemonsqueezy.com/pricing',
}

/** Session A (claude-code) brings four sources and makes two things; session B (codex) makes one from A's output. */
function relay(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  const dirA = tempDir('pb-e2e-a-')
  const dirB = tempDir('pb-e2e-b-')
  pb.run(['init', lib])
  pb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code'])
  pb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex'])
  writeFileSync(join(dirA, 'stripe.html'), '<html>Stripe pricing: 2.9% + 30c</html>')
  writeFileSync(join(dirA, 'paddle.html'), '<html>Paddle pricing: 5% + 50c, merchant of record</html>')
  writeFileSync(join(dirA, 'eu-vat.txt'), 'EU VAT applies to e-books sold to EU customers.')
  writeFileSync(join(dirA, 'comparison.md'), '# 支付服务对比\n\nStripe、Paddle、Lemon Squeezy 的费率和欧洲增值税的处理。\n')
  writeFileSync(join(dirA, 'recommendation.md'), '# 建议\n\n电子书小店的支付用 Paddle。\n')
  writeFileSync(join(dirB, 'integration.md'), '# 接入 Paddle\n')
  const A = (args: string[], input?: string) => pb.run(['@claude', ...args, '--session', 'sess-a'], { cwd: dirA, ...(input === undefined ? {} : { input }) })
  const B = (args: string[]) => pb.run(['@codex', ...args], { cwd: dirB, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  A(['start', DOING])
  A(['put', 'stripe.html', '--to', 'payments/sources/stripe-pricing.html', '--brought', '--source', SOURCES['payments/sources/stripe-pricing.html']])
  A(['put', 'paddle.html', '--to', 'payments/sources/paddle-pricing.html', '--brought', '--source', SOURCES['payments/sources/paddle-pricing.html']])
  A(['put', '-', '--to', 'payments/sources/lemonsqueezy-pricing.html', '--brought', '--source', SOURCES['payments/sources/lemonsqueezy-pricing.html']], '<html>Lemon Squeezy: 5% + 50c</html>')
  A(['put', 'eu-vat.txt', '--to', 'payments/sources/eu-vat-note.txt', '--brought', '--by', 'owner'])
  A(['put', 'comparison.md', '--to', 'payments/comparison.md', '--made', '--from', ...Object.keys(SOURCES), '--from-outside', '主人在对话里说：客户主要在欧洲'])
  A(['put', 'recommendation.md', '--to', 'payments/recommendation.md', '--made', '--from', 'payments/comparison.md', 'payments/sources/eu-vat-note.txt'])
  A(['say', 'decided', DECIDED])
  B(['start', '把支付服务接进电子书小店'])
  B(['put', 'integration.md', '--to', 'payments/integration-notes.md', '--made', '--from', 'payments/recommendation.md'])
  return lib
}

test('the items page and the provenance chain of a relayed library', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)

  // The ledger's page comes first in the navigation, so it is what opens.
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '条目' })).toBeVisible()
  await expect(main.getByText('7 样东西')).toBeVisible()
  const row = (path: string) => main.getByRole('row', { name: new RegExp(`^${path.replaceAll('.', '\\.')}\\b`) })
  await expect(row('payments/integration-notes.md')).toContainText('做出来的')
  await expect(row('payments/integration-notes.md')).toContainText('codex')
  await expect(row('payments/integration-notes.md')).toContainText('把支付服务接进电子书小店')
  await expect(row('payments/comparison.md')).toContainText('claude-code')
  await expect(row('payments/comparison.md')).toContainText(DOING)
  await expect(row('payments/comparison.md')).toContainText('一致')
  await expect(row('payments/sources/stripe-pricing.html')).toContainText('带进来的')

  // The basis chain, one panel at a time.
  const panel = page.getByRole('complementary', { name: '详情' })
  const title = panel.getByTestId('panel-title')
  const provenance = panel.getByRole('region', { name: '来历', exact: true })
  await row('payments/integration-notes.md').click()
  await expect(title).toHaveText('integration-notes.md')
  await expect(provenance).toContainText('做出来的')
  await expect(provenance).toContainText('codex')
  const basis = provenance.getByRole('region', { name: '依据', exact: true })
  await expect(basis.getByRole('listitem').filter({ hasText: 'payments/recommendation.md' })).toContainText('一致')

  await basis.getByRole('button', { name: /payments\/recommendation\.md/ }).click()
  await expect(title).toHaveText('recommendation.md')
  await expect(provenance.getByRole('region', { name: '被什么依据' })).toContainText('payments/integration-notes.md')
  await basis.getByRole('button', { name: /payments\/comparison\.md/ }).click()

  await expect(title).toHaveText('comparison.md')
  await expect(provenance).toContainText(DOING)
  await expect(provenance.getByRole('region', { name: '决定与备注' })).toContainText(DECIDED)
  await expect(basis).toContainText('主人在对话里说：客户主要在欧洲')
  for (const source of Object.keys(SOURCES)) await expect(basis.getByRole('listitem').filter({ hasText: source })).toContainText('一致')
  await expect(provenance.getByRole('region', { name: '版本' })).toContainText('当前')
  await expect(row('payments/comparison.md')).toHaveAttribute('aria-selected', 'true')
  await shoot(page, 'c3-items-with-detail')

  await basis.getByRole('button', { name: /payments\/sources\/stripe-pricing\.html/ }).click()
  await expect(title).toHaveText('stripe-pricing.html')
  await expect(provenance).toContainText('带进来的')
  await expect(provenance).toContainText('https://stripe.com/pricing')
  await expect(panel.getByLabel('预览')).toContainText('Stripe pricing')

  // Back goes up the chain again.
  await panel.getByRole('button', { name: '返回' }).click()
  await expect(title).toHaveText('comparison.md')

  // Filters narrow the table.
  await main.getByLabel('来历').selectOption('brought')
  await expect(main.getByText('4 样东西')).toBeVisible()
  await expect(row('payments/comparison.md')).toHaveCount(0)

  // The config page of a library with the ledger and two grants.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '配置' }).click()
  await expect(page.getByRole('region', { name: '授权与技能' }).getByRole('row', { name: /codex/ })).toBeVisible()
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await shoot(page, 'c3-config')
})
