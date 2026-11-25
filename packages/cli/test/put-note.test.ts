// put --note with only the ledger installed: the sentence rides on the fact the put writes, so
// another agent reads one put as one line, and inspect shows it on the content it describes.
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const claude = (args: string[], input?: string) =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const codex = (args: string[]) => sb.run(['--library', lib, '--as', 'codex', '--session', 's2', ...args], { cwd: outside })

describe('put --note', () => {
  it('is one line in another agent’s check, and ends the line of the content it describes in inspect', () => {
    ok(claude(['put', '-', '--to', 'quote.md', '--made', '--note', '初稿'], 'early bird 99'))
    ok(claude(['put', '-', '--to', 'quote.md', '--made', '--note', '按新成本重算早鸟价'], 'early bird 129'))
    ok(claude(['put', '-', '--to', 'brief.md', '--brought', '--note', '主人给的需求'], 'brief'))

    const since = ok(codex(['check', '--json'])).json().sections.find((s: any) => s.title === '自上次以来').data
    const scene = since.scenes.find((s: any) => s.scene === 's1')
    expect(scene.facts.map((f: any) => f.text)).toEqual(['放入 quote.md（做出来的）：初稿', 'quote.md 换了新内容：按新成本重算早鸟价', '放入 brief.md（带进来的）：主人给的需求'])

    const quote = ok(codex(['inspect', 'quote.md'])).stdout
    expect(quote).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}被换下，在留存里 {2}「初稿」$/m)
    expect(quote).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}「按新成本重算早鸟价」$/m)
    expect(quote).not.toContain('备注')
    expect(ok(codex(['inspect', 'brief.md'])).stdout).toMatch(/^ {2}[0-9a-f]{8} {2}\S+ \S+ {2}claude-code {2}「主人给的需求」$/m)
  })

  it('is refused on a move within the library, which changes no content', () => {
    ok(claude(['put', '-', '--to', 'a.md', '--made'], 'a'))
    const r = claude(['put', 'a.md', '--to', 'moved/a.md', '--note', '挪个地方'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('--note')
    expect(ok(claude(['inspect', 'a.md', '--json'])).json().sections[0].data).toMatchObject({ path: 'a.md' })
  })
})
