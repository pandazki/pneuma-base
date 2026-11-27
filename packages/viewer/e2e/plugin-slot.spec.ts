// C2: a test plugin that declares views gets pages in the navigation once installed, its blocks
// render by kind, and the pages go when it is removed. A block the kernel replaced, because no one
// knows its kind, renders as what it says; a plugin that throws in its view is the kernel's
// (packages/kernel/test/viewer.test.ts) and the server's (packages/viewer/test/server.test.ts).
import { join } from 'node:path'
import { cutTexts, expect, fromMenu, navTitles, tempDir, test, write } from './support.ts'

// The sample table's moment reads 11:11 here: the digit whose proportional and tabular widths differ most.
test.use({ timezoneId: 'UTC' })

test('a plugin’s page appears when installed, renders each kind of block, and goes when removed', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'], { testPlugins: true })
  write(lib, 'pager.md', 'pager 预览的内容')
  const { url } = await pb.view(lib, { testPlugins: true })
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00.000Z'))
  await page.goto(url)
  await expect(page.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  expect(await navTitles(page)).toEqual(['首页', '文件', 'Agent', '配置'])

  // Installed from outside the UI: the page shows up by itself, after the home page and before the kernel's other pages.
  pb.run(['plugin', 'add', 'pager', '--library', lib], { testPlugins: true })
  const nav = page.getByRole('navigation', { name: '导航' })
  await expect(nav.getByRole('button', { name: '块的样例' })).toBeVisible({ timeout: 5_000 })
  expect(await navTitles(page)).toEqual(['首页', '块的样例', '新的块', '文件', 'Agent', '配置'])

  await nav.getByRole('button', { name: '块的样例' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '块的样例' })).toBeVisible()
  await expect(main.getByText('这是一段说明文字。')).toBeVisible() // text
  const section = main.getByRole('region', { name: '一节' }) // section
  await expect(section).toContainText('节下的说明')
  await expect(section.getByRole('row', { name: /表的第一行/ })).toContainText('好') // table with a tag
  await expect(section.getByRole('row', { name: /表的第一行/ })).toContainText('49 分钟前') // a moment, near ones in words, never cut short
  expect(await cutTexts(section.getByRole('table'))).toEqual([])
  await expect(section.getByText('字段的值')).toBeVisible() // fields
  await expect(main.getByText('列表的一项')).toBeVisible() // list
  await expect(main.getByText('一项的说明')).toBeVisible()
  await expect(main.getByText('时间线的一条')).toBeVisible() // timeline
  await expect(main.locator('time[datetime="2026-11-25T01:00:00.000Z"]')).toBeVisible()
  await expect(main.getByRole('figure', { name: '预览' })).toContainText('pager 预览的内容') // preview
  await expect(main.getByText('空状态的标题')).toBeVisible() // empty
  await expect(main.getByText('插件 pager 的一块没法显示：blocks[7] 是不认识的块：sparkle')).toBeVisible() // a kind no one knows, caught by the kernel
  await expect(main.getByRole('alert')).toContainText('插件 pager 出了问题：一块没法显示')
  await main.getByRole('button', { name: '再打个招呼' }).click() // actions
  await expect(page.getByRole('status')).toContainText('pong')

  // A row's link opens the kernel's item panel.
  await section.getByRole('row', { name: /表的第一行/ }).click()
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('pager.md')

  // Removed from the config page: the page is gone.
  await nav.getByRole('button', { name: '配置' }).click()
  await fromMenu(page.getByRole('region', { name: '插件' }).getByRole('row', { name: /pager/ }), '卸下')
  await expect(page.getByRole('status')).toContainText('已卸下插件 pager')
  await expect(nav.getByRole('button', { name: '块的样例' })).toHaveCount(0)
  expect(await navTitles(page)).toEqual(['首页', '文件', 'Agent', '配置'])
})
