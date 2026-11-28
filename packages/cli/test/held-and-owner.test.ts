// C6: putting different content at a path keeps the old content; the owner gets it back with the
// same bytes; the agent face has no delete; at a terminal, input that ends is no confirmation (the
// gate itself is plugin-mechanism.test.ts's). C7: owner operations show up in an agent's check.
// C15 with the ledger: an archived item stays out of the stale lists, its origin still readable.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentFace, initLibrary, makeContext, openLibrary, type Library, type Session } from '@pneuma-base/kernel'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

/** A fresh machine and a library with the ledger. */
function fresh() {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
}

const agent = (args: string[], input?: string | Buffer, session = 's1') =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', session, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const owner = (args: string[], env?: Record<string, string>) => sb.run([...args, '--library', lib], { cwd: outside, ...(env ? { env } : {}) })
const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const sections = (r: { json: () => any }) => r.json().sections as { title: string; body: string; data: any }[]
/** A check section's data; for a list of things, the first ones it names, which are all of them below twenty. */
const section = (list: { title: string; data: any }[], title: string) => {
  const data = list.find((s) => s.title === title)?.data
  return data?.shown ?? data
}

const OLD = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
const NEW = Buffer.from('the new version\n')

// One library: the tests run in order, each on what the one before left.
describe('a new version over an old one (C6)', () => {
  beforeAll(() => {
    fresh()
    ok(agent(['put', '-', '--to', 'report.bin', '--generated'], OLD))
    writeFileSync(join(outside, 'report.bin'), NEW)
  })

  it('replaces the file and keeps the old bytes, a file nobody registered too; ledger copies restore gives the owner the same bytes at a new path, and refuses to overwrite', () => {
    const r = ok(agent(['put', 'report.bin', '--to', 'report.bin', '--generated', '--json']))
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(NEW)
    const data = sections(ok(agent(['inspect', 'report.bin', '--json'])))[0]?.data
    expect(data.versions).toHaveLength(2)
    expect(data.held).toHaveLength(1)
    expect(readFileSync(join(lib, data.held[0]))).toEqual(OLD)

    expect(ok(owner(['ledger', 'copies', 'list'])).stdout).toContain('report.bin')
    expect(owner(['ledger', 'copies', 'restore', 'report.bin', '--to', 'report.bin']).code).toBe(2)
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(NEW)
    ok(owner(['ledger', 'copies', 'restore', 'report.bin', '--to', 'restored/report.bin']))
    expect(readFileSync(join(lib, 'restored/report.bin'))).toEqual(OLD)
    const restored = sections(ok(agent(['inspect', 'restored/report.bin', '--json'])))[0]?.data
    expect(restored.origin).toMatchObject({ kind: 'imported', by: 'owner' })

    writeFileSync(join(lib, 'dropped.md'), 'by hand')
    writeFileSync(join(outside, 'dropped.md'), 'by the agent')
    ok(agent(['put', 'dropped.md', '--to', 'dropped.md', '--generated']))
    const dropped = sections(ok(agent(['inspect', 'dropped.md', '--json'])))[0]?.data
    expect(readFileSync(join(lib, dropped.held[0]), 'utf8')).toBe('by hand')
  })

  it('the agent face has no delete', () => {
    for (const verb of ['delete', 'rm', 'remove']) {
      const r = agent([verb, 'report.bin'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('未知命令')
    }
    // The agent's part of the help, above the owner's commands (removing a secret there is the owner's).
    const help = ok(sb.run(['--help'])).stdout
    expect(help.slice(0, help.indexOf('\n所有者：'))).not.toMatch(/delete|删除/)
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(NEW)
  })

  it.skipIf(!HAS_PTY)('in a terminal, input that ends (Ctrl+D) is no confirmation: refused in Chinese, exit 2; typing yes confirms', () => {
    const heldDir = join(lib, '.pneuma-base/ledger/held')
    const held = readdirSync(heldDir).length
    expect(held).toBeGreaterThan(0)
    const ended = inTerminal('EOF', ['ledger', 'copies', 'drop', '--library', lib])
    expect(ended.stdout).not.toMatch(/Aborted|Ctrl\+D/)
    expect(ended.stdout).toContain('拒绝（not-confirmed）：未获当面确认，未执行任何操作。')
    expect(ended.code).toBe(2)
    expect(readdirSync(heldDir)).toHaveLength(held)
    const confirmed = inTerminal('yes', ['ledger', 'copies', 'drop', '--library', lib])
    expect(confirmed.code, confirmed.stdout).toBe(0)
    expect(existsSync(heldDir) ? readdirSync(heldDir) : []).toEqual([])
  })
})

const TERMINAL = fileURLToPath(new URL('./fixtures/terminal.py', import.meta.url))
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const HAS_PTY = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0

/** `pneuma-base ...args` as the owner at a terminal, who answers the confirmation with `answer`, or ends the input. */
function inTerminal(answer: 'EOF' | 'yes', args: string[]): { code: number; stdout: string } {
  const r = spawnSync('python3', [TERMINAL, answer, process.execPath, BIN, ...args], {
    cwd: outside,
    env: { PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') },
    encoding: 'utf8',
    timeout: 90_000,
  })
  return { code: r.status ?? -1, stdout: r.stdout }
}

describe('owner operations (C7)', () => {
  beforeEach(fresh)

  it('appear in an agent’s check after its last visit when they change the content or the capabilities', () => {
    ok(agent(['start', '整理资料']))
    const withTest = (args: string[]) => ok(sb.runWithTestPlugins([...args, '--library', lib], { cwd: outside }))
    withTest(['plugin', 'enable', 'recorder'])
    withTest(['grant', 'create', 'helper', '--agent', 'codex'])
    withTest(['grant', 'revoke', 'helper'])
    withTest(['plugin', 'disable', 'recorder'])

    const r = ok(agent(['check', '--json'], undefined, 's2'))
    const since = section(sections(r), '最近动态')
    const ops = since.scenes.flatMap((s: any) => s.facts).filter((f: any) => f.kind === 'owner.op').map((f: any) => f.text)
    expect(ops).toHaveLength(2)
    for (const [i, command] of ['plugin enable', 'plugin disable'].entries()) expect(ops[i]).toContain(command)
    // That check was a look; the text asks from the same moment the look did.
    const text = ok(agent(['check', '--since', since.since], undefined, 's3')).stdout
    expect(text).toMatch(/^场景 adhoc-owner-\d{4}-\d\d-\d\d · 所有者/m)
    expect(text).toContain('pneuma-base plugin disable')
    expect(text).not.toContain('grant')
  })

  it('omits setup commands that ran before an agent’s first visit, while keeping content and online state changes', () => {
    const setup = ['plugin enable', 'deploy target set']
    const target = () => join(tempDir('pb-www-'), 'www')
    ok(owner(['plugin', 'enable', 'deploy']))
    ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', target()]))

    writeFileSync(join(outside, 'brief.md'), 'brief\n')
    ok(agent(['put', 'brief.md', '--to', 'brief.md', '--imported'], undefined, 'claude-1'))
    ok(agent(['say', 'deployable', 'brief.md'], undefined, 'claude-1'))
    ok(owner(['deploy', 'on', 'brief.md']))

    // A brand-new agent arriving via start or check sees the put, say and deploy on, not the prior setup noise.
    const started = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 'codex-1', 'start', '接着做'], { cwd: outside })).stdout
    for (const setupOp of setup) expect(started).not.toContain(setupOp)
    expect(started).toContain('导入 brief.md')
    expect(started).toContain('pneuma-base deploy on')

    const firstCheck = ok(sb.run(['--library', lib, '--as', 'antigravity', '--session', 'agy-1', 'check'], { cwd: outside })).stdout
    for (const setupOp of setup) expect(firstCheck).not.toContain(setupOp)
    expect(firstCheck).toContain('pneuma-base deploy on')

    // Explicit --since asks for everything since that moment, including setup operations.
    const explicit = ok(sb.run(['--library', lib, '--as', 'antigravity', '--session', 'agy-1', 'check', '--since', '2000-01-01T00:00:00Z'], { cwd: outside })).stdout
    for (const setupOp of setup) expect(explicit).toContain(`pneuma-base ${setupOp}`)

    // Once codex has visited, a later setup change by the owner IS news on codex's next visit.
    ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', target()]))
    const returning = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 'codex-2', 'check'], { cwd: outside })).stdout
    expect(returning).toContain('pneuma-base deploy target set')
  })
})

