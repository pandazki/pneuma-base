// What was seen can be corrected by what is said. The app registers a file the owner copied in as
// observed: brought by the owner, registered automatically. That can be wrong, so a later explicit
// origin replaces it, keeping both in the history. The same for a direct change seen by the app and a
// later say revised. Which one replaces which is the fold's (packages/plugin-ledger/test/fold.test.ts,
// "what was seen and what was said"); here, the refusals and one case end to end per verb.
// One library for the file.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
/** The app: the owner, in a session of its own. */
const app = (args: string[]) => sb.run(['--library', lib, '--session', 'app', ...args])
const claude = (args: string[], input?: string) => sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], input === undefined ? {} : { input })
const codex = (args: string[]) => sb.run(['--library', lib, '--as', 'codex', '--session', 's2', ...args])
const copiedIn = (path: string, content: string) => writeFileSync(join(lib, path), content)
const SEEN = '导入（所有者提供，自动登记）'

describe('put --observed', () => {
  it('registers a file as brought by the owner, registered automatically, and says so; a later explicit origin replaces it, and the history keeps both', () => {
    copiedIn('page.html', '<p>written by an agent with its own tools</p>')
    expect(ok(app(['put', 'page.html', '--imported', '--by', 'owner', '--observed'])).stdout).toContain(`已记录：${SEEN}`)
    expect(ok(codex(['show', 'item', '--path', 'page.html'])).stdout).toContain(`来源：${SEEN}`)
    expect(ok(claude(['put', 'page.html', '--generated', '--from-external', '主人在对话里要的'])).stdout).toContain(`已更正来源：生成，依据 0 个条目、1 条外部依据；之前为自动登记：${SEEN}`)
    const inspect = ok(codex(['inspect', 'page.html'])).stdout
    expect(inspect).toMatch(/^生成 · claude-code · .* · 场景 s1$/m)
    expect(inspect).toMatch(new RegExp(`^之前：${SEEN} · 所有者 · .* · 场景 app$`, 'm'))
  })

  it('is refused in an agent’s session, and goes only with --imported --by owner on a path in the library', () => {
    copiedIn('a.txt', 'a')
    const refused = claude(['put', 'a.txt', '--imported', '--by', 'owner', '--observed'])
    expect(refused.code).toBe(2)
    expect(refused.stdout).toContain('拒绝（agent-session）')
    expect(sb.run(['--library', lib, 'put', 'a.txt', '--imported', '--by', 'owner', '--observed'], { env: { CLAUDECODE: '1' } }).code).toBe(2)
    expect(app(['put', 'a.txt', '--generated', '--observed']).code).toBe(1)
    expect(app(['put', 'a.txt', '--imported', '--observed']).code).toBe(1)
    const outside = join(tempDir('pb-outside-'), 'b.txt')
    writeFileSync(outside, 'b')
    expect(app(['put', outside, '--to', 'b.txt', '--imported', '--by', 'owner', '--observed']).code).toBe(1)
  })
})

describe('say revised --observed', () => {
  it('is refused in an agent’s session; records a direct change seen by the app, which check then no longer reports; a later explicit say revised replaces it, keeping who first saw it', () => {
    ok(claude(['put', '-', '--to', 'draft.md', '--generated'], 'first'))
    copiedIn('draft.md', 'changed in place')
    expect(claude(['say', 'revised', 'draft.md', '--observed', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    expect(ok(app(['say', 'revised', 'draft.md', '--observed'])).stdout).toContain('已记录 draft.md 的外部修改（自动登记，执行者未知）')
    expect(ok(codex(['check', '--json'])).json().sections.find((s: any) => s.title === '外部修改')).toBeUndefined()
    expect(ok(codex(['inspect', 'draft.md'])).stdout).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}所有者 {2}外部修改（自动登记）$/m)
    expect(ok(codex(['show', 'item', '--path', 'draft.md'])).stdout).toContain('外部修改（自动登记）')
    expect(ok(codex(['show', 'ledger.activity'])).stdout).toContain('检测到 draft.md 的外部修改（自动登记）')

    expect(ok(claude(['say', 'revised', 'draft.md'])).stdout).toContain('已确认 draft.md 的外部修改，已替换自动登记的记录')
    const inspect = ok(codex(['inspect', 'draft.md'])).stdout
    expect(inspect).toContain('内容更新 1 次')
    expect(inspect).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}已确认外部修改（之前为自动登记）$/m)
  })
})
