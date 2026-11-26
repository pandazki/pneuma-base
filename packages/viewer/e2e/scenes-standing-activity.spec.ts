// C4: the scenes page lists each session and opens its card; the standing page lists what needs
// looking at, by kind, and a file changed outside the UI shows up there within five seconds without
// a reload; the activity page lists recent facts, the owner's operations included, newest first.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DECIDED, DOING, expect, navTitles, relay, shoot, test, write } from './support.ts'

test('scenes, standing and activity: what happened and what needs attention', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  expect(await navTitles(page)).toEqual(['条目', '场景', '状况', '动态', '留存', '文件', '归档区', 'Agent', '配置'])
  const nav = page.getByRole('navigation', { name: '导航' })
  const main = page.getByRole('main')
  const panel = page.getByRole('complementary', { name: '详情' })
  const title = panel.getByTestId('panel-title')

  // Scenes: each session with who, what it was doing and how many things; a row opens the card.
  await nav.getByRole('button', { name: '场景' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '场景' })).toBeVisible()
  const sceneRow = (text: string) => main.getByRole('row').filter({ hasText: text })
  await expect(sceneRow(DOING)).toContainText('claude-code')
  await expect(sceneRow('把支付服务接进电子书小店')).toContainText('codex')
  await expect(sceneRow('主人面的操作')).toContainText('grant issue')
  await sceneRow(DOING).click()
  await expect(title).toHaveText('场景 sess-a')
  await expect(panel.getByRole('region', { name: '说过的话' })).toContainText(DECIDED)
  const things = panel.getByRole('region', { name: '条目' })
  await expect(things.getByRole('listitem')).toHaveCount(6)
  await things.getByRole('button', { name: 'payments/comparison.md' }).click()
  await expect(title).toHaveText('comparison.md')
  await panel.getByRole('button', { name: '返回' }).click()
  await expect(title).toHaveText('场景 sess-a')
  await shoot(page, 'c4-scenes')

  // Standing: nothing yet; a file changed in the Finder appears within five seconds, no reload.
  await nav.getByRole('button', { name: '状况' }).click()
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await expect(main.getByText('没有要处理的事')).toBeVisible()
  writeFileSync(join(lib, 'payments/sources/stripe-pricing.html'), '<html>Stripe pricing: 3.4% now</html>')
  const section = (name: string) => main.getByRole('region', { name, exact: true })
  await expect(section('被直接改过的').getByRole('listitem').filter({ hasText: 'payments/sources/stripe-pricing.html' })).toBeVisible({ timeout: 5_000 })
  await expect(section('可能过期')).toContainText('payments/comparison.md')

  // Every other kind: a file nobody registered, a source deleted, a source moved.
  write(lib, 'payments/dropped-by-hand.md', '从访达拖进来的')
  rmSync(join(lib, 'payments/sources/lemonsqueezy-pricing.html'))
  mkdirSync(join(lib, 'payments/old'))
  renameSync(join(lib, 'payments/sources/paddle-pricing.html'), join(lib, 'payments/old/paddle-pricing.html'))
  await expect(section('挪过的')).toContainText('payments/old/paddle-pricing.html', { timeout: 5_000 })
  await expect(section('没人登记过的')).toContainText('payments/dropped-by-hand.md')
  await expect(section('不在了的')).toContainText('payments/sources/lemonsqueezy-pricing.html')
  await expect(section('来源不在')).toContainText('payments/comparison.md')
  await expect(section('上游有标记')).toContainText('payments/recommendation.md')
  await shoot(page, 'c4-standing')
  await section('被直接改过的').getByRole('button', { name: 'payments/sources/stripe-pricing.html' }).click()
  await expect(title).toHaveText('stripe-pricing.html')

  // Activity: newest first, the owner's operations among them.
  await nav.getByRole('button', { name: '动态' }).click()
  await panel.getByRole('button', { name: '关闭详情' }).click()
  const rows = main.getByRole('row')
  await expect(rows.nth(1)).toContainText('payments/integration-notes.md')
  await expect(rows.nth(1)).toContainText('codex')
  await expect(rows.filter({ hasText: 'grant issue' }).first()).toContainText('主人')
  await main.getByRole('radio', { name: '主人' }).click()
  await expect(rows.filter({ hasText: 'integration-notes.md' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'grant issue' })).toHaveCount(2)
  await main.getByRole('radio', { name: '全部' }).click()
  await shoot(page, 'c4-activity')
})
