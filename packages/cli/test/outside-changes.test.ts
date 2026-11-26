// C4: files added, changed, moved with the same content, and deleted outside the tool are reported
// by check as unowned, changed, moved and taken back, and missing; the library does not fail.
// C5: a thing made from S is marked stale when S changes, source-gone when S is deleted, and the
// mark goes when S holds its old content again.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { factsOf, sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const agent = (args: string[], input?: string) =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const other = (args: string[]) => sb.run(['--library', lib, '--as', 'codex', '--session', 's2', ...args], { cwd: outside })
/** The item.revise facts on disk, as written. */
const reviseFacts = () => factsOf(lib).filter((f) => f.kind === 'item.revise')
const check = () => {
  const r = ok(agent(['check', '--json']))
  expect(r.json().problems).toEqual([])
  return r.json().sections as { title: string; body: string; data: any }[]
}
/** A check section's rows: the first ones it names, which are all of them below twenty. */
const section = (sections: { title: string; data: any }[], title: string) => sections.find((s) => s.title === title)?.data?.shown
const paths = (rows: { path: string }[] | undefined) => (rows ?? []).map((r) => r.path)
const byHand = (path: string, content: string) => {
  mkdirSync(join(lib, path, '..'), { recursive: true })
  writeFileSync(join(lib, path), content)
}