// In process, with the built ledger: the command line adds nothing to what check, find and inspect answer
// here, and each call is a fresh context, as each command is a fresh process.
describe('archive with the ledger (C15)', () => {
  let root: string
  let home: string
  let library: Library
  const session = (id: string): Session => ({ id, source: 'flag', cwd: '/', machine: 'test', transcript: null })
  const as = (name: string, id: string) => makeContext(library, { kind: 'agent', name, grant: null }, session(id), home)
  const claude = () => as('claude-code', 's1')
  const stdin = (text: string) => ({ kind: 'stdin', content: new TextEncoder().encode(text) }) as const
  const check = async (includeArchived: boolean, ctx = claude()) => (await agentFace.check({ since: 'last', includeArchived }, ctx)).sections as { title: string; data: any }[]

  beforeEach(async () => {
    root = join(tempDir(), 'lib')
    home = tempDir('pb-home-')
    const init = await initLibrary(root, { plugins: ['ledger'], table: builtinPlugins, actor: { kind: 'owner' }, session: session('init'), home })
    expect(init.outcome).toBe('done')
    library = (await openLibrary(root, builtinPlugins)) as Library
    expect(await agentFace.put({ kind: 'place', from: stdin('source'), to: 'sources/s.md', origin: { kind: 'brought', source: 'https://example.com/s', by: null } }, claude())).toMatchObject({ outcome: 'accepted' })
    expect(await agentFace.put({ kind: 'place', from: stdin('draft from s'), to: 'drafts/a.md', origin: { kind: 'made', from: ['sources/s.md'], outside: [] } }, claude())).toMatchObject({ outcome: 'accepted' })
    expect(await agentFace.archive({ kind: 'archive', path: 'drafts/a.md' }, claude())).toMatchObject({ outcome: 'accepted' })
  })

  it('keeps an archived item out of find and the stale list by default, in with the switch; its origin stays readable', async () => {
    const found = async (includeArchived: boolean) => (await agentFace.find({ text: 'draft', match: 'terms', filters: {}, includeArchived, skipOwnSession: false }, claude())).hits.filter((h) => h.by === 'ledger').map((h) => h.path)
    expect(await found(false)).toEqual([])
    expect(await found(true)).toEqual(['_archive/drafts/a.md'])
    writeFileSync(join(root, 'sources/s.md'), 'source, edited')
    expect(section(await check(false), '可能已过期')).toBeUndefined()
    expect(section(await check(true), '可能已过期')).toMatchObject([{ path: '_archive/drafts/a.md' }])

    const inspected = await agentFace.inspect({ target: 'drafts/a.md' }, claude())
    expect(inspected.file).toMatchObject({ path: '_archive/drafts/a.md', archived: true })
    expect(inspected.sections[0]?.data).toMatchObject({ origin: { kind: 'generated' }, basis: [{ path: 'sources/s.md' }] })

    expect(await agentFace.archive({ kind: 'unarchive', path: 'drafts/a.md' }, claude())).toMatchObject({ outcome: 'accepted' })
    expect(section(await check(false), '可能已过期')).toMatchObject([{ path: 'drafts/a.md' }])
  })

  it('records the archive and the return as moves of the same item, not as unowned or missing files', async () => {
    const quiet = await check(true)
    for (const title of ['未登记', '已缺失', '已移动']) expect(section(quiet, title), title).toBeUndefined()
    // The same agent did it, so nothing new from others.
    expect(section(await check(false, as('claude-code', 'other')), '最近动态')).toBeUndefined()
    const lines = section(await check(false, as('codex', 'codex-1')), '最近动态').scenes.flatMap((s: any) => s.facts.map((f: any) => f.text))
    expect(lines).toContain('归档 drafts/a.md')
  })

  it('compares an archived source as usual', async () => {
    expect(await agentFace.archive({ kind: 'archive', path: 'sources/s.md' }, claude())).toMatchObject({ outcome: 'accepted' })
    expect(await agentFace.archive({ kind: 'unarchive', path: 'drafts/a.md' }, claude())).toMatchObject({ outcome: 'accepted' })
    expect(section(await check(false), '可能已过期')).toBeUndefined()
    writeFileSync(join(root, '_archive/sources/s.md'), 'archived source, edited')
    expect(section(await check(false), '可能已过期')).toMatchObject([{ path: 'drafts/a.md', sources: [{ path: '_archive/sources/s.md' }] }])
  })

  it('archiving a file nobody registered enters it, so it is not lost to the ledger', async () => {
    writeFileSync(join(root, 'loose.md'), 'loose')
    expect(await agentFace.archive({ kind: 'archive', path: 'loose.md' }, claude())).toMatchObject({ outcome: 'accepted' })
    const data = (await agentFace.inspect({ target: 'loose.md' }, claude())).sections[0]?.data
    expect(data).toMatchObject({ origin: { kind: 'unknown' }, archived: true, path: '_archive/loose.md' })
    expect(existsSync(join(root, '_archive/loose.md'))).toBe(true)
  })
})
