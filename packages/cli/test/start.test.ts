// The home page's 「开始」 through its states, as the command line prints it and as the page gets it:
// connect an agent, put the first thing in, have an agent work here. Every run has a temporary HOME
// with the product folders the test makes, and a PATH with no agent program on it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { instant, recordEndpoint, type Block, type Step } from '@pneuma-base/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let work: string

const run = (args: string[]) => {
  const r = sb.run(args, { env: { PATH: tempDir('pb-bin-') }, cwd: work })
  expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
  return r
}

const home = () => (run(['--library', lib, 'show', 'home', '--json']).json() as { blocks: Block[] }).blocks

/** The steps of 「开始」, or null when the home page has no such part. */
function stepsOf(blocks: Block[]): Step[] | null {
  const start = blocks[0]
  if (start?.kind !== 'section' || start.title !== '开始') return null
  const [steps] = start.blocks
  if (steps?.kind !== 'steps') throw new Error('开始 holds no steps')
  return steps.steps
}

const states = (steps: Step[] | null) => steps?.map((s) => `${s.key}:${s.done ? s.summary : 'todo'}`) ?? null

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  work = tempDir('pb-work-')
  mkdirSync(join(sb.home, '.claude'), { recursive: true })
})

describe('「开始」 on the home page', () => {
  it('opens a new library: the products found here with 接上 in one click, a drop area into inbox/, and the sentence to say', () => {
    run(['init', lib])
    const blocks = home()
    expect(blocks.map((b) => (b.kind === 'section' ? b.title : b.kind)).slice(0, 2)).toEqual(['开始', '等你决定'])
    const steps = stepsOf(blocks) as Step[]
    expect(steps.map((s) => [s.key, s.title, s.done])).toEqual([
      ['connect', '接上你的 agent', false],
      ['first', '放进第一样东西', false],
      ['say', '对你的 agent 说一句', false],
    ])
    const [connect, first, say] = steps as [Step, Step, Step]
    expect(connect.blocks).toMatchObject([{ kind: 'list', items: [{ cell: { text: 'Claude Code', actor: { kind: 'agent', name: 'claude-code' } }, actions: [{ label: '接上', inputs: [], call: { face: 'owner', command: 'agent connect', args: { positional: ['claude-code'], flags: {} } } }] }] }])
    expect(first.blocks).toEqual([{ kind: 'drop', to: 'inbox', command: `pneuma-base put <文件或文件夹> --to inbox/<名字> --brought --by owner --library ${lib}` }])
    expect(say.blocks).toMatchObject([{ kind: 'list', items: [{ cell: { text: '看看我的 Pneuma Base 库里有什么。', copy: true } }] }])
  })

  it('folds each step once it is done, and is gone when all three are', () => {
    run(['init', lib])
    run(['--library', lib, 'agent', 'connect', 'claude-code'])
    expect(states(stepsOf(home()))).toEqual(['connect:已接上 Claude Code', 'first:todo', 'say:todo'])
    expect(stepsOf(home())?.[0]?.blocks).toMatchObject([{ kind: 'list', items: [{ cell: { text: 'Claude Code', tag: { text: '已接上' } }, actions: [] }] }])

    writeFileSync(join(work, 'paper.pdf'), '%PDF')
    run(['--library', lib, 'put', join(work, 'paper.pdf'), '--to', 'inbox/paper.pdf', '--brought', '--by', 'owner'])
    expect(states(stepsOf(home()))).toEqual(['connect:已接上 Claude Code', 'first:库的根目录里有 1 样东西', 'say:todo'])

    run(['@claude-code', 'start', '看看库里有什么'])
    expect(stepsOf(home())).toBeNull()
  })

  it('in a library without the ledger has the kernel’s two steps, and a hidden file put there by Finder is not the first thing', () => {
    run(['init', lib, '--bare'])
    writeFileSync(join(lib, '.DS_Store'), '')
    expect(states(stepsOf(home()))).toEqual(['connect:todo', 'first:todo'])
    run(['--library', lib, 'agent', 'connect', 'claude-code'])
    writeFileSync(join(lib, 'a.md'), 'a')
    expect(stepsOf(home())).toBeNull()
  })

  it('says, when no product is found here, where it looked', () => {
    run(['init', lib])
    const empty = sandbox()
    const r = empty.run(['--library', lib, 'show', 'home', '--json'], { env: { PATH: tempDir('pb-bin-') }, cwd: work })
    const [connect] = stepsOf((r.json() as { blocks: Block[] }).blocks) as Step[]
    expect(connect?.blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('这台机器上还没找到能接上的 agent（看了 Claude Code：PATH 上的 claude、~/.claude') }])
  })

  it('shows the sentence to say to any agent, to copy, only while an endpoint runs for this library, and so does the agents page', async () => {
    run(['init', lib])
    const origin = 'http://127.0.0.1:7638'
    // The sentence's words are guide.test.ts's; here, that it carries this endpoint's guide.
    const sentence = `${origin}/guide`
    const connect = () => (stepsOf(home()) as Step[])[0] as Step
    const agents = () => (run(['--library', lib, 'show', 'agents', '--json']).json() as { blocks: { kind: string; title: string; blocks: Block[] }[] }).blocks
    const record = (library: string) => recordEndpoint(join(sb.home, '.pneuma-base'), { url: origin, port: 7638, pid: process.pid, library, at: instant(Date.now()) })
    await record(join(tempDir(), 'another'))
    expect(JSON.stringify(connect().blocks)).not.toContain(sentence)
    expect(agents().map((b) => b.title)).not.toContain('让 agent 自己接上')

    await record(lib)
    const item = { kind: 'list', items: [{ cell: { text: expect.stringContaining(sentence), copy: true }, note: expect.stringContaining('点「允许」'), actions: [] }] }
    expect(connect().blocks).toEqual(expect.arrayContaining([item]))
    expect(agents().find((b) => b.title === '让 agent 自己接上')?.blocks).toEqual([item])
    expect(run(['--library', lib, 'show', 'home']).stdout).toContain(sentence)
  })

  it('prints with show home: each step with whether it is done and its commands', () => {
    run(['init', lib])
    run(['--library', lib, 'agent', 'connect', 'claude-code'])
    const text = run(['--library', lib, 'show', 'home']).stdout
    expect(text).toContain('## 开始\n做完了 1 步，还有 2 步。\n[✓] 接上你的 agent：已接上 Claude Code\n')
    expect(text).toContain('[ ] 放进第一样东西\n')
    expect(text).toContain(`    $ pneuma-base put <文件或文件夹> --to inbox/<名字> --brought --by owner --library ${lib}\n`)
    expect(text).toContain('[ ] 对你的 agent 说一句\n    - 看看我的 Pneuma Base 库里有什么。\n')
  })
})
