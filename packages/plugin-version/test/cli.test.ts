// C4 through the real command line. Two libraries are made once for the file, one with only the version
// plugin (so what holds an old version over a put is this plugin and nothing else) and one with the ledger
// beside it; each test works under its own paths. A library a test changes for good gets its own.
// Without the plugin, say versioned is heard by nobody (packages/cli/test/bare-library.test.ts) and the
// description has no version section (packages/cli/test/description.test.ts).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { readTree, sandbox, tempDir, writeTree, type Run, type Sandbox } from './run.js'

let sb: Sandbox
let outside: string

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

/** A library with these plugins; `testPlugins`: every call through the command line that also has the test-only plugins. */
function library(plugins: string[], testPlugins = false) {
  const lib = join(tempDir(), 'lib')
  const exec = testPlugins ? sb.runWithTestPlugins : sb.run
  ok(exec(['init', lib, '--bare']))
  const owner = (args: string[], env?: Record<string, string>) => exec([...args, '--library', lib], { cwd: outside, ...(env ? { env } : {}) })
  for (const plugin of plugins) ok(owner(['plugin', 'enable', plugin]))
  const agent = (args: string[], input?: string | Buffer) =>
    exec(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
  return {
    lib,
    owner,
    agent,
    put: (content: string | Buffer, to: string) => agent(['put', '-', '--to', to, '--generated', '--json'], content),
    declare: (...args: string[]) => ok(agent(['say', 'versioned', ...args, '--json'])).json(),
    versions: (path: string) => ok(owner(['version', 'list', path, '--json'])).json().data.versions as any[],
    text: (path: string) => readFileSync(join(lib, path), 'utf8'),
  }
}

type Library = ReturnType<typeof library>
let plain: Library
let ledgered: Library

beforeAll(() => {
  sb = sandbox()
  outside = tempDir('pb-v-outside-')
  plain = library(['version'])
  ledgered = library(['version', 'ledger'])
})

describe('versions of a declared thing (C4)', () => {
  it('with no ledger, an undeclared thing cannot be overwritten; once declared, each put of different content adds a version and the same content adds none', () => {
    const { put, declare, versions, text } = plain
    ok(put('mine', 'a/notes.md'))
    const refused = put('theirs', 'a/notes.md')
    expect(refused.code).toBe(2)
    expect(refused.json()).toMatchObject({ outcome: 'refused', reason: 'would-overwrite' })
    expect(text('a/notes.md')).toBe('mine')

    expect(declare('a/notes.md', '第一稿')).toMatchObject({ outcome: 'heard', by: 'version' })
    expect(ok(put('mine', 'a/notes.md')).json()).toMatchObject({ outcome: 'accepted', copied: false })
    expect(versions('a/notes.md')).toHaveLength(1)
    const second = ok(put('theirs', 'a/notes.md')).json()
    expect(second).toMatchObject({ outcome: 'accepted', copied: true })
    expect(second.notes.map((n: any) => n.text).join('\n')).toContain('版本 2')
    expect(text('a/notes.md')).toBe('theirs')
    ok(put('theirs', 'a/notes.md'))
    expect(versions('a/notes.md').map((v) => [v.n, v.note, v.via])).toEqual([
      [1, '第一稿', 'declare'],
      [2, null, 'put'],
    ])
  })

  it('a bundle: declared through a path inside it, each new tree a version, exported and restored as the whole tree it had', () => {
    const { lib, agent, owner, declare, versions } = plain
    const site = join(outside, 'b-site')
    const V1 = { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' }
    writeTree(site, V1)
    ok(agent(['put', site, '--to', 'b/site', '--generated']))
    expect(declare('b/site/index.html').note).toContain('b/site')
    writeTree(site, { 'index.html': '<h1>2</h1>', 'js/b.js': 'b()' })
    expect(ok(agent(['put', site, '--to', 'b/site', '--generated', '--json'])).json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(readFileSync(join(lib, 'b/site/index.html'), 'utf8')).toBe('<h1>2</h1>')
    expect(versions('b/site').map((v) => [v.n, v.files])).toEqual([
      [1, 2],
      [2, 3],
    ])
    ok(owner(['version', 'export', 'b/site', '--version', '1', '--to', join(outside, 'b-v1')]))
    expect(readTree(join(outside, 'b-v1'))).toEqual(V1)
    ok(owner(['version', 'restore', 'b/site', '--version', '1']))
    expect(readTree(join(lib, 'b/site'), ['.pneuma-item'])).toEqual(V1)
    expect(versions('b/site')).toHaveLength(3)
  })

  it('an export by one agent is no news in another agent’s check; a restore is', () => {
    const { lib, agent, put, declare } = ledgered
    ok(put('v1', 'f/report.md'))
    declare('f/report.md')
    ok(put('v2', 'f/report.md'))
    ok(agent(['version', 'export', 'f/report.md', '--version', '1', '--to', join(outside, 'f-v1.md')]))
    const since = () => {
      const r = ok(sb.run(['--library', lib, '--as', 'codex', '--session', 's2', 'check', '--json'], { cwd: outside })).json()
      return r.sections.find((s: any) => s.title === '最近动态')?.body as string
    }
    const first = since()
    expect(first).toContain('生成 f/report.md')
    expect(first).toContain('f/report.md 内容已更新')
    expect(first).not.toContain('version export')
    ok(agent(['version', 'restore', 'f/report.md', '--version', '1']))
    // That check was a look: the next one has the restore, and only what came after the look.
    const next = since()
    expect(next).toContain('pneuma-base version restore')
    expect(next).not.toContain('生成 f/report.md')
  })

  it('put --note records the version description in the same step, and the ledger keeps it on that content, not as a separate note', () => {
    const { agent, put, declare, versions } = ledgered
    ok(put('v1', 'c/report.md'))
    declare('c/report.md', '初稿')
    const second = ok(agent(['put', '-', '--to', 'c/report.md', '--generated', '--note', '按新成本重算早鸟价', '--json'], 'v2')).json()
    expect(second).toMatchObject({ outcome: 'accepted', copied: true })
    expect(second.notes.map((n: any) => n.text).join('\n')).toContain('已记录为 c/report.md 的版本 2：「按新成本重算早鸟价」')
    expect(versions('c/report.md').map((v) => [v.n, v.note])).toEqual([
      [1, '初稿'],
      [2, '按新成本重算早鸟价'],
    ])
    const inspected = ok(agent(['inspect', 'c/report.md', '--json'])).json()
    const ledgerData = inspected.sections.find((s: any) => s.plugin === 'ledger').data
    expect(ledgerData.versions.map((v: any) => v.note)).toEqual([null, '按新成本重算早鸟价'])
    expect(ledgerData.said).toEqual([])
  })

  it('say version names the current version', () => {
    const { agent, put, declare, versions } = plain
    ok(put('v1', 's/report.md'))
    declare('s/report.md')
    ok(put('v2', 's/report.md'))
    expect(ok(agent(['say', 'version', 's/report.md', '换了结论', '--json'])).json()).toMatchObject({ outcome: 'heard' })
    expect(versions('s/report.md').map((v) => v.note)).toEqual([null, '换了结论'])
    expect(declare('s/report.md').note).toBe('s/report.md 已启用版本管理，当前共 2 个版本。')
    expect(agent(['say', 'version', 's/other.md', '没声明过', '--json']).json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
  })

  it('changed outside the tool: check records a file as a version and reports it, once; a change deep inside a bundle, its top level unchanged, waits for check --deep on its directory', () => {
    const { lib, agent, put, declare, versions } = plain
    const versionSection = (args: string[]) => ok(agent(['check', ...args, '--json'])).json().sections.find((s: any) => s.plugin === 'version')
    ok(put('v1', 'd/report.md'))
    declare('d/report.md')
    const site = join(outside, 'd-site')
    writeTree(site, { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' })
    ok(agent(['put', site, '--to', 'd/site', '--generated']))
    declare('d/site')
    writeFileSync(join(lib, 'd/report.md'), 'edited by hand')
    writeFileSync(join(lib, 'd/site/css/a.css'), 'a{color:red}')

    const section = versionSection([])
    expect(section.body).toContain('d/report.md')
    expect(section.body).toContain('版本 2')
    expect(section.data.recorded).toEqual([{ path: 'd/report.md', version: 2 }])
    expect(versions('d/report.md').map((v) => [v.n, v.via])).toEqual([
      [1, 'declare'],
      [2, 'outside'],
    ])
    expect(versionSection([])).toBeUndefined()
    expect(versions('d/site')).toHaveLength(1)

    expect(versionSection(['--deep', 'elsewhere'])).toBeUndefined()
    expect(versionSection(['--deep', 'd']).data.recorded).toEqual([{ path: 'd/site', version: 2 }])
    expect(versions('d/site').map((v) => [v.n, v.via])).toEqual([
      [1, 'declare'],
      [2, 'outside'],
    ])
    expect(versionSection(['--deep'])).toBeUndefined()
  })

  it('a version is exported outside the library with the bytes it had; not into the library, not over a file', () => {
    const { lib, owner, put, declare } = plain
    const OLD = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    ok(put(OLD, 'e/report.bin'))
    declare('e/report.bin')
    ok(put('new', 'e/report.bin'))

    const to = join(outside, 'e-out', 'v1.bin')
    ok(owner(['version', 'export', 'e/report.bin', '--version', '1', '--to', to]))
    expect(readFileSync(to)).toEqual(OLD)
    mkdirSync(join(outside, 'e-dir'))
    ok(owner(['version', 'export', 'e/report.bin', '--version', '2', '--to', join(outside, 'e-dir')]))
    expect(readFileSync(join(outside, 'e-dir', 'report.bin'), 'utf8')).toBe('new')

    const into = owner(['version', 'export', 'e/report.bin', '--version', '1', '--to', join(lib, 'copy.bin'), '--json'])
    expect(into.code).toBe(2)
    expect(into.json()).toMatchObject({ outcome: 'refused', reason: 'inside-library' })
    expect(existsSync(join(lib, 'copy.bin'))).toBe(false)
    const over = owner(['version', 'export', 'e/report.bin', '--version', '2', '--to', to, '--json'])
    expect(over.json()).toMatchObject({ outcome: 'refused', reason: 'would-overwrite' })
    expect(readFileSync(to)).toEqual(OLD)
    expect(owner(['version', 'export', 'e/report.bin', '--version', '9', '--to', join(outside, 'e-x'), '--json']).json()).toMatchObject({ reason: 'no-such-version' })
  })

  it('a hand edit deep inside a bundle is kept as a version when a put replaces it', () => {
    const { lib, agent, owner, declare, versions } = plain
    const site = join(outside, 'g-site')
    writeTree(site, { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' })
    ok(agent(['put', site, '--to', 'g/site', '--generated']))
    declare('g/site')
    writeFileSync(join(lib, 'g/site/css/a.css'), 'a{color:red}')
    writeTree(site, { 'index.html': '<h1>2</h1>' })
    ok(agent(['put', site, '--to', 'g/site', '--generated']))
    expect(versions('g/site').map((v) => [v.n, v.via])).toEqual([
      [1, 'declare'],
      [2, 'outside'],
      [3, 'put'],
    ])
    ok(owner(['version', 'export', 'g/site', '--version', '2', '--to', join(outside, 'g-v2')]))
    expect(readTree(join(outside, 'g-v2'))).toEqual({ 'index.html': '<h1>1</h1>', 'css/a.css': 'a{color:red}' })
  })

  it('restore puts an old version back as one more version, through a put every other plugin sees before the restore; the current content again is nothing to do', () => {
    // The recorder stays in this library's configuration, so it is a library of its own.
    const { lib, owner, put, declare, versions, text } = library(['version', 'recorder'], true)
    ok(put('v1', 'report.md'))
    declare('report.md')
    ok(put('v2', 'report.md'))
    const log = join(lib, '.pneuma-base/recorder/events.jsonl')
    const before = readFileSync(log, 'utf8').split('\n').filter(Boolean).length
    ok(owner(['version', 'restore', 'report.md', '--version', '1']))
    const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l))
    expect(events).toEqual([
      { face: 'agent', what: 'put', outcome: 'accepted' },
      { face: 'owner', what: 'version restore', outcome: 'done' },
    ])
    expect(text('report.md')).toBe('v1')
    expect(versions('report.md').map((v) => [v.n, v.same])).toEqual([
      [1, null],
      [2, null],
      [3, 1],
    ])
    ok(owner(['version', 'restore', 'report.md', '--version', '3']))
    expect(versions('report.md')).toHaveLength(3)
  })

  it('follows a move, an archive and an unarchive', () => {
    const { agent, owner, put, declare, versions } = plain
    ok(put('v1', 'i/report.md'))
    declare('i/report.md')
    ok(agent(['put', 'i/report.md', '--to', 'i/docs/report.md']))
    expect(versions('i/docs/report.md')).toHaveLength(1)
    expect(owner(['version', 'list', 'i/report.md', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-versioned' })

    ok(agent(['archive', 'i/docs/report.md']))
    const inspected = ok(agent(['inspect', 'i/docs/report.md', '--json'])).json()
    expect(inspected.sections.find((s: any) => s.plugin === 'version').data.path).toBe('_archive/i/docs/report.md')
    ok(agent(['unarchive', 'i/docs/report.md']))
    expect(ok(put('v2', 'i/docs/report.md')).json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(versions('i/docs/report.md')).toHaveLength(2)
  })

  it('agents export through a grant; prune is refused to them and without confirmation; a restore through a read-only grant is refused at the kernel gate', () => {
    const { owner, put, declare, versions, text } = plain
    ok(put('v1', 'j/report.md'))
    declare('j/report.md')
    ok(put('v2', 'j/report.md'))
    ok(owner(['grant', 'create', 'claude', '--agent', 'claude-code']))
    ok(sb.run(['@claude', 'version', 'export', 'j/report.md', '--version', '1', '--to', join(outside, 'j-a.md')], { cwd: outside }))
    expect(readFileSync(join(outside, 'j-a.md'), 'utf8')).toBe('v1')

    const viaGrant = sb.run(['@claude', 'version', 'prune', 'j/report.md', '--keep', '1'], { cwd: outside })
    expect(viaGrant.code).toBe(2)
    expect(viaGrant.stdout).toContain('agent-session')
    expect(owner(['version', 'prune', 'j/report.md', '--keep', '1'], { CLAUDE_CODE_SESSION_ID: 'x' }).stdout).toContain('agent-session')
    expect(owner(['version', 'prune', 'j/report.md', '--keep', '1']).stdout).toContain('not-confirmed')
    expect(versions('j/report.md').map((v) => v.pruned)).toEqual([false, false])

    ok(owner(['grant', 'create', 'reader', '--agent', 'claude-code', '--read-only']))
    const r = sb.run(['@reader', 'version', 'restore', 'j/report.md', '--version', '1', '--json'], { cwd: outside })
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'outside-grant' })
    expect(text('j/report.md')).toBe('v2')
    expect(versions('j/report.md')).toHaveLength(2)
  })

  it('versions the plugin wrote before storage still list, export and restore: facts under facts/<scene>/, a directory version as one object per file', () => {
    // The old facts name report.md and sites/a, so this is a library of its own.
    const { lib, agent, owner, put, versions, text } = library(['version'])
    const sha = (content: string) => createHash('sha256').update(content).digest('hex')
    const tree = (files: Record<string, string>) => {
      const rows = Object.entries(files)
        .map(([path, content]) => ({ path, fingerprint: sha(content), size: Buffer.byteLength(content) }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      return { rows, fingerprint: sha(rows.map((r) => `${r.path}\0${r.fingerprint}\n`).join('')) }
    }
    const V1 = { 'index.html': '<h1>1</h1>', 'css/a.css': 'a{}' }
    const V2 = { 'index.html': '<h1>2</h1>' }
    ok(put('v2', 'report.md'))
    const site = join(outside, 'k-site')
    writeTree(site, V2)
    ok(agent(['put', site, '--to', 'sites/a', '--generated']))

    const dir = join(lib, '.pneuma-base/version')
    for (const content of ['v1', 'v2', ...Object.values(V1), ...Object.values(V2)]) writeTree(dir, { [`objects/${sha(content).slice(0, 2)}/${sha(content)}`]: content })
    const by = { kind: 'agent', name: 'claude-code' }
    let n = 0
    const f = (body: object) => ({ id: `f_20261125000000000_aaaaaa_${String(n++).padStart(4, '0')}`, at: '2026-11-25T00:00:00.000Z', scene: 's1', by, ...body })
    const file = (content: string, via: string) => ({ kind: 'version', thing: 't_report', path: 'report.md', fingerprint: sha(content), manifest: { kind: 'file', rows: [{ path: '', fingerprint: sha(content), size: content.length }] }, via })
    const bundle = (files: Record<string, string>, via: string) => {
      const { rows, fingerprint } = tree(files)
      return { kind: 'version', thing: 't_site', path: 'sites/a', fingerprint, manifest: { kind: 'bundle', rows }, via }
    }
    const facts = [
      f({ kind: 'declare', thing: 't_report', path: 'report.md' }),
      f(file('v1', 'declare')),
      f({ kind: 'note', thing: 't_report', version: 'f_20261125000000000_aaaaaa_0001', text: '初稿' }),
      f(file('v2', 'put')),
      f({ kind: 'declare', thing: 't_site', path: 'sites/a' }),
      f(bundle(V1, 'declare')),
      f(bundle(V2, 'put')),
    ]
    writeTree(dir, { 'facts/s1/20261125000000000-0a1b2c3d.jsonl': facts.map((x) => `${JSON.stringify(x)}\n`).join('') })

    const list = ok(owner(['version', 'list', 'sites/a', '--json'])).json().data
    expect(list.state).toBe('current')
    expect(list.versions.map((v: any) => [v.n, v.files])).toEqual([
      [1, 2],
      [2, 1],
    ])
    expect(versions('report.md').map((v) => [v.n, v.note])).toEqual([
      [1, '初稿'],
      [2, null],
    ])
    ok(owner(['version', 'export', 'sites/a', '--version', '1', '--to', join(outside, 'k-v1')]))
    expect(readTree(join(outside, 'k-v1'))).toEqual(V1)
    ok(owner(['version', 'export', 'report.md', '--version', '1', '--to', join(outside, 'k-r1.md')]))
    expect(readFileSync(join(outside, 'k-r1.md'), 'utf8')).toBe('v1')

    ok(owner(['version', 'restore', 'sites/a', '--version', '1']))
    expect(readTree(join(lib, 'sites/a'), ['.pneuma-item'])).toEqual(V1)
    expect(versions('sites/a').map((v) => [v.n, v.same])).toEqual([
      [1, null],
      [2, null],
      [3, 1],
    ])
    ok(owner(['version', 'restore', 'report.md', '--version', '1']))
    expect(text('report.md')).toBe('v1')
    expect(versions('report.md').map((v) => v.same)).toEqual([null, null, 1])
  })
})
