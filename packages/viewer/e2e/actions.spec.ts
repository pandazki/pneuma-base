// How a region offers what can be done without a row of text buttons: the item panel's head with its
// icons, their keys and its 「···」 menu, a note written where the history is, and a table row whose
// actions show on hover or focus. Each is what the owner reaches by mouse and by keyboard alone.
import { expect, relay, test } from './support.ts'

const THING = 'payments/comparison.md'

test('the panel head: archive and move are icons that name their keys, the rarer actions are in a menu the keyboard drives', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.items&panel=item&panel.path=${encodeURIComponent(THING)}`)
  const panel = page.getByRole('complementary', { name: '详情' })
  await expect(panel.getByTestId('panel-title')).toHaveText('comparison.md')

  // The frequent ones: an icon each, its name and key in the tooltip and for the screen reader.
  const archive = panel.getByRole('button', { name: '归档', exact: true })
  await expect(archive).toHaveAttribute('aria-keyshortcuts', 'E')
  await expect(archive).toHaveAttribute('data-tip', '归档 E')
  await expect(panel.getByRole('button', { name: '移动' })).toHaveAttribute('aria-keyshortcuts', 'M')
  // No row of text buttons: the basis is an icon too, and the decision is not a button of its own.
  await expect(panel.getByRole('button', { name: '补充依据' })).toHaveAttribute('data-tip', '补充依据')
  await expect(panel.getByRole('button', { name: '添加决策' })).toHaveCount(0)

  // The menu opens from the keyboard, walks with the arrows, and Escape gives the focus back.
  const more = panel.getByRole('button', { name: '更多' }).first()
  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: '添加决策' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(more).toBeFocused()

  // Chosen from the menu, an action asks what it needs as a button would.
  await more.click()
  await menu.getByRole('menuitem', { name: '添加决策' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('说明').fill('先只接 Paddle')
  await dialog.getByRole('button', { name: '添加决策' }).click()
  const happened = panel.getByRole('region', { name: '历史记录' })
  await expect(happened.getByRole('listitem').filter({ hasText: '先只接 Paddle' })).toContainText('决策')
  await expect(dialog).toHaveCount(0)

  // Its key works while the focus is in the panel: E archives the thing.
  await panel.getByTestId('panel-title').click()
  await page.keyboard.press('e')
  await expect(page.getByRole('status')).toContainText(`已归档：${THING}`)
})

test('a note is written where the history is: Enter records it, the field empties, Escape drops what was typed', async ({ page, pb }) => {
  const lib = relay(pb)
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=ledger.items&panel=item&panel.path=${encodeURIComponent(THING)}`)
  const panel = page.getByRole('complementary', { name: '详情' })
  const happened = panel.getByRole('region', { name: '历史记录' })
  const note = happened.getByRole('textbox', { name: '添加备注' })
  await expect(note).toHaveAttribute('placeholder', '添加备注…')

  // Escape takes back what was typed, and nothing is recorded.
  await note.fill('还没想好')
  await page.keyboard.press('Escape')
  await expect(note).toHaveValue('')

  // The arrow shows once something is typed; Enter records it in place, with no dialog.
  await note.fill('欧洲的税由 Paddle 处理')
  await expect(happened.getByRole('button', { name: '添加备注：提交' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(happened.getByRole('listitem').filter({ hasText: '欧洲的税由 Paddle 处理' })).toBeVisible()
  await expect(note).toHaveValue('')
  expect(pb.run(['--library', lib, 'inspect', THING]).stdout).toContain('欧洲的税由 Paddle 处理')
})

test('a row that opens something keeps its actions out of sight until it is hovered or has the focus', async ({ page, pb }) => {
  const lib = relay(pb)
  pb.run(['--library', lib, 'archive', 'payments/recommendation.md'])
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=archive&view.dir=_archive/payments`)
  const main = page.getByRole('main')
  const row = main.getByRole('row', { name: /recommendation\.md/ })
  const actions = row.locator('.row-actions')
  const restore = row.getByRole('button', { name: '取消归档' })
  await expect(restore).toHaveAttribute('data-tip', '取消归档')
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS('opacity', '0')
  await row.hover()
  await expect(actions).toHaveCSS('opacity', '1')
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS('opacity', '0')
  // From the keyboard: the button itself takes the focus and shows.
  await restore.focus()
  await expect(actions).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status')).toContainText('已取消归档：_archive/payments/recommendation.md → payments/recommendation.md')
})
