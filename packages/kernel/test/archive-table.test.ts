// C2, C15, K1, K9: the archive totalization table (ARCHITECTURE "归档"), one test per cell.
// The kernel distinguishes four states of a path: in neither area, only in the main area, only in
// _archive/, and in both. "已在归档区" in the architecture table splits into the last two.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, ownerFace, type ArchiveResult, type GrantId } from '../src/index.js'
import { fixture } from './support.js'

const fp8 = { new: '11507a0e' } // sha256('new')

function outcome(r: ArchiveResult) {
  return r.outcome === 'refused' ? r.reason : { from: r.from, to: r.to, moved: r.moved }
}

describe('archive', () => {
  it('path in neither area: refused, no such file', async () => {
    const f = await fixture()
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx))).toBe('no-such-file')
  })

  it('path in the main area: moved into _archive/ under the same relative path', async () => {
    const f = await fixture()
    f.write('d/a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'd/a.md' }, f.ctx))).toEqual({ from: 'd/a.md', to: '_archive/d/a.md', moved: true })
    expect(f.read('_archive/d/a.md')).toBe('a')
    expect(existsSync(join(f.root, 'd/a.md'))).toBe(false)
  })

  it('archive already holds different content at that path: the newcomer gets the first eight of its fingerprint', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'old')
    f.write('a.md', 'new')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx))).toEqual({ from: 'a.md', to: `_archive/a.${fp8.new}.md`, moved: true })
    expect(f.read('_archive/a.md')).toBe('old')
    expect(f.read(`_archive/a.${fp8.new}.md`)).toBe('new')
  })

  it('archive already holds the same content at that path: moved, nothing lost', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'same')
    f.write('a.md', 'same')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx))).toEqual({ from: 'a.md', to: '_archive/a.md', moved: true })
    expect(f.read('_archive/a.md')).toBe('same')
  })

  it('path only in _archive/: accepted, nothing moves', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx))).toEqual({ from: 'a.md', to: '_archive/a.md', moved: false })
    expect(outcome(await agentFace.archive({ kind: 'archive', path: '_archive/a.md' }, f.ctx))).toEqual({ from: 'a.md', to: '_archive/a.md', moved: false })
    expect(f.read('_archive/a.md')).toBe('a')
  })

  it('outside the library, on kernel files, or outside the grant: refused', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: '../a.md' }, f.ctx))).toBe('outside-library')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'PNEUMA-BASE.md' }, f.ctx))).toBe('outside-library')
    expect(outcome(await agentFace.archive({ kind: 'archive', path: '.pneuma-base/config.json' }, f.ctx))).toBe('outside-library')
    const r = await ownerFace.dispatch(
      { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => false },
      'grant issue',
      { positional: ['claude'], flags: { agent: ['claude-code'], area: ['work'] } },
    )
    if (r.outcome !== 'done') throw new Error(r.text)
    await f.reopen({ kind: 'agent', name: 'claude-code', grant: (r.data as { grant: { id: GrantId } }).grant.id })
    expect(outcome(await agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx))).toBe('outside-grant')
  })
})

describe('unarchive', () => {
  it('path in neither area: refused, no such file', async () => {
    const f = await fixture()
    expect(outcome(await agentFace.archive({ kind: 'unarchive', path: 'a.md' }, f.ctx))).toBe('no-such-file')
  })

  it('path only in the main area: accepted, nothing moves', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'unarchive', path: 'a.md' }, f.ctx))).toEqual({ from: 'a.md', to: 'a.md', moved: false })
    expect(f.read('a.md')).toBe('a')
  })

  it('path only in _archive/, original free: moved back', async () => {
    const f = await fixture()
    f.write('_archive/d/a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'unarchive', path: 'd/a.md' }, f.ctx))).toEqual({ from: '_archive/d/a.md', to: 'd/a.md', moved: true })
    expect(f.read('d/a.md')).toBe('a')
    expect(existsSync(join(f.root, '_archive/d/a.md'))).toBe(false)
  })

  it('accepts the archived path itself', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'a')
    expect(outcome(await agentFace.archive({ kind: 'unarchive', path: '_archive/a.md' }, f.ctx))).toEqual({ from: '_archive/a.md', to: 'a.md', moved: true })
  })

  it('path in both areas, original taken: refused, both untouched', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'old')
    f.write('a.md', 'current')
    expect(outcome(await agentFace.archive({ kind: 'unarchive', path: 'a.md' }, f.ctx))).toBe('original-path-taken')
    expect(f.read('_archive/a.md')).toBe('old')
    expect(f.read('a.md')).toBe('current')
  })
})
