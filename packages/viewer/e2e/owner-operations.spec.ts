// C5: each owner operation, done from the page: take back a held version, give a file nobody
// registered its provenance, accept a direct change, install and remove a plugin, issue and revoke a
// grant, generate a skill into a directory the owner types. Each leaves a fact; an agent's check from
// the command line then reports those that changed content or capabilities.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, shoot, tempDir, test, write } from './support.ts'

test('every owner operation from the page leaves a trace an agent sees in check', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  const work = tempDir('pb-e2e-work-')
  const skills = tempDir('pb-e2e-skills-')
  pb.run(['init', lib], { testPlugins: true })
  pb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code'], { testPlugins: true })
  const agent = (args: string[], input?: string) => pb.run(['@claude', ...args], { cwd: work, env: { PNEUMA_BASE_SESSION: 'agent-session' }, testPlugins: true, ...(input === undefined ? {} : { input }) })
  agent(['put', '-', '--to', 'doc.md', '--made'], 'first version\n')
  agent(['put', '-', '--to', 'doc.md', '--made'], 'second version\n')
  agent(['put', '-', '--to', 'notes.md', '--brought'], 'notes\n')
  write(lib, 'dropped.md', 'dropped in by hand\n')
  write(lib, 'summary.md', 'a summary written by hand\n')
  write(lib, 'notes.md', 'notes, edited by hand\n')

  const { url } = await pb.view(lib, { testPlugins: true })
  await page.goto(url)
  const nav = page.getByRole('navigation', { name: '导航' })
  const main = page.getByRole('main')
  const panel = page.getByRole('complementary', { name: '详情' })
  const dialog = page.getByRole('dialog')
  const status = page.getByRole('status')

  // Take back the held first version of doc.md, from its panel, to a path the owner types.
  await nav.getByRole('button', { name: '库' }).click()
  await main.getByRole('row', { name: /^doc\.md/ }).click()
  await panel.getByRole('region', { name: '留存' }).getByRole('button', { name: '取回到新路径' }).click()
  await dialog.getByLabel('新的库内路径').fill('doc.first.md')
  await dialog.getByRole('button', { name: '取回到新路径' }).click()
  await expect(status).toContainText('取回到 doc.first.md')
  expect(readFileSync(join(lib, 'doc.first.md'), 'utf8')).toBe('first version\n')
  await expect(main.getByRole('row', { name: /^doc\.first\.md/ })).toContainText('带进来的，主人给的')

  // Give dropped.md its provenance, from the standing page.
  await nav.getByRole('button', { name: '状况' }).click()
  await panel.getByRole('button', { name: '关闭详情' }).click()
  const unowned = main.getByRole('region', { name: '没人登记过的' })
  await unowned.getByRole('listitem').filter({ hasText: 'dropped.md' }).getByRole('button', { name: '记为带进来的' }).click()
  await dialog.getByLabel('出处').fill('从邮件附件存下来的')
  await dialog.getByRole('button', { name: '记为带进来的' }).click()
  await expect(status).toContainText('已放好 dropped.md')

  // summary.md was made from two things of the library: one path per line.
  await unowned.getByRole('listitem').filter({ hasText: 'summary.md' }).getByRole('button', { name: '记为做出来的' }).click()
  await dialog.getByLabel('依据库里的哪些').fill('doc.md\ndoc.first.md')
  await dialog.getByLabel('库外的依据').fill('主人在对话里口述的提纲')
  await shoot(page, 'c5-provenance-dialog')
  await dialog.getByRole('button', { name: '记为做出来的' }).click()
  await expect(status).toContainText('已放好 summary.md')
  await expect(unowned).toHaveCount(0)
  await nav.getByRole('button', { name: '库' }).click()
  await main.getByRole('row', { name: /^summary\.md/ }).click()
  const basis = panel.getByRole('region', { name: '怎么来的', exact: true })
  await expect(basis.getByRole('listitem')).toHaveCount(3)
  await expect(basis).toContainText('doc.first.md')
  await expect(basis).toContainText('主人在对话里口述的提纲')
  await nav.getByRole('button', { name: '状况' }).click()
  await panel.getByRole('button', { name: '关闭详情' }).click()

  // Accept the direct change to notes.md.
  await main.getByRole('region', { name: '被直接改过的' }).getByRole('button', { name: '认下这次改动' }).click()
  await expect(status).toContainText('已认下 notes.md 的直接改动')
  await expect(main.getByText('没有要处理的事')).toBeVisible()

  // Install a plugin offered on the config page, then remove it.
  await nav.getByRole('button', { name: '配置' }).click()
  const plugins = main.getByRole('region', { name: '插件' })
  await plugins.getByRole('row', { name: /pager/ }).getByRole('button', { name: '装上' }).click()
  await expect(status).toContainText('已装上插件 pager')
  await expect(nav.getByRole('button', { name: '块的样例' })).toBeVisible()
  await plugins.getByRole('row', { name: /pager/ }).getByRole('button', { name: '卸下' }).click()
  await expect(status).toContainText('已卸下插件 pager')
  await expect(nav.getByRole('button', { name: '块的样例' })).toHaveCount(0)

  // Issue a grant, then revoke it after confirming.
  const grants = main.getByRole('region', { name: '授权与技能' })
  await grants.getByRole('button', { name: '发授权' }).click()
  await dialog.getByLabel('授权名').fill('codex')
  await dialog.getByLabel('给谁').fill('codex')
  await dialog.getByRole('button', { name: '发授权' }).click()
  await expect(status).toContainText('已发授权 codex 给 codex')
  await grants.getByRole('row', { name: /^codex/ }).getByRole('button', { name: '撤回' }).click()
  await expect(dialog).toContainText('撤回后')
  await dialog.getByRole('button', { name: '撤回' }).click()
  await expect(status).toContainText('已撤回授权 codex')
  await expect(grants.getByRole('row', { name: /^codex/ })).toHaveCount(0)

  // Generate a skill into a directory the owner types.
  await grants.getByRole('row', { name: /^claude/ }).getByRole('button', { name: '为 Claude 生成技能' }).click()
  await dialog.getByLabel('放技能的目录').fill(skills)
  await dialog.getByRole('button', { name: '为 Claude 生成技能' }).click()
  await expect(status).toContainText('已为 claude 写好技能')
  expect(existsSync(join(skills, 'pneuma-base-claude', 'SKILL.md'))).toBe(true)

  // The activity page lists every one of them.
  await nav.getByRole('button', { name: '活动' }).click()
  for (const command of ['ledger held restore', 'plugin add', 'plugin remove', 'grant issue', 'grant revoke', 'skill install']) {
    await expect(main.getByRole('listitem').filter({ hasText: `主人面的操作 ${command}` }).first()).toContainText('主人做的')
  }
  await expect(main.getByRole('listitem').filter({ hasText: '认了 notes.md 的直接改动' })).toContainText('主人做的')

  // An agent's check reports what changed content or capabilities, not the grant or the skill.
  const news = agent(['check']).stdout
  for (const line of ['主人面的操作 ledger held restore', '放入 doc.first.md', '放入 dropped.md（带进来的，主人给的）', '放入 summary.md（做出来的）', '认了 notes.md 的直接改动', '主人面的操作 plugin add', '主人面的操作 plugin remove']) {
    expect(news).toContain(line)
  }
  for (const quiet of ['grant issue', 'grant revoke', 'skill install']) expect(news).not.toContain(quiet)
})

