// put --note with only the ledger installed: the sentence rides on the fact the put writes, so
// another agent reads one put as one line, and inspect shows it on the content it describes. Where the
// note sits in the rows is the fold's (packages/plugin-ledger/test/fold.test.ts); find matching it is
// packages/plugin-ledger/test/find.test.ts's.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run } from './helpers.js'

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

describe('put --note', () => {
  it('is one line in another agent’s check, and ends the line of the content it describes in inspect; a move, which changes no content, refuses it', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    const outside = tempDir('pb-outside-')
    ok(sb.run(['init', lib]))
    const claude = (args: string[], input?: string) =>
      sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
    const codex = (args: string[]) => sb.run(['--library', lib, '--as', 'codex', '--session', 's2', ...args], { cwd: outside })

    ok(claude(['put', '-', '--to', 'quote.md', '--generated', '--note', '拉丝铝初稿'], 'early bird 99'))
    ok(claude(['put', '-', '--to', 'quote.md', '--generated', '--note', '芯片涨价后重算早鸟价'], 'early bird 129'))
    ok(claude(['put', '-', '--to', 'brief.md', '--imported', '--note', '主人给的需求'], 'brief'))

    const since = ok(codex(['check', '--json'])).json().sections.find((s: any) => s.title === '自上次以来').data
    const scene = since.scenes.find((s: any) => s.scene === 's1')
    expect(scene.facts.map((f: any) => f.text)).toEqual(['放入 quote.md（做出来的）：拉丝铝初稿', 'quote.md 换了新内容：芯片涨价后重算早鸟价', '放入 brief.md（带进来的）：主人给的需求'])

    const quote = ok(codex(['inspect', 'quote.md'])).stdout
    expect(quote).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}被换下，在留存里 {2}「拉丝铝初稿」$/m)
    expect(quote).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}「芯片涨价后重算早鸟价」$/m)
    expect(quote).not.toContain('备注')

    const moved = claude(['put', 'brief.md', '--to', 'moved/brief.md', '--note', '挪个地方'])
    expect(moved.code).toBe(1)
    expect(moved.stderr).toContain('--note')
    expect(ok(claude(['inspect', 'brief.md', '--json'])).json().sections[0].data).toMatchObject({ path: 'brief.md' })
  })
})
