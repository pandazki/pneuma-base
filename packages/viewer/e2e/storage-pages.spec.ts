// What the library says since it stands on storage, as the page shows it: long lists come a page at a
// time with the page in the address; a directory with nothing registered in it is one row with what a
// look into it found and its three answers; registering all of one and reading every thing's content
// are named passes that say first what they will read, show how far they are with a way to stop, and
// then say what they did; a thing's panel says its state in words, whether its content was read, and
// what storage's facets tell of it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, frames, fromMenu, tempDir, test, write, type Cli } from './support.ts'

const pad = (i: number) => String(i).padStart(3, '0')

/** A library with the ledger, made from what is already in `lib`, and its page. */
async function ledgerLibrary(pb: Cli, lib: string): Promise<string> {
  pb.run(['init', lib])
  return (await pb.view(lib)).url
}

test('a long folder comes 50 at a time: next and previous, the page in the address, the keyboard', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  for (let i = 1; i <= 120; i++) write(lib, `many/n${pad(i)}.md`, `${i}\n`)
  pb.run(['init', lib, '--bare'])
  const { url } = await pb.view(lib)
  await page.goto(`${url}#view=files&view.dir=many`)
  const main = page.getByRole('main')
  const pager = main.getByRole('navigation', { name: '分页' })
  const prev = pager.getByRole('button', { name: '上一页' })
  const next = pager.getByRole('button', { name: '下一页' })
  await expect(pager).toContainText('1–50，共 120 项')
  await expect(main.getByRole('row', { name: /n050\.md/ })).toBeVisible()
  await expect(main.getByRole('row', { name: /n051\.md/ })).toHaveCount(0)
  await expect(prev).toHaveAttribute('aria-disabled', 'true')

  await next.click()
  await expect(pager).toContainText('51–100，共 120 项')
  await expect(main.getByRole('row', { name: /n051\.md/ })).toBeVisible()
  expect(decodeURIComponent(new URL(page.url()).hash)).toContain('view.after=n050.md')
  // The page is in the address: a reload opens the same one.
  await page.reload()
  await expect(pager).toContainText('51–100，共 120 项')

  // Tab reaches the turns; Enter and Space press them, ← and → turn the page while the keyboard is there.
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(pager).toContainText('101–120，共 120 项')
  await expect(next).toBeFocused()
  await expect(next).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(pager).toContainText('51–100，共 120 项')
  await page.keyboard.press('Shift+Tab')
  await expect(prev).toBeFocused()
  await page.keyboard.press('Space')
  await expect(pager).toContainText('1–50，共 120 项')
  // The browser's back steps through the pages.
  await page.goBack()
  await expect(pager).toContainText('51–100，共 120 项')
})

test('the library’s table and a bundle’s first level in the panel page the same way', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  for (let i = 1; i <= 60; i++) write(lib, `notes/n${pad(i)}.md`, `${i}\n`)
  for (let i = 1; i <= 55; i++) write(lib, `site/p${pad(i)}.html`, `<p>${i}</p>\n`)
  write(lib, 'site/.pneuma-item', '{"format":1}\n')
  const url = await ledgerLibrary(pb, lib)
  pb.run(['ledger', 'register', 'notes', '--recursive', '--library', lib])
  await page.goto(`${url}#view=ledger.items&view.dir=notes`)
  const main = page.getByRole('main')
  const pager = main.getByRole('navigation', { name: '分页' })
  await expect(pager).toContainText('1–50，共 60 项')
  await pager.getByRole('button', { name: '下一页' }).click()
  await expect(pager).toContainText('51–60，共 60 项')
  // In the folder chosen, a row names the thing alone.
  await expect(main.getByRole('row', { name: /^n060\.md/ })).toBeVisible()

  await page.goto(`${url}#view=files&panel=item&panel.path=site`)
  const panel = page.getByRole('complementary', { name: '详情' })
  const level = panel.getByRole('region', { name: '内容' })
  const turns = level.getByRole('navigation', { name: '分页' })
  await expect(turns).toContainText('1–50，共 55 项')
  await turns.getByRole('button', { name: '下一页' }).click()
  await expect(turns).toContainText('51–55，共 55 项')
  await expect(level.getByRole('row', { name: /p055\.html/ })).toBeVisible()
  expect(decodeURIComponent(new URL(page.url()).hash)).toContain('panel.after=p050.html')
})

