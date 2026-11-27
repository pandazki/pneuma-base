// C2: with the ledger, a bundle has provenance and a basis; a new tree over it keeps the old tree in
// held/ and the owner gets it back byte for byte; registering a folder of files already on record
// absorbs them, so they are not reported missing. Each describe makes its library once and its tests
// run on it in order. What the search plugin finds inside a bundle is plugin-search/test/cli.test.ts's.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { factsOf, sandbox, tempDir, type Sandbox } from './helpers.js'

const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const ledgerData = (r: { json: () => any }) => r.json().sections.find((s: any) => s.plugin === 'ledger')?.data
const sectionTitles = (r: { json: () => any }) => r.json().sections.map((s: any) => s.title)

function write(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** Every regular file under `dir`, by relative path, with its bytes. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[relative(dir, path)] = readFileSync(path).toString('base64')
    }
  }
  walk(dir)
  return out
}

/** A library with the ledger (init's default) in a home of its own, and a place outside it. */
function library() {
  const sb: Sandbox = sandbox()
  const lib = join(tempDir(), 'lib')
  const outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
  return {
    lib,
    outside,
    agent: (args: string[], session = 's1', input = '') => sb.run(['--library', lib, '--as', 'claude-code', '--session', session, ...args], { cwd: outside, input }),
    owner: (args: string[]) => sb.run([...args, '--library', lib], { cwd: outside }),
  }
}

const OLD = { 'index.html': '<h1>v1</h1>', 'css/site.css': 'body{}', 'img/logo.png': Buffer.from([0, 1, 2, 255]) }

describe('a bundle with the ledger', () => {
  let l: ReturnType<typeof library>
  beforeAll(() => {
    l = library()
    ok(l.agent(['put', '-', '--to', 'sources/brief.md', '--brought', '--source', 'https://example.com/brief'], 's1', 'brief'))
    write(l.outside, Object.fromEntries(Object.entries(OLD).map(([p, c]) => [`site/${p}`, c])))
    ok(l.agent(['put', 'site', '--to', 'sites/a', '--made', '--from', 'sources/brief.md']))
  })

  it('has provenance and a basis, its enter fact says it is a bundle, and it is the basis of what is made from a file inside it', () => {
    const r = ok(l.agent(['inspect', 'sites/a', '--json']))
    expect(r.json().file).toMatchObject({ kind: 'bundle', size: null, level: { entries: [{ name: 'css' }, { name: 'img' }, { name: 'index.html' }], more: 0 } })
    expect(ledgerData(r)).toMatchObject({ path: 'sites/a', origin: { kind: 'made' }, basis: [{ path: 'sources/brief.md', state: 'consistent' }] })
    const facts = factsOf(l.lib).filter((f) => f.scene === 's1')
    expect(facts.filter((f) => f.kind === 'item.enter').map((f) => [f.path, f.bundle ?? false])).toEqual([['sources/brief.md', false], ['sites/a', true]])

    ok(l.agent(['put', '-', '--to', 'review.md', '--made', '--from', 'sites/a/index.html'], 's1', 'review'))
    expect(ledgerData(ok(l.agent(['inspect', 'review.md', '--json']))).basis).toMatchObject([{ path: 'sites/a' }])
  })

  it('a new tree over it keeps the old tree, marked as the version kept; ledger held restore gives it back byte for byte', () => {
    const old = filesOf(join(l.lib, 'sites/a'))
    write(l.outside, { 'site/index.html': '<h1>v2</h1>', 'site/about.html': 'about' })
    rmSync(join(l.outside, 'site/img'), { recursive: true })
    const r = ok(l.agent(['put', 'site', '--to', 'sites/a', '--made', '--json']))
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(r.json().notes.map((n: any) => n.text).join('\n')).toContain('留存')
    expect(Object.keys(filesOf(join(l.lib, 'sites/a'))).sort()).toEqual(['.pneuma-item', 'about.html', 'css/site.css', 'index.html'])

    // The version that was kept is marked, not the one that replaced it.
    const versions = ledgerData(ok(l.agent(['inspect', 'sites/a', '--json']))).versions.map((v: any) => v.fingerprint.slice(0, 8))
    const text = ok(l.agent(['inspect', 'sites/a'])).stdout.split('\n')
    const row = (print: string) => text.find((line) => line.trim().startsWith(print)) ?? ''
    expect(row(versions[0])).toContain('留存')
    expect(row(versions[1])).not.toContain('留存')

    expect(ok(l.owner(['ledger', 'held', 'list'])).stdout).toContain('sites/a')
    ok(l.owner(['ledger', 'held', 'restore', 'sites/a', '--to', 'restored/a']))
    expect(filesOf(join(l.lib, 'restored/a'))).toEqual(old)
    const restored = ok(l.agent(['inspect', 'restored/a', '--json']))
    expect(restored.json().file).toMatchObject({ kind: 'bundle', level: { entries: [{ name: 'css' }, { name: 'img' }, { name: 'index.html' }], more: 0 } })
    expect(ledgerData(restored)).toMatchObject({ origin: { kind: 'brought', by: 'owner' } })
  })

  // ARCHITECTURE.md「找、看、说、查、归档」: the ledger finds by its records (the path, what was said), not by the text
  // inside a bundle. The kernel marks a bundle's hit 目录.
  it('find matches a bundle by its record with the ledger, under its scene with its origin, and not by the text inside', () => {
    ok(l.agent(['start', '做早鸟预订页'], 's3'))
    write(l.outside, { 'landing/index.html': '<h1>桌上只留一块铝</h1>', 'landing/style.css': 'body { color: #222; }' })
    ok(l.agent(['put', 'landing', '--to', 'sites/landing', '--made'], 's3'))
    expect(ok(l.agent(['find', '一块铝'], 's2')).stdout).toBe('没有找到。\n')
    const found = ok(l.agent(['find', 'landing'], 's2')).stdout
    expect(found).toContain('在做：做早鸟预订页')
    expect(found).toMatch(/sites\/landing\s+目录，做出来的/)
  })

  // ARCHITECTURE.md「每个动作在每种位置上做什么」: check compares a directory-thing's token and its first level; an edit
  // deeper inside is for the named deep look, which reads content.
  it('is consistent in check, and an edit in its first level shows the bundle as changed', () => {
    // Only what was made from a file of the replaced tree may be stale; the bundle itself is in order.
    const quiet = ok(l.agent(['check', '--json'])).json().sections
    expect(quiet.map((s: any) => s.title)).toEqual(['可能过期'])
    expect(JSON.stringify(quiet[0].data)).toContain('review.md')
    writeFileSync(join(l.lib, 'sites/a/index.html'), '<h1>edited by hand</h1>')
    const changed = ok(l.agent(['check', '--json'])).json().sections.find((s: any) => s.title === '被直接改过的')
    expect(changed.data.shown).toMatchObject([{ path: 'sites/a' }])
  })
})

