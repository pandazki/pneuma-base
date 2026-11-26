// Bundles in the UI: a directory with the marker is one thing. On the files page it is one row that
// opens the item panel, not a folder to walk into; the panel gives its facts and its files, and an
// inner text or image file previews. Archived, it is one row in the archive. In the ledger's items
// table it is one row, and the files it absorbed are not listed.
import { join } from 'node:path'
import { expect, png, shoot, tempDir, test, write } from './support.ts'

function site(root: string, at: string): void {
  write(root, `${at}/.pneuma-item`, '{"format":1}\n')
  write(root, `${at}/index.html`, '<h1>电子书小店</h1>\n<p>欢迎。</p>\n')
  write(root, `${at}/css/main.css`, 'h1 { color: #2563eb; }\n')
  write(root, `${at}/img/cover.png`, png(64, 40, [37, 99, 235]))
}

test('a bundle is one row on the files page; its panel lists its files and previews them', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  site(lib, 'shop-site')
  write(lib, 'notes/todo.md', '# 待办\n')
  write(lib, 'readme.txt', '这个库只当文件夹用。\n')
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=files`)
  const main = page.getByRole('main')
  const panel = page.getByRole('complementary', { name: '详情' })
  const title = panel.getByTestId('panel-title')

  const row = main.getByRole('row', { name: /shop-site/ })
  await expect(row).toContainText('3 个文件')
  await row.click()
  await expect(title).toHaveText('shop-site')
  await expect(main.getByText('库的根目录')).toBeVisible() // still at the root: not walked into
  const facts = panel.getByRole('region', { name: '文件', exact: true })
  await expect(facts).toContainText('一样东西（带标记的目录）')
  await expect(facts).toContainText('文件数3')
  const files = panel.getByRole('region', { name: '里面的文件' })
  await expect(files.getByRole('row')).toHaveCount(4) // the header and three files

  await files.getByRole('row', { name: /index\.html/ }).click()
  await expect(title).toHaveText('index.html')
  await expect(panel.getByRole('figure', { name: '预览' })).toContainText('电子书小店')
  await expect(panel.getByRole('button', { name: '归档', exact: true })).toHaveCount(0)
  await shoot(page, 'c5-bundle-files')
  await panel.getByRole('button', { name: 'shop-site' }).click()
  await expect(title).toHaveText('shop-site')
  await files.getByRole('row', { name: /img\/cover\.png/ }).click()
  const image = panel.getByRole('img', { name: 'shop-site/img/cover.png' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([64, 40])

  // Archived from its panel, it is one row in the archive.
  await panel.getByRole('button', { name: 'shop-site' }).click()
  await panel.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已归档：shop-site → _archive/shop-site')
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '归档区' }).click()
  await expect(main.getByRole('row')).toHaveCount(2)
  await expect(main.getByRole('row', { name: /shop-site/ })).toContainText('3 个文件')
})

test('the items table shows a bundle as one row and leaves out what it absorbed', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  const outside = tempDir('pb-e2e-out-')
  pb.run(['init', lib])
  write(lib, 'shop-site/index.html', '<h1>旧的首页</h1>\n')
  pb.run(['--library', lib, '--as', 'claude-code', 'put', 'shop-site/index.html', '--brought'], { cwd: outside })
  pb.run(['--library', lib, '--as', 'claude-code', 'put', 'shop-site', '--made'], { cwd: outside })
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.items`)
  const main = page.getByRole('main')
  await expect(main.getByRole('row', { name: /^shop-site\b/ })).toContainText('做出来的')
  await expect(main.getByRole('row', { name: /shop-site\/index\.html/ })).toHaveCount(0)
})
