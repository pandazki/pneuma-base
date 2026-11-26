// What was seen can be corrected by what is said. The app registers a file the owner copied in as
// observed: brought by the owner, registered automatically. That can be wrong, so a later explicit
// origin replaces it, keeping both in the history; an observed one never replaces an explicit one.
// The same for a direct change seen by the app and a later say revised.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

beforeEach(() => {
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
const SEEN = '带进来的，主人给的（自动登记）'

describe('put --observed', () => {
  it('registers a file as brought by the owner, registered automatically, and says so wherever the origin is shown', () => {
    copiedIn('photo.txt', 'copied in with Finder')
    expect(ok(app(['put', 'photo.txt', '--brought', '--by', 'owner', '--observed'])).stdout).toContain(`已记下：${SEEN}`)
    const inspect = ok(codex(['inspect', 'photo.txt'])).stdout
    expect(inspect).toMatch(new RegExp(`^${SEEN} · 主人 · `, 'm'))
    expect(ok(codex(['inspect', 'photo.txt', '--json'])).json().sections[0].data.entered).toMatchObject({ how: 'observed', actor: { kind: 'owner' } })
    expect(ok(codex(['show', 'item', '--path', 'photo.txt'])).stdout).toContain(`怎么来的：[${SEEN}]`)
    expect(ok(codex(['show', 'ledger.items'])).stdout).toContain(`[${SEEN}]`)
    expect(ok(codex(['find', 'photo'])).stdout).toContain(`photo.txt  ${SEEN}`)
    const since = ok(codex(['check', '--json'])).json().sections.find((s: any) => s.title === '自上次以来').data
    expect(since.scenes.flatMap((s: any) => s.facts.map((f: any) => f.text))).toContain(`放入 photo.txt（${SEEN}）`)
  })

  it('is refused in an agent’s session, and goes only with --brought --by owner on a path in the library', () => {
    copiedIn('a.txt', 'a')
    const refused = claude(['put', 'a.txt', '--brought', '--by', 'owner', '--observed'])
    expect(refused.code).toBe(2)
    expect(refused.stdout).toContain('拒绝（agent-session）')
    expect(sb.run(['--library', lib, 'put', 'a.txt', '--brought', '--by', 'owner', '--observed'], { env: { CLAUDECODE: '1' } }).code).toBe(2)
    expect(app(['put', 'a.txt', '--made', '--observed']).code).toBe(1)
    expect(app(['put', 'a.txt', '--brought', '--observed']).code).toBe(1)
    const outside = join(tempDir('pb-outside-'), 'b.txt')
    writeFileSync(outside, 'b')
    expect(app(['put', outside, '--to', 'b.txt', '--brought', '--by', 'owner', '--observed']).code).toBe(1)
  })

  it('is replaced by a later explicit origin of the same content, from anyone, and the history keeps both', () => {
    copiedIn('page.html', '<p>written by an agent with its own tools</p>')
    ok(app(['put', 'page.html', '--brought', '--by', 'owner', '--observed']))
    expect(ok(claude(['put', 'page.html', '--made', '--from-outside', '主人在对话里要的'])).stdout).toContain(`已更正来历：做出来的，依据库里 0 样、库外 1 句；先前是自动登记的：${SEEN}`)
    const inspect = ok(codex(['inspect', 'page.html'])).stdout
    expect(inspect).toMatch(/^做出来的 · claude-code · .* · 场景 s1$/m)
    expect(inspect).toMatch(new RegExp(`^先前：${SEEN} · 主人 · .* · 场景 app$`, 'm'))
    expect(ok(codex(['show', 'item', '--path', 'page.html'])).stdout).toMatch(new RegExp(`先前：${SEEN} · 主人`))
    // The owner, saying it explicitly, replaces an observation too.
    copiedIn('notes.txt', 'mine')
    ok(app(['put', 'notes.txt', '--brought', '--by', 'owner', '--observed']))
    ok(app(['put', 'notes.txt', '--brought', '--by', 'owner', '--source', '我的笔记本']))
    expect(ok(codex(['inspect', 'notes.txt'])).stdout).toMatch(/^带进来的，主人给的 · 主人 · .*\n出处：我的笔记本\n先前：带进来的，主人给的（自动登记） · 主人/m)
  })

  it('never replaces an explicit origin', () => {
    ok(claude(['put', '-', '--to', 'report.md', '--made'], 'a report'))
    expect(ok(app(['put', 'report.md', '--brought', '--by', 'owner', '--observed'])).stdout).toContain('已在册')
    const inspect = ok(codex(['inspect', 'report.md'])).stdout
    expect(inspect).toMatch(/^做出来的 · claude-code · /m)
    expect(inspect).not.toContain('自动登记')
  })
})

describe('say revised --observed', () => {
  beforeEach(() => {
    ok(claude(['put', '-', '--to', 'draft.md', '--made'], 'first'))
    copiedIn('draft.md', 'changed in place')
  })

  it('records a direct change seen by the app, which check then no longer reports, and is refused in an agent’s session', () => {
    expect(claude(['say', 'revised', 'draft.md', '--observed', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    expect(ok(app(['say', 'revised', 'draft.md', '--observed'])).stdout).toContain('已记下 draft.md 被直接改了，自动登记')
    expect(ok(codex(['check', '--json'])).json().sections.find((s: any) => s.title === '被直接改过的')).toBeUndefined()
    expect(ok(codex(['inspect', 'draft.md'])).stdout).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}主人 {2}直接改的，自动登记$/m)
    expect(ok(codex(['show', 'item', '--path', 'draft.md'])).stdout).toContain('直接改的（自动登记）')
    expect(ok(codex(['show', 'ledger.activity'])).stdout).toContain('看到 draft.md 被直接改了（自动登记）')
  })

  it('is replaced by a later explicit say revised, with or without --by owner, keeping who first saw it', () => {
    ok(app(['say', 'revised', 'draft.md', '--observed']))
    expect(ok(claude(['say', 'revised', 'draft.md'])).stdout).toContain('已认下 draft.md 的直接改动，替下了自动登记的那条')
    const inspect = ok(codex(['inspect', 'draft.md'])).stdout
    expect(inspect).toContain('内容换过 1 次')
    expect(inspect).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}认了直接改动（先是自动登记）$/m)

    copiedIn('draft.md', 'changed in place again')
    ok(app(['say', 'revised', 'draft.md', '--observed']))
    ok(codex(['say', 'revised', 'draft.md', '--by', 'owner']))
    expect(ok(codex(['inspect', 'draft.md'])).stdout).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}codex {2}主人直接改的，codex 代记（先是自动登记）$/m)
  })

  it('never replaces an explicit claim', () => {
    ok(claude(['say', 'revised', 'draft.md']))
    expect(ok(app(['say', 'revised', 'draft.md', '--observed'])).stdout).toContain('一致')
    expect(ok(codex(['inspect', 'draft.md'])).stdout).not.toContain('自动登记')
  })
})
