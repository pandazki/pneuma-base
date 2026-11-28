// The shell around the views: the detail panel's tabs and their place in the address, the command
// palette, keyboard movement in a table, a notice that turns into its answer in place, the sidebar's
// remembered width, both colour schemes without a reload, and the browser's own choice of one.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openShared, tempDir, test, write, type Cli } from './support.ts'

// The library's rows stand under their folder and name the thing alone.
const row = (page: Page, path: string) => page.getByRole('main').getByRole('row', { name: new RegExp(`^${path.slice(path.lastIndexOf('/') + 1).replaceAll('.', '\\.')}\\b`) })
const hashOf = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1))

test('several things open at once as tabs, kept in the address; Escape closes the front one', async ({ page, relayUrl: url }) => {
  await page.goto(`${url}#view=ledger.items`)
  const panel = page.getByRole('complementary', { name: '详情' })
  const tabs = panel.getByRole('tablist', { name: '详情' }).getByRole('tab')
  const title = panel.getByTestId('panel-title')

  await row(page, 'payments/comparison.md').click()
  await expect(title).toHaveText('comparison.md')
  await expect(tabs).toHaveCount(1)
  expect(hashOf(page).get('panel.path')).toBe('payments/comparison.md')

  // A middle click opens a second tab in front (⌘-click adds to the selection, as among files); the address names both and which one is in front.
  await row(page, 'payments/recommendation.md').click({ button: 'middle' })
  await expect(title).toHaveText('recommendation.md')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  expect(hashOf(page).get('panel2.path')).toBe('payments/recommendation.md')
  expect(hashOf(page).get('tab')).toBe('2')

  // A reload opens the same two, the same one in front.
  await page.reload()
  await expect(title).toHaveText('recommendation.md')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toHaveText('comparison.md')

  // The keyboard moves between tabs.
  await tabs.nth(1).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(title).toHaveText('comparison.md')
  expect(hashOf(page).get('tab')).toBe('1')

  // Escape closes the front tab; the other comes to the front. The browser's back brings it again.
  await page.keyboard.press('Escape')
  await expect(tabs).toHaveCount(1)
  await expect(title).toHaveText('recommendation.md')
  expect(hashOf(page).get('panel.path')).toBe('payments/recommendation.md')
  await page.goBack()
  await expect(tabs).toHaveCount(2)

  // A tab's own close button, then the panel's.
  await panel.getByRole('button', { name: '关闭 recommendation.md' }).click()
  await expect(tabs).toHaveCount(1)
  await panel.getByRole('button', { name: '关闭详情' }).click()
  await expect(panel).toHaveCount(0)
  expect(hashOf(page).has('panel')).toBe(false)
})

test('the palette finds a thing by its text and opens it, and with nothing typed lists the pages', async ({ page, relayUrl: url }) => {
  await page.goto(url)
  await expect(page.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
  const palette = page.getByRole('dialog', { name: '命令面板' })

  // ⌘K: the pages to go to.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  const pages = palette.getByRole('group', { name: '前往' })
  await expect(pages.getByRole('option')).toHaveText(['首页', '资料库', '状态', '历史副本', '活动', '统计', '场景', '文件', '已归档', 'Agent', '设置'].map((t) => new RegExp(`^${t}`)))
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(pages.getByRole('option', { name: /^活动/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: '活动' })).toBeVisible()

  // From the sidebar's search field: text finds in the library, grouped by the scene it came from.
  await page.getByRole('button', { name: '搜索或前往' }).click()
  await palette.getByRole('combobox').fill('Lemon Squeezy')
  const scene = palette.getByRole('group', { name: /^场景 sess-a/ })
  const hit = scene.getByRole('option', { name: /payments\/sources\/lemonsqueezy-pricing\.html/ })
  await expect(hit).toBeVisible()
  await expect(hit).toContainText('导入')
  await hit.click()
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('lemonsqueezy-pricing.html')

  // Nothing found says so; Escape closes the palette and leaves the panel open.
  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('combobox').fill('没有这样的字')
  await expect(palette).toContainText('无结果')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '详情' })).toBeVisible()
})