// ARCHITECTURE.md「放」: registering a directory that holds registered things registers its loose
// files and leaves it open; the marker is what makes such a directory one thing.
describe('registering a folder whose files are on record, with the marker written', () => {
  let l: ReturnType<typeof library>
  beforeAll(() => {
    l = library()
    ok(l.agent(['put', '-', '--to', 'notes/a.md', '--made'], 's1', 'a'))
    ok(l.agent(['put', '-', '--to', 'notes/deep/b.md', '--brought'], 's1', 'b'))
    ok(l.agent(['put', '-', '--to', 'summary.md', '--made', '--from', 'notes/a.md'], 's1', 'summary of a'))
    write(l.lib, { 'notes/.pneuma-item': '{"format":1}\n' })
    ok(l.agent(['put', 'notes', '--brought']))
  })

  it('absorbs them: check reports none of them missing or unowned, nothing stale; inspecting one says which bundle absorbed it, and a file never on record is part of it', () => {
    const titles = sectionTitles(ok(l.agent(['check', '--json'])))
    for (const title of ['不在了的', '没人登记过的', '来源不在', '可能过期']) expect(titles, title).not.toContain(title)
    expect(ok(l.agent(['inspect', 'notes/a.md'])).stdout).toContain('并入了 notes')
    expect(ledgerData(ok(l.agent(['inspect', 'notes/deep/b.md', '--json'])))).toMatchObject({ state: { kind: 'absorbed' }, absorbedInto: 'notes' })
    write(l.lib, { 'notes/c.md': 'c' })
    expect(ok(l.agent(['inspect', 'notes/c.md'])).stdout).toContain('notes 的一部分')
  })

  it('archiving the bundle takes the absorbed items along', () => {
    ok(l.agent(['archive', 'notes']))
    const titles = sectionTitles(ok(l.agent(['check', '--include-archived', '--json'])))
    expect(titles).not.toContain('不在了的')
    expect(ok(l.agent(['inspect', 'notes/a.md'])).stdout).toContain('并入了 _archive/notes')
    const found = (args: string[]) => ok(l.agent(['find', 'notes', ...args, '--json'])).json().hits.filter((h: any) => h.path === '_archive/notes')
    expect(found([])).toEqual([])
    expect(found(['--include-archived'])[0].detail).toMatch(/^目录，已归档，/)
  })
})
