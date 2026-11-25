// C7, the confirmed half: destructive owner commands that the person confirmed run, and agents see
// them in check. archive purge removes the items it deleted, so what was made from them shows its
// source gone. Driven through the kernel with an injected confirmation, as a terminal would give.
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, type Actor, type Instant, type Library, type OwnerCall, type Session } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { ledger, ownerSummary } from '../src/index.js'

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

describe('an owner operation in the record', () => {
  it('names a path by its last name, so a line in check or the activity list is not a long absolute path', () => {
    expect(ownerSummary('已把 /private/var/folders/x/lib 建成库。说明在 PNEUMA-BASE.md。')).toBe('已把 lib 建成库。说明在 PNEUMA-BASE.md。')
    expect(ownerSummary('已发授权 c 给 claude-code。本机副本：/Users/me/.pneuma-base/grants/c.json')).toBe('已发授权 c 给 claude-code。本机副本：c.json')
    expect(ownerSummary('部署目标已设为目录 /tmp/a/www。开着的 2 样还没发到新目标：运行 deploy sync。')).toBe('部署目标已设为目录 www。开着的 2 样还没发到新目标：运行 deploy sync。')
    expect(ownerSummary('已打开 sites/a：在线 · 开关开')).toBe('已打开 sites/a：在线 · 开关开')
    expect(ownerSummary('已打开 sites/a：在线 · file:///tmp/x/www/sites-a/ · 开关开')).toBe('已打开 sites/a：在线 · sites-a/ · 开关开')
    expect(ownerSummary('已同步：本地 ⇄ 目录 /tmp/s\n推上去 3 · 拉下来 0\n')).toBe('已同步：本地 ⇄ 目录 s；推上去 3 · 拉下来 0')
  })
})

describe('a read-only owner command', () => {
  it('is recorded, but is no news in check', async () => {
    const { as, call } = await library()
    await agentFace.put({ kind: 'place', from: text('old'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    await agentFace.put({ kind: 'place', from: text('new'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    expect(await ownerFace.dispatch(call(), 'ledger held list', { positional: [], flags: {} })).toMatchObject({ outcome: 'done' })
    const { lines } = await sinceLines(as(claude, 's2'))
    expect(lines.some((l) => l.includes('ledger held list'))).toBe(false)
  })
})

describe('a plugin command run by an agent', () => {
  it('is attributed as a command run by that agent, not as 主人面的操作', async () => {
    const syncer = {
      name: 'syncer' as never,
      cognition: null,
      storage: [],
      statements: [],
      ownerCommands: [{ name: 'syncer run', summary: '', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done' as const, text: '已对一遍' }) }],
    }
    const dir = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-l-agent-op-')))
    const root = join(dir, 'lib')
    const home = join(dir, 'home')
    const both = new Map<string, any>([[ledger.name as string, ledger], ['syncer', syncer]])
    await initLibrary(root, { plugins: ['ledger', 'syncer'], table: both, actor: owner, session: session('init'), home })
    const lib = (await openLibrary(root, both))!
    const codex: Actor = { kind: 'agent', name: 'codex', grant: null }
    await ownerFace.dispatch({ ctx: makeContext(lib, codex, session('s-codex'), home, next()), table: both, env: {}, viaGrant: true, confirm: async () => false }, 'syncer run', { positional: [], flags: {} })
    const { lines } = await sinceLines(makeContext(lib, claude, session('s-claude'), home, next()))
    expect(lines).toContain('  执行 syncer run：已对一遍')
    expect(lines.some((l) => l.includes('主人面的操作 syncer run'))).toBe(false)
  })
})

describe('new content made from the old', () => {
  it('records no basis on itself', async () => {
    const { as } = await library()
    await agentFace.put({ kind: 'place', from: text('v1'), to: 'site.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    const r = await agentFace.put({ kind: 'place', from: text('v2'), to: 'site.md', origin: { kind: 'made', from: ['site.md'], outside: [] } }, as(claude, 's2'))
    expect(r).toMatchObject({ outcome: 'accepted' })
    const body = (await agentFace.inspect({ target: 'site.md' }, as(claude, 's3'))).sections[0]?.body ?? ''
    expect(body).not.toContain('依据：')
    expect(body).not.toContain('被依据')
  })
})

describe('confirmed destructive owner commands', () => {
  it('ledger held drop deletes the held copies, and an agent sees it in check', async () => {
    const { lib, as, call } = await library()
    await agentFace.put({ kind: 'place', from: text('old'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    const replaced = await agentFace.put({ kind: 'place', from: text('new'), to: 'a.md', origin: { kind: 'made', from: [], outside: [] } }, as(claude, 's1'))
    expect(replaced).toMatchObject({ outcome: 'accepted', copied: true })
    expect(existsSync(join(lib.root, '.pneuma-base/ledger/held'))).toBe(true)

    expect(await ownerFace.dispatch(call(), 'ledger held drop', { positional: [], flags: {} })).toMatchObject({ outcome: 'done', text: '已清掉 1 份留存。' })
    expect(existsSync(join(lib.root, '.pneuma-base/ledger/held'))).toBe(false)

    const { lines } = await sinceLines(as(claude, 's2'))
    expect(lines).toContain('  主人面的操作 ledger held drop：已清掉 1 份留存。')
  })

  it('archive purge removes the purged items; what was made from them shows its source gone', async () => {
    const { as, call } = await library()
    await agentFace.put({ kind: 'place', from: text('s'), to: 's.md', origin: { kind: 'brought', source: null, by: null } }, as(claude, 's1'))
    await agentFace.put({ kind: 'place', from: text('a'), to: 'a.md', origin: { kind: 'made', from: ['s.md'], outside: [] } }, as(claude, 's1'))
    await agentFace.archive({ kind: 'archive', path: 's.md' }, as(claude, 's1'))
    expect(await ownerFace.dispatch(call(), 'archive purge', { positional: [], flags: {} })).toMatchObject({ outcome: 'done' })

    const { r, lines } = await sinceLines(as(claude, 's2'))
    expect(lines).toContain('  _archive/s.md 随归档区一起清掉了')
    expect(r.sections.find((s) => s.title === '来源不在')?.data).toMatchObject([{ path: 'a.md', sources: [{ path: '_archive/s.md' }] }])
    expect(r.sections.find((s) => s.title === '不在了的')).toBeUndefined()
    const inspected = await agentFace.inspect({ target: 'a.md' }, as(claude, 's2'))
    expect(inspected.sections[0]?.body).toMatch(/_archive\/s\.md\s+已除 ← 来源不在/)
  })
})
