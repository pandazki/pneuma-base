// What the deploy kit copies out of a thing before a publish: the files storage's manifest names, each
// read into the stage folder and checked against its manifest entry. A stand-in for storage answers
// the manifest and the reads, so a file that changes between the two can be staged on purpose.
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NotStaged, withStaged } from '../src/kit/deploy/content.js'
import type { ContentAnswer, Fingerprint, LibraryPath, PluginStorage, ReadAnswer } from '../src/index.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex') as Fingerprint

/**
 * Storage holding the files of the bundle `site`, which reads `served` instead of what the manifest
 * says where it is given, and answers its manifest a page of `page` files at a time; `fingerprints`,
 * the fingerprint of the whole content on each page.
 */
function storage(files: Record<string, string>, opts: { served?: Record<string, string>; page?: number; fingerprints?: string[] } = {}): PluginStorage {
  const paths = Object.keys(files).sort()
  const page = opts.page ?? paths.length
  let asked = 0
  const content = async (_place: string, o: { manifest?: true | { after?: string } } = {}): Promise<ContentAnswer> => {
    const after = typeof o.manifest === 'object' ? o.manifest.after : undefined
    const from = after === undefined ? 0 : paths.indexOf(after) + 1
    const shown = paths.slice(from, from + page)
    const fingerprint = (opts.fingerprints?.[asked++] ?? 'whole') as Fingerprint
    const more = from + page < paths.length ? { after: shown.at(-1) as string } : null
    return { kind: 'dir', fingerprint, token: 't', files: paths.length, bytes: 0, manifest: { entries: shown.map((p) => ({ path: p, fingerprint: sha(files[p] as string), size: 1 })), more } }
  }
  const read = async (place: string, o: { to?: string } = {}): Promise<ReadAnswer> => {
    const rel = place.slice('site/'.length)
    writeFileSync(o.to as string, opts.served?.[rel] ?? (files[rel] as string))
    return { token: 't', size: 1, offset: 0, length: 1, data: null }
  }
  return { content, read } as unknown as PluginStorage
}

const stageRoot = () => mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-stage-'))

describe('staging a bundle', () => {
  it('copies the files its manifest names, page after page, under their paths, with the manifest’s fingerprint, and leaves no stage behind', async () => {
    const root = stageRoot()
    const files = { 'index.html': '<h1>a</h1>', 'css/site.css': 'h1{}', 'img/logo.svg': '<svg/>' }
    const seen = await withStaged(storage(files, { page: 2 }), 'site' as LibraryPath, 'bundle', root, async (staged) => ({ paths: staged.files.map((f) => f.path), fingerprint: staged.fingerprint }))
    expect(seen).toEqual({ paths: ['css/site.css', 'img/logo.svg', 'index.html'], fingerprint: 'whole' })
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses, as changed, a file whose bytes are not those of its manifest entry, or a manifest whose pages were taken of different content', async () => {
    const changing: [string, PluginStorage][] = [
      ['a file', storage({ 'index.html': '<h1>a</h1>', 'about.html': 'about' }, { served: { 'index.html': '<h1>b</h1>' } })],
      ['the manifest', storage({ 'a.html': 'a', 'b.html': 'b' }, { page: 1, fingerprints: ['first', 'second'] })],
    ]
    for (const [what, store] of changing) {
      await expect(withStaged(store, 'site' as LibraryPath, 'bundle', stageRoot(), async () => 'published'), what).rejects.toThrow(new NotStaged('site 正在修改，未发布'))
    }
  })
})
