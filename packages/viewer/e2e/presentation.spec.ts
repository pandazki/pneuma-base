// The presentation layer: typed blocks for what the first third-party plugin could not express (an
// outside link, a live preview, a timeline entry's action, an input that validates), a plugin's own
// page in a sandboxed frame whose actions take the same confirmed path as a button's, the open view
// in the address, and when a view is asked for again.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, frames, tempDir, test, write, type Cli } from './support.ts'

test.use({ timezoneId: 'UTC' })

const LONG_URL = 'http://127.0.0.1:18080/apps/a-rather-long-application-name-for-the-demo-site/index.html'
const FRAME = 'iframe[title="插件 pager 的页"]'

/** A bare library with the test plugin pager, and its view server. */
async function pagerLibrary(pb: Cli, env: Record<string, string> = {}): Promise<string> {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib, '--bare'], { testPlugins: true })
  pb.run(['plugin', 'add', 'pager', '--library', lib], { testPlugins: true })
  write(lib, 'pager.md', 'pager 预览的内容')
  return (await pb.view(lib, { testPlugins: true, env })).url
}

/** A site on this machine for the embed: one page whose script writes a line. */
async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><h1>站点首页</h1><p id="ran"></p><script>document.getElementById("ran").textContent = "脚本运行了"</script>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

test('a link cell opens in a new tab, is cut in the middle when narrow, and copies; another address stays text', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto(`${url}#view=pager.new`)
  const table = page.getByRole('region', { name: '站点' }).getByRole('table')
  const long = table.getByRole('link', { name: LONG_URL })
  await expect(long).toHaveAttribute('href', LONG_URL)
  await expect(long).toHaveAttribute('target', '_blank')
  await expect(long).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(long).toHaveAttribute('title', LONG_URL)
  const cut = await long.innerText()
  expect(cut).toContain('…')
  expect(cut.startsWith('http://127.0.0.1:18080/')).toBe(true)
  expect(cut.endsWith('index.html')).toBe(true)

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(long).toHaveText(LONG_URL)

  const other = table.getByRole('row', { name: /不是网址/ })
  await expect(other).toContainText('javascript:alert(1)')
  await expect(other.getByRole('link')).toHaveCount(0)

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await table.getByRole('row', { name: /短地址/ }).getByRole('button', { name: '复制' }).click()
  await expect(table.getByRole('row', { name: /短地址/ }).getByRole('button', { name: '已复制' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/')
})

test('an embed shows an outside page in a sandboxed frame, with a way to open it in a new tab', async ({ page, pb }) => {
  const local = await site()
  try {
    const url = await pagerLibrary(pb, { PAGER_EMBED: local.url })
    await page.goto(`${url}#view=pager.new`)
    const embed = page.getByRole('figure', { name: '站点预览' })
    await expect(embed.locator('iframe')).toHaveAttribute('sandbox', /allow-scripts/)
    await expect(embed.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer')
    const inside = page.frameLocator('iframe[title="站点预览"]')
    await expect(inside.getByRole('heading', { name: '站点首页' })).toBeVisible()
    await expect(inside.getByText('脚本运行了')).toBeVisible()
    await expect(embed.getByRole('link', { name: '在新标签页打开' })).toHaveAttribute('href', local.url)
    await expect(embed.getByRole('link', { name: '在新标签页打开' })).toHaveAttribute('rel', 'noopener noreferrer')
  } finally {
    await local.close()
  }
})

test('a timeline entry’s button runs its action after its question', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  await page.goto(`${url}#view=pager.new`)
  await page.getByRole('listitem').filter({ hasText: '第 1 版' }).getByRole('button', { name: '放回这一版' }).click()
  const dialog = page.getByRole('dialog', { name: '放回这一版' })
  await expect(dialog).toContainText('把线上换回第 1 版？')
  await dialog.getByRole('button', { name: '放回这一版' }).click()
  await expect(page.getByRole('status')).toContainText('已放回第 1 版')
  await expect(page.getByRole('listitem').filter({ hasText: '第 2 版' }).getByRole('button')).toHaveCount(0)
})

test('an input’s pattern keeps a bad value from being sent, and its hint says what fits', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  await page.goto(`${url}#view=pager.new`)
  await page.getByRole('main').getByRole('button', { name: '设前缀' }).click()
  const dialog = page.getByRole('dialog', { name: '设前缀' })
  const field = dialog.getByRole('textbox', { name: '前缀' })
  const submit = dialog.getByRole('button', { name: '设前缀' })
  await expect(field).toHaveAccessibleDescription('小写字母开头，最多 12 个小写字母或数字')
  await field.fill('Shop Front')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(submit).toBeDisabled()
  await field.press('Enter')
  await expect(dialog).toBeVisible()
  await field.fill('shop1')
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')
  await submit.click()
  await expect(page.getByRole('status')).toContainText('前缀是 shop1')
})

test('a plugin’s own page gets its data and the scheme, runs a declared action through the confirmation and sees the new data, and nothing more', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  const calls: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/call') calls.push(r.postData() ?? '')
  })
  await page.goto(`${url}#view=pager.new`)
  const frame = page.locator('main').frameLocator(FRAME).first()
  await expect(frame.locator('#count')).toHaveText('0')
  await expect(frame.locator('#note')).toHaveText('插件自己画的一页')
  await expect(frame.locator('#scheme')).toHaveText('浅色')
  const surface = () => frame.locator('.card').evaluate((el) => getComputedStyle(el).backgroundColor)
  const light = await surface()

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(frame.locator('#scheme')).toHaveText('深色')
  await expect.poll(surface).not.toBe(light)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(frame.locator('#scheme')).toHaveText('浅色')

  // An action the block did not declare, and a message from somewhere else, do nothing.
  await frame.getByRole('button', { name: '做没声明的事' }).click()
  await page.evaluate(() => window.postMessage({ pneuma: 1, type: 'run', name: 'bump' }, '*'))
  await frames(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(calls).toEqual([])

  // A declared one asks its own question, runs through the faces, and the frame sees the refetched data.
  await frame.getByRole('button', { name: '加一' }).click()
  const dialog = page.getByRole('dialog', { name: '加一' })
  await expect(dialog).toContainText('把计数加一？')
  await dialog.getByRole('button', { name: '加一' }).click()
  await expect(page.getByRole('status')).toContainText('计数是 1')
  await expect(frame.locator('#count')).toHaveText('1')
  expect(calls.map((c) => JSON.parse(c))).toMatchObject([{ call: { face: 'owner', command: 'pager bump' }, confirmed: true }])
  const inside = page.frames().find((f) => f.url().includes('/plugin-ui/pager/counter.html'))
  const held = await inside?.evaluate(() => JSON.stringify((window as unknown as { lastMessage: unknown }).lastMessage))
  expect(held).toContain('"label":"加一"')
  expect(held).not.toContain('pager bump')
  // Nor the API's token: not in its address, not in its referrer.
  const seen = await inside?.evaluate(() => `${location.href} ${document.referrer}`)
  expect(seen).toContain('/plugin-ui/pager/counter.html')
  expect(seen).not.toContain(new URL(url).searchParams.get('token') ?? 'no token')

  // It may open a view.
  await frame.getByRole('button', { name: '打开文件页' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '文件' })).toBeVisible()
})

