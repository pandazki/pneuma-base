// What an agent reads. "Since last time" lists only news; working directories and scene ids are
// short in text and whole in --json; find puts the hits of one scene under one heading; inspect
// leads with provenance; start prints only the parts that have something.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const SA = '3f9a2c7e-1111-4222-8333-444455556666'
const SA2 = '3f9a2c7e-2222-4222-8333-444455556666'
const SB = '9b1d4e2a-aaaa-4bbb-8ccc-ddddeeeeffff'
const DOING_A = '比较三家印刷厂的画册报价'
const DOING_B = '给选定的印刷厂写下单邮件'

let sb: Sandbox
let lib: string
let dirA: string
let dirB: string
let fresh: string

const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const A = (args: string[], session = SA) => ok(sb.run(['@claude', ...args, '--session', session], { cwd: dirA }))
const B = (args: string[]) => ok(sb.run(['@codex', ...args, '--session', SB], { cwd: dirB }))
const lines = (text: string) => text.replace(/\n$/, '').split('\n')
const cut = (dir: string) => `…${dir.slice(-45)}`

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  dirA = join(sb.home, 'work', 'print-job') // under the home directory, so shown with ~
  dirB = join(tempDir(), 'a-directory-name-long-enough-to-be-cut-short', 'mail-draft')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  ok(sb.run(['init', lib]))
  ok(sb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code']))
  ok(sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex']))
  ok(sb.run(['skill', 'install', 'codex', '--agent', 'codex', '--dir', join(dirB, '.agents', 'skills')]))

  writeFileSync(join(dirA, 'fast.txt'), '速印通印刷厂：5 个工作日，10500 元\n')
  writeFileSync(join(dirA, 'solid.txt'), '恒雅彩印印刷厂：7 个工作日，9900 元\n')
  writeFileSync(join(dirA, 'comparison.md'), '# 三家印刷厂的报价比较\n\n首选恒雅彩印。\n')
  A(['start', DOING_A])
  A(['put', 'fast.txt', '--to', 'print/quotes/fast.txt', '--brought', '--by', 'owner'])
  A(['put', 'solid.txt', '--to', 'print/quotes/solid.txt', '--brought', '--by', 'owner'])
  A(['put', 'comparison.md', '--to', 'print/comparison.md', '--made', '--from', 'print/quotes/fast.txt', 'print/quotes/solid.txt'])

  // A second library, with nothing in it, for an agent that finds nothing related.
  fresh = join(tempDir(), 'fresh')
  ok(sb.run(['init', fresh]))
  ok(sb.run(['grant', 'issue', 'helper', '--library', fresh, '--agent', 'codex']))
})

describe('start, for the agent that comes next', () => {
  it('prints its three parts; since lists only news, with short scene ids and directories', () => {
    const text = B(['start', DOING_B]).stdout
    expect(lines(text)[0]).toBe('【记下】')
    for (const heading of ['【库的变化与状况】', '【库里可能相关的】']) expect(text).toContain(heading)
    expect(text).toContain('场景 3f9a2c7e · claude-code · 在 ~/work/print-job')
    expect(text).not.toContain(SA)
    expect(text).not.toContain('主人面的操作') // init, grant issue and skill install change neither content nor capabilities

    // start was a look, so this check asks from before anything happened.
    const since = B(['check', '--json', '--since', '2000-01-01T00:00:00Z']).json().sections.find((s: any) => s.title === '自上次以来')
    expect(since.data.scenes).toMatchObject([{ scene: SA, cwds: [dirA] }])
  })

  it('says so when nothing is related, and prints no heading for a part that has nothing', () => {
    const r = ok(sb.run(['@helper', 'start', '整理会议纪要'], { cwd: dirB }))
    expect(lines(r.stdout)).toEqual(['【记下】', '已记下（ledger）：在做：整理会议纪要', '【库里可能相关的】', '库里没有和这件事相关的东西。'])
    expect(ok(sb.run(['@helper', 'check', '--json'], { cwd: dirB })).json().sections).toEqual([])
  })
})

