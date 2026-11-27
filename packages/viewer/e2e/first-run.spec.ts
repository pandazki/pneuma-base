// The owner's first run in the page: the home page's 「开始」 through its three states, the drop area
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

test('开始 walks the owner from a new library to an agent at work, each step folding once it is done', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  await page.goto(url)
  const start = page.getByRole('main').getByRole('region', { name: '开始' })
  await expect(start).toContainText('0 / 3')
  const connect = start.getByRole('listitem', { name: /第 1 步，接上你的 agent，在做/ })
  await expect(connect.getByRole('listitem').filter({ hasText: 'Claude Code' }).getByRole('button', { name: '接上' })).toBeVisible()
  // Only the current step shows what to do; the others are one line each and open on a click.
  const second = start.getByRole('listitem', { name: /第 2 步，放进第一样东西，还没做/ })
  await expect(second).not.toContainText('pneuma-base put')
  await second.getByRole('button', { name: /放进第一样东西/ }).click()
  await expect(second).toContainText(`pneuma-base put <文件或文件夹> --to inbox/<名字> --brought --by owner --library '${lib}'`)
  const third = start.getByRole('listitem', { name: /第 3 步，对你的 agent 说一句/ })
  await third.getByRole('button', { name: /对你的 agent 说一句/ }).click()
  await expect(third).toContainText('看看我的 Pneuma Base 库里有什么。')

  // One click: no form, the same agent connect the agents page runs.
  await connect.getByRole('listitem').filter({ hasText: 'Claude Code' }).getByRole('button', { name: '接上' }).click()
  const done = start.getByRole('listitem', { name: /第 1 步，接上你的 agent，做完了/ })
  await expect(done.getByRole('button', { name: /接上你的 agent.*已接上 Claude Code/ })).toBeVisible()
  expect(existsSync(join(pb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'))).toBe(true)
  await expect(start.getByRole('listitem', { name: /第 2 步，放进第一样东西，在做/ })).toBeVisible()
  // A done step opens again on a click, with what it offered.
  await done.getByRole('button', { name: /接上你的 agent/ }).click()
  await expect(done.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('已接上')
  await done.getByRole('button', { name: /接上你的 agent/ }).click()

  const paper = join(tempDir('pb-e2e-out-'), 'paper.pdf')
  writeFileSync(paper, '%PDF')
  pb.run(['--library', lib, 'put', paper, '--to', 'inbox/paper.pdf', '--brought', '--by', 'owner'], { env: noAgentPath() })
  await expect(start.getByRole('listitem', { name: /第 2 步，放进第一样东西，做完了/ })).toContainText('库的根目录里有 1 样东西')
  await expect(start).toContainText('2 / 3')

  pb.run(['@claude-code', 'start', '看看库里有什么'], { env: noAgentPath() })
  await expect(page.getByRole('main').getByRole('region', { name: '开始' })).toHaveCount(0)
  // The home page goes on without it: nothing to decide is not drawn, what the agent did since is.
  await expect(page.getByRole('main').getByRole('region', { name: '自上次以来' })).toBeVisible()
})

test('in the app the drop area chooses files for the app to put into inbox/; in a browser it shows the command', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  const sent = await catchShell(page)
  await page.goto(`${url}&shell=mac`)
  const start = page.getByRole('main').getByRole('region', { name: '开始' })
  await start.getByRole('button', { name: /放进第一样东西/ }).click()
  const drop = start.getByRole('button', { name: /把文件或文件夹拖到这里，或 选择…/ })
  await expect(drop).toContainText('放进 inbox/，记成你带进来的')
  await expect(start).not.toContainText('pneuma-base put')
  await drop.click()
  expect(await sent()).toContainEqual({ type: 'choose', to: 'inbox' })
})

test('in the app, the page shows what the app says it did and opens the links the panel hands it', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  const { url } = await pb.view(lib, { env: noAgentPath() })
  await page.goto(`${url}&shell=mac`)
  await expect(page.getByRole('main').getByRole('region', { name: '开始' })).toBeVisible()
  const tell = (detail: unknown) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: d })), detail)
  await tell({ notice: { tone: 'good', text: '已放进 inbox/paper.pdf，记成你带进来的' } })
  await expect(page.getByText('已放进 inbox/paper.pdf，记成你带进来的')).toBeVisible()
  await tell({ link: { view: 'agents', params: {}, target: 'main' } })
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('region', { name: '这台机器上找到的' })).toBeVisible()
})

test('the menu bar panel: the library, what waits for the owner decided right there, the latest rows, and the two buttons', async ({ page, pb }) => {
  const lib = newLibrary(pb)
  pb.run(['--library', lib, 'plugin', 'add', 'deploy'], { env: noAgentPath() })
  pb.run(['--library', lib, 'deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-e2e-www-'), 'www')], { env: noAgentPath() })
  pb.run(['--library', lib, 'agent', 'connect', 'claude-code'], { env: noAgentPath() })
  const site = tempDir('pb-e2e-site-')
  for (const name of ['shop', 'blog', 'docs', 'notes']) write(site, `${name}/index.html`, `<h1>${name}</h1>`)
  for (const name of ['shop', 'blog', 'docs', 'notes']) {
    pb.run(['@claude-code', 'put', name, '--to', `sites/${name}`, '--made'], { cwd: site, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'sites' } })
    pb.run(['@claude-code', 'say', 'deployable', `sites/${name}`], { cwd: site, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'sites' } })
  }
  for (const name of ['a', 'b']) pb.run(['@claude-code', 'put', '-', '--to', `notes/${name}.md`, '--made'], { input: `# ${name}\n`, env: { ...noAgentPath(), PNEUMA_BASE_SESSION: 'notes' } })
  const { url } = await pb.view(lib, { env: noAgentPath() })
  const sent = await catchShell(page)
  await page.setViewportSize({ width: 340, height: 640 })
  await page.goto(`${url}&shell=mac&panel=tray`)
  const panel = page.locator('.tray')
  await expect(panel.getByRole('button', { name: '库：我的库，换一个库' })).toBeVisible()
  await expect(panel.locator('.tray-head')).toContainText('4 件等你')
  const decide = panel.getByRole('region', { name: '等你决定' })
  await expect(decide.locator('.asks-row')).toHaveCount(3)
  await expect(decide.getByRole('button', { name: '还有 1 件，在窗口里看' })).toBeVisible()
  const latest = panel.getByRole('region', { name: '自上次以来' })
  await expect(latest.getByRole('listitem')).toHaveCount(5)
  await expect(latest.getByRole('listitem').first()).toContainText('notes/b.md')
  await expect.poll(sent).toContainEqual({ type: 'waiting', count: 4 })

  await decide.getByRole('button', { name: '上线', exact: true }).first().click()
  await expect(decide.getByRole('status')).toContainText('上线')
  await expect.poll(sent).toContainEqual({ type: 'waiting', count: 3 })
  await panel.getByRole('button', { name: '打开窗口' }).click()
  await panel.getByRole('button', { name: '退出' }).click()
  await panel.getByRole('button', { name: '库：我的库，换一个库' }).click()
  const messages = await sent()
  expect(messages).toContainEqual({ type: 'open' })
  expect(messages).toContainEqual({ type: 'quit' })
  expect(messages).toContainEqual({ type: 'libraries' })
  expect(messages.some((m) => (m as { type: string }).type === 'height')).toBe(true)
})