test('a directory with nothing registered in it is one row: what a look found, and its three answers', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  write(lib, 'proj/package.json', '{}\n')
  write(lib, 'proj/.git/HEAD', 'ref: refs/heads/main\n')
  for (let i = 1; i <= 12; i++) write(lib, `proj/src/m${i}.ts`, `export const m${i} = ${i}\n`)
  for (let i = 1; i <= 3; i++) write(lib, `scans/s${i}.pdf`, `scan ${i}\n`)
  write(lib, 'junk/cache.bin', 'x')
  const url = await ledgerLibrary(pb, lib)

  // On the home page it is one question, saying what the look found.
  await page.goto(url)
  const decide = page.getByRole('region', { name: '待处理' })
  await expect(decide).toContainText('proj/ 未登记：13 个文件，可能是项目目录（package.json、.git）。')

  await page.goto(`${url}#view=files`)
  const main = page.getByRole('main')
  const proj = main.getByRole('row', { name: /^proj\// })
  await expect(proj).toContainText('未登记')
  await expect(proj).toContainText('13 个文件，可能是项目目录（package.json、.git）')
  // The first answer is the row's button; the other two are in its menu.
  await expect(proj.getByRole('button', { name: '登记为条目' })).toBeVisible()
  await proj.getByRole('button', { name: '更多' }).click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['登记目录内的文件', '忽略'])
  await page.keyboard.press('Escape')

  // 忽略: it joins the library's ignore rules and is gone from the page.
  await fromMenu(main.getByRole('row', { name: /^junk\// }), '忽略')
  await expect(page.getByRole('status')).toContainText('已忽略：junk')
  await expect(main.getByRole('row', { name: /^junk\// })).toHaveCount(0)

  // 登记目录内的文件: it says first what it will register, then what it did; the folder is an open one after.
  await fromMenu(main.getByRole('row', { name: /^scans\// }), '登记目录内的文件')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('将登记 scans/ 中所有层级的全部文件：3 个，不含已忽略的。')
  await dialog.getByRole('button', { name: '登记目录内的文件' }).click()
  await expect(page.getByRole('status')).toContainText('已将 scans/ 中的 3 个文件标记为所有者导入。')
  await expect(main.getByRole('row', { name: /^scans\// })).not.toContainText('未登记')

  // 登记为条目: it is one thing now, which opens its panel.
  await proj.getByRole('button', { name: '登记为条目' }).click()
  await expect(page.getByRole('status')).toContainText('已添加 proj')
  const thing = main.getByRole('row', { name: /^proj\b/ })
  await expect(thing).not.toContainText('未登记')
  await thing.click()
  await expect(page.getByRole('complementary', { name: '详情' }).getByTestId('panel-title')).toHaveText('proj')
})

test('a named pass says what it will read, shows how far it is with a way to stop, then says what it did', async ({ page, pb }) => {
  // More files than a look reads within its budget, and enough that reading them all takes seconds.
  const lib = join(tempDir(), 'lib')
  for (let d = 0; d < 10; d++) mkdirSync(join(lib, `big/d${d}`), { recursive: true })
  for (let i = 0; i < 20000; i++) writeFileSync(join(lib, `big/d${Math.floor(i / 2000)}/f${i}.txt`), `${i}\n`)
  const url = await ledgerLibrary(pb, lib)
  // The page's clock, so the time a notice usually shows passes at once.
  await page.clock.install()
  await page.goto(`${url}#view=files`)
  const main = page.getByRole('main')
  const notices = page.getByRole('status')

  // Registering all of a directory: what a look within its budget found, at least that many, then what it did.
  await fromMenu(main.getByRole('row', { name: /^big\// }), '登记目录内的文件')
  await expect(page.getByRole('dialog')).toContainText(/将登记 big\/ 中所有层级的全部文件：至少 \d+ 个，不含已忽略的。/)
  await page.getByRole('dialog').getByRole('button', { name: '登记目录内的文件' }).click()
  await expect(notices).toContainText('已将 big/ 中的 20000 个文件标记为所有者导入。')

  // Reading every registered thing's content: how many first, how far it is, and a stop that keeps what was read.
  await page.goto(`${url}#view=ledger.status`)
  await main.getByRole('button', { name: '深度检查' }).click()
  await expect(page.getByRole('dialog')).toContainText('将读取整个资料库的内容：20000 个已登记条目。')
  await page.getByRole('dialog').getByRole('button', { name: '深度检查' }).click()
  const bar = notices.getByRole('progressbar', { name: '进度' })
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('aria-valuemax', '20000')
  await expect(notices).toContainText(/已检查 \d+ \/ 20000 个/)
  await notices.getByRole('button', { name: '停止' }).click()
  await expect(notices.getByRole('button', { name: '正在停止…' })).toBeDisabled()
  await expect(notices).toContainText(/已停止：整个资料库已检查 \d+ \/ 20000 个已登记条目。/)
  await expect(bar).toHaveCount(0)
  // What it did stays past the time a notice usually shows, until it is closed; nothing holds the
  // notices meanwhile, as the pointer or the keyboard on them would.
  await page.mouse.move(1, 1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.clock.runFor(5_000)
  await frames(page)
  await expect(notices).toContainText('已停止')
})

/** Apple's binary property list of a list of strings, as the extended attributes hold it. */
function bplist(strings: string[]): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${strings.map((s) => `<string>${s}</string>`).join('')}</array></plist>`
  return execFileSync('plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: xml }).toString('hex')
}

test('a thing’s panel says its state in words, whether its content was read, and where it was downloaded from', async ({ page, pb }) => {
  // The where-from, quarantine and tag attributes exist only on macOS, and so does the `macos` facet.
  test.skip(process.platform !== 'darwin', 'needs macOS file attributes')
  const lib = join(tempDir(), 'lib')
  const outside = tempDir('pb-e2e-out-')
  write(lib, 'report.pdf', '%PDF-1.4 report\n')
  write(lib, 'memo.txt', '备忘\n')
  const file = join(lib, 'report.pdf')
  execFileSync('xattr', ['-wx', 'com.apple.metadata:kMDItemWhereFroms', bplist(['https://example.com/report.pdf']), file])
  execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;6aee14ed;Safari;0A1B2C3D-0000-0000-0000-000000000000', file])
  execFileSync('xattr', ['-wx', 'com.apple.metadata:_kMDItemUserTags', bplist(['工作\n6']), file])
  const url = await ledgerLibrary(pb, lib)
  // Registered as it lies: no content read. Something made from it rests on it.
  pb.run(['ledger', 'register', '.', '--library', lib])
  pb.run(['--library', lib, '--as', 'claude-code', 'put', '-', '--to', 'notes/summary.md', '--generated', '--from', 'report.pdf'], { cwd: outside, input: '# 摘要\n' })

  await page.goto(`${url}#view=files&panel=item&panel.path=report.pdf`)
  const panel = page.getByRole('complementary', { name: '详情' })
  const ledger = panel.getByRole('region', { name: '溯源' })
  // Consistent with the record is the usual state: no state is said. Whether the content was read is in the folded record.
  await expect(ledger.getByRole('term').filter({ hasText: '状态' })).toHaveCount(0)
  const record = ledger.getByRole('region', { name: '记录', exact: true })
  await record.getByRole('button', { name: '记录', exact: true }).click()
  await expect(record).toContainText('未读取')
  const facts = panel.getByRole('region', { name: '文件', exact: true })
  await expect(facts.getByRole('link', { name: 'https://example.com/report.pdf' })).toHaveAttribute('href', 'https://example.com/report.pdf')
  await expect(facts).toContainText('下载应用Safari')
  await expect(facts).toContainText('标签工作')

  // Things rest on it, so reading its content is offered; once read, the panel says so.
  await panel.getByRole('button', { name: '读取内容' }).click()
  await expect(page.getByRole('status')).toContainText('深度检查完成：report.pdf 共 1 个已登记条目。')
  await expect(record).toContainText(/已读取 · [0-9a-f]{12}/)
  await expect(panel.getByRole('button', { name: '读取内容' })).toHaveCount(0)

  // Changed outside the library: the state says so in words; with its content read before, whether the content differs.
  write(lib, 'report.pdf', '%PDF-1.4 report, edited\n')
  await page.reload()
  const state = ledger.getByRole('definition').first()
  await expect(state).toContainText('外部修改')
  await expect(state).toContainText('内容与记录不一致')
  // One never read says only its state was compared.
  write(lib, 'memo.txt', '备忘，改过\n')
  await page.goto(`${url}#view=files&panel=item&panel.path=memo.txt`)
  await expect(state).toContainText('外部修改')
  await expect(state).toContainText('仅比较了状态，内容未读取')
  await expect(panel.getByRole('button', { name: '确认修改' })).toBeVisible()
})
