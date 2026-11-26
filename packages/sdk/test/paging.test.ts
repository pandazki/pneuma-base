// Pages of a long list: where a page stands is in the view's parameters, and its links name the pages
// on either side, so a page can be opened from the address and walked back the way it came.
import { describe, expect, it } from 'vitest'
import { pageAt, pageOfList, pagingOf, rowsOf, PAGE_ROWS, TEXT_ROWS } from '../src/index.js'

describe('a page of a long list', () => {
  it('holds 50 rows on the page, 20 in the text form, and never more than a thousand', () => {
    expect([PAGE_ROWS, TEXT_ROWS]).toEqual([50, 20])
    expect([rowsOf({}), rowsOf({ size: 20 }), rowsOf({ size: 0 }), rowsOf({ size: 5000 })]).toEqual([50, 20, 50, 1000])
  })

  it('on the first page has no way back, and its next page starts after the cursor the listing gave', () => {
    const p = pagingOf({ view: 'files', params: { dir: 'notes' }, rows: 50, shown: 50, next: 'n050.md', total: 120 })
    expect(p).toEqual({ first: 1, shown: 50, total: 120, prev: null, next: { view: 'files', params: { dir: 'notes', after: 'n050.md' }, target: 'main' } })
  })

  it('past the second page carries the cursors before it, so its previous page is the one it came from', () => {
    const second = { dir: 'notes', after: 'n050.md' }
    const p2 = pagingOf({ view: 'files', params: second, rows: 50, shown: 50, next: 'n100.md', total: 120 })
    expect(p2.first).toBe(51)
    expect(p2.prev?.params).toEqual({ dir: 'notes' })
    expect(p2.next?.params).toEqual({ dir: 'notes', after: 'n100.md', back: '["n050.md"]' })
    const p3 = pagingOf({ view: 'files', params: p2.next?.params ?? {}, rows: 50, shown: 20, next: null, total: 120 })
    expect([p3.first, p3.next, p3.prev?.params]).toEqual([101, null, second])
  })

  it('says at least how many when the count stopped short, and never fewer than it shows', () => {
    expect(pagingOf({ view: 'v', params: {}, rows: 20, shown: 20, next: 'k', total: 21, atLeast: true })).toMatchObject({ total: 21, atLeast: true })
    expect(pagingOf({ view: 'v', params: { after: 'k' }, rows: 20, shown: 20, next: null, total: 0 }).total).toBe(40)
  })

  it('of one list among several on a view pages under its own name, leaving the others where they stand', () => {
    const params = { path: 'notes/a.md', 'history.after': '50', 'history.back': '[]' }
    expect(pageAt(params, 'history.')).toEqual({ after: '50', back: [] })
    expect(pageAt(params, 'basis.')).toEqual({ after: undefined, back: [] })
    const p = pagingOf({ view: 'item', params, rows: 50, shown: 3, next: '50', total: 53, target: 'panel', name: 'basis.' })
    expect(p.next).toEqual({ view: 'item', params: { ...params, 'basis.after': '50' }, target: 'panel' })
  })

  it('of a list held whole is cut by position', () => {
    const all = Array.from({ length: 53 }, (_, i) => i)
    expect(pageOfList(all, {}, 50)).toEqual({ rows: all.slice(0, 50), next: '50' })
    expect(pageOfList(all, { 'h.after': '50' }, 50, 'h.')).toEqual({ rows: [50, 51, 52], next: null })
  })

  it('reads a cursor list that is not a list of strings as none', () => {
    expect(pageAt({ after: 'b', back: 'not json' })).toEqual({ after: 'b', back: [] })
    expect(pageAt({ after: 'b', back: '[1,2]' })).toEqual({ after: 'b', back: [] })
    expect(pageAt({ back: '["a"]' })).toEqual({ after: undefined, back: [] })
  })
})
