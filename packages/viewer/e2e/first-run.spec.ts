// The owner's first run in the page: the home page's 「快速开始」 through its three states, the drop area
// as the app and a browser show it, what the app tells the page, and the menu bar panel's layout. HOME
// is the test's own, with the product folders the test makes, and PATH has no agent program on it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, tempDir, test, write, type Cli } from './support.ts'

const noAgentPath = () => ({ PATH: `${tempDir('pb-e2e-bin-')}:/usr/bin:/bin` })

/** A new library, and the folders that show Claude Code and Cursor are on this machine. */
function newLibrary(pb: Cli): string {
  mkdirSync(join(pb.home, '.claude'), { recursive: true })
  mkdirSync(join(pb.home, '.cursor'), { recursive: true })
  const lib = join(tempDir(), '我的库')
  pb.run(['init', lib], { env: noAgentPath() })
  return lib
}

/** What the page asks of the app, as the app would receive it. */
async function catchShell(page: Page): Promise<() => Promise<unknown[]>> {
  await page.addInitScript(() => {
    const sent: unknown[] = []
    ;(window as unknown as { sent: unknown[] }).sent = sent
    ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { shell: { postMessage: (m: unknown) => sent.push(m) } } }
  })
  return () => page.evaluate(() => (window as unknown as { sent: unknown[] }).sent)
}

test('快速开始 walks the owner from a new library to an agent at work, each step folding once it is done', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  await page.goto(url)
  const start = page.getByRole('main').getByRole('region', { name: '快速开始' })
  await expect(start).toContainText('0 / 3')
  const connect = start.getByRole('listitem', { name: /第 1 步，连接 Agent，进行中/ })
  await expect(connect.getByRole('listitem').filter({ hasText: 'Claude Code' }).getByRole('button', { name: '连接' })).toBeVisible()
  // Only the current step shows what to do; the others are one line each and open on a click.
  const second = start.getByRole('listitem', { name: /第 2 步，添加第一个条目，未完成/ })
  await expect(second).not.toContainText('pneuma-base put')
  await second.getByRole('button', { name: /添加第一个条目/ }).click()
  await expect(second).toContainText(`pneuma-base put <文件或文件夹> --to inbox/<名称> --imported --by owner --library '${lib}'`)
  const third = start.getByRole('listitem', { name: /第 3 步，向 Agent 发出第一条指令/ })
  await third.getByRole('button', { name: /向 Agent 发出第一条指令/ }).click()
  await expect(third).toContainText('查看我的 Pneuma Base 资料库中有哪些内容。')

  // One click: no form, the same agent connect the agents page runs.
  await connect.getByRole('listitem').filter({ hasText: 'Claude Code' }).getByRole('button', { name: '连接' }).click()
  const done = start.getByRole('listitem', { name: /第 1 步，连接 Agent，已完成/ })
  await expect(done.getByRole('button', { name: /连接 Agent.*已连接 Claude Code/ })).toBeVisible()
  expect(existsSync(join(pb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'))).toBe(true)
  await expect(start.getByRole('listitem', { name: /第 2 步，添加第一个条目，进行中/ })).toBeVisible()
  // A done step opens again on a click, with what it offered.
  await done.getByRole('button', { name: /连接 Agent/ }).click()
  await expect(done.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('已连接')
  await done.getByRole('button', { name: /连接 Agent/ }).click()

  const paper = join(tempDir('pb-e2e-out-'), 'paper.pdf')
  writeFileSync(paper, '%PDF')
  pb.run(['--library', lib, 'put', paper, '--to', 'inbox/paper.pdf', '--imported', '--by', 'owner'], { env: noAgentPath() })
  await expect(start.getByRole('listitem', { name: /第 2 步，添加第一个条目，已完成/ })).toContainText('资料库根目录中有 1 个条目')
  await expect(start).toContainText('2 / 3')

  pb.run(['@claude-code', 'start', '看看库里有什么'], { env: noAgentPath() })
  await expect(page.getByRole('main').getByRole('region', { name: '快速开始' })).toHaveCount(0)
  // The home page goes on without it: nothing to decide is not drawn, what the agent did since is.
  await expect(page.getByRole('main').getByRole('region', { name: '最近动态' })).toBeVisible()
})

test('in the app the drop area chooses files for the app to put into inbox/; in a browser it shows the command', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  const sent = await catchShell(page)
  await page.goto(`${url}&shell=mac`)
  const start = page.getByRole('main').getByRole('region', { name: '快速开始' })
  await start.getByRole('button', { name: /添加第一个条目/ }).click()
  const drop = start.getByRole('button', { name: /将文件或文件夹拖到此处，或 选择…/ })
  await expect(drop).toContainText('添加到 inbox/，标记为我导入')
  await expect(start).not.toContainText('pneuma-base put')
  await drop.click()
  expect(await sent()).toContainEqual({ type: 'choose', to: 'inbox' })
})

test('in the app, the page shows what the app says it did and opens the links the panel hands it', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  await page.goto(`${url}&shell=mac`)
  await expect(page.getByRole('main').getByRole('region', { name: '快速开始' })).toBeVisible()
  const tell = (detail: unknown) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: d })), detail)
  await tell({ notice: { tone: 'good', text: '已添加 inbox/paper.pdf，标记为我导入' } })
  await expect(page.getByText('已添加 inbox/paper.pdf，标记为我导入')).toBeVisible()
  await tell({ link: { view: 'agents', params: {}, target: 'main' } })
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('region', { name: '可连接' })).toBeVisible()
})

