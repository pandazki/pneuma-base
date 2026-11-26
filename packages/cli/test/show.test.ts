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
  expect(owner(['grant', 'issue', 'claude', '--agent', 'claude-code']).code).toBe(0)
  expect(agent(['put', '-', '--to', 'notes/a.md', '--made', '--note', '第一版'], '# 笔记\n').code).toBe(0)
  expect(agent(['put', '-', '--to', 'notes/old.md', '--made'], 'old\n').code).toBe(0)
  expect(agent(['archive', 'notes/old.md']).code).toBe(0)
})

const facts = () => readdirSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true }).length

describe('pneuma-base show', () => {
  it('with no view lists the views of the library, each with its title and who gives it', () => {
    const r = owner(['show'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^ {2}ledger\.items +条目 +ledger/m)
    expect(r.stdout).toMatch(/^ {2}config +配置 +kernel +只给主人$/m)
    expect(r.stdout).toMatch(/^ {2}item +一样东西 +kernel +从别的页的链接打开$/m)
    const list = owner(['show', '--json']).json()
    expect(list.views.find((v: { id: string }) => v.id === 'ledger.scenes')).toMatchObject({ title: '场景', by: 'ledger', nav: true })
    expect(list.views.find((v: { id: string }) => v.id === 'config')).toMatchObject({ by: 'kernel', ownerOnly: true })
  })

  it('prints a page in words, every button as the command that does the same, marked when only the owner may and with the question it asks', () => {
    const r = owner(['show', 'archive'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trimEnd().split('\n')).toEqual([
      '# 归档区',
      '',
      '## 归档的东西（1）',
      '归档的东西不删；默认的找和查不带它们。',
      '$ archive purge  # 清空归档区（只给主人）；先问：归档区里的 1 样东西会被删掉，不能撤回。',
      expect.stringMatching(/^原来的路径 +在归档区的位置 +大小 +改于 +打开$/),
      expect.stringMatching(/^notes\/old\.md +_archive\/notes\/old\.md +4 B +\d{4}-\d\d-\d\d \d\d:\d\dZ +→ show item --path _archive\/notes\/old\.md$/),
      '  $ unarchive _archive/notes/old.md  # 取回',
    ])
  })

  it('opens the item panel of a path with every plugin’s section', () => {
    const r = agent(['show', 'item', '--path', 'notes/a.md'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('$ archive notes/a.md  # 归档')
    expect(r.stdout).toContain('\n## 来历\n')
    expect(r.stdout).toContain('\n## 文件\n路径：notes/a.md\n')
    expect(r.stdout).toContain('预览：notes/a.md')
  })

  it('gives with --json the ViewResult the page gets', async () => {
    const server = await startServer({ dir: lib, builtins: builtinPlugins, home: join(sb.home, '.pneuma-base'), env: {} })
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
    for (const view of ['ledger.items', 'ledger.standing', 'files', 'archive']) expect(agent(['show', view]).code, view).toBe(0)
    expect(facts()).toBe(before)
    const page = agent(['show', 'config'])
    expect(page.code).toBe(2)
    const command = agent(['plugin', 'add', 'version'])
    expect(command.code).toBe(2)
    const words = (text: string, name: string) => text.trim().replace(`「${name}」`, '「…」')
    expect(words(page.stdout, 'show config')).toBe(words(command.stdout, 'plugin add'))
    expect(page.stdout).toContain('拒绝（agent-session）：「show config」是替主人做的决定')
    expect(agent(['show', 'config', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(owner(['show', 'config']).code).toBe(0)
  })

  it('refuses a view the library does not have as a usage error', () => {
    const r = owner(['show', 'version.things'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('这个库没有这一页：version.things。pneuma-base show 列出这个库的页。')
  })
})

describe('the words of each kind of block', () => {
  it('a section with its note and count, a table with its header and tags, fields, a list, a timeline in UTC, a preview, an empty state, a plugin’s own block by its text', () => {
    const home = tempDir('pb-show-')
    const lib2 = join(home, 'lib')
    const run = (args: string[]) => sb.runWithTestPlugins(args, { cwd: home })
    expect(run(['init', lib2, '--bare']).code).toBe(0)
    expect(run(['plugin', 'add', 'pager', '--library', lib2]).code).toBe(0)
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
      '- 2026-11-25 01:00Z  时间线的一条  [标签]',
      '  一条的说明',
      '预览：pager.md',
      '$ pager ping  # 再打个招呼',
      '空状态的标题',
      '空状态的提示',
      '错误：插件 pager 的一块没法显示：blocks[7] 是不认识的块：sparkle',
      '  插件 pager 出错：一块没法显示：blocks[7] 是不认识的块：sparkle',
    ])
    const fresh = run(['show', 'pager.new', '--library', lib2])
    expect(fresh.code, fresh.stderr).toBe(0)
    expect(fresh.stdout).toContain('嵌入的页面「站点预览」：http://127.0.0.1:9/')
    expect(fresh.stdout).toMatch(/^长地址 +http:\/\/127\.0\.0\.1:18080\/apps\/a-rather-long-application-name-for-the-demo-site\/index\.html$/m)
    expect(fresh.stdout).toContain('  $ pager restore --release 1  # 放回这一版；先问：把线上换回第 1 版？')
    expect(fresh.stdout).toContain('$ pager prefix [<前缀>]  # 设前缀')
    expect(fresh.stdout).toContain('计数：{"count":0,"note":"插件自己画的一页"}\n$ pager bump  # 加一；先问：把计数加一？')
  })
})
