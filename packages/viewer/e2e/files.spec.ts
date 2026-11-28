// Files behave as a file manager's do, in a browser: a folder as a list or as icons, chosen in the
// head and kept for the page; selection by click, ⌘-click, Shift-click, ⌘A, arrows and typed letters,
// a double-click opening a folder, Space the page's own preview; sorting from the column heads and the
// head's menu, kept; a path bar with back and forward; and the context menu with the library's own
// actions: archive, move, rename in place.
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { cutTexts, expect, png, tempDir, test, write, type Cli } from './support.ts'

/** A library with the ledger: three files and two folders in `inbox/`, an image among them, the files changed a day apart. */
async function library(pb: Cli): Promise<{ url: string; lib: string }> {
  const lib = join(tempDir(), 'lib')
  write(lib, 'inbox/b-notes.md', '# notes\n')
  write(lib, 'inbox/c-picture.png', png(64, 40, [200, 80, 40]))
  write(lib, 'inbox/a-report.pdf', `%PDF-1.4 ${'x'.repeat(4000)}`)
  write(lib, 'inbox/deeper/inner/z.md', 'deep\n')
  pb.run(['init', lib])
  for (const f of ['b-notes.md', 'c-picture.png', 'a-report.pdf', 'deeper/inner/z.md']) pb.run(['--library', lib, 'put', `inbox/${f}`, '--imported'])
  const day = 86_400
  const now = Date.now() / 1000
  utimesSync(join(lib, 'inbox/a-report.pdf'), now - 3 * day, now - 3 * day)
  utimesSync(join(lib, 'inbox/b-notes.md'), now - 1 * day, now - 1 * day)
  utimesSync(join(lib, 'inbox/c-picture.png'), now - 2 * day, now - 2 * day)
  pb.run(['--library', lib, 'check'])
  return { url: (await pb.view(lib)).url, lib }
}

const names = async (rows: import('@playwright/test').Locator) => (await rows.allInnerTexts()).map((t) => t.split('\n')[0]?.trim())

test('a folder as a list or as icons, chosen in the head or with ⌘1 and ⌘2, and kept for the page', async ({ page, pb }) => {
  const { url } = await library(pb)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  const main = page.getByRole('main')
  const looks = main.getByRole('radiogroup', { name: '显示方式' })
  await expect(looks.getByRole('radio', { name: '列表' })).toHaveAttribute('aria-checked', 'true')
  await expect(main.getByRole('row', { name: /b-notes\.md/ })).toBeVisible()

  await looks.getByRole('radio', { name: '图标' }).click()
  const icons = main.getByRole('listbox', { name: '文件' })
  await expect(icons.getByRole('option')).toHaveCount(4)
  // An image is its own thumbnail, through the file route; other files and folders are icons by type.
  await expect(icons.getByRole('option', { name: 'c-picture.png' }).locator('img')).toHaveAttribute('src', /\/api\/file\?path=inbox%2Fc-picture\.png/)
  await expect(icons.getByRole('option', { name: 'b-notes.md' }).locator('img')).toHaveCount(0)
  await expect(main.getByRole('table')).toHaveCount(0)

  // Kept for this page on this machine: a reload and another folder of it still show icons; another page lists.
  await page.reload()
  await expect(icons.getByRole('option')).toHaveCount(4)
  await page.goto(`${url}#view=files`)
  await expect(icons.getByRole('option', { name: 'inbox' })).toBeVisible()
  await page.goto(`${url}#view=archive`)
  await expect(main.getByRole('listbox', { name: '文件' })).toHaveCount(0)

  await page.goto(`${url}#view=files&view.dir=inbox`)
  await icons.getByRole('option', { name: 'b-notes.md' }).click()
  await page.keyboard.press('Meta+1')
  await expect(main.getByRole('row', { name: /b-notes\.md/ })).toBeVisible()
  await page.keyboard.press('Meta+2')
  await expect(icons.getByRole('option')).toHaveCount(4)
  await expect(looks.getByRole('radio', { name: '图标' })).toHaveAttribute('aria-checked', 'true')
  await expect(looks.getByRole('radio', { name: '列表' })).toHaveAttribute('aria-checked', 'false')
})

