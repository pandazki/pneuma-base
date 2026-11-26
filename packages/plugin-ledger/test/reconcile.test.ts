// reconcile: the ledger against a snapshot of the files. ledger-design.md section 4.
import type { Fingerprint, LibraryPath } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { fold } from '../src/fold.js'
import { confirm, reconcile, type Files } from '../src/reconcile.js'
import { basis, enter, f, fp, id, p } from './support.js'

/** A snapshot of files given as path → [size, fingerprint seed]; records which fingerprints were taken. */
function files(entries: Record<string, [number, string]>): Files & { taken: string[] } {
  const taken: string[] = []
  return {
    taken,
    sizes: new Map(Object.entries(entries).map(([path, [size]]) => [path as LibraryPath, size])),
    fingerprint: async (path) => {
      taken.push(path)
      const entry = entries[path]
      if (!entry) throw new Error(`no file ${path}`)
      return fp(entry[1]) as Fingerprint
    },
  }
}

const sized = (item: string, path: string, print: string, size: number, origin?: Parameters<typeof enter>[3]) => ({ ...enter(item, path, print, origin), size })

describe('the state of each item', () => {
  const ledger = fold([
    f(1, sized('i_same', 'same.md', 'a', 1)),
    f(2, sized('i_changed', 'changed.md', 'b', 1)),
    f(3, sized('i_gone', 'gone.md', 'c', 1)),
    f(4, sized('i_moved', 'old/moved.md', 'd', 7)),
    f(5, sized('i_removed', 'removed.md', 'e', 1)),
    f(6, { kind: 'item.remove', item: id('i_removed') }),
  ])

  it('is consistent, changed, moved, missing or removed, and the unowned files are listed', async () => {
    const snapshot = files({ 'same.md': [1, 'a'], 'changed.md': [1, 'b2'], 'new/moved.md': [7, 'd'], 'dropped.md': [3, 'x'] })
    const standing = await reconcile(ledger, snapshot)
    expect(Object.fromEntries(standing.states)).toEqual({
      i_same: { kind: 'consistent' },
      i_changed: { kind: 'changed', now: fp('b2') },
      i_gone: { kind: 'missing' },
      i_moved: { kind: 'moved', to: 'new/moved.md' },
      i_removed: { kind: 'removed' },
    })
    expect(standing.unowned).toEqual(['dropped.md'])
  })

  it('takes fingerprints of unowned files only when their size matches a missing item', async () => {
    const snapshot = files({ 'same.md': [1, 'a'], 'changed.md': [1, 'b'], 'new/moved.md': [7, 'd'], 'big.bin': [999, 'z'] })
    await reconcile(ledger, snapshot)
    expect(snapshot.taken).not.toContain('big.bin')
  })

  it('is missing, not moved, when two unowned files hold its content or two missing items share it', async () => {
    const twoCopies = await reconcile(ledger, files({ 'x/moved.md': [7, 'd'], 'y/moved.md': [7, 'd'] }))
    expect(twoCopies.states.get(id('i_moved'))).toEqual({ kind: 'missing' })
    expect(twoCopies.unowned).toEqual(['x/moved.md', 'y/moved.md'])
    const twins = fold([f(1, sized('i_one', 'one.md', 'd', 7)), f(2, sized('i_two', 'two.md', 'd', 7))])
    const shared = await reconcile(twins, files({ 'three.md': [7, 'd'] }))
    expect([...shared.states.values()]).toEqual([{ kind: 'missing' }, { kind: 'missing' }])
  })
})

describe('an item absorbed into a bundle', () => {
  const ledger = fold([
    f(1, sized('i_a', 'notes/a.md', 'a', 1)),
    f(2, sized('i_d', 'd.md', 'd', 1, { kind: 'made', basis: basis([['i_a', 'a']]) })),
    f(3, { ...sized('i_notes', 'notes', 'n', 1), bundle: true }),
  ])
  /** The snapshot lists the bundle, not the files in it; the fingerprint of a file inside is still taken on demand. */
  const snapshot = (inner: string | null): Files => ({
    sizes: new Map([[p('notes'), 1], [p('d.md'), 1]]),
    fingerprint: async (path) => (path === 'notes' ? fp('n') : path === 'd.md' ? fp('d') : path === 'notes/a.md' && inner !== null ? fp(inner) : null),
  })

  it('is absorbed, not missing, and judged by the content at its path inside the bundle', async () => {
    const same = await reconcile(ledger, snapshot('a'))
    expect(same.states.get(id('i_a'))).toEqual({ kind: 'absorbed', into: 'i_notes', now: fp('a') })
    expect(same.marks.size).toBe(0)
    const edited = await reconcile(ledger, snapshot('a2'))
    expect(edited.marks.get(id('i_d'))).toEqual([{ kind: 'stale', source: 'i_a', recorded: fp('a'), now: fp('a2') }])
  })
})

