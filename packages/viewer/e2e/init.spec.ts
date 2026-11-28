// C7: a plain directory gets "初始化资料库"; choosing it makes the directory a library and opens it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, navTitles, openShared, tempDir, test, write } from './support.ts'

test('a directory that is not a library becomes one from the UI, with the ledger chosen by default', async ({ page, pb }) => {
  const dir = tempDir('pb-e2e-plain-')
  write(dir, 'kept.md', '原来就有的文件')
  const { url } = await pb.view(dir)
  await page.goto(url)

  await expect(page.getByRole('heading', { name: '此目录不是资料库' })).toBeVisible()
  const ledger = page.getByRole('checkbox', { name: '溯源' })
  await expect(ledger).toBeChecked()
  await page.getByRole('button', { name: '初始化资料库' }).click()

  await expect(page.getByRole('status')).toContainText('初始化为资料库')
  await expect(page.getByRole('navigation', { name: '导航' })).toBeVisible()
  expect(await navTitles(page)).toEqual(expect.arrayContaining(['文件', '设置']))
  expect(JSON.parse(readFileSync(join(dir, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['ledger'])
  expect(readFileSync(join(dir, 'kept.md'), 'utf8')).toBe('原来就有的文件')
  // The home page says nobody did anything yet and asks about the file that was there; the standing page still lists it.
  const main = page.getByRole('main')
  await expect(main.getByRole('region', { name: '最近动态' })).toContainText('暂无新动态')
  await expect(main.getByRole('region', { name: '待处理' })).toContainText('资料库根目录中有 1 个未登记的文件。')
  await openShared(page, '资料库', '状态')
  await expect(main.getByRole('region', { name: '未登记' }).getByRole('listitem').filter({ hasText: 'kept.md' }).getByRole('button', { name: '标记为导入' })).toBeVisible()
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '文件' }).click()
  await expect(page.getByRole('row', { name: /kept\.md/ })).toBeVisible()
})
