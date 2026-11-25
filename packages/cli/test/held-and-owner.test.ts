// C6: putting different content at a path keeps the old content; the owner gets it back with the
// same bytes; the agent face has no delete. C7: owner operations show up in an agent's check;
// destructive owner commands are refused in an agent session and without in-person confirmation.
// C15 with the ledger: an archived item stays out of the stale lists, its origin still readable.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const agent = (args: string[], input?: string | Buffer, session = 's1') =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', session, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const owner = (args: string[], env?: Record<string, string>) => sb.run([...args, '--library', lib], { cwd: outside, ...(env ? { env } : {}) })
const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const sections = (r: { json: () => any }) => r.json().sections as { title: string; body: string; data: any }[]
const section = (list: { title: string; data: any }[], title: string) => list.find((s) => s.title === title)?.data

const OLD = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
const NEW = Buffer.from('the new version\n')

describe('a new version over an old one (C6)', () => {
  beforeEach(() => {
    ok(agent(['put', '-', '--to', 'report.bin', '--made'], OLD))
    writeFileSync(join(outside, 'report.bin'), NEW)
  })

  it('replaces the file and keeps the old bytes, and inspect shows both versions', () => {
    const r = ok(agent(['put', 'report.bin', '--to', 'report.bin', '--made', '--json']))
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(r.json().notes.map((n: any) => n.text).join('\n')).toContain('留存')
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(NEW)
    const data = sections(ok(agent(['inspect', 'report.bin', '--json'])))[0]?.data
    expect(data.versions).toHaveLength(2)
    expect(data.held).toHaveLength(1)
    expect(readFileSync(join(lib, data.held[0]))).toEqual(OLD)
  })

  it('held list shows it; held restore gives the owner the same bytes at a new path, and refuses to overwrite', () => {
    ok(agent(['put', 'report.bin', '--to', 'report.bin', '--made']))
    const list = ok(owner(['held', 'list']))
    expect(list.stdout).toContain('report.bin')
    const refusedOver = owner(['held', 'restore', 'report.bin', '--to', 'report.bin'])
    expect(refusedOver.code).toBe(2)
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(NEW)

    ok(owner(['held', 'restore', 'report.bin', '--to', 'restored/report.bin']))
    expect(readFileSync(join(lib, 'restored/report.bin'))).toEqual(OLD)
    const restored = sections(ok(agent(['inspect', 'restored/report.bin', '--json'])))[0]?.data
    expect(restored.origin).toMatchObject({ kind: 'brought', by: 'owner' })
  })

  it('a put over a file nobody registered keeps that file too', () => {
    writeFileSync(join(lib, 'dropped.md'), 'by hand')
    writeFileSync(join(outside, 'dropped.md'), 'by the agent')
    ok(agent(['put', 'dropped.md', '--to', 'dropped.md', '--made']))
    const data = sections(ok(agent(['inspect', 'dropped.md', '--json'])))[0]?.data
    expect(readFileSync(join(lib, data.held[0]), 'utf8')).toBe('by hand')
  })

  it('the agent face has no delete', () => {
    for (const verb of ['delete', 'rm', 'remove']) {
      const r = agent([verb, 'report.bin'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('不认识的命令')
    }
    expect(ok(sb.run(['--help'])).stdout).not.toMatch(/delete|删除/)
    expect(readFileSync(join(lib, 'report.bin'))).toEqual(OLD)
  })

  it('held drop is refused in an agent session, through a grant, and without in-person confirmation', () => {
    ok(agent(['put', 'report.bin', '--to', 'report.bin', '--made']))
    const heldDir = join(lib, '.pneuma-base/ledger/held')
    for (const variable of ['PNEUMA_BASE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
      const r = owner(['held', 'drop'], { [variable]: 'x' })
      expect(r.code).toBe(2)
      expect(r.stdout).toContain('agent-session')
    }
    ok(owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    expect(sb.run(['@claude', 'held', 'drop'], { cwd: outside }).stdout).toContain('agent-session')
    const unconfirmed = owner(['held', 'drop'])
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.stdout).toContain('not-confirmed')
    expect(readdirSync(heldDir)).toHaveLength(1)
  })
})

describe('owner operations (C7)', () => {
  it('appear in an agent’s check after its last visit when they change the content or the capabilities', () => {
    ok(agent(['start', '整理资料']))
    const withTest = (args: string[]) => ok(sb.runWithTestPlugins([...args, '--library', lib], { cwd: outside }))
    withTest(['plugin', 'add', 'recorder'])
    withTest(['grant', 'issue', 'helper', '--agent', 'codex'])
    withTest(['grant', 'revoke', 'helper'])
    withTest(['plugin', 'remove', 'recorder'])

    const r = ok(agent(['check', '--json'], undefined, 's2'))
    const since = section(sections(r), '自上次以来')
    const ops = since.scenes.flatMap((s: any) => s.facts).filter((f: any) => f.kind === 'owner.op').map((f: any) => f.text)
    expect(ops).toHaveLength(2)
    for (const [i, command] of ['plugin add', 'plugin remove'].entries()) expect(ops[i]).toContain(command)
    const text = ok(agent(['check'], undefined, 's3')).stdout
    expect(text).toMatch(/^场景 adhoc-owner-\d{4}-\d\d-\d\d · 主人/m)
    expect(text).toContain('主人面的操作 plugin remove')
    expect(text).not.toContain('grant')
  })

  it('omits setup commands that ran before an agent’s first visit, while keeping content and online state changes', () => {
    const deployDir = join(tempDir('pb-www-'), 'www')
    const syncDir = tempDir('pb-sync-')
    for (const name of ['version', 'deploy', 'sync', 'search']) ok(owner(['plugin', 'add', name]))
    ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', deployDir]))
    ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', syncDir]))
    ok(owner(['search', 'embedder', 'set', '--kind', 'hash']))
    ok(owner(['search', 'embedder', 'clear']))

    writeFileSync(join(outside, 'brief.md'), 'brief\n')
    ok(agent(['put', 'brief.md', '--to', 'brief.md', '--brought'], undefined, 'claude-1'))
    ok(agent(['say', 'deployable', 'brief.md'], undefined, 'claude-1'))
    ok(owner(['deploy', 'on', 'brief.md']))

    // A brand-new agent arriving via start or check sees the put, say and deploy on, not the prior setup noise.
    const started = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 'codex-1', 'start', '接着做'], { cwd: outside })).stdout
    for (const setupOp of ['plugin add', 'deploy target set', 'sync target set', 'search embedder set', 'search embedder clear']) {
      expect(started).not.toContain(setupOp)
    }
    expect(started).toContain('放入 brief.md')
    expect(started).toContain('主人面的操作 deploy on')

    const firstCheck = ok(sb.run(['--library', lib, '--as', 'antigravity', '--session', 'agy-1', 'check'], { cwd: outside })).stdout
    for (const setupOp of ['plugin add', 'deploy target set', 'sync target set', 'search embedder set', 'search embedder clear']) {
      expect(firstCheck).not.toContain(setupOp)
    }
    expect(firstCheck).toContain('主人面的操作 deploy on')

    // Explicit --since asks for everything since that moment, including setup operations.
    const explicit = ok(sb.run(['--library', lib, '--as', 'antigravity', '--session', 'agy-1', 'check', '--since', '2000-01-01T00:00:00Z'], { cwd: outside })).stdout
    expect(explicit).toContain('主人面的操作 plugin add')
    expect(explicit).toContain('主人面的操作 deploy target set')

    // Once codex has visited, a later setup change by the owner IS news on codex's next visit.
    ok(owner(['search', 'embedder', 'set', '--kind', 'hash']))
    const returning = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 'codex-2', 'check'], { cwd: outside })).stdout
    expect(returning).toContain('主人面的操作 search embedder set')
  })
})

