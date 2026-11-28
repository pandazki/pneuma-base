// C4: the scenes page lists each session and opens its page, with its figures; the standing page lists
// what needs looking at, by kind, and a file added, removed or moved outside the UI shows up there
// within five seconds without a reload (a file edited in place, on the page's next fetch: ARCHITECTURE.md「界面的服务」, the
// poll looks at the facts and the open directories only); the activity page lists recent facts, newest
// first, the owner's acts marked and an agent's own not, with filters that count what they keep.
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DECIDED, DOING, expect, navTitles, openShared, relay, test, write } from './support.ts'

test('scenes, standing and activity: what happened and what needs attention', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  expect(await navTitles(page)).toEqual(['首页', '库', '活动', '文件', 'Agent', '配置'])
  const nav = page.getByRole('navigation', { name: '导航' })
  const main = page.getByRole('main')
  const panel = page.getByRole('complementary', { name: '详情' })
  const title = panel.getByTestId('panel-title')

  // Scenes: each session with who, what it was doing and how many things; a row opens its page.
  await openShared(page, '活动', '场景')
  await expect(main.getByRole('heading', { level: 1, name: '场景' })).toBeVisible()
  const sceneRow = (text: string) => main.getByRole('listitem').filter({ hasText: text })
  await expect(sceneRow(DOING).getByRole('img', { name: /^claude-code/ })).toBeVisible()
  await expect(sceneRow(DOING)).toContainText('放入 6 样')
  await expect(sceneRow('把支付服务接进电子书小店').getByRole('img', { name: /^codex/ })).toBeVisible()
  await expect(sceneRow('主人面的操作')).toContainText('grant create')
  await sceneRow(DOING).getByRole('link').click()
  await expect(title).toHaveText(DOING)
  // Only the figures that are not nothing; a session of under a minute does not say how long it took.
  for (const label of ['放入', '依据', '决定']) await expect(panel.getByText(label, { exact: true })).toBeVisible()
  await expect(panel.locator('.stat').filter({ hasText: '放入' })).toContainText('6')
  // The page is the scene, so what happened in it needs no heading of its own.
  const happened = panel.locator('.feed')
  await expect(happened).toContainText(DECIDED)
  const puts = happened.getByRole('listitem').filter({ has: page.getByRole('img', { name: /^(放入|带进来)$/ }) })
  await expect(puts).toHaveCount(6)
  await puts.filter({ hasText: 'comparison.md' }).getByRole('link').click()
  await expect(title).toHaveText('comparison.md')
  await panel.getByRole('button', { name: '返回' }).click()
  await expect(title).toHaveText(DOING)

  // Standing: nothing yet; a file edited in place in the Finder appears at the page's next fetch.
  await openShared(page, '库', '状况')
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await expect(main.getByText('没有要处理的事')).toBeVisible()
  writeFileSync(join(lib, 'payments/sources/stripe-pricing.html'), '<html>Stripe pricing: 3.4% now</html>')
  await page.reload()
  const section = (name: string) => main.getByRole('region', { name, exact: true })
  await expect(section('被直接改过的').getByRole('listitem').filter({ hasText: 'payments/sources/stripe-pricing.html' })).toBeVisible({ timeout: 5_000 })
  await expect(section('可能过期')).toContainText('payments/comparison.md')

  // Every other kind, within five seconds: a file nobody registered, a source deleted, a source moved
  // within the directories the records point into.
  write(lib, 'payments/dropped-by-hand.md', '从访达拖进来的')
  rmSync(join(lib, 'payments/sources/lemonsqueezy-pricing.html'))
  renameSync(join(lib, 'payments/sources/paddle-pricing.html'), join(lib, 'payments/paddle-pricing.html'))
  await expect(section('挪过的')).toContainText('payments/paddle-pricing.html', { timeout: 5_000 })
  await expect(section('没人登记过的')).toContainText('payments/dropped-by-hand.md')
  await expect(section('不在了的')).toContainText('payments/sources/lemonsqueezy-pricing.html')
  await expect(section('来源不在')).toContainText('payments/comparison.md')
  await expect(section('上游有标记')).toContainText('payments/recommendation.md')
  await section('被直接改过的').getByRole('button', { name: 'payments/sources/stripe-pricing.html' }).click()
  await expect(title).toHaveText('stripe-pricing.html')

  // Activity: newest first, the owner's operations among them.
  await nav.getByRole('button', { name: '活动' }).click()
  await panel.getByRole('button', { name: '关闭详情' }).click()
  const rows = main.getByRole('listitem')
  await expect(rows.first().locator('.feed-name')).toHaveText('integration-notes.md')
  await expect(rows.first().getByRole('img', { name: /^codex/ })).toBeVisible()
  const granted = rows.filter({ has: page.locator('.feed-line[title^="pneuma-base grant create "]') })
  await expect(granted.first().getByRole('img', { name: '主人' })).toBeVisible()
  // An agent acting on its own is the ordinary case, and goes unmarked.
  await expect(main.getByText('自己做的')).toHaveCount(0)
  const who = main.getByRole('radiogroup', { name: '谁做的' })
  const owner = who.getByRole('radio', { name: /^主人做的/ })
  await owner.click()
  await expect(rows.filter({ hasText: 'integration-notes.md' })).toHaveCount(0)
  await expect(granted).toHaveCount(2)
  await expect(owner).toHaveText(`主人做的${await rows.count()}`)
})