test('a plugin’s page that never says it is ready shows a message naming the plugin; the rest stands, in the panel too', async ({ page, pb }) => {
  const local = await site()
  try {
    const url = await pagerLibrary(pb, { PAGER_EMBED: local.url })
    // The page's clock, so the time a frame has to say it is ready passes at once.
    await page.clock.install()
    await page.goto(`${url}#view=pager.new`)
    const counter = page.locator('main').frameLocator(FRAME).first().locator('#count')
    await expect(counter).toHaveText('0')
    await expect(page.frameLocator('iframe[title="站点预览"]').getByText('脚本运行了')).toBeVisible()
    await page.clock.runFor(5_000)
    const failed = page.getByRole('main').getByRole('alert').filter({ hasText: '插件 pager 的页没能打开' })
    await expect(failed).toBeVisible()
    await expect(failed).toContainText('missing.html')
    await expect(counter).toHaveText('0')
    await expect(page.getByRole('main').getByText('第 2 版')).toBeVisible()

    // In its section of the item panel.
    await page.getByRole('region', { name: '站点' }).getByRole('row', { name: /短地址/ }).getByRole('cell').first().click()
    const panel = page.getByRole('complementary', { name: '详情' })
    await expect(panel.getByTestId('panel-title')).toHaveText('pager.md')
    await expect(panel.frameLocator(FRAME).locator('#note')).toHaveText('面板里的 pager.md')
  } finally {
    await local.close()
  }
})

test('a reload keeps the open view and panel, a pasted address opens them, and back and forward step through them', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  await page.goto(url)
  const nav = page.getByRole('navigation', { name: '导航' })
  const heading = (name: string) => page.getByRole('heading', { level: 1, name })
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(heading('首页')).toBeVisible()
  await nav.getByRole('button', { name: '新的块' }).click()
  await expect(heading('新的块')).toBeVisible()
  await page.getByRole('region', { name: '站点' }).getByRole('row', { name: /短地址/ }).getByRole('cell').first().click()
  await expect(panel.getByTestId('panel-title')).toHaveText('pager.md')

  await page.reload()
  await expect(heading('新的块')).toBeVisible()
  await expect(panel.getByTestId('panel-title')).toHaveText('pager.md')

  const pasted = await page.context().newPage()
  await pasted.goto(page.url())
  await expect(pasted.getByRole('heading', { level: 1, name: '新的块' })).toBeVisible()
  await expect(pasted.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('pager.md')
  await pasted.close()

  await page.goBack()
  await expect(panel).toHaveCount(0)
  await expect(heading('新的块')).toBeVisible()
  await page.goBack()
  await expect(heading('首页')).toBeVisible()
  await page.goForward()
  await page.goForward()
  await expect(heading('新的块')).toBeVisible()
  await expect(panel.getByTestId('panel-title')).toHaveText('pager.md')
})

test('a view without refresh is not asked for again while nothing changes; one with refresh is, at its pace', async ({ page, pb }) => {
  const url = await pagerLibrary(pb)
  const asked: string[] = []
  let polled = 0
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/api/view') asked.push(u.searchParams.get('view') ?? '')
  })
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/rev') polled++
  })
  // The page's clock, so seven seconds pass at once: the shortest pace a view may ask for is five.
  await page.clock.install()
  await page.goto(`${url}#view=pager.still&panel=pager.ticking`)
  await expect(page.getByRole('heading', { level: 1, name: '不自己更新的页' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('自己更新的页')
  await expect.poll(() => polled).toBeGreaterThanOrEqual(1)
  const before = polled
  await page.clock.runFor(7_000)
  // The page asked three times in those seconds whether the library changed, and had its answers.
  await expect.poll(() => polled).toBeGreaterThanOrEqual(before + 3)
  await frames(page)
  expect(asked.filter((v) => v === 'pager.still')).toHaveLength(1)
  expect(asked.filter((v) => v === 'pager.ticking').length).toBeGreaterThanOrEqual(2)
})