describe('archive with the ledger (C15)', () => {
  beforeEach(() => {
    ok(agent(['put', '-', '--to', 'sources/s.md', '--brought', '--source', 'https://example.com/s'], 'source'))
    ok(agent(['put', '-', '--to', 'drafts/a.md', '--made', '--from', 'sources/s.md'], 'draft from s'))
    ok(agent(['archive', 'drafts/a.md']))
  })

  it('keeps an archived item out of the stale list by default, in with the switch; its origin stays readable', () => {
    writeFileSync(join(lib, 'sources/s.md'), 'source, edited')
    expect(section(sections(ok(agent(['check', '--json']))), '可能过期')).toBeUndefined()
    expect(section(sections(ok(agent(['check', '--include-archived', '--json']))), '可能过期')).toMatchObject([{ path: '_archive/drafts/a.md' }])

    const text = ok(agent(['inspect', 'drafts/a.md'])).stdout
    for (const readable of ['做出来的', 'claude-code', '已归档', 'sources/s.md']) expect(text).toContain(readable)

    ok(agent(['unarchive', 'drafts/a.md']))
    expect(section(sections(ok(agent(['check', '--json']))), '可能过期')).toMatchObject([{ path: 'drafts/a.md' }])
  })

  it('records the archive and the return as moves of the same item, not as unowned or missing files', () => {
    const quiet = sections(ok(agent(['check', '--include-archived', '--json'])))
    for (const title of ['没人登记过的', '不在了的', '挪过的']) expect(section(quiet, title), title).toBeUndefined()
    const later = section(sections(ok(agent(['check', '--json'], undefined, 'other'))), '自上次以来')
    expect(later).toBeUndefined() // the same agent did it, so nothing new from others
    const codexSees = sb.run(['--library', lib, '--as', 'codex', 'check', '--json'], { cwd: outside }).json()
    const lines = section(codexSees.sections, '自上次以来').scenes.flatMap((s: any) => s.facts.map((f: any) => f.text))
    expect(lines).toContain('归档 drafts/a.md')
  })

  it('compares an archived source as usual', () => {
    ok(agent(['archive', 'sources/s.md']))
    ok(agent(['unarchive', 'drafts/a.md']))
    expect(section(sections(ok(agent(['check', '--json']))), '可能过期')).toBeUndefined()
    writeFileSync(join(lib, '_archive/sources/s.md'), 'archived source, edited')
    expect(section(sections(ok(agent(['check', '--json']))), '可能过期')).toMatchObject([{ path: 'drafts/a.md', sources: [{ path: '_archive/sources/s.md' }] }])
  })

  it('find leaves an archived item out by default and brings it in with the switch', () => {
    const paths = (args: string[]) => ok(agent(['find', 'draft', ...args, '--json'])).json().hits.filter((h: any) => h.by === 'ledger').map((h: any) => h.path)
    expect(paths([])).toEqual([])
    expect(paths(['--include-archived'])).toEqual(['_archive/drafts/a.md'])
  })

  it('archiving a file nobody registered enters it, so it is not lost to the ledger', () => {
    writeFileSync(join(lib, 'loose.md'), 'loose')
    ok(agent(['archive', 'loose.md']))
    const data = sections(ok(agent(['inspect', 'loose.md', '--json'])))[0]?.data
    expect(data).toMatchObject({ origin: { kind: 'adopted' }, archived: true, path: '_archive/loose.md' })
    expect(existsSync(join(lib, '_archive/loose.md'))).toBe(true)
  })
})
