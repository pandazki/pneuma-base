// C1: a library with no plugin has three pages; the files page goes into folders and previews text
// and images; archiving a file in the UI puts it in the archive, taking it back returns it.
// Failure semantics: a server that stops leaves a visible state that keeps retrying.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, navTitles, png, shoot, tempDir, test, write } from './support.ts'

function bareLibrary(pb: { run(args: string[]): unknown }): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  write(lib, 'notes/hello.md', '# 你好\n\n一段笔记，写给以后的自己。\n')
  write(lib, 'notes/todo.txt', '买牛奶\n')
  write(lib, 'pics/dot.png', png(48, 32, [40, 120, 220]))
  write(lib, 'readme.txt', '这个库只当文件夹用。\n')
  return lib
}

test('a bare library: three pages, folders, text and image preview, archive and take back', async ({ page, pb }) => {
  const lib = bareLibrary(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)

  await expect(page.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  expect(await navTitles(page)).toEqual(['首页', '文件', '归档区', '配置'])
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '文件' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '文件' })).toBeVisible()

  // Into a folder, and a text preview in the panel.
  await page.getByRole('button', { name: 'notes/' }).click()
  await expect(page.getByRole('main').getByText('notes', { exact: true })).toBeVisible()
  await page.getByRole('row', { name: /hello\.md/ }).click()
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(panel.getByTestId('panel-title')).toHaveText('hello.md')
  await expect(panel.getByRole('figure', { name: '预览' })).toContainText('一段笔记，写给以后的自己。')
  await shoot(page, 'c1-files-text-preview')

  // Back up, into another folder, and an image preview.
  await page.getByRole('button', { name: '..' }).click()
  await page.getByRole('button', { name: 'pics/' }).click()
  await page.getByRole('row', { name: /dot\.png/ }).click()
  const image = panel.getByRole('img', { name: 'pics/dot.png' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([48, 32])
  await shoot(page, 'c1-files-image-preview')

  // Archive from the panel: the file moves into _archive/.
  await page.getByRole('button', { name: '..' }).click()
  await page.getByRole('button', { name: 'notes/' }).click()
  await page.getByRole('row', { name: /hello\.md/ }).click()
  await panel.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已归档：notes/hello.md → _archive/notes/hello.md')
  expect(existsSync(join(lib, 'notes/hello.md'))).toBe(false)
  expect(readFileSync(join(lib, '_archive/notes/hello.md'), 'utf8')).toContain('一段笔记')
  await expect(page.getByRole('main').getByRole('row', { name: /hello\.md/ })).toHaveCount(0)

  // The archive page lists it; taking it back returns it to its path.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '归档区' }).click()
  const row = page.getByRole('main').getByRole('row', { name: /notes\/hello\.md/ })
  await expect(row).toBeVisible()
  await shoot(page, 'c1-archive')
  await row.getByRole('button', { name: '取回' }).click()
  await expect(page.getByRole('status')).toContainText('已取回：_archive/notes/hello.md → notes/hello.md')
  await expect(page.getByRole('main').getByText('归档区是空的')).toBeVisible()
  expect(readFileSync(join(lib, 'notes/hello.md'), 'utf8')).toContain('一段笔记')
  expect(existsSync(join(lib, '_archive/notes/hello.md'))).toBe(false)

  // The config page of a bare library.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '配置' }).click()
  // Nothing installed; the ledger this pneuma-base knows is offered.
  await expect(page.getByRole('region', { name: '插件' }).getByRole('row', { name: /ledger/ })).toContainText('没装')
  await expect(page.getByRole('region', { name: '插件' }).getByRole('row', { name: /ledger/ }).getByRole('button', { name: '装上' })).toBeVisible()
  await expect(page.getByRole('region', { name: '授权与技能' })).toContainText('codex --add-dir')
  await page.getByRole('complementary', { name: '详情' }).getByRole('button', { name: '关闭详情' }).click()
  await shoot(page, 'c1-config')
})

test('a file changed outside the UI shows up without a reload', async ({ page, pb }) => {
  const lib = bareLibrary(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  await expect(page.getByRole('row', { name: /readme\.txt/ })).toBeVisible()
  write(lib, 'dropped-in.md', 'from the finder')
  await expect(page.getByRole('row', { name: /dropped-in\.md/ })).toBeVisible({ timeout: 5_000 })
})

test('when the server stops, the page says it cannot reach it and keeps what it showed', async ({ page, pb }) => {
  const lib = bareLibrary(pb)
  const server = await pb.view(lib)
  await page.goto(server.url)
  await expect(page.getByRole('row', { name: /readme\.txt/ })).toBeVisible()
  await server.stop()
  await expect(page.getByRole('alert')).toContainText('连不上服务', { timeout: 6_000 })
  await expect(page.getByRole('row', { name: /readme\.txt/ })).toBeVisible()
})