test('removing a plugin that refuses offers 仍然卸下, which asks with the plugin’s sentence and removes it anyway', async ({ page, pb }) => {
  const lib = join(tempDir(), 'lib')
  const www = tempDir('pb-e2e-www-')
  pb.run(['init', lib])
  pb.run(['plugin', 'add', 'deploy', '--library', lib])
  pb.run(['deploy', 'target', 'set', '--kind', 'dir', '--to', www, '--library', lib])
  pb.run(['--library', lib, '--as', 'claude-code', 'put', '-', '--to', 'site.html', '--made'], { input: '<h1>hi</h1>\n' })
  pb.run(['--library', lib, '--as', 'claude-code', 'say', 'deployable', 'site.html'])
  pb.run(['deploy', 'on', 'site.html', '--library', lib])

  const { url } = await pb.view(lib)
  await page.goto(url)
  const main = page.getByRole('main')
  const dialog = page.getByRole('dialog')
  const status = page.getByRole('status')
  await page.getByRole('navigation', { name: '导航' }).getByRole('button', { name: '配置' }).click()
  const deploy = main.getByRole('region', { name: '插件' }).getByRole('row', { name: /^deploy/ })
  await deploy.getByRole('button', { name: '卸下' }).click()
  await expect(status).toContainText('插件 deploy 没有卸下，它说：还有 1 样在线')
  await status.getByRole('button', { name: '仍然卸下' }).click()
  await expect(dialog).toContainText('插件 deploy 说：还有 1 样在线')
  await dialog.getByRole('button', { name: '仍然卸下' }).click()
  await expect(status).toContainText('已卸下插件 deploy')
  await expect(status.getByRole('button', { name: '仍然卸下' })).toHaveCount(0)
  await expect(deploy).toContainText('没装')
  expect(JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')).plugins).toEqual(['ledger'])
})
