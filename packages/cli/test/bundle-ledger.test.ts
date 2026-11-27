// C2: with the ledger, a bundle has provenance and a basis; a new tree over it keeps the old tree in
// held/ and the owner gets it back byte for byte; registering a folder of files already on record
// absorbs them, so they are not reported missing. Also: a start sentence finds an earlier 下单.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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

const ok = <R extends { code: number; stdout: string; stderr: string }>(r: R): R => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const agent = (args: string[], session = 's1', input = '') =>
  sb.run(['--library', lib, '--as', 'claude-code', '--session', session, ...args], { cwd: outside, input })
const owner = (args: string[]) => sb.run([...args, '--library', lib], { cwd: outside })
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

const OLD = { 'index.html': '<h1>v1</h1>', 'css/site.css': 'body{}', 'img/logo.png': Buffer.from([0, 1, 2, 255]) }

describe('a bundle with the ledger', () => {
  beforeEach(() => {
    ok(agent(['put', '-', '--to', 'sources/brief.md', '--brought', '--source', 'https://example.com/brief'], 's1', 'brief'))
    write(outside, Object.fromEntries(Object.entries(OLD).map(([p, c]) => [`site/${p}`, c])))
    ok(agent(['put', 'site', '--to', 'sites/a', '--made', '--from', 'sources/brief.md']))
  })

  it('has provenance and a basis, and its enter fact says it is a bundle', () => {
    const r = ok(agent(['inspect', 'sites/a', '--json']))
    expect(r.json().file).toMatchObject({ kind: 'bundle', size: null, level: { entries: [{ name: 'css' }, { name: 'img' }, { name: 'index.html' }], more: 0 } })
    expect(ledgerData(r)).toMatchObject({ path: 'sites/a', origin: { kind: 'made' }, basis: [{ path: 'sources/brief.md', state: 'consistent' }] })
    const facts = factsOf(lib).filter((f) => f.scene === 's1')
    expect(facts.filter((f) => f.kind === 'item.enter').map((f) => [f.path, f.bundle ?? false])).toEqual([['sources/brief.md', false], ['sites/a', true]])
  })

  // tmp/run-7 section 5: check compares a directory-thing's token and its first level; an edit
  // deeper inside is for the named deep look, which reads content.
  it('is consistent in check, and an edit in its first level shows the bundle as changed', () => {
    expect(sectionTitles(ok(agent(['check', '--json'])))).toEqual([])
    writeFileSync(join(lib, 'sites/a/index.html'), '<h1>edited by hand</h1>')
    const changed = ok(agent(['check', '--json'])).json().sections.find((s: any) => s.title === '被直接改过的')
    expect(changed.data.shown).toMatchObject([{ path: 'sites/a' }])
  })

  it('a new tree over it keeps the old tree; ledger held restore gives it back byte for byte', () => {
    const old = filesOf(join(lib, 'sites/a'))
    write(outside, { 'site/index.html': '<h1>v2</h1>', 'site/about.html': 'about' })
    rmSync(join(outside, 'site/img'), { recursive: true })
    const r = ok(agent(['put', 'site', '--to', 'sites/a', '--made', '--json']))
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: true })
    expect(r.json().notes.map((n: any) => n.text).join('\n')).toContain('留存')
    expect(Object.keys(filesOf(join(lib, 'sites/a'))).sort()).toEqual(['.pneuma-item', 'about.html', 'css/site.css', 'index.html'])

    expect(ok(owner(['ledger', 'held', 'list'])).stdout).toContain('sites/a')
    ok(owner(['ledger', 'held', 'restore', 'sites/a', '--to', 'restored/a']))
    expect(filesOf(join(lib, 'restored/a'))).toEqual(old)
    const restored = ok(agent(['inspect', 'restored/a', '--json']))
    expect(restored.json().file).toMatchObject({ kind: 'bundle', level: { entries: [{ name: 'css' }, { name: 'img' }, { name: 'index.html' }], more: 0 } })
    expect(ledgerData(restored)).toMatchObject({ origin: { kind: 'brought', by: 'owner' } })
  })

  it('marks the version that was kept, not the one that replaced it', () => {
    write(outside, { 'site/index.html': '<h1>v2</h1>' })
    ok(agent(['put', 'site', '--to', 'sites/a', '--made']))
    const versions = ledgerData(ok(agent(['inspect', 'sites/a', '--json']))).versions.map((v: any) => v.fingerprint.slice(0, 8))
    const text = ok(agent(['inspect', 'sites/a'])).stdout.split('\n')
    const row = (print: string) => text.find((line) => line.trim().startsWith(print)) ?? ''
    expect(row(versions[0])).toContain('留存')
    expect(row(versions[1])).not.toContain('留存')
  })

  it('a made origin naming a file inside it records the bundle as the basis', () => {
    ok(agent(['put', '-', '--to', 'review.md', '--made', '--from', 'sites/a/index.html'], 's1', 'review'))
    expect(ledgerData(ok(agent(['inspect', 'review.md', '--json']))).basis).toMatchObject([{ path: 'sites/a' }])
  })

  // tmp/run-7 section 5: the ledger finds by its records (the path, what was said); text inside a
  // bundle is the search plugin's index. The kernel marks a bundle's hit 目录.
  it('find matches a bundle by its record with the ledger and by the text inside with the search plugin, under its scene with its origin', () => {
    ok(agent(['start', '做早鸟预订页'], 's1'))
    write(outside, { 'landing/index.html': '<h1>桌上只留一块铝</h1>', 'landing/style.css': 'body { color: #222; }' })
    ok(agent(['put', 'landing', '--to', 'sites/landing', '--made']))
    expect(ok(agent(['find', '一块铝'], 's2')).stdout).toBe('没有找到。\n')
    const ledgerOnly = ok(agent(['find', 'landing'], 's2')).stdout
    expect(ledgerOnly).toContain('在做：做早鸟预订页')
    expect(ledgerOnly).toMatch(/sites\/landing\s+目录，做出来的/)

    ok(owner(['plugin', 'add', 'search']))
    // Put before the search plugin was added: its text is indexed once it is registered again.
    ok(agent(['put', join(lib, 'sites/landing'), '--made']))
    const withSearch = ok(agent(['find', '一块铝'], 's2')).stdout
    expect(withSearch).toContain('在做：做早鸟预订页')
    expect(withSearch).toMatch(/sites\/landing\s+目录，做出来的\s+index\.html：.*一块铝/)
  })

  it('with the search plugin, find reaches a bundle’s text past images that sort before it', () => {
    const image = Buffer.alloc(400 * 1024, 0xff)
    write(outside, { 'shop/assets/a.png': image, 'shop/assets/b.png': image, 'shop/assets/c.png': image, 'shop/index.html': '<h1>黄铜镇纸</h1>' })
    ok(owner(['plugin', 'add', 'search']))
    ok(agent(['put', 'shop', '--to', 'sites/shop', '--made']))
    expect(ok(agent(['find', '黄铜镇纸'], 's2')).stdout).toMatch(/sites\/shop\s+目录，做出来的\s+index\.html：.*黄铜镇纸/)
  })
})

