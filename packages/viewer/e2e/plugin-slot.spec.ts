// C2: a test plugin that declares one view gets a page in the navigation once installed, its blocks
// render by kind, and the page goes when it is removed. A plugin that throws in its view does not
// blank the UI: its page says it failed and every other page carries on.
import { join } from 'node:path'
import { expect, navTitles, shoot, tempDir, test, write } from './support.ts'

test('a plugin’s page appears when installed, renders each kind of block, and goes when removed', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'], { testPlugins: true })
  write(lib, 'pager.md', 'pager 预览的内容')
  const { url } = await pb.view(lib, { testPlugins: true })
  await page.goto(url)
  await expect(page.getByRole('heading', { level: 1, name: '文件' })).toBeVisible()
  expect(await navTitles(page)).toEqual(['文件', '归档区', '配置'])

  // Installed from outside the UI: the page shows up by itself, before the kernel's pages.
  pb.run(['plugin', 'add', 'pager', '--library', lib], { testPlugins: true })
  const nav = page.getByRole('navigation', { name: '导航' })
  await expect(nav.getByRole('button', { name: '块的样例' })).toBeVisible({ timeout: 5_000 })
  expect(await navTitles(page)).toEqual(['块的样例', '文件', '归档区', '配置'])

  await nav.getByRole('button', { name: '块的样例' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '块的样例' })).toBeVisible()
  await expect(main.getByText('这是一段说明文字。')).toBeVisible() // text
  const section = main.getByRole('region', { name: '一节' }) // section
  await expect(section).toContainText('节下的说明')
  await expect(section.getByRole('row', { name: /表的第一行/ })).toContainText('好') // table with a tag
  await expect(section.getByText('字段的值')).toBeVisible() // fields
  await expect(main.getByText('列表的一项')).toBeVisible() // list
  await expect(main.getByText('一项的说明')).toBeVisible()
  await expect(main.getByText('时间线的一条')).toBeVisible() // timeline
  await expect(main.getByText('2026-11-25 01:00Z')).toBeVisible()
  await expect(main.getByLabel('预览')).toContainText('pager 预览的内容') // preview
  await expect(main.getByText('空状态的标题')).toBeVisible() // empty
  await expect(main.getByText('这一块界面还不认识：sparkle')).toBeVisible() // a kind this page does not know
  await shoot(page, 'c2-plugin-blocks')
  await main.getByRole('button', { name: '再打个招呼' }).click() // actions
  await expect(page.getByRole('status')).toContainText('pong')

  // A row's link opens the kernel's item panel.
  await section.getByRole('row', { name: /表的第一行/ }).click()
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('pager.md')

  // Removed from the config page: the page is gone.
  await nav.getByRole('button', { name: '配置' }).click()
  await page.getByRole('region', { name: '插件' }).getByRole('row', { name: /pager/ }).getByRole('button', { name: '卸下' }).click()
  await expect(page.getByRole('status')).toContainText('已卸下插件 pager')
  await expect(nav.getByRole('button', { name: '块的样例' })).toHaveCount(0)
  expect(await navTitles(page)).toEqual(['文件', '归档区', '配置'])
})

test('a plugin that throws in its view does not blank the UI', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'], { testPlugins: true })
  write(lib, 'a.md', 'a')
  pb.run(['plugin', 'add', 'thrower', '--library', lib], { testPlugins: true, codes: [3] })
  const { url } = await pb.view(lib, { testPlugins: true })
  await page.goto(url)

  const nav = page.getByRole('navigation', { name: '导航' })
  await expect(nav.getByRole('button', { name: '总出错的页' })).toBeVisible()
  const main = page.getByRole('main')
  await expect(main.getByText('插件 thrower 出错了，没能给出这一页')).toBeVisible()
  await expect(main.getByText('thrower failed in onView').first()).toBeVisible()

  await nav.getByRole('button', { name: '文件' }).click()
  await page.getByRole('row', { name: /a\.md/ }).click()
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(panel.getByLabel('预览')).toContainText('a')
  await expect(panel.getByText('插件 thrower 出错了，没能给出它知道的')).toBeVisible()
  await expect(panel.getByText('thrower failed in onItemView').first()).toBeVisible()
})
