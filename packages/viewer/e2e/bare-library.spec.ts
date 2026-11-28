// C1: a library with no plugin has its pages; the files page goes into folders and previews text and
// images; archiving a file in the UI puts it in the archive, taking it back returns it.
// Failure semantics: a server that stops leaves a visible state that keeps retrying.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, navTitles, openShared, png, tempDir, test, write } from './support.ts'

function bareLibrary(pb: { run(args: string[]): unknown }): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  write(lib, 'notes/hello.md', '# 你好\n\n一段笔记，写给以后的自己。\n')
  write(lib, 'notes/todo.txt', '买牛奶\n')
  write(lib, 'pics/dot.png', png(48, 32, [40, 120, 220]))
  write(lib, 'readme.txt', '这个库只当文件夹用。\n')
  return lib
}

test('a bare library: four pages, folders, text and image preview, archive and take back', async ({ page, pb }) => {
  const lib = bareLibrary(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)

  await expect(page.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  expect(await navTitles(page)).toEqual(['首页', '文件', 'Agent', '设置'])
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '文件' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '文件' })).toBeVisible()

  // Into a folder, and a text preview in the panel.
  const up = page.getByRole('navigation', { name: '位置' }).getByRole('button', { name: '文件', exact: true })
  await page.getByRole('row', { name: /^notes\// }).dblclick()
  await expect(page.getByRole('main').getByText('notes', { exact: true })).toBeVisible()
  await page.getByRole('row', { name: /hello\.md/ }).click()
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(panel.getByTestId('panel-title')).toHaveText('hello.md')
  await expect(panel.getByRole('figure', { name: '预览' })).toContainText('一段笔记，写给以后的自己。')

  // Back up from the path bar, into another folder, and an image preview.
  await up.click()
  await page.getByRole('row', { name: /^pics\// }).dblclick()
  await page.getByRole('row', { name: /dot\.png/ }).click()
  const image = panel.getByRole('img', { name: 'pics/dot.png' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([48, 32])

  // Archive from the panel: the file moves into _archive/.
  await up.click()
  await page.getByRole('row', { name: /^notes\// }).dblclick()
  await page.getByRole('row', { name: /hello\.md/ }).click()
  await panel.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已归档：notes/hello.md → _archive/notes/hello.md')
  expect(existsSync(join(lib, 'notes/hello.md'))).toBe(false)
  expect(readFileSync(join(lib, '_archive/notes/hello.md'), 'utf8')).toContain('一段笔记')
  await expect(page.getByRole('main').getByRole('row', { name: /hello\.md/ })).toHaveCount(0)

  // The archive page lists one level at a time: the folder, then in it the file; taking it back returns it to its path.
  await openShared(page, '文件', '已归档')
  await page.getByRole('main').getByRole('row', { name: /^notes\// }).dblclick()
  const row = page.getByRole('main').getByRole('row', { name: /notes\/hello\.md/ })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '取消归档' }).click()
  await expect(page.getByRole('status')).toContainText('已取消归档：_archive/notes/hello.md → notes/hello.md')
  await expect(page.getByRole('main').getByText(/^暂无归档条目。/)).toBeVisible()
  expect(readFileSync(join(lib, 'notes/hello.md'), 'utf8')).toContain('一段笔记')
  expect(existsSync(join(lib, '_archive/notes/hello.md'))).toBe(false)

  // The config page of a bare library: settings, no column heads. Nothing installed; the ledger this
  // pneuma-base knows is a row whose switch is off, its whole text behind an ⓘ, nothing else to do.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('main').getByRole('columnheader')).toHaveCount(0)
  const ledger = page.getByRole('region', { name: '插件' }).getByRole('listitem').filter({ hasText: '溯源' })
  await expect(ledger.getByRole('switch', { name: '溯源' })).toHaveAttribute('aria-checked', 'false')
  await expect(ledger.getByRole('img', { name: /^溯源：.*命令行中的名称：ledger。$/ })).toBeVisible()
  await expect(ledger.getByRole('button', { name: '更多' })).toHaveCount(0)
  // What Codex needs is said on demand, beside the title of the Agent page's first section.
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: 'Agent' }).click()
  await expect(page.getByRole('region', { name: '已连接的 Agent' }).getByRole('img', { name: /codex --add-dir/ })).toBeVisible()
})

test('when the server stops, the page says it cannot reach it and keeps what it showed', async ({ page, pb }) => {
  const lib = bareLibrary(pb)
  const server = await pb.view(lib)
  await page.goto(server.url)
  await expect(page.getByRole('row', { name: /readme\.txt/ })).toBeVisible()
  await server.stop()
  await expect(page.getByRole('alert')).toContainText('无法连接服务', { timeout: 6_000 })
  await expect(page.getByRole('row', { name: /readme\.txt/ })).toBeVisible()
})