// tmp/run-7 section 5: registering a directory that holds registered things registers its loose
// files and leaves it open; the marker is what makes such a directory one thing.
describe('registering a folder whose files are on record, with the marker written', () => {
  beforeEach(() => {
    ok(agent(['put', '-', '--to', 'notes/a.md', '--made'], 's1', 'a'))
    ok(agent(['put', '-', '--to', 'notes/deep/b.md', '--brought'], 's1', 'b'))
    ok(agent(['put', '-', '--to', 'summary.md', '--made', '--from', 'notes/a.md'], 's1', 'summary of a'))
    write(lib, { 'notes/.pneuma-item': '{"format":1}\n' })
    ok(agent(['put', 'notes', '--brought']))
  })

  it('absorbs them: check reports none of them missing or unowned, nothing stale', () => {
    const titles = sectionTitles(ok(agent(['check', '--json'])))
    for (const title of ['不在了的', '没人登记过的', '来源不在', '可能过期']) expect(titles, title).not.toContain(title)
  })

  it('inspecting one says which bundle absorbed it', () => {
    const text = ok(agent(['inspect', 'notes/a.md'])).stdout
    expect(text).toContain('并入了 notes')
    expect(ledgerData(ok(agent(['inspect', 'notes/deep/b.md', '--json'])))).toMatchObject({ state: { kind: 'absorbed' }, absorbedInto: 'notes' })
  })

  it('a file inside the bundle that was never on record is described as part of it', () => {
    write(lib, { 'notes/c.md': 'c' })
    expect(ok(agent(['inspect', 'notes/c.md'])).stdout).toContain('notes 的一部分')
  })

  it('archiving the bundle takes the absorbed items along', () => {
    ok(agent(['archive', 'notes']))
    const titles = sectionTitles(ok(agent(['check', '--include-archived', '--json'])))
    expect(titles).not.toContain('不在了的')
    expect(ok(agent(['inspect', 'notes/a.md'])).stdout).toContain('并入了 _archive/notes')
    const found = (args: string[]) => ok(agent(['find', 'notes', ...args, '--json'])).json().hits.filter((h: any) => h.path === '_archive/notes')
    expect(found([])).toEqual([])
    expect(found(['--include-archived'])[0].detail).toMatch(/^目录，已归档，/)
  })
})

describe('a start sentence', () => {
  it('finds an earlier 下单 from 看看下单进展', () => {
    ok(agent(['start', '跟进下单'], 'earlier'))
    const find = ok(agent(['start', '看看下单进展', '--json'], 'later')).json().find
    expect(find.hits.map((h: any) => h.group ?? h.title).join('\n')).toContain('跟进下单')
  })
})
