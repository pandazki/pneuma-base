// The pages that say what the owner came for: the home page with what waits on the owner, what
// agents did since the owner last looked and what needs looking at; deciding an agent's request there;
// the library's folder tree.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOING, expect, navTitles, relay, tempDir, test, write, type Cli } from './support.ts'

/** A library with the ledger and two grants: claude for claude-code, codex for codex. */
function twoGrants(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  pb.run(['grant', 'create', 'claude', '--library', lib, '--agent', 'claude-code'])
  pb.run(['grant', 'create', 'codex', '--library', lib, '--agent', 'codex'])
  return lib
}

/** The relay library, with deploy installed and a site codex declared deployable that nobody switched yet. */
function withAsk(pb: Cli): string {
  const lib = relay(pb)
  pb.run(['plugin', 'enable', 'deploy', '--library', lib])
  pb.run(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-e2e-www-'), 'www'), '--library', lib])
  const dir = tempDir('pb-e2e-site-')
  write(dir, 'shop/index.html', '<h1>小店</h1>')
  pb.run(['@codex', 'put', 'shop', '--to', 'sites/shop', '--generated'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  pb.run(['@codex', 'say', 'deployable', 'sites/shop'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  return lib
}

test('the app opens on the home page: what waits on the owner, what agents did since the last look by scene, and what needs looking at', async ({ page, pb }) => {
  const lib = withAsk(pb)
  writeFileSync(join(lib, 'payments/sources/stripe-pricing.html'), '<html>Stripe pricing: 3.4% now</html>')
  const { url } = await pb.view(lib)
  await page.goto(url)
  expect((await navTitles(page)).slice(0, 5)).toEqual(['首页', '库', '活动', '文件', 'Agent'])
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()

  const decide = main.getByRole('region', { name: '等你决定' })
  await expect(decide).toContainText('codex 说 sites/shop 可以部署，还没上线。要上线吗？')
  await expect(decide.getByRole('button', { name: '上线', exact: true })).toHaveClass(/btn-primary/)

  const since = main.getByRole('region', { name: '自上次以来' })
  await expect(since.getByRole('button', { name: DOING })).toBeVisible()
  await expect(since.getByRole('button', { name: '把支付服务接进电子书小店' })).toBeVisible()
  // Who is the row's mark; its name is in the mark's tooltip, not repeated in the row. The act is an icon, the thing its name, the whole sentence the tooltip.
  const put = since.getByRole('listitem').filter({ hasText: 'integration-notes.md' }).filter({ has: page.getByRole('img', { name: '放入' }) })
  await expect(put.getByRole('img', { name: /^codex/ })).toBeVisible()
  await expect(put.locator('.feed-line')).toHaveAttribute('title', /^放入 payments\/integration-notes\.md/)
  // The heading says what the scene was doing; the same sentence is not a row under it as well.
  await expect(since.getByRole('listitem').filter({ hasText: `在做：${DOING}` })).toHaveCount(0)

  const attention = main.getByRole('region', { name: '需要留意' })
  await attention.getByRole('button', { name: '1 样被直接改过的' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '状况 · 被直接改过的' })).toBeVisible()
  await expect(main.getByRole('region', { name: '被直接改过的' })).toContainText('payments/sources/stripe-pricing.html')
  await page.goBack()
  await expect(main.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
})

test('an agent’s request: its reason with the command under it; approving or declining in the browser folds it, and the command line then shows it decided', async ({ page, pb }) => {
  const lib = twoGrants(pb)
  pb.run(['@codex', 'ask', '要给支付方案留住每一版', 'plugin', 'enable', 'version'], { env: { PNEUMA_BASE_SESSION: 'sess-b' } })
  const { url } = await pb.view(lib)
  await page.goto(url)
  const decide = page.getByRole('main').getByRole('region', { name: '等你决定' })
  await expect(decide).toContainText('要给支付方案留住每一版')
  await expect(decide.getByText('plugin enable version', { exact: true })).toBeVisible()
  await expect(decide).toContainText('codex')
  await expect(decide.getByRole('button', { name: '批准', exact: true })).toHaveClass(/btn-primary/)
  await decide.getByRole('button', { name: '批准', exact: true }).click()
  const receipt = decide.getByRole('status')
  await expect(receipt).toContainText('批准')
  await expect(receipt).toContainText('已装上插件 version')
  expect(pb.run(['request', 'list', '--all', '--library', lib]).stdout).toMatch(/plugin enable version · 已批准/)
  expect(pb.run(['@codex', 'check'], { env: { PNEUMA_BASE_SESSION: 'sess-later' } }).stdout).toContain('plugin enable version：已批准')

  // A request asked while the page is open shows up on its own; declining asks for a reason first.
  pb.run(['@claude', 'ask', '支付接好了，codex 用不着写了', 'grant', 'revoke', 'codex'], { env: { PNEUMA_BASE_SESSION: 'sess-a2' } })
  await expect(decide.getByText('grant revoke codex', { exact: true })).toBeVisible()
  // The page fetched again for it; the receipt of the first decision stays where its request was.
  await expect(decide.getByRole('status').filter({ hasText: '批准' })).toContainText('已装上插件 version')
  await decide.getByRole('button', { name: '拒绝', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('理由').fill('codex 还要改接入说明')
  await dialog.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(decide.getByRole('status').filter({ hasText: '拒绝' })).toContainText('codex 还要改接入说明')
  expect(pb.run(['request', 'list', '--all', '--library', lib]).stdout).toMatch(/grant revoke codex · 已拒绝.*codex 还要改接入说明/)
  expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).grants.map((g: { name: string }) => g.name)).toContain('codex')
})

test('都看过了 empties 自上次以来, says when the owner last looked and leads to the activity, until an agent does something new', async ({ page, pb }) => {
  const lib = twoGrants(pb)
  const dir = tempDir('pb-e2e-c-')
  writeFileSync(join(dir, 'first.md'), '# 先前的\n')
  writeFileSync(join(dir, 'later.md'), '# 后来的\n')
  pb.run(['@claude', 'put', 'first.md', '--to', 'notes/first.md', '--generated'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-a' } })
  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  const since = main.getByRole('region', { name: '自上次以来' })
  await expect(since.getByRole('listitem').first()).toBeVisible()
  await since.getByRole('button', { name: '都看过了' }).click()
  await expect(since).toContainText('上次看过：刚刚')
  await expect(since).toContainText('那之后还没有谁做过什么。')
  await expect(since.getByRole('listitem').filter({ has: page.getByRole('img', { name: /^(放入|带进来)$/ }) })).toHaveCount(0)
  await expect(since.getByRole('button', { name: '都看过了' })).toHaveCount(0)
  await since.getByRole('button', { name: '看全部活动' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '活动' })).toBeVisible()
  await page.goBack()

  pb.run(['@claude', 'put', 'later.md', '--to', 'notes/later.md', '--generated'], { cwd: dir, env: { PNEUMA_BASE_SESSION: 'sess-c' } })
  await expect(since.getByRole('listitem').filter({ hasText: 'later.md' })).toBeVisible()
})

test('the library page: choosing a folder in the tree shows what is in it, and the address keeps it', async ({ page, relayUrl: url }) => {
  await page.goto(`${url}#view=ledger.items`)
  const main = page.getByRole('main')
  const tree = main.getByRole('tree', { name: '文件夹' })
  const folder = (value: string) => tree.locator(`[role=treeitem][data-value="${value}"]`)
  // Choosing payments opens it as well; its folder inside then shows.
  await folder('payments').locator('.tree-row').first().click()
  await expect(folder('payments')).toHaveAttribute('aria-expanded', 'true')
  const sources = folder('payments/sources')
  await sources.locator('.tree-row').first().click()
  await expect(sources).toHaveAttribute('aria-selected', 'true')
  await expect(main.getByRole('row')).toHaveCount(5)
  expect(page.url()).toContain('view.dir=payments%2Fsources')
  await page.reload()
  await expect(main.getByRole('row')).toHaveCount(5)
})
