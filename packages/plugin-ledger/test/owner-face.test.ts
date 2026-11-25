// C7, the confirmed half: destructive owner commands that the person confirmed run, and agents see
// them in check. archive purge removes the items it deleted, so what was made from them shows its
// source gone. Driven through the kernel with an injected confirmation, as a terminal would give.
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, type Actor, type Instant, type Library, type OwnerCall, type Session } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { ledger } from '../src/index.js'

const table = new Map([[ledger.name as string, ledger]])
const owner: Actor = { kind: 'owner' }
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session = (id: string): Session => ({ id, source: 'flag', cwd: '/work', machine: 'test', transcript: null })
let second = 0
const next = () => `2026-11-25T01:00:${String(second++).padStart(2, '0')}.000Z` as Instant

async function library(): Promise<{ lib: Library; call: () => OwnerCall; as: (actor: Actor, id: string) => ReturnType<typeof makeContext> }> {
  const dir = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-l-')))
  const root = join(dir, 'lib')
  const home = join(dir, 'home')
  await initLibrary(root, { plugins: ['ledger'], table, actor: owner, session: session('init'), home })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const as = (actor: Actor, id: string) => makeContext(lib, actor, session(id), home, next())
  return { lib, as, call: () => ({ ctx: as(owner, 'owner'), table, home, env: {}, viaGrant: false, confirm: async () => true }) }
}

const text = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })
const sinceLines = async (ctx: ReturnType<typeof makeContext>) => {
  const r = await agentFace.check({ since: 'last', includeArchived: false }, ctx)
  return { r, lines: (r.sections.find((s) => s.title === '自上次以来')?.body ?? '').split('\n') }
}

describe('confirmed destructive owner commands', () => {
  it('held drop deletes the held copies, and an agent sees it in check', async () => {
    const { lib, as, call } = await library()
    await agentFace.put({ kind: 'place', from: text('old'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    const replaced = await agentFace.put({ kind: 'place', from: text('new'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    expect(replaced).toMatchObject({ outcome: 'accepted', copied: true })
    expect(existsSync(join(lib.root, '.pneuma-base/ledger/held'))).toBe(true)

    const drop = ledger.ownerCommands.find((c) => c.name === 'held drop')
    if (!drop) throw new Error('no held drop')
    expect(await ownerFace.run(call(), ledger, drop, { positional: [], flags: {} })).toMatchObject({ outcome: 'done', text: '已清掉 1 份留存。' })
    expect(existsSync(join(lib.root, '.pneuma-base/ledger/held'))).toBe(false)

    const { lines } = await sinceLines(as(claude, 's2'))
    expect(lines).toContain('  主人面的操作 held drop：已清掉 1 份留存。')
  })

  it('archive purge removes the purged items; what was made from them shows its source gone', async () => {
    const { as, call } = await library()
    await agentFace.put({ kind: 'place', from: text('s'), to: 's.md', origin: { kind: 'brought', source: null, by: null } }, as(claude, 's1'))
    await agentFace.put({ kind: 'place', from: text('a'), to: 'a.md', origin: { kind: 'made', from: ['s.md'], outside: [] } }, as(claude, 's1'))
    await agentFace.archive({ kind: 'archive', path: 's.md' }, as(claude, 's1'))
    expect(await ownerFace.purgeArchive(call())).toMatchObject({ outcome: 'done' })

    const { r, lines } = await sinceLines(as(claude, 's2'))
    expect(lines).toContain('  _archive/s.md 随归档区一起清掉了')
    expect(r.sections.find((s) => s.title === '来源不在')?.data).toMatchObject([{ path: 'a.md', sources: [{ path: '_archive/s.md' }] }])
    expect(r.sections.find((s) => s.title === '不在了的')).toBeUndefined()
    const inspected = await agentFace.inspect({ target: 'a.md' }, as(claude, 's2'))
    expect(inspected.sections[0]?.body).toMatch(/_archive\/s\.md\s+已除 ← 来源不在/)
  })
})
