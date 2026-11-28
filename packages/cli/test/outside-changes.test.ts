// C4: files added, changed, moved with the same content, and deleted outside the tool are reported
// by check as unowned, changed, moved and taken back, and missing; the library does not fail. Each
// case by position is the ledger's (packages/plugin-ledger/test/look.test.ts); here, how check
// prints them and the remedies it names.
// C5: a thing made from S is marked stale when S changes, source-gone when S is deleted, and the
// mark goes when S holds its old content again.
// One library for the file, its tests in order.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { factsOf, sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeAll(() => {
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
/** The item.revise facts on disk, as written. */
const reviseFacts = () => factsOf(lib).filter((f) => f.kind === 'item.revise')
const check = () => {
  const r = ok(agent(['check', '--json']))
  expect(r.json().problems).toEqual([])
  return r.json().sections as { title: string; body: string; data: any }[]
}
/** A check section's rows: the first ones it names, which are all of them below twenty. */
const section = (sections: { title: string; data: any }[], title: string) => sections.find((s) => s.title === title)?.data?.shown
const byHand = (path: string, content: string) => {
  mkdirSync(join(lib, path, '..'), { recursive: true })
  writeFileSync(join(lib, path), content)
}

describe('changes made outside the tool (C4)', () => {
  beforeAll(() => {
    for (const name of ['kept', 'edited', 'moved', 'deleted']) ok(agent(['put', '-', '--to', `${name}.md`, '--imported'], `${name} content`))
    byHand('dropped.md', 'nobody registered me')
    byHand('edited.md', 'edited by hand')
    // elsewhere/ holds a registered thing, so it is an open directory, the one kind check lists.
    ok(agent(['put', '-', '--to', 'elsewhere/anchor.md', '--imported'], 'anchor'))
    renameSync(join(lib, 'moved.md'), join(lib, 'elsewhere/moved.md'))
    rmSync(join(lib, 'deleted.md'))
  })

  it('check names each: unowned, changed, moved and taken back, missing', () => {
    const sections = check()
    const paths = (rows: { path: string }[] | undefined) => (rows ?? []).map((r) => r.path)
    expect(paths(section(sections, '未登记'))).toEqual(['dropped.md'])
    expect(paths(section(sections, '外部修改'))).toEqual(['edited.md'])
    expect(section(sections, '已移动')).toMatchObject([{ from: 'moved.md', to: 'elsewhere/moved.md' }])
    expect(paths(section(sections, '已缺失'))).toEqual(['deleted.md'])
    // The text output prints each section's title and body.
    const body = (title: string) => sections.find((s) => s.title === title)?.body
    expect(body('未登记')).toContain('dropped.md')
    expect(body('外部修改')).toContain('edited.md')
    expect(body('已移动')).toContain('moved.md → elsewhere/moved.md，已记录新路径')
    expect(body('已缺失')).toContain('deleted.md')
    expect(ok(agent(['check'])).stdout).toContain('## 已缺失（ledger）\n  deleted.md')
  })

  it('the remedies clear the reports: put gives an unowned file its origin, say revised claims an edit, as the agent’s or, with --by owner, as the owner’s; what they cannot fix is answered plainly', () => {
    expect(agent(['say', 'revised', 'dropped.md', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    expect(ok(agent(['say', 'revised', 'kept.md'])).stdout).toContain('一致')
    ok(agent(['put', 'dropped.md', '--imported', '--by', 'owner']))
    expect(ok(agent(['say', 'revised', 'edited.md', '--json'])).json()).toMatchObject({ outcome: 'heard', by: 'ledger' })
    const sections = check()
    expect(section(sections, '未登记')).toBeUndefined()
    expect(section(sections, '外部修改')).toBeUndefined()

    // The owner edits it again: the agent stays the one who recorded it, the owner is named as who edited.
    byHand('edited.md', 'edited by the owner')
    expect(agent(['say', 'revised', 'edited.md', '--by', 'someone', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    expect(ok(agent(['say', 'revised', 'edited.md', '--by', 'owner', '--json'])).json()).toMatchObject({ outcome: 'heard', by: 'ledger', note: '已记录 edited.md 的外部修改为所有者直接修改' })
    expect(reviseFacts()).toMatchObject([
      { actor: { kind: 'agent', name: 'claude-code' }, claimed: true },
      { actor: { kind: 'agent', name: 'claude-code' }, claimed: true, by: 'owner' },
    ])
    expect(reviseFacts()[0]).not.toHaveProperty('by')
    expect(ok(agent(['inspect', 'edited.md'])).stdout).toMatch(/claude-code\s+所有者直接修改，claude-code 代为记录/)

    // Said by the owner, --by owner records the owner, with no by.
    byHand('edited.md', 'edited by the owner, again')
    ok(sb.run(['--library', lib, 'say', 'revised', 'edited.md', '--by', 'owner'], { cwd: outside }))
    const owners = reviseFacts().at(-1)
    expect(owners).toMatchObject({ actor: { kind: 'owner' }, claimed: true })
    expect(owners).not.toHaveProperty('by')
  })
})

describe('staleness (C5)', () => {
  const ORIGINAL = 'source, first version'

  beforeAll(() => {
    ok(agent(['put', '-', '--to', 'sources/s.md', '--imported', '--source', 'https://example.com/s'], ORIGINAL))
    ok(agent(['put', '-', '--to', 'made/a.md', '--generated', '--from', 'sources/s.md'], 'made from s'))
    ok(agent(['put', '-', '--to', 'made/b.md', '--generated', '--from', 'made/a.md'], 'made from a'))
  })

  it('S changed: A is maybe stale, B upstream-flagged; S deleted: source gone; S back as it was: no mark', () => {
    byHand('sources/s.md', 'source, edited')
    const sections = check()
    expect(section(sections, '可能已过期')).toMatchObject([{ path: 'made/a.md', sources: [{ path: 'sources/s.md' }] }])
    expect(section(sections, '上游已标记')).toMatchObject([{ path: 'made/b.md', via: [{ path: 'made/a.md' }] }])
    expect(ok(agent(['check'])).stdout).toMatch(/made\/a\.md ← 依据 sources\/s\.md 已修改/)
    expect(ok(agent(['inspect', 'made/a.md'])).stdout).toMatch(/sources\/s\.md\s+已修改 ← 可能已过期/)

    rmSync(join(lib, 'sources/s.md'))
    const gone = check()
    expect(section(gone, '可能已过期')).toBeUndefined()
    expect(section(gone, '来源缺失')).toMatchObject([{ path: 'made/a.md', sources: [{ path: 'sources/s.md' }] }])

    // ARCHITECTURE.md「没经过资料库的改动」: a file whose row has a fingerprint, written back as it was, is taken as the new
    // baseline silently: not changed directly, and no mark comes from it.
    byHand('sources/s.md', ORIGINAL)
    const back = check()
    for (const title of ['可能已过期', '来源缺失', '上游已标记', '外部修改']) expect(section(back, title), title).toBeUndefined()
  })
})