test('the menu bar panel: the library, what waits for the owner decided right there, the latest rows one line each, the window and the app’s menu as icons', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  pb.run(['--library', lib, 'plugin', 'enable', 'deploy'], { env: noAgentPath() })
  pb.run(['--library', lib, 'deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-e2e-www-'), 'www')], { env: noAgentPath() })
  pb.run(['--library', lib, 'agent', 'connect', 'claude-code'], { env: noAgentPath() })
  const site = tempDir('pb-e2e-site-')
  for (const name of ['shop', 'blog', 'docs', 'notes']) write(site, `${name}/index.html`, `<h1>${name}</h1>`)
  for (const name of ['shop', 'blog', 'docs', 'notes']) {
    pb.run(['@claude-code', 'put', name, '--to', `sites/${name}`, '--generated'], { cwd: site, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'sites' } })
    pb.run(['@claude-code', 'say', 'deployable', `sites/${name}`], { cwd: site, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'sites' } })
  }
  for (const name of ['a', 'b']) pb.run(['@claude-code', 'put', '-', '--to', `notes/${name}.md`, '--generated'], { input: `# ${name}\n`, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'notes' } })
  const { url } = await pb.view(lib, { env: noAgentPath() })
  const sent = await catchShell(page)
  await page.setViewportSize({ width: 340, height: 640 })
  await page.goto(`${url}&shell=mac&panel=tray`)
  const panel = page.locator('.tray')
  await expect(panel.getByRole('link', { name: '我的库' })).toBeVisible()
  await expect(panel.locator('.tray-head').getByRole('img', { name: '4 项待处理' })).toHaveText('4')
  // No text button: the head's two are icons; what waits answers with its own.
  expect(await panel.locator('button').evaluateAll((els) => els.filter((b) => !b.closest('.asks-answers') && b.textContent?.trim()).length)).toBe(0)
  const decide = panel.getByRole('region', { name: '待处理' })
  await expect(decide.locator('.asks-row')).toHaveCount(3)
  await expect(decide.getByRole('link', { name: '另有 1 项，在主窗口中查看' })).toBeVisible()
  // What happened: one line each, the thing by its name; that a deployable site was declared is not a row.
  const latest = panel.getByRole('region', { name: '最近动态' })
  await expect(latest.getByRole('listitem')).toHaveCount(6)
  await expect(latest.getByRole('listitem').first().locator('.feed-name')).toHaveText('b.md')
  expect(Math.max(...(await latest.getByRole('listitem').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))))).toBeLessThanOrEqual(34)
  await expect.poll(sent).toContainEqual({ type: 'waiting', count: 4 })

  await decide.getByRole('button', { name: '上线', exact: true }).first().click()
  await expect(decide.getByRole('status')).toContainText('上线')
  await expect.poll(sent).toContainEqual({ type: 'waiting', count: 3 })
  await panel.getByRole('button', { name: '打开主窗口' }).click()
  await panel.getByRole('button', { name: '更多' }).click()
  await panel.getByRole('link', { name: '我的库' }).click()
  const messages = await sent()
  expect(messages).toContainEqual({ type: 'open' })
  expect(messages).toContainEqual({ type: 'open', link: { view: 'home', params: {}, target: 'main' } })
  expect(messages.some((m) => (m as { type: string }).type === 'panel-menu')).toBe(true)
  expect(messages.some((m) => (m as { type: string }).type === 'height')).toBe(true)
})