describe('find', () => {
  it('puts the hits of one scene under one heading, each hit one short line; gives what the caller’s own session did, which start leaves out', () => {
    const out = lines(B(['find', 'print']).stdout)
    expect(out[0]).toMatch(new RegExp(`^场景 3f9a2c7e · claude-code · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\dZ · 在做：${DOING_A}$`))
    expect(out.slice(1).sort()).toEqual(['  print/comparison.md  做出来的', '  print/quotes/fast.txt  带进来的，主人给的', '  print/quotes/solid.txt  带进来的，主人给的'])

    const hits = B(['find', 'print', '--json']).json().hits
    expect(hits.filter((h: any) => h.by === 'ledger').map((h: any) => h.group)).toEqual([out[0], out[0], out[0]])
    expect(hits.filter((h: any) => h.by === 'kernel').every((h: any) => h.group === null)).toBe(true)

    writeFileSync(join(dirB, 'draft.md'), '下单邮件草稿：恒雅彩印\n')
    B(['put', 'draft.md', '--to', 'print/order-mail.md', '--made', '--from', 'print/comparison.md'])

    const found = B(['find', '下单邮件']).stdout
    expect(found).toMatch(/^场景 9b1d4e2a · codex · /m)
    expect(found).toContain('  print/order-mail.md  做出来的')

    const related = B(['start', '下单邮件', '--json']).json().find.hits
    expect(related.map((h: any) => h.title)).not.toContain(`场景 ${SB}`)
    expect(related.map((h: any) => h.path)).not.toContain('print/order-mail.md')
  })
})

describe('inspect', () => {
  it('leads with provenance and ends with the file facts; the fingerprint comes with the content; a working directory is short in text, under ~ or cut to its last part, and whole in --json', () => {
    const out = lines(B(['inspect', 'print/comparison.md']).stdout)
    expect(out[0]).toBe('## 来历（ledger）')
    expect(out[1]).toContain('在 ~/work/print-job · 场景 3f9a2c7e')
    expect(out.join('\n')).not.toContain(SA)
    expect(out.at(-1)).toMatch(/^print\/comparison\.md · \d+ 字节，改于 \d{4}-\d\d-\d\d \d\d:\d\dZ$/)

    const json = B(['inspect', 'print/comparison.md', '--json']).json()
    expect(json.file.fingerprint).toBeNull()
    expect(json.sections[0].data.entered).toMatchObject({ scene: SA, where: { cwd: dirA } })

    const read = B(['inspect', 'print/comparison.md', '--content']).stdout
    expect(read).toMatch(/^print\/comparison\.md · \d+ 字节，改于 \d{4}-\d\d-\d\d \d\d:\d\dZ · 指纹 [0-9a-f]{12}…$/m)

    expect(dirB.length).toBeGreaterThan(48)
    const text = B(['inspect', 'print/order-mail.md']).stdout
    expect(text).toContain(`在 ${cut(dirB)} · 场景 9b1d4e2a`)
    expect(text).not.toContain(dirB)
    expect(B(['inspect', 'print/order-mail.md', '--json']).json().sections[0].data.entered.where.cwd).toBe(dirB)
  })

  it('takes a unique scene id prefix of six characters or more, and lists the candidates of an ambiguous one', () => {
    expect(B(['inspect', '3f9a2c']).stdout).toContain(`场景 3f9a2c7e\nclaude-code · `)
    expect(sb.run(['@codex', 'inspect', '3f9a2'], { cwd: dirB }).stdout).toContain('库里没有这个文件：3f9a2')

    A(['say', 'note', '另一次会话'], SA2)
    const ambiguous = B(['inspect', '3f9a2c7e']).stdout
    for (const id of [SA, SA2]) expect(ambiguous).toContain(id)
    expect(B(['inspect', '3f9a2c7e-1']).stdout).toContain(DOING_A)
  })
})

describe('skill install', () => {
  it('tells the owner that Codex needs the library among its writable directories, and gives no such hint for Claude', () => {
    const r = ok(sb.run(['skill', 'install', 'codex', '--agent', 'codex', '--dir', tempDir('pb-skills-')]))
    const hint = `Codex 在沙箱里运行，这个库要是它能写的目录之一，比如：codex --add-dir ${lib}`
    expect(lines(r.stdout)).toEqual([expect.stringMatching(/^已为 codex 写好技能：/), hint])
    expect(ok(sb.run(['skill', 'install', 'claude', '--agent', 'claude', '--dir', tempDir('pb-skills-'), '--json'])).json().data.hint).toBeUndefined()
  })
})
