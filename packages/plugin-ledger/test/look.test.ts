// How the ledger looks at the library, by position (ARCHITECTURE.md「每个动作在每种位置上做什么」): a registered
// file, a registered directory-thing, an open directory, a directory nobody looked into, and noise; for
// check, which compares state tokens, and for check --deep, the named whole pass that reads content.
// Registering reads no content: a spy on the plugin's storage counts every content read.
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, type Actor, type CheckResult, type Instant, type Library, type Plugin, type PluginContext, type Session } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { ledger } from '../src/index.js'

const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session = (id: string): Session => ({ id, source: 'flag', cwd: '/work', machine: 'test', transcript: null })
const text = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The ledger with every content read it asks of storage counted. */
function spied() {
  const reads: string[] = []
  const spy = (ctx: PluginContext): PluginContext => {
    const storage = ctx.tools.storage
    return { ...ctx, tools: { ...ctx.tools, storage: { ...storage, content: (place, opts) => (reads.push(place), storage.content(place, opts)) } } }
  }
  const plugin: Plugin = {
    ...ledger,
    onPut: (req, ctx) => (ledger.onPut as NonNullable<Plugin['onPut']>)(req, spy(ctx)),
    onCheck: (req, ctx) => (ledger.onCheck as NonNullable<Plugin['onCheck']>)(req, spy(ctx)),
    onAsks: (ctx) => (ledger.onAsks as NonNullable<Plugin['onAsks']>)(spy(ctx)),
    ownerCommands: ledger.ownerCommands.map((c) => ({ ...c, run: (values: Parameters<typeof c.run>[0], ctx: PluginContext) => c.run(values, spy(ctx)) })),
  }
  return { plugin, reads }
}

async function library() {
  const { plugin, reads } = spied()
  const table = new Map([[plugin.name as string, plugin]])
  const base = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-look-')))
  const root = join(base, 'lib')
  const home = join(base, 'home')
  await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init'), home })
  const lib = (await openLibrary(root, table)) as Library
  let second = 0
  const now = () => new Date(Date.parse('2026-11-27T03:00:00.000Z') + 1000 * second++).toISOString() as Instant
  const agent = (id = 'work') => makeContext(lib, claude, session(id), home, now())
  const put = (path: string, content: string) => agentFace.put({ kind: 'place', from: text(content), to: path, origin: { kind: 'imported', source: null, by: null } }, agent())
  const check = (deep?: { dir: string | null }) => agentFace.check({ since: 'last', includeArchived: false, ...(deep ? { deep: deep as never } : {}) }, agent('checker'))
  const run = (command: string, positional: string[], flags: Record<string, string[] | true> = {}) =>
    ownerFace.dispatch({ ctx: makeContext(lib, { kind: 'owner' }, session('owner'), home, now()), table, env: {}, viaGrant: false, confirm: async () => true }, command, { positional, flags })
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return { root, reads, agent, put, check, run, write }
}

/** Everything a check tells an agent: its sections and its asks, as text. */
const told = (r: CheckResult) => [...r.sections.map((s) => `【${s.title}】\n${s.body}`), ...r.asks.map((a) => `问：${a.text}`)].join('\n')
const section = (r: CheckResult, title: string) => r.sections.find((s) => s.title === title)?.body ?? ''

/** Checks until what it tells satisfies `ok`: the file system reports a change a moment after it happened. */
async function checkUntil(check: () => Promise<CheckResult>, ok: (r: CheckResult) => boolean): Promise<CheckResult> {
  let r = await check()
  for (let i = 0; i < 30 && !ok(r); i++) {
    await sleep(100)
    r = await check()
  }
  return r
}

