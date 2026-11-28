// Every page of the management UI is a read-only command: `pneuma-base show` prints it in words, or
// with --json as the ViewResult the page gets. An agent reads every page the owner reads, except the
// pages of management, which it is refused as it is refused an owner-only command.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from '@pneuma-base/viewer'
import { beforeAll, describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let work: string

const owner = (args: string[]) => sb.run(['--library', lib, ...args], { cwd: work })
const agent = (args: string[], input?: string) => sb.run(['@claude', ...args], { cwd: work, env: { PNEUMA_BASE_SESSION: 'agent-show' }, ...(input === undefined ? {} : { input }) })

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  work = tempDir('pb-work-')
  expect(sb.run(['init', lib]).code).toBe(0)
  expect(owner(['grant', 'create', 'claude', '--agent', 'claude-code']).code).toBe(0)
  expect(agent(['put', '-', '--to', 'notes/a.md', '--generated', '--note', '第一版'], '# 笔记\n').code).toBe(0)
  expect(agent(['put', '-', '--to', 'notes/old.md', '--generated'], 'old\n').code).toBe(0)
  expect(agent(['archive', 'notes/old.md']).code).toBe(0)
})

const facts = () => readdirSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true }).length

describe('pneuma-base show', () => {
  it('with no view lists the views of the library, each with its title and who gives it', () => {
    const r = owner(['show'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^ {2}ledger\.items +资料库 +ledger/m)
    expect(r.stdout).toMatch(/^ {2}settings +设置 +kernel +仅所有者$/m)
    expect(r.stdout).toMatch(/^ {2}item +条目 +kernel +从其他页面的链接打开$/m)
    // A view that shares a navigation entry says with which.
    expect(r.stdout).toMatch(/^ {2}ledger\.status +状态 +ledger +.*与 ledger\.items 共用入口$/m)
    expect(r.stdout).toMatch(/^ {2}archive +已归档 +kernel +与 files 共用入口$/m)
    const list = owner(['show', '--json']).json()
    expect(list.views.find((v: { id: string }) => v.id === 'ledger.scenes')).toMatchObject({ title: '场景', by: 'ledger', nav: true })
    expect(list.views.find((v: { id: string }) => v.id === 'settings')).toMatchObject({ by: 'kernel', ownerOnly: true })
  })

  // ARCHITECTURE.md「归档区（`archive`）」: the archive page lists one level at a time; a folder row opens the next level.
  it('prints a page in words, every button as the command that does the same, marked when only the owner may and with the question it asks', () => {
    const r = owner(['show', 'archive'])
    expect(r.code, r.stderr).toBe(0)
    const head = ['$ archive purge  # 清空归档（仅所有者）；需确认：清空归档？已归档的条目将全部删除，且无法撤销。', expect.stringMatching(/^原路径 +大小 +修改时间 +打开$/)]
    expect(r.stdout.trimEnd().split('\n')).toEqual(['# 已归档', ...head, expect.stringMatching(/^notes\/ +→ show archive --dir _archive\/notes$/)])
    const inside = owner(['show', 'archive', '--dir', '_archive/notes'])
    expect(inside.code, inside.stderr).toBe(0)
    expect(inside.stdout.trimEnd().split('\n')).toEqual([
      '# 已归档',
      '_archive/notes',
      '.. → show archive',
      ...head,
      expect.stringMatching(/^notes\/old\.md +4 B +\d{4}-\d\d-\d\d \d\d:\d\dZ +→ show item --path _archive\/notes\/old\.md$/),
      '  $ unarchive _archive/notes/old.md  # 取消归档',
    ])
  })

  it('says once under a folder’s table what can be done with each thing in it, as commands taking its path, and the folder above it', () => {
    const r = agent(['show', 'files', '--dir', 'notes'])
    expect(r.code, r.stderr).toBe(0)
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines.slice(0, 3)).toEqual(['# 文件', 'notes', '.. → show files'])
    expect(lines.slice(-3)).toEqual(['其中每个条目：', '  $ archive <库内路径>  # 归档', '  $ put <库内路径> --to <新路径>  # 移动'])
  })

  it('opens the item panel of a path with every plugin’s section', () => {
    const r = agent(['show', 'item', '--path', 'notes/a.md'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('$ archive notes/a.md  # 归档')
    expect(r.stdout).toContain('\n## 溯源\n')
    expect(r.stdout).toContain('\n## 文件\n类型：文件\n')
    expect(r.stdout).toContain('预览：notes/a.md')
  })

  it('gives with --json the ViewResult the page gets', async () => {
    const server = await startServer({ dir: lib, builtins: builtinPlugins, home: join(sb.home, '.pneuma-base'), env: {}, port: 0 })
    try {
      for (const [view, params] of [['ledger.items', {}], ['item', { path: 'notes/a.md' }], ['archive', {}]] as const) {
        const query = new URLSearchParams({ view, ...params })
        const page = await (await fetch(`http://127.0.0.1:${server.port}/api/view?${query}`, { headers: { 'x-pneuma-token': server.token } })).json()
        const flags = Object.entries(params).flatMap(([k, v]) => [`--${k}`, v])
        expect(owner(['show', view, ...flags, '--json']).json()).toEqual(page)
      }
    } finally {
      await server.close()
    }
  })

  it('is open to an agent as inspect is and sends no event; config, the owner’s page, is refused in the words of an owner-only command', () => {
    const before = facts()
    for (const view of ['ledger.items', 'ledger.status', 'files', 'archive']) expect(agent(['show', view]).code, view).toBe(0)
    expect(facts()).toBe(before)
    const page = agent(['show', 'settings'])
    expect(page.code).toBe(2)
    // An owner-only command no agent may ask for: a page of management cannot be asked for either.
    const command = agent(['request', 'list'])
    expect(command.code).toBe(2)
    const words = (text: string, name: string) => text.trim().replace(`「${name}」`, '「…」')
    expect(words(page.stdout, 'show settings')).toBe(words(command.stdout, 'request list'))
    expect(agent(['show', 'settings', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(owner(['show', 'settings']).code).toBe(0)
  })

  it('refuses a view the library does not have as a usage error', () => {
    const r = owner(['show', 'version.items'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('此资料库没有该页面：version.items。pneuma-base show 列出此资料库的页面。')
  })
})

describe('the words of each kind of block', () => {
  it('a section with its note and count, a table with its header and tags, fields, a list with a switch and its whole text, a timeline in UTC, a preview, an empty state, a plugin’s own block by its text', () => {
    const home = tempDir('pb-show-')
    const lib2 = join(home, 'lib')
    const run = (args: string[]) => sb.runWithTestPlugins(args, { cwd: home })
    expect(run(['init', lib2, '--bare']).code).toBe(0)
    expect(run(['plugin', 'enable', 'pager', '--library', lib2]).code).toBe(0)
    const blocks = run(['show', 'pager.blocks', '--library', lib2])
    expect(blocks.code).toBe(3)
    expect(blocks.stdout.trimEnd().split('\n')).toEqual([
      '# 块的样例',
      '测试插件 pager 的一页',
      '这是一段说明文字。',
      '',
      '## 一节（2）',
      '节下的说明',
      '$ pager ping  # 打个招呼',
      '名字        状态  何时               打开',
      '表的第一行  [好]  2026-11-25 11:11Z  → show item --path pager.md',
      '字段：字段的值',
      '',
      '- 列表的一项',
      '  一项的说明',
      '- 一个开关',
      '  开着的设置',
      '  （拨它就打个招呼。）',
      '  已启用  $ pager ping  # 关上',
      '- 2026-11-25 01:00Z  时间线的一条  [标签]',
      '  一条的说明',
      '预览：pager.md',
      '$ pager ping  # 再打个招呼',
      '空状态的标题',
      '空状态的提示',
      '错误：插件 pager 的一个区块无法显示：blocks[7] 是未知的区块类型：sparkle',
      '  插件 pager 出错：一个区块无法显示：blocks[7] 是未知的区块类型：sparkle',
    ])
    const fresh = run(['show', 'pager.new', '--library', lib2])
    expect(fresh.code, fresh.stderr).toBe(0)
    expect(fresh.stdout).toContain('嵌入页面「站点预览」：http://127.0.0.1:9/')
    expect(fresh.stdout).toMatch(/^长地址 +http:\/\/127\.0\.0\.1:18080\/apps\/a-rather-long-application-name-for-the-demo-site\/index\.html$/m)
    expect(fresh.stdout).toContain('  $ pager restore --release 1  # 放回这一版；需确认：把线上换回第 1 版？')
    expect(fresh.stdout).toContain('$ pager prefix [<前缀>]  # 设前缀')
    expect(fresh.stdout).toContain('计数：{"count":0,"note":"插件自己画的一页"}\n$ pager bump  # 加一；需确认：把计数加一？')
  })

  it('a feed by its groups and rows, each row with who, what, whose, its meta and what it opens or does; stats; a tree with its parameter; asks with their commands, the suggested marked; a chart as its sentence and its numbers; counted filter options', () => {
    const home = tempDir('pb-show-')
    const lib2 = join(home, 'lib')
    const run = (args: string[]) => sb.runWithTestPlugins(args, { cwd: home })
    expect(run(['init', lib2, '--bare']).code).toBe(0)
    expect(run(['plugin', 'enable', 'asker', '--library', lib2]).code).toBe(0)
    const story = run(['show', 'asker.story', '--library', lib2])
    expect(story.code, story.stderr).toBe(0)
    const at = (iso: string) => {
      const d = new Date(iso)
      return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`
    }
    expect(story.stdout.trimEnd().split('\n')).toEqual([
      '# 新的块',
      '谁做的（--who）：*全部 12 · agent 做的 8',
      '放入：4（带进来 2 样）',
      '决定：1',
      '文件夹（--dir）：',
      "  * 全部文件夹（3）  → show asker.story --dir ''",
      '      notes（2）  → show asker.story --dir notes',
      '        old（1）  → show asker.story --dir notes/old',
      '今天（2）  → show ledger.scene --scene s1',
      `  - ${at('2026-11-25T11:11:00.000Z')}  claude-code  归档 notes/old.md  [Agent 执行]  整理笔记 · 凭授权 claude  → show item --path _archive/old.md`,
      '      $ unarchive _archive/old.md  # 取回',
      `  - ${at('2026-11-25T11:12:00.000Z')}  主人  主人面的操作 plugin enable  [所有者执行]  [已定]`,
      '空的一串。',
      '- 要上线吗？（claude-code）  关于 site → show item --path site',
      '    $ asker yes  # 上线（仅所有者）（推荐）',
      '    $ asker no  # 不上线（仅所有者）',
      '没有要你决定的事。',
      '这 3 天放进 9 样东西：带进来 5 样，做出来 4 样。',
      '            带进来的（样）  做出来的（样）',
      '  11月24日  2               1',
      '  11月25日  0               2',
      '  11月26日  3               1',
    ])
  })

  it('the home page in words: what waits on the owner, by the plugin’s title, then each plugin’s part', () => {
    const home = tempDir('pb-show-')
    const lib2 = join(home, 'lib')
    const run = (args: string[]) => sb.runWithTestPlugins(args, { cwd: home })
    expect(run(['init', lib2, '--bare']).code).toBe(0)
    const bare = run(['show', 'home', '--library', lib2])
    expect(bare.stdout).toContain('## 待处理\n暂无待处理事项')
    expect(bare.stdout).toContain('此资料库未启用插件')
    expect(run(['plugin', 'enable', 'asker', '--library', lib2]).code).toBe(0)
    const r = run(['show', 'home', '--library', lib2])
    expect(r.code, r.stderr).toBe(0)
    // 快速开始 comes first while no agent is connected; start.test.ts has its words.
    expect(r.stdout.startsWith('# 首页\n\n## 快速开始\n')).toBe(true)
    expect(r.stdout.slice(r.stdout.indexOf('## 待处理')).trimEnd().split('\n')).toEqual([
      '## 待处理（1）',
      '- site 可以上线了，要上线吗？（问主人的测试插件）  关于 site → show item --path site',
      '    $ asker yes  # 上线（仅所有者）（推荐）',
      '    $ asker no  # 不上线（仅所有者）',
      '',
      '问主人的测试插件也在首页上。',
    ])
  })

  it('check tells an agent what only the owner can settle, with the owner’s command for each answer and what to do with them', () => {
    const home = tempDir('pb-show-')
    const lib2 = join(home, 'lib')
    const run = (args: string[]) => sb.runWithTestPlugins(args, { cwd: home })
    expect(run(['init', lib2, '--bare']).code).toBe(0)
    expect(run(['plugin', 'enable', 'asker', '--library', lib2]).code).toBe(0)
    expect(run(['grant', 'create', 'helper', '--agent', 'codex', '--library', lib2]).code).toBe(0)
    const check = run(['@helper', 'check'])
    expect(check.code, check.stderr).toBe(0)
    expect(check.stdout.trimEnd().split('\n')).toEqual([
      '## 需所有者处理',
      '- site 可以上线了，要上线吗？（asker）',
      `  pneuma-base asker yes --library ${lib2}  # 上线（推荐）`,
      `  pneuma-base asker no --library ${lib2}  # 不上线`,
      '以上事项仅所有者可决定：告知所有者，由所有者在自己的终端中运行上述命令，或在管理界面首页操作。',
    ])
    expect(run(['@helper', 'check', '--json']).json().asks).toMatchObject([{ key: 'asker:site', by: 'asker', about: 'site', suggested: 0 }])
    expect(run(['asker', 'yes', '--library', lib2]).code).toBe(0)
    expect(run(['@helper', 'check']).stdout).not.toContain('要主人来做的')
  })
})
