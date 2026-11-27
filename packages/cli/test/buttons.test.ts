// The buttons that give a verb or a command its place on a page, pressed as a person presses them:
// each does what the same call does from the command line.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action, Block, ViewResult } from '@pneuma-base/sdk'
import { sandbox, type Sandbox, type Viewer } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

let sb: Sandbox
let viewer: Viewer

const agent = async (args: string[], input?: string) => {
  const r = await sb.agent('claude-code', 's1', [...args, '--json'], input === undefined ? {} : { input })
  expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
  return r.json
}

function actionsIn(blocks: readonly Block[]): Action[] {
  return blocks.flatMap((b) => {
    switch (b.kind) {
      case 'section':
        return [...b.actions, ...actionsIn(b.blocks)]
      case 'actions':
        return b.actions
      case 'table':
        return b.rows.flatMap((r) => r.actions)
      case 'list':
        return b.items.flatMap((i) => [...i.actions, ...(i.toggle ? [i.toggle.action] : [])])
      case 'custom':
        return Object.values(b.actions)
      default:
        return []
    }
  })
}

/** Presses the button with `label` on a page, filling its inputs with `values`; it must say it was done. */
async function press(page: ViewResult, label: string, values: Record<string, string> = {}) {
  const action = (page.outcome === 'shown' ? actionsIn(page.blocks) : []).find((a) => a.label === label)
  if (action === undefined) throw new Error(`no button ${label} on ${JSON.stringify(page)}`)
  const done = await viewer.act(action, values)
  expect(done.tone, done.text).toBe('good')
  return done
}

const words = (page: ViewResult) => JSON.stringify(page)

const originOf = async (path: string) => (await agent(['inspect', path])).sections.find((s: { plugin: string }) => s.plugin === 'ledger')?.data.origin

beforeAll(async () => {
  sb = await sandbox({ cli, builtins: ['version', 'deploy'] })
  await sb.owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(sb.work, 'www')])
  await agent(['put', '-', '--to', 'notes/a.md', '--made'], '# a\n')
  await agent(['put', '-', '--to', 'notes/plan.md', '--made'], '# 计划\n')
  await agent(['say', 'versioned', 'notes/plan.md'])
  await agent(['put', '-', '--to', 'notes/plan.md', '--made'], '# 计划 v2\n')
  mkdirSync(join(sb.work, 'shop'))
  writeFileSync(join(sb.work, 'shop/index.html'), '<h1>小店</h1>\n')
  await agent(['put', 'shop', '--to', 'sites/shop', '--made'])
  writeFileSync(join(sb.work, 'paper.txt'), '一篇论文\n')
  viewer = await sb.viewer()
}, 60_000)

afterAll(() => sb.cleanup())

describe('the buttons that give each verb and command a place', () => {
  it('the files page brings in a file of this machine as brought in, with where it came from, or none when left empty', async () => {
    await press(await viewer.view('files'), '从这台机器放进来', { from: join(sb.work, 'paper.txt'), to: 'sources/paper.txt', source: 'https://example.org/paper' })
    expect(await originOf('sources/paper.txt')).toMatchObject({ kind: 'brought', source: 'https://example.org/paper' })
    await press(await viewer.view('files'), '从这台机器放进来', { from: join(sb.work, 'paper.txt'), to: 'sources/copy.txt' })
    expect(await originOf('sources/copy.txt')).toMatchObject({ kind: 'brought', source: null })
  })

  it('the item panel moves a thing', async () => {
    await press(await viewer.item('notes/a.md'), '挪到', { to: 'notes/b.md' })
    expect([existsSync(join(sb.library, 'notes/a.md')), existsSync(join(sb.library, 'notes/b.md'))]).toEqual([false, true])
  })

  it('the ledger’s section records a decision, a note and what a thing was made from', async () => {
    await press(await viewer.item('notes/b.md'), '记一条决定', { text: '用 Paddle' })
    await press(await viewer.item('notes/b.md'), '记一条备注', { text: '下周再看' })
    await press(await viewer.item('notes/b.md'), '补上依据', { from: 'sources/paper.txt', outside: '主人在对话里说的' })
    const panel = words(await viewer.item('notes/b.md', { plugin: 'ledger' }))
    for (const said of ['用 Paddle', '下周再看', 'sources/paper.txt', '主人在对话里说的']) expect(panel).toContain(said)
  })

  it('the deploy section declares a thing deployable', async () => {
    await press(await viewer.item('sites/shop', { plugin: 'deploy' }), '声明可以部署')
    expect(words(await viewer.item('sites/shop', { plugin: 'deploy' }))).toContain('离线')
  })

  it('the version section notes the current version and keeps only the latest few', async () => {
    await press(await viewer.item('notes/plan.md', { plugin: 'version' }), '给当前这一版写说明', { note: '第二版定稿' })
    expect(words(await viewer.item('notes/plan.md', { plugin: 'version' }))).toContain('第二版定稿')
    await press(await viewer.item('notes/plan.md', { plugin: 'version' }), '只留最近几版', { keep: '1' })
    const versions = (await sb.owner(['version', 'list', 'notes/plan.md', '--json'])).json.data.versions as { pruned: boolean }[]
    expect(versions.filter((v) => !v.pruned)).toHaveLength(1)
  })

  it('the held page takes a held copy back to a new path, and drops them all', async () => {
    const held = await viewer.view('ledger.held')
    expect(words(held)).toContain('notes/plan.md')
    const [restore] = held.outcome === 'shown' ? actionsIn(held.blocks).filter((a) => a.label === '取回到新路径') : []
    const to = restore?.inputs.find((i) => i.name === 'to')?.value as string
    await press(held, '取回到新路径')
    expect(existsSync(join(sb.library, to))).toBe(true)
    await press(held, '清掉全部留存')
    expect(await viewer.view('ledger.held')).toMatchObject({ blocks: [{ kind: 'section', title: '换下的旧内容', count: 0 }] })
  })

  it('the config page installs a plugin on this machine from a directory, and uninstalls it', async () => {
    const dir = join(sb.work, 'extra')
    mkdirSync(dir)
    writeFileSync(join(dir, 'index.js'), "export default { contract: 2, name: 'extra', cognition: null, storage: [], statements: [], ownerCommands: [] }\n")
    await press(await viewer.view('config'), '从目录装一个插件到这台机器', { dir })
    expect((await sb.run(['plugin', 'list'])).stdout).toContain('extra')
    await press(await viewer.view('config'), '从这台机器卸掉')
    expect((await sb.run(['plugin', 'list'])).stdout).not.toContain('extra')
  })
})
