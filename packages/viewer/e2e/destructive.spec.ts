// C6: purging the archive asks first; cancelling, by the button or Escape, changes nothing; confirmed,
// the archive is emptied and the purge is recorded. The dialog keeps the keyboard inside it while open.
// That a server started in an agent session refuses it is packages/viewer/test/server.test.ts's.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, fromMenu, openShared, tempDir, test, type Cli } from './support.ts'

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
  // Emptying the archive is rare and destructive: it is in the page head's menu, never one click.
  const head = main.locator('.page-tools')
  const more = head.getByRole('button', { name: '更多' })
  const purge = () => fromMenu(head, '清空归档区')
  await openShared(page, '文件', '归档区')
  // One level at a time: the archived file lies in its folder.
  await expect(main.getByRole('row', { name: /^drafts\// })).toBeVisible()

  // The dialog asks, starts on the safe choice, and Tab never leaves it.
  await purge()
  await expect(dialog).toContainText('不能撤回')
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }

  // Escape cancels; so does the button. Nothing changed, and focus is back on the button.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(more).toBeFocused()
  await purge()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  expect(readFileSync(join(lib, '_archive/drafts/old.md'), 'utf8')).toBe('一份不要了的草稿\n')

  // Confirmed: emptied, and the activity page records it.
  await purge()
  await dialog.getByRole('button', { name: '清空归档区' }).click()
  await expect(page.getByRole('status')).toContainText('已清空归档区，删掉了 1 样东西')
  await expect(main.getByText('归档区是空的')).toBeVisible()
  expect(existsSync(join(lib, '_archive'))).toBe(false)
  await nav.getByRole('button', { name: '活动' }).click()
  await expect(main.getByRole('listitem').filter({ hasText: '主人面的操作 archive purge' }).getByRole('img', { name: '主人' })).toBeVisible()
})
