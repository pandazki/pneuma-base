// A directory with the marker is one thing (ARCHITECTURE "一个目录算一样东西"): its fingerprint,
// what is left out, and the put table's directory cells at the kernel's own interface.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, BUNDLE_MARKER, bundleManifest, fingerprintOf, fingerprintOfManifest } from '../src/index.js'
import { fixture, tempDir } from './support.js'

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

describe('the fingerprint of a bundle', () => {
  it('is the sha256 of "<path>\\0<sha256 of content>\\n" per counted file, sorted by the UTF-8 bytes of the path', async () => {
    const expected = sha(`css/site.css\0${sha('body{}')}\nindex.html\0${sha('home')}\nz/é.txt\0${sha('e')}\n`)
    expect(await fingerprintOf(tree(SITE))).toBe(expected)
  })

  it('leaves out the marker, .git, node_modules and .DS_Store at any depth', async () => {
    expect(await fingerprintOf(tree({ ...SITE, ...JUNK }))).toBe(await fingerprintOf(tree(SITE)))
    expect((await bundleManifest(tree({ ...SITE, ...JUNK }))).map((e) => e.path)).toEqual(['css/site.css', 'index.html', 'z/é.txt'])
  })

  it('changes when one inner file changes', async () => {
    expect(await fingerprintOf(tree({ ...SITE, 'css/site.css': 'body{color:red}' }))).not.toBe(await fingerprintOf(tree(SITE)))
  })

  it('can be computed from a manifest alone', async () => {
    const dir = tree(SITE)
    expect(fingerprintOfManifest(await bundleManifest(dir))).toBe(await fingerprintOf(dir))
  })

  it('of a single file is the sha256 of its bytes', async () => {
    const dir = tree({ 'a.txt': 'hello' })
    expect(await fingerprintOf(join(dir, 'a.txt'))).toBe(sha('hello'))
  })
})

describe('placing an outside directory', () => {
  const brought = { kind: 'brought', source: null, by: null } as const

  it('leaves no half tree at the target when the copy fails partway', async () => {
    const f = await fixture()
    const source = tree({ 'a.html': 'a', 'b.html': 'b', 'z.html': 'z' })
    chmodSync(join(source, 'b.html'), 0o000)
    try {
      await expect(agentFace.put({ kind: 'place', from: { kind: 'directory', path: source }, to: 'sites/a', origin: brought }, f.ctx)).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(join(source, 'b.html'), 0o644)
    }
    expect(existsSync(join(f.root, 'sites'))).toBe(false)
    // The folder of the marks of puts in progress stays; the failed put's own mark is gone.
    expect(readdirSync(join(f.root, '.pneuma-base/tmp'), { recursive: true })).toEqual(['putting'])
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