describe('marks on the basis', () => {
  const made = (rows: [string, string][]) => ({ kind: 'made' as const, basis: basis(rows) })
  const ledger = fold([
    f(1, sized('i_s', 's.md', 's', 1)),
    f(2, sized('i_a', 'a.md', 'a', 1, made([['i_s', 's']]))),
    f(3, sized('i_b', 'b.md', 'b', 1, made([['i_a', 'a']]))),
  ])
  const at = (s: [number, string] | null) => files({ ...(s ? { 's.md': s } : {}), 'a.md': [1, 'a'], 'b.md': [1, 'b'] })

  it('marks a thing stale when a source holds other content now, and its dependents upstream-flagged', async () => {
    const standing = await reconcile(ledger, at([1, 's2']))
    expect(standing.marks.get(id('i_a'))).toEqual([{ kind: 'stale', source: 'i_s', recorded: fp('s'), now: fp('s2') }])
    expect(standing.marks.has(id('i_b'))).toBe(false)
    expect(standing.upstream.get(id('i_b'))).toEqual(['i_a'])
  })

  it('marks the source gone when it is missing', async () => {
    const standing = await reconcile(ledger, at(null))
    expect(standing.marks.get(id('i_a'))).toEqual([{ kind: 'source-gone', source: 'i_s' }])
  })

  it('has no mark once the source holds the recorded content again, or when it only moved', async () => {
    expect((await reconcile(ledger, at([1, 's']))).marks.size).toBe(0)
    const moved = await reconcile(ledger, files({ 'elsewhere/s.md': [1, 's'], 'a.md': [1, 'a'], 'b.md': [1, 'b'] }))
    expect(moved.states.get(id('i_s'))).toEqual({ kind: 'moved', to: p('elsewhere/s.md') })
    expect(moved.marks.size).toBe(0)
  })
})

describe('a standing confirmed against puts', () => {
  const made = (rows: [string, string][]) => ({ kind: 'made' as const, basis: basis(rows) })
  const before = [f(1, sized('i_s', 's.md', 's', 1)), f(2, sized('i_a', 'a.md', 'a', 1, made([['i_s', 's']])))]
  const ledger = fold(before)
  // What the first look saw: a new file, s.md with new content, and a stray nobody put.
  const seen = () => reconcile(ledger, files({ 's.md': [1, 's2'], 'a.md': [1, 'a'], 'new.md': [1, 'n'], 'stray.md': [1, 'x'] }))

  it('keeps every finding when no put is at its path and no fact since names it', async () => {
    const standing = confirm(ledger, await seen(), fold(before), new Set())
    expect(standing.unowned).toEqual(['new.md', 'stray.md'])
    expect(standing.states.get(id('i_s'))).toEqual({ kind: 'changed', now: fp('s2') })
    expect(standing.marks.get(id('i_a'))).toMatchObject([{ kind: 'stale' }])
  })

  it('drops what a put still running explains, and the marks it put on the things made from it', async () => {
    const standing = confirm(ledger, await seen(), fold(before), new Set([p('new.md'), p('s.md')]))
    expect(standing.unowned).toEqual(['stray.md'])
    expect(standing.states.get(id('i_s'))).toEqual({ kind: 'consistent' })
    expect(standing.marks.size).toBe(0)
  })

  it('drops what puts that finished meanwhile explain, even a thing recorded and then moved on', async () => {
    const later = fold([
      ...before,
      f(3, sized('i_n', 'new.md', 'n', 1)),
      f(4, { kind: 'item.move', item: id('i_n'), from: p('new.md'), to: p('moved/new.md'), archive: null }),
      f(5, { kind: 'item.revise', item: id('i_s'), base: fp('s'), fingerprint: fp('s2'), size: 1, held: null, claimed: false }),
    ])
    const standing = confirm(ledger, await seen(), later, new Set())
    expect(standing.unowned).toEqual(['stray.md'])
    expect(standing.states.get(id('i_s'))).toEqual({ kind: 'consistent' })
  })
})
