// Freshness: one decision from (path, size, modification time) on disk against what the index
// recorded. Each row of the table, and nothing read that did not change.
import { describe, expect, it } from 'vitest'
import type { LibraryPath } from '@pneuma-base/kernel'
import { freshness, type Stamp } from '../src/fresh.js'

const stamp = (path: string, inner = '', size = 10, modifiedAt = '2026-11-25T08:00:00.000Z'): Stamp => ({ path: path as LibraryPath, inner, size, modifiedAt })

describe('freshness', () => {
  it('reads a file on disk the index does not have', () => {
    expect(freshness([stamp('a.md')], [])).toEqual({ read: [stamp('a.md')], drop: [] })
  })

  it('keeps a file whose size and modification time are what the index recorded', () => {
    expect(freshness([stamp('a.md')], [stamp('a.md')])).toEqual({ read: [], drop: [] })
  })

  it('reads again a file whose size or modification time changed', () => {
    const bigger = stamp('a.md', '', 11)
    const touched = stamp('b.md', '', 10, '2026-11-25T09:00:00.000Z')
    expect(freshness([bigger, touched], [stamp('a.md'), stamp('b.md')])).toEqual({ read: [bigger, touched], drop: [] })
  })

  it('drops what the index has and the disk no longer does', () => {
    expect(freshness([], [stamp('a.md')])).toEqual({ read: [], drop: [{ path: 'a.md', inner: '' }] })
  })

  it('tells files inside a bundle apart by their inner path, and a moved file by its new path', () => {
    const disk = [stamp('sites/a', 'index.html'), stamp('sites/a', 'about.html', 20), stamp('_archive/notes.md')]
    const indexed = [stamp('sites/a', 'index.html'), stamp('sites/a', 'about.html'), stamp('notes.md')]
    expect(freshness(disk, indexed)).toEqual({
      read: [stamp('sites/a', 'about.html', 20), stamp('_archive/notes.md')],
      drop: [{ path: 'notes.md', inner: '' }],
    })
  })
})