describe('changes made outside the tool (C4)', () => {
  beforeEach(() => {
    for (const name of ['kept', 'edited', 'moved', 'deleted']) ok(agent(['put', '-', '--to', `${name}.md`, '--brought'], `${name} content`))
    byHand('dropped.md', 'nobody registered me')
    byHand('edited.md', 'edited by hand')
    // elsewhere/ holds a registered thing, so it is an open directory, the one kind check lists.
    ok(agent(['put', '-', '--to', 'elsewhere/anchor.md', '--brought'], 'anchor'))
    renameSync(join(lib, 'moved.md'), join(lib, 'elsewhere/moved.md'))
    rmSync(join(lib, 'deleted.md'))
  })

  it('check names each: unowned, changed, moved and taken back, missing', () => {
    const sections = check()
    expect(paths(section(sections, '没人登记过的'))).toEqual(['dropped.md'])
    expect(paths(section(sections, '被直接改过的'))).toEqual(['edited.md'])
    expect(section(sections, '挪过的')).toMatchObject([{ from: 'moved.md', to: 'elsewhere/moved.md' }])
    expect(paths(section(sections, '不在了的'))).toEqual(['deleted.md'])
    // The text output prints each section's title and body.
    const body = (title: string) => sections.find((s) => s.title === title)?.body
    expect(body('没人登记过的')).toContain('dropped.md')
    expect(body('被直接改过的')).toContain('edited.md')
    expect(body('挪过的')).toContain('moved.md → elsewhere/moved.md，已接回')
    expect(body('不在了的')).toContain('deleted.md')
    expect(ok(agent(['check'])).stdout).toContain('## 不在了的（ledger）\n  deleted.md')
  })

  it('takes a moved file back for good: the next check is quiet about it, and inspect finds it at the new path', () => {
    check()
    const again = check()
    expect(section(again, '挪过的')).toBeUndefined()
    expect(paths(section(again, '没人登记过的'))).toEqual(['dropped.md'])
    const data = ok(agent(['inspect', 'elsewhere/moved.md', '--json'])).json().sections[0].data
    expect(data).toMatchObject({ path: 'elsewhere/moved.md', state: { kind: 'consistent' }, origin: { kind: 'brought' } })
  })

  it('the remedies clear the reports: put gives an unowned file its origin, say revised claims an edit', () => {
    ok(agent(['put', 'dropped.md', '--brought', '--by', 'owner']))
    const said = ok(agent(['say', 'revised', 'edited.md', '--json'])).json()
    expect(said).toMatchObject({ outcome: 'heard', by: 'ledger' })
    const sections = check()
    expect(section(sections, '没人登记过的')).toBeUndefined()
    expect(section(sections, '被直接改过的')).toBeUndefined()
    const edited = ok(agent(['inspect', 'edited.md', '--json'])).json().sections[0].data
    expect(edited.state).toEqual({ kind: 'consistent' })
    expect(edited.versions.map((v: any) => v.claimed)).toEqual([false, true])
  })

  it('say revised --by owner: the agent stays the one who recorded it, the owner is named as who edited, and unknown --by values are refused', () => {
    expect(agent(['say', 'revised', 'edited.md', '--by', 'someone', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    const said = ok(agent(['say', 'revised', 'edited.md', '--by', 'owner', '--json'])).json()
    expect(said).toMatchObject({ outcome: 'heard', by: 'ledger', note: '已记下 edited.md 的这次直接改动是主人做的' })
    expect(reviseFacts()).toMatchObject([{ actor: { kind: 'agent', name: 'claude-code' }, claimed: true, by: 'owner' }])
    expect(section(check(), '被直接改过的')).toBeUndefined()
    expect(ok(agent(['inspect', 'edited.md'])).stdout).toMatch(/claude-code\s+主人直接改的，claude-code 代记/)
    const since = ok(other(['check', '--json'])).json().sections.find((s: any) => s.title === '自上次以来').data
    const told = since.scenes.flatMap((s: any) => s.facts).filter((f: any) => f.kind === 'item.revise')
    expect(told).toEqual([expect.objectContaining({ actor: 'claude-code', text: '记下 edited.md 是主人直接改的' })])
  })

  it('say revised --by owner said by the owner records the owner, with no by', () => {
    ok(sb.run(['--library', lib, 'say', 'revised', 'edited.md', '--by', 'owner'], { cwd: outside }))
    const [revise] = reviseFacts()
    expect(revise).toMatchObject({ actor: { kind: 'owner' }, claimed: true })
    expect(revise).not.toHaveProperty('by')
  })

  it('say revised on a file nobody registered or one that did not change is answered plainly', () => {
    expect(agent(['say', 'revised', 'dropped.md', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    expect(agent(['say', 'revised', 'kept.md', '--json']).json()).toMatchObject({ outcome: 'heard' })
    expect(agent(['say', 'revised', 'kept.md']).stdout).toContain('一致')
  })
})

describe('staleness (C5)', () => {
  const ORIGINAL = 'source, first version'

  beforeEach(() => {
    ok(agent(['put', '-', '--to', 'sources/s.md', '--brought', '--source', 'https://example.com/s'], ORIGINAL))
    ok(agent(['put', '-', '--to', 'made/a.md', '--made', '--from', 'sources/s.md'], 'made from s'))
    ok(agent(['put', '-', '--to', 'made/b.md', '--made', '--from', 'made/a.md'], 'made from a'))
  })

  it('S changed: A is maybe stale, B upstream-flagged; S deleted: source gone; S back as it was: no mark', () => {
    byHand('sources/s.md', 'source, edited')
    let sections = check()
    expect(section(sections, '可能过期')).toMatchObject([{ path: 'made/a.md', sources: [{ path: 'sources/s.md' }] }])
    expect(section(sections, '上游有标记')).toMatchObject([{ path: 'made/b.md', via: [{ path: 'made/a.md' }] }])
    expect(ok(agent(['check'])).stdout).toMatch(/made\/a\.md ← 依据 sources\/s\.md 变了/)
    expect(ok(agent(['inspect', 'made/a.md'])).stdout).toMatch(/sources\/s\.md\s+已变 ← 可能过期/)

    rmSync(join(lib, 'sources/s.md'))
    sections = check()
    expect(section(sections, '可能过期')).toBeUndefined()
    expect(section(sections, '来源不在')).toMatchObject([{ path: 'made/a.md', sources: [{ path: 'sources/s.md' }] }])
    expect(ok(agent(['inspect', 'made/a.md'])).stdout).toMatch(/sources\/s\.md\s+不在 ← 来源不在/)

    // tmp/run-7: a file whose row has a fingerprint, written back as it was, is taken as the new
    // baseline silently: not changed directly, and no mark comes from it.
    byHand('sources/s.md', ORIGINAL)
    sections = check()
    for (const title of ['可能过期', '来源不在', '上游有标记', '被直接改过的']) expect(section(sections, title), title).toBeUndefined()
  })
})