test('selection as in a file manager: click, ⌘-click, Shift-click, ⌘A, arrows, typed letters; a double-click opens a folder; Space previews', async ({ page, pb }) => {
  const { url } = await library(pb)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  const main = page.getByRole('main')
  const row = (name: RegExp) => main.getByRole('row', { name })
  const selected = main.locator('tr[aria-selected="true"]')

  // A click selects a file and shows it in the panel; a folder is only selected.
  await row(/b-notes\.md/).click()
  await expect(selected).toHaveCount(1)
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'b-notes.md' })).toBeVisible()
  await row(/deeper/).click()
  await expect(row(/deeper/)).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/view\.dir=inbox(&|$)/)

  await row(/a-report\.pdf/).click({ modifiers: ['Meta'] })
  expect(await names(selected)).toEqual(['a-report.pdf', 'deeper/'])
  await row(/b-notes\.md/).click()
  await row(/deeper/).click({ modifiers: ['Shift'] })
  expect(await names(selected)).toHaveLength(3)
  await page.keyboard.press('Meta+a')
  await expect(selected).toHaveCount(4)

  // Arrows move the selection, Shift with them stretches it; letters typed go to the first name they start.
  await row(/a-report\.pdf/).click()
  await page.keyboard.press('ArrowDown')
  expect(await names(selected)).toEqual(['b-notes.md'])
  await page.keyboard.press('Shift+ArrowDown')
  expect(await names(selected)).toEqual(['b-notes.md', 'c-picture.png'])
  await page.keyboard.type('de')
  expect(await names(selected)).toEqual(['deeper/'])

  // Space shows the page's own preview of an image; arrows follow the selection; Escape closes it.
  await row(/c-picture\.png/).click()
  await page.keyboard.press('Space')
  const preview = page.getByRole('dialog', { name: 'c-picture.png' })
  await expect(preview.getByRole('img', { name: 'inbox/c-picture.png' })).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('dialog', { name: 'b-notes.md' })).toContainText('# notes')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // A double-click on a folder opens it, as ⌘↓ does.
  await row(/deeper/).dblclick()
  await expect(row(/inner/)).toBeVisible()
  await row(/inner/).click()
  await page.keyboard.press('Meta+ArrowDown')
  await expect(row(/z\.md/)).toBeVisible()
})

test('among the icons a rectangle drawn from an empty part selects what it covers; with ⌘ it adds to what was selected', async ({ page, pb }) => {
  const { url } = await library(pb)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  const main = page.getByRole('main')
  await main.getByRole('radio', { name: '图标' }).click()
  const grid = main.getByRole('listbox', { name: '文件' })
  const tile = (name: string) => grid.getByRole('option', { name })
  await expect(tile('a-report.pdf')).toBeVisible()
  const box = async (name: string) => (await tile(name).boundingBox()) as { x: number; y: number; width: number; height: number }
  const [a, b, d] = [await box('a-report.pdf'), await box('b-notes.md'), await box('deeper')]
  // From below the first row, up across the first two tiles.
  const below = Math.max(a.y, b.y, d.y) + a.height + 6
  await page.mouse.move(a.x + 10, below)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 10, a.y + a.height / 2, { steps: 5 })
  await page.mouse.up()
  const selected = grid.locator('[aria-selected="true"]')
  await expect(selected).toHaveText(['a-report.pdf', 'b-notes.md'])
  await page.keyboard.down('Meta')
  await page.mouse.move(d.x + d.width - 10, below)
  await page.mouse.down()
  await page.mouse.move(d.x + 10, d.y + d.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Meta')
  await expect(selected).toHaveText(['a-report.pdf', 'b-notes.md', 'deeper'])
})

test('sorting from the column heads and the head’s menu, by when it changed, kind and size, kept for the page', async ({ page, pb }) => {
  const { url } = await library(pb)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  const main = page.getByRole('main')
  const rows = main.locator('tbody tr[data-key]')
  await expect.poll(() => names(rows)).toEqual(['a-report.pdf', 'b-notes.md', 'c-picture.png', 'deeper/'])

  // 改于 first shows the newest; again, the oldest.
  await main.getByRole('columnheader', { name: '改于' }).getByRole('button').click()
  await expect(main.getByRole('columnheader', { name: '改于' })).toHaveAttribute('aria-sort', 'descending')
  await expect.poll(() => names(rows)).toEqual(['deeper/', 'b-notes.md', 'c-picture.png', 'a-report.pdf'])
  await main.getByRole('columnheader', { name: '改于' }).getByRole('button').click()
  await expect.poll(() => names(rows)).toEqual(['a-report.pdf', 'c-picture.png', 'b-notes.md', 'deeper/'])

  // The sort is kept for the page: another folder of it, and the icons, are sorted the same way.
  await page.goto(`${url}#view=files`)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  await expect.poll(() => names(rows)).toEqual(['a-report.pdf', 'c-picture.png', 'b-notes.md', 'deeper/'])
  await main.getByRole('radio', { name: '图标' }).click()
  const tiles = main.getByRole('option')
  await expect.poll(async () => (await tiles.allInnerTexts()).map((t) => t.trim())).toEqual(['a-report.pdf', 'c-picture.png', 'b-notes.md', 'deeper'])

  // The head's menu: by size, the largest first; by kind, folders first, then by extension.
  await main.getByRole('button', { name: /^排序/ }).click()
  await page.getByRole('menuitem', { name: '大小' }).click()
  await expect.poll(async () => (await tiles.allInnerTexts()).map((t) => t.trim())).toEqual(['a-report.pdf', 'c-picture.png', 'b-notes.md', 'deeper'])
  await main.getByRole('button', { name: /^排序/ }).click()
  await page.getByRole('menuitem', { name: '种类' }).click()
  await expect.poll(async () => (await tiles.allInnerTexts()).map((t) => t.trim())).toEqual(['deeper', 'b-notes.md', 'a-report.pdf', 'c-picture.png'])
})

