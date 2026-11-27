// A directory with the marker is one thing (ARCHITECTURE "一个目录算一样东西"): its fingerprint,
// what is left out, and the put table's directory cells at the kernel's own interface: a path inside
// a bundle, a directory placed onto what is there, a target of another kind, a bundle moved whole.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, BUNDLE_MARKER, fingerprintOfManifest, type ArchiveResult, type LibraryPath, type PutResult } from '../src/index.js'
import { storageOf } from '../src/storage.js'
import { fingerprintOf } from '../src/things.js'
import { fixture, outsideFile, tempDir } from './support.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function tree(files: Record<string, string>): string {
  const dir = join(tempDir('pb-k-tree-'), 'site')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const SITE = { 'index.html': 'home', 'css/site.css': 'body{}', 'z/é.txt': 'e', [BUNDLE_MARKER]: '{"format":1}\n' }
const JUNK = { '.git/HEAD': 'ref', 'node_modules/x/index.js': 'x', '.DS_Store': 'ds', 'css/.DS_Store': 'ds', 'sub/.git': 'gitdir: ..' }

/** The fingerprint storage gives of the thing at `path` in a fresh library holding `files` under `site/`. */
async function printOf(files: Record<string, string>, path = 'site'): Promise<string | undefined> {
  const f = await fixture()
  for (const [p, content] of Object.entries(files)) f.write(`site/${p}`, content)
  return (await fingerprintOf(storageOf(f.root), path as LibraryPath))?.fingerprint
}

describe('the fingerprint of a bundle, as storage reads it when asked', () => {
  it('is the sha256 of "<path>\\0<sha256 of content>\\n" per counted file, sorted by the UTF-8 bytes of the path', async () => {
    const expected = sha(`css/site.css\0${sha('body{}')}\nindex.html\0${sha('home')}\nz/é.txt\0${sha('e')}\n`)
    expect(await printOf(SITE)).toBe(expected)
  })

  it('leaves out the marker, the noise at any depth, and what its .gitignore excludes', async () => {
    expect(await printOf({ ...SITE, ...JUNK })).toBe(await printOf(SITE))
    expect(await printOf({ ...SITE, '.gitignore': 'build/\n', 'build/out.js': 'o' })).toBe(await printOf({ ...SITE, '.gitignore': 'build/\n' }))
  })

  it('is what the kernel computes from a manifest alone', async () => {
    const manifest = [{ path: 'index.html', fingerprint: sha('home') }, { path: 'css/site.css', fingerprint: sha('body{}') }, { path: 'z/é.txt', fingerprint: sha('e') }]
    expect(fingerprintOfManifest(manifest as never)).toBe(await printOf(SITE))
  })

  it('of a single file is the sha256 of its bytes', async () => {
    expect(await printOf({ 'a.txt': 'hello' }, 'site/a.txt')).toBe(sha('hello'))
  })
})

describe('placing an outside directory', () => {
  const brought = { kind: 'brought', source: null, by: null } as const

  it('leaves no half tree at the target when the copy fails partway', async () => {
    const f = await fixture()
    const source = tree({ 'a.html': 'a', 'b.html': 'b', 'z.html': 'z' })
    chmodSync(join(source, 'b.html'), 0o000)
    try {
      await expect(agentFace.put({ kind: 'place', from: { kind: 'directory', path: source }, to: 'sites/a', origin: brought }, f.ctx)).rejects.toThrow(/unreadable/)
    } finally {
      chmodSync(join(source, 'b.html'), 0o644)
    }
    // Storage writes all of it or none of it.
    expect(existsSync(join(f.root, 'sites', 'a'))).toBe(false)
  })

  it('copies the tree without the left-out names and writes the marker', async () => {
    const f = await fixture()
    const source = tree({ 'index.html': 'home', ...JUNK })
    const r = await agentFace.put({ kind: 'place', from: { kind: 'directory', path: source }, to: 'sites/a', origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'accepted', path: 'sites/a', copied: true, fingerprint: sha(`index.html\0${sha('home')}\n`) })
    expect(f.read('sites/a/index.html')).toBe('home')
    expect(JSON.parse(f.read(`sites/a/${BUNDLE_MARKER}`))).toEqual({ format: 1 })
    for (const junk of Object.keys(JUNK)) expect(existsSync(join(f.root, 'sites/a', junk)), junk).toBe(false)
    expect(readFileSync(join(source, '.git/HEAD'), 'utf8')).toBe('ref')
  })

  it('refuses a directory source that holds the library', async () => {
    const f = await fixture()
    const r = await agentFace.put({ kind: 'place', from: { kind: 'directory', path: dirname(f.root) }, to: 'copy', origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'refused', reason: 'outside-library' })
  })
})

