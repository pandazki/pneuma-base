// C4 and C8 through the real command line. Most libraries here have only the version plugin, so
// what holds an old version over a put is this plugin and nothing else.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { readTree, sandbox, tempDir, writeTree, type Run, type Sandbox } from './run.js'

let sb: Sandbox
let lib: string
let outside: string

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const agent = (args: string[], input?: string | Buffer) =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const owner = (args: string[], env?: Record<string, string>) => sb.run([...args, '--library', lib], { cwd: outside, ...(env ? { env } : {}) })
const put = (content: string | Buffer, to = 'report.md') => agent(['put', '-', '--to', to, '--made', '--json'], content)
const declare = (...args: string[]) => ok(agent(['say', 'versioned', ...args, '--json'])).json()
const versions = (path: string) => ok(owner(['version', 'list', path, '--json'])).json().data.versions as any[]
const description = () => readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')

/** A library with only the version plugin installed. */
function versionOnly(): void {
  ok(sb.run(['init', lib, '--bare']))
  ok(owner(['plugin', 'add', 'version']))
}

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-v-outside-')
})

describe('not installed (C8)', () => {
  it('say versioned and say version are not heard, with the ledger or with no plugin at all', () => {
    ok(sb.run(['init', lib]))
    ok(put('x', 'a.md'))
    for (const kind of ['versioned', 'version']) {
      const r = agent(['say', kind, 'a.md', '一句话', '--json'])
      expect(r.json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
    }
    const bare = join(tempDir(), 'bare')
    ok(sb.run(['init', bare, '--bare']))
    expect(sb.run(['--library', bare, 'say', 'versioned', 'a.md', '--json'], { cwd: outside }).json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
  })

  it('the description has the version section while the plugin is installed, and not after it is removed', () => {
    ok(sb.run(['init', lib, '--bare']))
    expect(description()).not.toContain('say versioned')
    ok(owner(['plugin', 'add', 'version']))
    expect(description()).toContain('## 版本：留住每一版')
    expect(description()).toContain('say versioned')
    ok(owner(['plugin', 'remove', 'version']))
    expect(description()).not.toContain('## 版本：留住每一版')
    expect(description()).not.toContain('say versioned')
  })
})

describe('versions of a declared thing (C4)', () => {
  beforeEach(versionOnly)

  it('each put of different content adds a version; the same content adds none', () => {
    ok(put('v1'))
    expect(declare('report.md', '第一稿')).toMatchObject({ outcome: 'heard', by: 'version' })
    expect(ok(put('v1')).json()).toMatchObject({ outcome: 'accepted', copied: false })
    expect(versions('report.md')).toHaveLength(1)

    const second = ok(put('v2')).json()
    expect(second).toMatchObject({ outcome: 'accepted', copied: true })
    expect(second.notes.map((n: any) => n.text).join('\n')).toContain('第 2 版')
    expect(readFileSync(join(lib, 'report.md'), 'utf8')).toBe('v2')
    ok(put('v2'))
    expect(versions('report.md').map((v) => [v.n, v.note, v.via])).toEqual([
      [1, '第一稿', 'declare'],
      [2, null, 'put'],
    ])
  })

  it('with no ledger: a declared thing can be overwritten by put, an undeclared one cannot', () => {
    ok(put('mine', 'notes.md'))
    const refused = put('theirs', 'notes.md')
    expect(refused.code).toBe(2)
    expect(refused.json()).toMatchObject({ outcome: 'refused', reason: 'would-overwrite' })
    expect(readFileSync(join(lib, 'notes.md'), 'utf8')).toBe('mine')

    declare('notes.md')
    expect(ok(put('theirs', 'notes.md')).json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(readFileSync(join(lib, 'notes.md'), 'utf8')).toBe('theirs')
  })

  it('a bundle: declared through a path inside it, a new tree is a new version', () => {
    const site = join(outside, 'site')
    writeTree(site, { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' })
    ok(agent(['put', site, '--to', 'sites/a', '--made']))
    expect(declare('sites/a/index.html').note).toContain('sites/a')
    writeTree(site, { 'index.html': '<h1>2</h1>' })
    expect(ok(agent(['put', site, '--to', 'sites/a', '--made', '--json'])).json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(readFileSync(join(lib, 'sites/a/index.html'), 'utf8')).toBe('<h1>2</h1>')
    expect(versions('sites/a').map((v) => [v.n, v.files])).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('put --note records the version description in the same step, and the ledger keeps it on that content, not as a separate note', () => {
    ok(owner(['plugin', 'add', 'ledger']))
    ok(put('v1'))
    declare('report.md', '初稿')
    const second = ok(agent(['put', '-', '--to', 'report.md', '--made', '--note', '按新成本重算早鸟价', '--json'], 'v2')).json()
    expect(second).toMatchObject({ outcome: 'accepted', copied: true })
    expect(second.notes.map((n: any) => n.text).join('\n')).toContain('记为 report.md 的第 2 版：「按新成本重算早鸟价」')
    expect(versions('report.md').map((v) => [v.n, v.note])).toEqual([
      [1, '初稿'],
      [2, '按新成本重算早鸟价'],
    ])
    const inspected = ok(agent(['inspect', 'report.md', '--json'])).json()
    const ledgerData = inspected.sections.find((s: any) => s.plugin === 'ledger').data
    expect(ledgerData.versions.map((v: any) => v.note)).toEqual([null, '按新成本重算早鸟价'])
    expect(ledgerData.said).toEqual([])
  })

  it('say version names the current version', () => {
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    expect(ok(agent(['say', 'version', 'report.md', '换了结论', '--json'])).json()).toMatchObject({ outcome: 'heard' })
    expect(versions('report.md').map((v) => v.note)).toEqual([null, '换了结论'])
    expect(declare('report.md').note).toBe('report.md 早已声明有版本，现在有 2 版。')
    const refused = agent(['say', 'version', 'other.md', '没声明过', '--json'])
    expect(refused.json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
  })

  it('changed outside the tool: check records it as a version and reports it, once', () => {
    ok(put('v1'))
    declare('report.md')
    writeFileSync(join(lib, 'report.md'), 'edited by hand')
    const check = ok(agent(['check', '--json'])).json()
    const section = check.sections.find((s: any) => s.plugin === 'version')
    expect(section.body).toContain('report.md')
    expect(section.body).toContain('第 2 版')
    expect(section.data.recorded).toEqual([{ path: 'report.md', version: 2 }])
    expect(versions('report.md').map((v) => [v.n, v.via])).toEqual([
      [1, 'declare'],
      [2, 'outside'],
    ])
    expect(ok(agent(['check', '--json'])).json().sections.filter((s: any) => s.plugin === 'version')).toEqual([])
  })

  it('a version is exported outside the library with the bytes it had; not into the library, not over a file', () => {
    const OLD = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    ok(put(OLD, 'report.bin'))
    declare('report.bin')
    ok(put('new', 'report.bin'))

    const to = join(outside, 'out', 'v1.bin')
    ok(owner(['version', 'export', 'report.bin', '--version', '1', '--to', to]))
    expect(readFileSync(to)).toEqual(OLD)
    mkdirSync(join(outside, 'dir'))
    ok(owner(['version', 'export', 'report.bin', '--version', '2', '--to', join(outside, 'dir')]))
    expect(readFileSync(join(outside, 'dir', 'report.bin'), 'utf8')).toBe('new')

    const into = owner(['version', 'export', 'report.bin', '--version', '1', '--to', join(lib, 'copy.bin'), '--json'])
    expect(into.code).toBe(2)
    expect(into.json()).toMatchObject({ outcome: 'refused', reason: 'inside-library' })
    expect(existsSync(join(lib, 'copy.bin'))).toBe(false)
    const over = owner(['version', 'export', 'report.bin', '--version', '2', '--to', to, '--json'])
    expect(over.json()).toMatchObject({ outcome: 'refused', reason: 'would-overwrite' })
    expect(readFileSync(to)).toEqual(OLD)
    expect(owner(['version', 'export', 'report.bin', '--version', '9', '--to', join(outside, 'x'), '--json']).json()).toMatchObject({ reason: 'no-such-version' })
  })

  it('an export by one agent is no news in another agent’s check; a restore is', () => {
    ok(owner(['plugin', 'add', 'ledger']))
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    ok(agent(['version', 'export', 'report.md', '--version', '1', '--to', join(outside, 'v1.md')]))
    const since = () => {
      const r = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 's2', 'check', '--json'], { cwd: outside })).json()
      return r.sections.find((s: any) => s.title === '自上次以来')?.body as string
    }
    expect(since()).toContain('report.md 换了新内容')
    expect(since()).not.toContain('version export')
    ok(agent(['version', 'restore', 'report.md', '--version', '1']))
    expect(since()).toContain('执行 version restore')
  })

  it('a bundle version is exported as the tree it had', () => {
    const site = join(outside, 'site')
    writeTree(site, { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' })
    ok(agent(['put', site, '--to', 'sites/a', '--made']))
    declare('sites/a')
    writeTree(site, { 'index.html': '<h1>2</h1>', 'js/b.js': 'b()' })
    ok(agent(['put', site, '--to', 'sites/a', '--made']))
    ok(owner(['version', 'export', 'sites/a', '--version', '1', '--to', join(outside, 'v1')]))
    expect(readTree(join(outside, 'v1'))).toEqual({ 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' })
  })

  it('restore puts an old version back as one more version, through put', () => {
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    ok(owner(['version', 'restore', 'report.md', '--version', '1']))
    expect(readFileSync(join(lib, 'report.md'), 'utf8')).toBe('v1')
    expect(versions('report.md').map((v) => [v.n, v.same])).toEqual([
      [1, null],
      [2, null],
      [3, 1],
    ])
    // Already the content of that version: nothing to do.
    ok(owner(['version', 'restore', 'report.md', '--version', '3']))
    expect(versions('report.md')).toHaveLength(3)
  })

  it('a restore is a put every other plugin sees: the put event comes before the restore event', () => {
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    ok(sb.runWithTestPlugins(['plugin', 'add', 'recorder', '--library', lib], { cwd: outside }))
    const log = join(lib, '.pneuma-base/recorder/events.jsonl')
    const before = readFileSync(log, 'utf8').split('\n').filter(Boolean).length
    ok(sb.runWithTestPlugins(['version', 'restore', 'report.md', '--version', '1', '--library', lib], { cwd: outside }))
    const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l))
    expect(events).toEqual([
      { face: 'agent', what: 'put', outcome: 'accepted' },
      { face: 'owner', what: 'version restore', outcome: 'done' },
    ])
  })

  it('restores a bundle version as the whole tree', () => {
    const site = join(outside, 'site')
    writeTree(site, { 'index.html': '<h1>1</h1>' })
    ok(agent(['put', site, '--to', 'sites/a', '--made']))
    declare('sites/a')
    writeTree(site, { 'index.html': '<h1>2</h1>', 'extra.txt': 'e' })
    ok(agent(['put', site, '--to', 'sites/a', '--made']))
    ok(owner(['version', 'restore', 'sites/a', '--version', '1']))
    expect(readTree(join(lib, 'sites/a'), ['.pneuma-item'])).toEqual({ 'index.html': '<h1>1</h1>' })
    expect(versions('sites/a')).toHaveLength(3)
  })

  it('follows a move, an archive and an unarchive', () => {
    ok(put('v1'))
    declare('report.md')
    ok(agent(['put', 'report.md', '--to', 'docs/report.md']))
    expect(versions('docs/report.md')).toHaveLength(1)
    expect(owner(['version', 'list', 'report.md', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-versioned' })

    ok(agent(['archive', 'docs/report.md']))
    const inspected = ok(agent(['inspect', 'docs/report.md', '--json'])).json()
    expect(inspected.sections.find((s: any) => s.plugin === 'version').data.path).toBe('_archive/docs/report.md')
    ok(agent(['unarchive', 'docs/report.md']))
    expect(ok(put('v2', 'docs/report.md')).json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(versions('docs/report.md')).toHaveLength(2)
  })

  it('agents export through a grant; prune is refused to them and without confirmation', () => {
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    ok(owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    ok(sb.run(['@claude', 'version', 'export', 'report.md', '--version', '1', '--to', join(outside, 'a.md')], { cwd: outside }))
    expect(readFileSync(join(outside, 'a.md'), 'utf8')).toBe('v1')

    const viaGrant = sb.run(['@claude', 'version', 'prune', 'report.md', '--keep', '1'], { cwd: outside })
    expect(viaGrant.code).toBe(2)
    expect(viaGrant.stdout).toContain('agent-session')
    expect(owner(['version', 'prune', 'report.md', '--keep', '1'], { CLAUDE_CODE_SESSION_ID: 'x' }).stdout).toContain('agent-session')
    expect(owner(['version', 'prune', 'report.md', '--keep', '1']).stdout).toContain('not-confirmed')
    expect(versions('report.md').map((v) => v.pruned)).toEqual([false, false])
  })

  it('a restore goes through the kernel gate: an agent with a read-only grant cannot write', () => {
    ok(put('v1'))
    declare('report.md')
    ok(put('v2'))
    ok(owner(['grant', 'issue', 'reader', '--agent', 'claude-code', '--read-only']))
    const r = sb.run(['@reader', 'version', 'restore', 'report.md', '--version', '1', '--json'], { cwd: outside })
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'outside-grant' })
    expect(readFileSync(join(lib, 'report.md'), 'utf8')).toBe('v2')
    expect(versions('report.md')).toHaveLength(2)
  })

  it('stores the same content once, across versions and across things, as files written once', () => {
    ok(put('same', 'a.md'))
    ok(put('same', 'b.md'))
    declare('a.md')
    declare('b.md')
    ok(put('other', 'a.md'))
    ok(put('same', 'a.md'))
    expect(versions('a.md')).toHaveLength(3)

    const dir = join(lib, '.pneuma-base/version')
    const files = Object.keys(readTree(dir))
    expect(files.filter((f) => f.startsWith('objects/'))).toHaveLength(2)
    for (const file of files) expect(file).toMatch(/^(objects\/[0-9a-f]{2}\/[0-9a-f]{64}|facts\/s1\/\d+-[0-9a-f]{8}\.jsonl)$/)
    expect(readdirSync(lib).sort()).toEqual(['.pneuma-base', 'PNEUMA-BASE.md', 'a.md', 'b.md'])
  })
})