test('in a table the arrow keys move between rows, one row in the Tab order, and Enter opens it', async ({ page, relayUrl: url }) => {
  await page.goto(`${url}#view=ledger.items`)
  const rows = page.getByRole('main').getByRole('table').getByRole('row')
  // The header, the two folders' headings and the seven things.
  await expect(rows).toHaveCount(10)
  const body = rows.filter({ has: page.locator('td') })
  await expect(body.and(page.locator('[tabindex="0"]'))).toHaveCount(1)

  await body.nth(0).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(body.nth(2)).toBeFocused()
  await expect(body.nth(2)).toHaveAttribute('tabindex', '0')
  await expect(body.and(page.locator('[tabindex="0"]'))).toHaveCount(1)
  await page.keyboard.press('End')
  await expect(body.nth(6)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(body.nth(5)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(body.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('recommendation.md')
  await expect(body.nth(1)).toHaveAttribute('aria-selected', 'true')
})

async function pagerLibrary(pb: Cli): Promise<string> {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'], { testPlugins: true })
  pb.run(['plugin', 'enable', 'pager', '--library', lib], { testPlugins: true })
  write(lib, 'pager.md', 'pager 预览的内容')
  return (await pb.view(lib, { testPlugins: true })).url
}

test('an action’s notice appears at once and turns into its answer in place', async ({ page, pb }) => {
  await page.goto(`${await pagerLibrary(pb)}#view=pager.blocks`)
  await expect(page.getByRole('heading', { level: 1, name: '块的样例' })).toBeVisible()
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/call', async (route) => {
    await held
    await route.continue()
  })

  await page.getByRole('main').getByRole('button', { name: '再打个招呼' }).click()
  const status = page.getByRole('status')
  const notice = status.getByRole('listitem')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('再打个招呼')
  await expect(notice).toContainText('正在进行')
  await notice.evaluate((el) => el.setAttribute('data-seen', 'before'))

  release()
  await expect(notice).toContainText('pong')
  await expect(notice).not.toContainText('正在进行')
  await expect(notice).toHaveCount(1)
  await expect(notice).toHaveAttribute('data-seen', 'before')
})

test('the sidebar’s width is kept across a reload, and the sidebar folds to a rail', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  const { url } = await pb.view(lib)
  await page.goto(url)
  const handle = page.getByRole('separator', { name: '侧边栏宽度' })
  const width = Number(await handle.getAttribute('aria-valuenow'))
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', String(width + 32))
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', String(width + 32))

  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await expect(handle).toHaveCount(0)
  // The pages stay in the navigation, by icon.
  await openShared(page, '资料库', '状态')
  await expect(page.getByRole('heading', { level: 1, name: '状态' })).toBeVisible()
  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await expect(handle).toHaveAttribute('aria-valuenow', String(width + 32))
})

test('both colour schemes apply without a reload', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  write(lib, 'notes.md', '# 笔记\n')
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=files&panel=item&panel.path=notes.md`)
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('notes.md')
  await page.evaluate(() => ((window as unknown as { kept: number }).kept = 1))
  const colours = () =>
    page.evaluate(() => {
      const of = (sel: string) => getComputedStyle(document.querySelector(sel) as Element).backgroundColor
      return { ground: of('body'), main: of('main'), detail: of('#detail-body'), ink: getComputedStyle(document.body).color }
    })

  await page.emulateMedia({ colorScheme: 'light' })
  const light = await colours()
  expect(light.ground).toBe('rgb(248, 248, 248)')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(colours).toEqual({ ground: 'rgb(14, 14, 16)', main: 'rgb(20, 20, 22)', detail: 'rgb(27, 27, 30)', ink: 'rgba(255, 255, 255, 0.9)' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(colours).toEqual(light)
  expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1)
})

test('in a browser the configuration page chooses 浅色, 深色 or 跟随系统 at once, and the browser keeps the choice', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'])
  const { url } = await pb.view(lib)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${url}#view=settings`)
  const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const choice = page.getByRole('region', { name: '当前浏览器' }).getByRole('radiogroup', { name: '外观' })
  await expect(choice.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(ground).toBe('rgb(248, 248, 248)')

  await choice.getByRole('radio', { name: '深色' }).click()
  await expect.poll(ground).toBe('rgb(14, 14, 16)')
  await page.reload()
  await expect(choice.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(ground).toBe('rgb(14, 14, 16)')

  await choice.getByRole('radio', { name: '跟随系统' }).click()
  await expect.poll(ground).toBe('rgb(248, 248, 248)')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(ground).toBe('rgb(14, 14, 16)')
  await choice.getByRole('radio', { name: '浅色' }).click()
  await expect.poll(ground).toBe('rgb(248, 248, 248)')
  await page.reload()
  await expect.poll(ground).toBe('rgb(248, 248, 248)')
})