describe('a bundle in the put table', () => {
  const brought = { kind: 'brought', source: null, by: null } as const
  const reason = (r: PutResult | ArchiveResult) => (r.outcome === 'refused' ? r.reason : 'accepted')
  /** A library holding the bundle sites/a. */
  async function withSite() {
    const f = await fixture()
    for (const [path, content] of Object.entries({ [BUNDLE_MARKER]: '{"format":1}\n', 'index.html': '<h1>a</h1>', 'css/site.css': 'body{}' })) f.write(`sites/a/${path}`, content)
    return f
  }

  it('a path inside a bundle is no target: register, place, move and archive are refused, the bundle untouched; a made origin may name a file inside it', async () => {
    const f = await withSite()
    const from = { kind: 'file', path: outsideFile('p') } as const
    expect(reason(await agentFace.put({ kind: 'register', path: 'sites/a/index.html', origin: brought }, f.ctx))).toBe('inside-bundle')
    expect(reason(await agentFace.put({ kind: 'place', from, to: 'sites/a/page.html', origin: brought }, f.ctx))).toBe('inside-bundle')
    expect(reason(await agentFace.put({ kind: 'move', from: 'sites/a/index.html', to: 'moved.html' }, f.ctx))).toBe('inside-bundle')
    expect(reason(await agentFace.archive({ kind: 'archive', path: 'sites/a/index.html' }, f.ctx))).toBe('inside-bundle')
    expect(readdirSync(join(f.root, 'sites/a')).sort()).toEqual([BUNDLE_MARKER, 'css', 'index.html'])
    const made = { kind: 'made' as const, from: ['sites/a/index.html'], outside: [] }
    expect(reason(await agentFace.put({ kind: 'place', from, to: 'review.md', origin: made }, f.ctx))).toBe('accepted')
  })

  it('with no plugin to keep the old, a directory placed onto a bundle is refused, even with the same content; so is one onto a folder without the marker or onto a file, and a file onto a bundle', async () => {
    const f = await withSite()
    const dir = (files: Record<string, string>) => ({ kind: 'directory', path: tree(files) }) as const
    const place = async (from: { kind: 'directory' | 'file'; path: string }, to: string) => reason(await agentFace.put({ kind: 'place', from, to, origin: brought }, f.ctx))
    expect(await place(dir({ 'index.html': '<h1>a</h1>', 'css/site.css': 'body{}' }), 'sites/a')).toBe('would-overwrite')
    expect(await place(dir({ 'index.html': '<h1>new</h1>' }), 'sites/a')).toBe('would-overwrite')
    f.write('plain/mine.md', 'mine')
    expect(await place(dir({ 'index.html': 'x' }), 'plain')).toBe('would-overwrite')
    f.write('file', 'a file')
    expect(await place(dir({ 'index.html': 'x' }), 'file')).toBe('would-overwrite')
    expect(await place({ kind: 'file', path: outsideFile('n') }, 'sites/a')).toBe('would-overwrite')
    expect(f.read('sites/a/index.html')).toBe('<h1>a</h1>')
    expect(readdirSync(join(f.root, 'plain'))).toEqual(['mine.md'])
    expect(f.read('file')).toBe('a file')
  })

  it('a target that is neither a file nor a directory is refused for every form of put', async () => {
    const f = await fixture()
    mkdirSync(join(f.root, 'pipes'))
    execFileSync('mkfifo', [join(f.root, 'pipes/p')])
    expect(reason(await agentFace.put({ kind: 'register', path: 'pipes/p', origin: brought }, f.ctx))).toBe('no-such-file')
    expect(reason(await agentFace.put({ kind: 'place', from: { kind: 'directory', path: tree({ 'index.html': 'x' }) }, to: 'pipes/p', origin: brought }, f.ctx))).toBe('would-overwrite')
    expect(reason(await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('n') }, to: 'pipes/p', origin: brought }, f.ctx))).toBe('would-overwrite')
  })

  it('a bundle moves whole, is refused a move onto anything already there, gives its fingerprint only when its content is asked for, and is not taken back while a plain folder holds its path', async () => {
    const f = await withSite()
    f.write(`sites/b/${BUNDLE_MARKER}`, '{"format":1}\n')
    f.write('sites/b/index.html', 'b')
    f.write('taken.md', 't')
    for (const to of ['sites/b', 'taken.md']) expect(reason(await agentFace.put({ kind: 'move', from: 'sites/a', to }, f.ctx)), to).toBe('would-overwrite')
    expect(reason(await agentFace.put({ kind: 'move', from: 'sites/a', to: 'old/a' }, f.ctx))).toBe('accepted')
    expect(f.read('old/a/css/site.css')).toBe('body{}')
    expect(existsSync(join(f.root, 'sites/a'))).toBe(false)
    expect((await agentFace.inspect({ target: 'old/a' }, f.ctx)).file).toMatchObject({ kind: 'bundle', fingerprint: null })
    expect((await agentFace.inspect({ target: 'old/a', content: { file: null } }, f.ctx)).file?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(reason(await agentFace.archive({ kind: 'archive', path: 'old/a' }, f.ctx))).toBe('accepted')
    f.write('old/a/other.md', 'o')
    expect(reason(await agentFace.archive({ kind: 'unarchive', path: 'old/a' }, f.ctx))).toBe('original-path-taken')
  })
})
