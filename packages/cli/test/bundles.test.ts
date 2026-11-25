// C1, K1, K2: a directory with the marker is one thing, in a library with no plugin. Each cell the
// put table gained for directories (ARCHITECTURE "放"); find, inspect, move, archive and unarchive
// act on the whole directory; a path inside one is not a target of the agent face.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
})

const agent = (args: string[]) => sb.run(['--library', lib, '--as', 'claude-code', ...args, '--json'], { cwd: outside })

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

const SITE = { 'index.html': '<h1>a</h1>', 'css/site.css': 'body{}', 'img/logo.svg': '<svg/>' }

/** An outside directory holding a small site, with the names a put leaves out. */
function site(name = 'site-a', files: Record<string, string> = SITE): string {
  const dir = join(outside, name)
  write(dir, { ...files, '.git/HEAD': 'ref: main', 'node_modules/x/index.js': 'x', '.DS_Store': 'junk' })
  return dir
}

const refusal = (r: { json: () => any }) => r.json().reason

describe('placing an outside directory', () => {
  it('to a free path: copies the tree without .git, node_modules and .DS_Store, writes the marker, accepts', () => {
    const r = agent(['put', site(), '--to', 'sites/a', '--made'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'sites/a', copied: true, notes: [], problems: [] })
    expect(readdirSync(join(lib, 'sites/a')).sort()).toEqual(['.pneuma-item', 'css', 'img', 'index.html'])
    expect(JSON.parse(readFileSync(join(lib, 'sites/a/.pneuma-item'), 'utf8'))).toEqual({ format: 1 })
    expect(readFileSync(join(lib, 'sites/a/css/site.css'), 'utf8')).toBe('body{}')
  })

  it('a relative directory next to the caller is placed too', () => {
    site('site-b')
    expect(agent(['put', 'site-b', '--to', 'sites/b', '--brought'])).toMatchObject({ code: 0 })
    expect(existsSync(join(lib, 'sites/b/index.html'))).toBe(true)
  })

  it('onto a bundle with the same content: accepted, nothing copied', () => {
    agent(['put', site(), '--to', 'sites/a', '--made'])
    const r = agent(['put', site(), '--to', 'sites/a', '--made'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: false })
  })

  it('onto a bundle with different content and no plugin to keep the old: refused, the tree untouched', () => {
    agent(['put', site(), '--to', 'sites/a', '--made'])
    const r = agent(['put', site('site-a2', { ...SITE, 'index.html': '<h1>new</h1>' }), '--to', 'sites/a', '--made'])
    expect(r.code).toBe(2)
    expect(refusal(r)).toBe('would-overwrite')
    expect(readFileSync(join(lib, 'sites/a/index.html'), 'utf8')).toBe('<h1>a</h1>')
  })

  it('onto a folder without the marker: refused, the folder untouched', () => {
    write(lib, { 'sites/a/mine.md': 'mine' })
    const r = agent(['put', site(), '--to', 'sites/a', '--made'])
    expect(r.code).toBe(2)
    expect(refusal(r)).toBe('would-overwrite')
    expect(readdirSync(join(lib, 'sites/a'))).toEqual(['mine.md'])
  })

  it('onto a file: refused; and a file onto a bundle: refused', () => {
    write(lib, { 'sites/a': 'a file' })
    expect(refusal(agent(['put', site(), '--to', 'sites/a', '--made']))).toBe('would-overwrite')
    expect(readFileSync(join(lib, 'sites/a'), 'utf8')).toBe('a file')
    agent(['put', site(), '--to', 'sites/b', '--made'])
    write(outside, { 'note.md': 'n' })
    expect(refusal(agent(['put', 'note.md', '--to', 'sites/b', '--made']))).toBe('would-overwrite')
    expect(existsSync(join(lib, 'sites/b/index.html'))).toBe(true)
  })
})

describe('a target that is neither a file nor a directory', () => {
  it('is refused for every form of put', () => {
    mkdirSync(join(lib, 'pipes'))
    execFileSync('mkfifo', [join(lib, 'pipes/p')])
    expect(refusal(agent(['put', 'pipes/p', '--brought']))).toBe('no-such-file')
    expect(refusal(agent(['put', site(), '--to', 'pipes/p', '--made']))).toBe('would-overwrite')
    write(outside, { 'note.md': 'n' })
    expect(refusal(agent(['put', 'note.md', '--to', 'pipes/p', '--made']))).toBe('would-overwrite')
  })
})

