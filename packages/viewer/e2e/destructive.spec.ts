// C6: purging the archive asks first; cancelling, by the button or Escape, changes nothing; confirmed,
// the archive is emptied and the purge is recorded. A server started in an agent session refuses it
// and the page says why. The dialog keeps the keyboard inside it while open.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, shoot, tempDir, test, type Cli } from './support.ts'

function archivedLibrary(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  pb.run(['--library', lib, '--as', 'claude-code', 'put', '-', '--to', 'drafts/old.md', '--made'], { input: '一份不要了的草稿\n' })
  pb.run(['--library', lib, '--as', 'claude-code', 'archive', 'drafts/old.md'])
  return lib
}

test('purging the archive asks first; cancelled, nothing changes; confirmed, it is emptied and recorded', async ({ page, pb }) => {
  const lib = archivedLibrary(pb)
  const { url } = await pb.view(lib)
  await page.goto(url)
  const nav = page.getByRole('navigation', { name: '导航' })
  const main = page.getByRole('main')
  const dialog = page.getByRole('dialog')
  const purge = main.getByRole('button', { name: '清空归档区' })
  await nav.getByRole('button', { name: '归档区' }).click()
  await expect(main.getByRole('row', { name: /drafts\/old\.md/ })).toBeVisible()

  // The dialog asks, starts on the safe choice, and Tab never leaves it.
  await purge.click()
  await expect(dialog).toContainText('不能撤回')
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await shoot(page, 'c6-confirm-dialog')

  // Escape cancels; so does the button. Nothing changed, and focus is back on the button.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(purge).toBeFocused()
  await purge.click()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  expect(readFileSync(join(lib, '_archive/drafts/old.md'), 'utf8')).toBe('一份不要了的草稿\n')

  // Confirmed: emptied, and the activity page records it.
  await purge.click()
  await dialog.getByRole('button', { name: '清空归档区' }).click()
  await expect(page.getByRole('status')).toContainText('已清空归档区，删掉了 1 样东西')
  await expect(main.getByText('归档区是空的')).toBeVisible()
  expect(existsSync(join(lib, '_archive'))).toBe(false)
  await nav.getByRole('button', { name: '动态' }).click()
  await expect(main.getByRole('row').filter({ hasText: '主人面的操作 archive purge' })).toContainText('主人')
})

test('a server started in an agent session refuses the purge, and the page says why', async ({ page, pb }) => {
  const lib = archivedLibrary(pb)
  const { url } = await pb.view(lib, { env: { CLAUDE_CODE_SESSION_ID: 'session-of-an-agent' } })
  await page.goto(url)
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '归档区' }).click()
  await page.getByRole('main').getByRole('button', { name: '清空归档区' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '清空归档区' }).click()
  const status = page.getByRole('status')
  await expect(status).toContainText('不能在 agent 的会话里做')
  await expect(status).toContainText('CLAUDE_CODE_SESSION_ID')
  // The refusal stays until the owner closes it.
  await page.waitForTimeout(5_000)
  await expect(status).toContainText('CLAUDE_CODE_SESSION_ID')
  expect(readFileSync(join(lib, '_archive/drafts/old.md'), 'utf8')).toBe('一份不要了的草稿\n')
  await status.getByRole('button', { name: '关闭' }).click()
  await expect(status).not.toContainText('CLAUDE_CODE_SESSION_ID')
})