test('a path bar from the library’s root, each folder a way back to it; back, forward and ⌘↑', async ({ page, pb }) => {
  const { url } = await library(pb)
  await page.goto(`${url}#view=files`)
  const main = page.getByRole('main')
  const bar = main.getByRole('navigation', { name: '位置' })
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('文件')
  await main.getByRole('row', { name: /inbox/ }).dblclick()
  await main.getByRole('row', { name: /deeper/ }).dblclick()
  await main.getByRole('row', { name: /inner/ }).dblclick()
  await expect(bar.getByRole('listitem')).toHaveText(['文件', 'inbox', 'deeper', 'inner'])
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('inner')

  await bar.getByRole('button', { name: 'inbox' }).click()
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('inbox')
  await bar.getByRole('button', { name: '后退' }).click()
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('inner')
  await bar.getByRole('button', { name: '前进' }).click()
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('inbox')
  await main.getByRole('row', { name: /deeper/ }).click()
  await page.keyboard.press('Meta+ArrowUp')
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText('文件')
})

test('the context menu: the page’s preview and a path to copy, then the library’s archive, move and rename in place', async ({ page, pb }) => {
  const { url, lib } = await library(pb)
  await page.goto(`${url}#view=files&view.dir=inbox`)
  const main = page.getByRole('main')
  const row = (name: RegExp) => main.getByRole('row', { name })

  await row(/a-report\.pdf/).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '对这些文件' })
  await expect(menu.getByRole('menuitem')).toHaveText(['快速查看空格', '拷贝路径', '归档', '挪到…', '重新命名'])
  await menu.getByRole('menuitem', { name: '归档' }).click()
  await expect(row(/a-report\.pdf/)).toHaveCount(0)
  expect(pb.run(['--library', lib, 'inspect', '_archive/inbox/a-report.pdf']).stdout).toContain('a-report.pdf')

  // Renamed in place: the name's part before its extension is chosen; Return keeps the new name, a move recorded as one.
  await row(/b-notes\.md/).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '重新命名' }).click()
  const field = main.getByRole('textbox', { name: '新的名字' })
  await expect(field).toHaveValue('b-notes.md')
  await page.keyboard.type('notes')
  await page.keyboard.press('Enter')
  await expect(row(/notes\.md/)).toBeVisible()
  await expect(row(/b-notes\.md/)).toHaveCount(0)
  // The library's move: the thing keeps where it came from.
  expect(pb.run(['--library', lib, 'inspect', 'inbox/notes.md']).stdout).toContain('带进来的 · 主人')

  // F2 renames too; Escape leaves the name as it was. Several selected: only what applies to all.
  await row(/c-picture\.png/).click()
  await page.keyboard.press('F2')
  await page.keyboard.press('Escape')
  await expect(row(/c-picture\.png/)).toBeVisible()
  await row(/notes\.md/).click({ modifiers: ['Meta'] })
  await row(/notes\.md/).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['快速查看空格', '拷贝路径', '归档'])
  await page.keyboard.press('Escape')

  // 挪到… asks where, starting from where it is.
  await row(/c-picture\.png/).click()
  await row(/c-picture\.png/).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '挪到…' }).click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '新的库内路径' })).toHaveValue('inbox/c-picture.png')
})

test('a time from today keeps its whole width as the page’s clock moves it on: 刚刚 becomes 2 分钟前 and stays whole', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  write(lib, 'fresh.md', 'x\n')
  pb.run(['init', lib, '--bare'])
  const { url } = await pb.view(lib)
  await page.clock.install()
  await page.goto(`${url}#view=files`)
  const row = page.getByRole('main').getByRole('row', { name: /fresh\.md/ })
  await expect(row).toContainText('刚刚')
  await page.clock.runFor(130_000)
  await expect(row).toContainText('2 分钟前')
  expect(await cutTexts(page.getByRole('main').getByRole('table'))).toEqual([])
})