describe('registering a directory in the library', () => {
  it('without the marker: writes the marker and accepts; it is one thing from then on', () => {
    write(lib, { 'notes/a.md': 'a', 'notes/b.md': 'b' })
    const r = agent(['put', 'notes', '--brought'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'notes', copied: false })
    expect(existsSync(join(lib, 'notes/.pneuma-item'))).toBe(true)
    expect(agent(['find', 'a.md']).json().hits).toEqual([])
  })

  it('that is already a bundle: accepted, nothing changes', () => {
    agent(['put', site(), '--to', 'sites/a', '--made'])
    const before = agent(['inspect', 'sites/a']).json().file.fingerprint
    expect(agent(['put', 'sites/a', '--made']).json()).toMatchObject({ outcome: 'accepted', path: 'sites/a', fingerprint: before })
  })

  it('that is not there: refused, no such file', () => {
    expect(refusal(agent(['put', 'nothing-here', '--brought']))).toBe('no-such-file')
  })
})

describe('a bundle under the other verbs', () => {
  beforeEach(() => {
    expect(agent(['put', site(), '--to', 'sites/a', '--made']).code).toBe(0)
  })

  it('find gives it as one hit and none of the files inside', () => {
    const hits = agent(['find', 'a']).json().hits
    expect(hits).toEqual([{ path: 'sites/a', title: 'a', by: 'kernel', group: null, detail: '目录' }])
    expect(agent(['find', 'logo']).json().hits).toEqual([])
  })

  it('inspect gives kind, file count and fingerprint; the fingerprint changes when one inner file changes', () => {
    const before = agent(['inspect', 'sites/a']).json().file
    expect(before).toMatchObject({ path: 'sites/a', kind: 'bundle', files: 3, size: 22, archived: false })
    writeFileSync(join(lib, 'sites/a/css/site.css'), 'body{color:red}')
    const after = agent(['inspect', 'sites/a']).json().file
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(sb.run(['--library', lib, 'inspect', 'sites/a'], { cwd: outside }).stdout).toContain('目录，3 个文件')
  })

  it('move onto anything already there is refused', () => {
    agent(['put', site('site-b', { 'index.html': 'b' }), '--to', 'sites/b', '--made'])
    write(lib, { 'taken.md': 't' })
    for (const to of ['sites/b', 'taken.md']) expect(refusal(agent(['put', 'sites/a', '--to', to])), to).toBe('would-overwrite')
    expect(readFileSync(join(lib, 'sites/b/index.html'), 'utf8')).toBe('b')
  })

  it('move takes the whole directory; archive and unarchive too', () => {
    expect(agent(['put', 'sites/a', '--to', 'old/a'])).toMatchObject({ code: 0 })
    expect(existsSync(join(lib, 'sites/a'))).toBe(false)
    expect(readFileSync(join(lib, 'old/a/img/logo.svg'), 'utf8')).toBe('<svg/>')

    expect(agent(['archive', 'old/a']).json()).toMatchObject({ outcome: 'accepted', from: 'old/a', to: '_archive/old/a', moved: true })
    expect(existsSync(join(lib, 'old/a'))).toBe(false)
    expect(existsSync(join(lib, '_archive/old/a/.pneuma-item'))).toBe(true)
    expect(agent(['find', 'a']).json().hits).toEqual([])
    expect(agent(['find', 'a', '--include-archived']).json().hits.map((h: any) => [h.path, h.detail])).toEqual([['_archive/old/a', '目录，已归档']])
    expect(agent(['inspect', 'old/a']).json().file).toMatchObject({ path: '_archive/old/a', kind: 'bundle', archived: true })

    expect(agent(['unarchive', 'old/a']).json()).toMatchObject({ outcome: 'accepted', from: '_archive/old/a', to: 'old/a', moved: true })
    expect(readFileSync(join(lib, 'old/a/index.html'), 'utf8')).toBe('<h1>a</h1>')
  })

  it('unarchive is refused when anything holds the original path, a plain folder included', () => {
    agent(['archive', 'sites/a'])
    write(lib, { 'sites/a/other.md': 'o' })
    const r = agent(['unarchive', 'sites/a'])
    expect(r.code).toBe(2)
    expect(refusal(r)).toBe('original-path-taken')
  })

  it('a path inside it is not a target: put, move and archive are refused, the bundle untouched', () => {
    write(outside, { 'page.html': 'p' })
    for (const args of [
      ['put', 'page.html', '--to', 'sites/a/page.html', '--made'],
      ['put', 'sites/a/index.html', '--brought'],
      ['put', 'sites/a/index.html', '--to', 'moved.html'],
      ['archive', 'sites/a/index.html'],
    ]) {
      const r = agent(args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(refusal(r), args.join(' ')).toBe('inside-bundle')
    }
    expect(readdirSync(join(lib, 'sites/a')).sort()).toEqual(['.pneuma-item', 'css', 'img', 'index.html'])
    expect(sb.run(['--library', lib, 'archive', 'sites/a/index.html'], { cwd: outside }).stdout).toContain('sites/a 是一样东西')
  })

  it('a made origin may name a file inside it', () => {
    const r = agent(['put', '-', '--to', 'review.md', '--made', '--from', 'sites/a/index.html'])
    expect(r.code, r.stderr).toBe(0)
  })
})