describe('check, by position', () => {
  it('a registered file: changed content is said; a touch that kept the content is not; a gone one is missing, and back as it was is missing no longer', async () => {
    const { root, put, check, reads } = await library()
    await put('a.md', 'one')
    await put('b.md', 'two')
    await put('c.md', 'three')
    await check()
    writeFileSync(join(root, 'a.md'), 'one, and more')
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'b.md'), later, later)
    unlinkSync(join(root, 'c.md'))
    const r = await checkUntil(check, (x) => section(x, '外部修改').includes('a.md') && section(x, '已缺失').includes('c.md'))
    expect(section(r, '外部修改')).toBe('  a.md\nAgent 自己的修改，用 say revised <库内路径> 确认；所有者说明是自己修改的，加 --by owner。')
    expect(section(r, '已缺失')).toBe('  c.md')
    expect(told(r)).not.toContain('b.md')
    // Only the things whose token differs and that have a fingerprint were read: the touched one and the changed one.
    expect([...new Set(reads)].sort()).toEqual(['a.md', 'b.md'])
    // The touch was taken as recorded: the next check reads nothing.
    reads.length = 0
    await check()
    expect(reads.filter((p) => p === 'b.md')).toEqual([])
    writeFileSync(join(root, 'c.md'), 'three')
    const back = await checkUntil(check, (x) => !told(x).includes('c.md'))
    expect(told(back)).not.toContain('c.md')
  })

  it('a registered directory-thing: a change in it is said of the thing, never of its files', async () => {
    const { write, agent, check } = await library()
    write('site/index.html', '<h1>hi</h1>')
    write('site/.pneuma-item', '')
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'imported', source: null, by: null } }, agent())
    expect(told(await check())).not.toContain('site')
    write('site/style.css', 'h1{}')
    const r = await checkUntil(check, (x) => section(x, '外部修改').includes('site'))
    expect(section(r, '外部修改').split('\n')[0]).toBe('  site')
    expect(told(r)).not.toContain('style.css')
  })

  it('an open directory: a new loose file is asked about once, under its directory', async () => {
    const { write, put, check } = await library()
    await put('notes/a.md', 'a')
    await check()
    write('notes/b.md', 'b')
    const r = await checkUntil(check, (x) => x.asks.length > 0)
    expect(r.asks.map((a) => a.text)).toEqual(['notes/ 中有 1 个未登记的文件。'])
    expect(section(r, '未登记').split('\n')[0]).toBe('  notes/b.md')
  })

  it('a directory nobody looked into: one line for the directory, nothing of what is in it', async () => {
    const { write, put, check } = await library()
    await put('notes/a.md', 'a')
    await check()
    write('notes/proj/src/main.ts', 'x')
    write('notes/proj/README.md', 'r')
    const r = await checkUntil(check, (x) => x.asks.length > 0)
    expect(r.asks.map((a) => a.text)).toEqual(['notes/proj/ 未登记：2 个文件。'])
    expect(section(r, '未登记的目录')).toBe('  notes/proj/')
    expect(told(r)).not.toMatch(/main\.ts|README|src/)
  })

  it('noise: never mentioned', async () => {
    const { write, put, check } = await library()
    await put('notes/a.md', 'a')
    write('node_modules/x/index.js', 'x')
    write('notes/.git/HEAD', 'ref')
    write('late.md', 'l')
    const r = await checkUntil(check, (x) => told(x).includes('late.md'))
    expect(told(r)).not.toMatch(/node_modules|\.git/)
  })

  it('a registered file moved within an open directory is found again by its size and moment, and check records the move', async () => {
    const { root, put, check } = await library()
    await put('notes/a.md', 'a moved file')
    await put('notes/keep.md', 'k')
    await check()
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'notes/a.md'), join(root, 'notes/here.md'))
    const r = await checkUntil(check, (x) => section(x, '已移动') !== '')
    expect(section(r, '已移动')).toBe('  notes/a.md → notes/here.md，已记录新路径')
    const after = await check()
    expect(told(after)).not.toMatch(/a\.md|here\.md/)
  })
})

describe('check --deep, by position', () => {
  async function arranged() {
    const l = await library()
    await l.put('a.md', 'one')
    await l.put('notes/n.md', 'n')
    l.write('site/index.html', '<h1>hi</h1>')
    l.write('site/.pneuma-item', '')
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'imported', source: null, by: null } }, l.agent())
    l.write('notes/loose.md', 'loose')
    l.write('notes/proj/x.md', 'x')
    l.write('node_modules/y.js', 'y')
    await l.check()
    return l
  }

  it('reads every registered thing and nothing else; says which changed by content, which were only touched; stays within the directory named', async () => {
    const { root, check, reads } = await arranged()
    reads.length = 0
    const whole = await check({ dir: null })
    expect(section(whole, '深度检查').split('\n')[0]).toBe('深度检查完成：整个资料库共 3 个已登记条目。')
    // No loose file, no directory nobody looked into, no noise.
    expect([...new Set(reads)].sort()).toEqual(['a.md', 'notes/n.md', 'site'])

    writeFileSync(join(root, 'a.md'), 'one, changed')
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'notes/n.md'), later, later)
    const r = await check({ dir: null })
    const body = section(r, '深度检查')
    expect(body).toContain('内容已变更（1 个）：\n  a.md')
    expect(body).toContain('仅元数据变化，内容未变，已按当前状态记录（1 个）：\n  notes/n.md')
    reads.length = 0
    const notes = await check({ dir: 'notes' })
    expect(section(notes, '深度检查').split('\n')[0]).toBe('深度检查完成：notes 共 1 个已登记条目。')
    expect([...new Set(reads)]).toEqual(['notes/n.md'])
  })
})

describe('registering', () => {
  it('an open directory through put takes its loose files, reading no content', async () => {
    const { write, put, agent, check, reads } = await library()
    await put('notes/a.md', 'a')
    write('notes/b.md', 'b')
    write('notes/c.md', 'c')
    write('notes/deeper/d.md', 'd')
    reads.length = 0
    const r = await agentFace.put({ kind: 'register', path: 'notes', origin: { kind: 'imported', source: null, by: 'owner' } }, agent())
    expect(r.outcome).toBe('accepted')
    expect(reads).toEqual([])
    const after = await check()
    expect(told(after)).not.toMatch(/b\.md|c\.md/)
    // Its folders are left as they were: one directory nobody looked into.
    expect(after.asks.map((a) => a.text)).toEqual(['notes/deeper/ 未登记：1 个文件。'])
  })

  it('everything in a directory, by the owner, says how much first, reads no content, and leaves nothing to ask', async () => {
    const { write, put, check, run, reads } = await library()
    await put('notes/a.md', 'a')
    for (let i = 0; i < 5; i++) write(`notes/proj/src/f${i}.ts`, `f${i}`)
    write('notes/proj/node_modules/z.js', 'z')
    await check()
    reads.length = 0
    const r = await run('ledger register', ['notes/proj'], { recursive: true })
    expect(r).toMatchObject({ outcome: 'done', text: '已将 notes/proj/ 中的 5 个文件标记为所有者导入。', data: { registered: 5 } })
    expect(reads).toEqual([])
    const after = await check()
    expect(after.asks).toEqual([])
    expect(told(after)).not.toMatch(/f[0-4]\.ts|node_modules/)
  })
})
