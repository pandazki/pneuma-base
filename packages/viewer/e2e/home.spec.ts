// The pages that say what the owner came for: the home page with what waits on the owner, what
// agents did since the owner last looked and what needs looking at; the activity page's filters
// with counts; the library's folder tree; a scene's page.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOING, expect, navTitles, relay, shoot, tempDir, test, write, type Cli } from './support.ts'

/** The relay library, with deploy installed and a site codex declared deployable that nobody switched yet. */
function withAsk(pb: Cli): string {
  const lib = relay(pb)
  pb.run(['plugin', 'add', 'deploy', '--library', lib])
  pb.run(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-e2e-www-'), 'www'), '--library', lib])
  const dir = tempDir('pb-e2e-site-')
  write(dir, 'shop/index.html', '<h1>小店</h1>')
  pb.run(['@codex', 'put', 'shop', '--to', 'sites/shop', '--made'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  pb.run(['@codex', 'say', 'deployable', 'sites/shop'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  return lib
}

test('the app opens on the home page: what waits on the owner, what agents did since the last look by scene, and what needs looking at', async ({ page, pb }) => {
  const lib = withAsk(pb)
  writeFileSync(join(lib, 'payments/sources/stripe-pricing.html'), '<html>Stripe pricing: 3.4% now</html>')
  const { url } = await pb.view(lib)
  await page.goto(url)
  expect((await navTitles(page)).slice(0, 4)).toEqual(['首页', '库', '活动', '场景'])
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()

  const decide = main.getByRole('region', { name: '等你决定' })
  await expect(decide).toContainText('codex 说 sites/shop 可以部署，还没上线。要上线吗？')
  await expect(decide.getByRole('button', { name: '上线', exact: true })).toHaveClass(/btn-primary/)

  const since = main.getByRole('region', { name: '自上次以来' })
  await expect(since.getByRole('button', { name: DOING })).toBeVisible()
  await expect(since.getByRole('button', { name: '把支付服务接进电子书小店' })).toBeVisible()
  await expect(since.getByRole('listitem').filter({ hasText: '放入 payments/integration-notes.md' })).toContainText('codex')
  // The heading says what the scene was doing; the same sentence is not a row under it as well.
  await expect(since.getByRole('listitem').filter({ hasText: `在做：${DOING}` })).toHaveCount(0)

  const attention = main.getByRole('region', { name: '需要留意' })
  await attention.getByRole('button', { name: '1 样被直接改过的' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '状况 · 被直接改过的' })).toBeVisible()
  await expect(main.getByRole('region', { name: '被直接改过的' })).toContainText('payments/sources/stripe-pricing.html')
  await page.goBack()
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  await shoot(page, 'u2-home')
})

test('deciding an ask runs its answer and folds it in place into what was decided', async ({ page, pb }) => {
  const lib = withAsk(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const decide = page.getByRole('main').getByRole('region', { name: '等你决定' })
  await decide.getByRole('button', { name: '上线', exact: true }).click()
  const receipt = decide.getByRole('status')
  await expect(receipt).toContainText('上线')
  await expect(receipt).toContainText('sites/shop')
  await expect(decide.getByRole('button', { name: '上线', exact: true })).toHaveCount(0)
  // The ask is gone from the answer now; the receipt stays where the ask was while the page is open.
  await page.waitForTimeout(2500)
  await expect(receipt).toBeVisible()
  expect(pb.run(['deploy', 'list', '--library', lib]).stdout).toContain('sites/shop')
  expect(pb.run(['@claude', 'check', '--session', 'later']).stdout).not.toContain('要主人来做的')
})

test('都看过了 empties 自上次以来 until an agent does something new', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const since = page.getByRole('main').getByRole('region', { name: '自上次以来' })
  await expect(since.getByRole('listitem').first()).toBeVisible()
  await since.getByRole('button', { name: '都看过了' }).click()
  await expect(since).toContainText('你上次看过之后，agent 没有做过什么。')
  await expect(since.getByRole('listitem')).toHaveCount(0)
  await expect(since.getByRole('button', { name: '都看过了' })).toHaveCount(0)

  const dir = tempDir('pb-e2e-c-')
  writeFileSync(join(dir, 'later.md'), '# 后来的\n')
  pb.run(['@claude', 'put', 'later.md', '--to', 'notes/later.md', '--made'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-c' } })
  await expect(since.getByRole('listitem').filter({ hasText: '放入 notes/later.md' })).toBeVisible()
})

test('with no plugin, the home page says so and shows the files', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  write(lib, 'notes/a.md', 'a')
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  await expect(main.getByRole('region', { name: '等你决定' })).toContainText('没有要你决定的事。')
  await expect(main).toContainText('这个库没装插件')
  await expect(main.getByRole('region', { name: '库里的文件' }).getByRole('row', { name: /notes/ })).toBeVisible()
  await shoot(page, 'u2-home-bare')
})

test('activity: by day, who did each, with filters that count what they keep', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.activity`)
  const main = page.getByRole('main')
  const who = main.getByRole('radiogroup', { name: '谁做的' })
  const agent = main.getByRole('radiogroup', { name: '哪个 agent' })
  const rows = main.getByRole('listitem')
  await expect(rows.first()).toBeVisible()
  const all = await rows.count()
  await expect(who.getByRole('radio', { name: /^全部/ })).toHaveText(`全部${all}`)
  await who.getByRole('radio', { name: /^主人做的/ }).click()
  await expect(who.getByRole('radio', { name: /^主人做的/ })).toHaveAttribute('aria-checked', 'true')
  await expect(rows.first()).toContainText('主人面的操作')
  await expect(who.getByRole('radio', { name: /^主人做的/ })).toHaveText(`主人做的${await rows.count()}`)
  await who.getByRole('radio', { name: /^全部/ }).click()
  await agent.getByRole('radio', { name: /^codex/ }).click()
  const codex = Number((await agent.getByRole('radio', { name: /^codex/ }).innerText()).replace(/\D/g, ''))
  await expect(rows).toHaveCount(codex)
  for (const text of await rows.allInnerTexts()) expect(text).toContain('codex')
  await shoot(page, 'u2-activity')
})

test('the library page: choosing a folder in the tree shows what is in it, and the address keeps it', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.items`)
  const main = page.getByRole('main')
  const tree = main.getByRole('tree', { name: '文件夹' })
  const folder = (value: string) => tree.locator(`[role=treeitem][data-value="${value}"]`)
  // Choosing payments opens it as well; its folder inside then shows.
  await folder('payments').locator('.aui-tree-row').first().click()
  await expect(folder('payments')).toHaveAttribute('aria-expanded', 'true')
  const sources = folder('payments/sources')
  await sources.locator('.aui-tree-row').first().click()
  await expect(sources).toHaveAttribute('aria-selected', 'true')
  await expect(main.getByRole('row')).toHaveCount(5)
  expect(page.url()).toContain('view.dir=payments%2Fsources')
  await page.reload()
  await expect(main.getByRole('row')).toHaveCount(5)
  await shoot(page, 'u2-library')
})

test('a scene’s page: its figures, its conversation and what happened in it', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.scenes`)
  const main = page.getByRole('main')
  await main.getByRole('link', { name: new RegExp(DOING) }).click()
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(panel.getByTestId('panel-title')).toHaveText(DOING)
  for (const label of ['时长', '放入', '依据', '决定']) await expect(panel.getByText(label, { exact: true })).toBeVisible()
  await expect(panel.locator('.aui-stat').filter({ hasText: '放入' })).toContainText('6')
  await expect(panel.getByRole('listitem').filter({ hasText: '放入 payments/comparison.md' })).toBeVisible()
  await shoot(page, 'u2-scene')
})
