// C7: a plain directory gets "把它建成库"; choosing it makes the directory a library and opens it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, navTitles, tempDir, test, write } from './support.ts'

test('a directory that is not a library becomes one from the UI, with the ledger chosen by default', async ({ page, pb }) => {
  const dir = tempDir('pb-e2e-plain-')
  write(dir, 'kept.md', '原来就有的文件')
  const { url } = await pb.view(dir)
  await page.goto(url)

  await expect(page.getByRole('heading', { name: '这个目录还不是库' })).toBeVisible()
  const ledger = page.getByRole('checkbox', { name: /ledger/ })
  await expect(ledger).toBeChecked()
  await page.getByRole('button', { name: '把它建成库' }).click()

  await expect(page.getByRole('status')).toContainText('建成库')
  await expect(page.getByRole('navigation', { name: '导航' })).toBeVisible()
  expect(await navTitles(page)).toEqual(expect.arrayContaining(['文件', '归档区', '配置']))
  expect(JSON.parse(readFileSync(join(dir, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['ledger'])
  expect(readFileSync(join(dir, 'kept.md'), 'utf8')).toBe('原来就有的文件')
  // The empty items page says what to do; the standing page has the file that was there, with what to do about it.
  const main = page.getByRole('main')
  await expect(main).toContainText('库里还没有登记过的东西')
  await expect(main).toContainText('「状况」页')
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '状况' }).click()
  await expect(main.getByRole('region', { name: '没人登记过的' }).getByRole('listitem').filter({ hasText: 'kept.md' }).getByRole('button', { name: '记为带进来的' })).toBeVisible()
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '文件' }).click()
  await expect(page.getByRole('row', { name: /kept\.md/ })).toBeVisible()
})
