// The rows the ledger keeps (state.ts) say what the full fold of the facts says (fold.ts), however the
// facts arrive: all at once, a few at a time, or each one alone, and with a batch seen twice.
// tmp/run-7 architecture.md section 7: state is rows derived incrementally from the facts.
import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/facts.js'
import { fold } from '../src/fold.js'
import { emptyState, foldInto, liveItems, mayBeNews, newsKey, type LedgerState } from '../src/state.js'
import { basis, codex, enter, f, fp, id, p } from './support.js'

const made = (rows: [string, string][]) => ({ kind: 'made' as const, basis: basis(rows) })

/** A history with every kind of fact that changes an item, in three scenes and two actors. */
const HISTORY: Fact[] = [
  f(1, { kind: 'said', flavor: 'doing', text: '整理支付资料', about: null }),
  f(2, enter('i_s', 'notes/s.md', 's')),
  f(3, enter('i_a', 'notes/deep/a.md', 'a', made([['i_s', 's']]))),
  f(4, enter('i_x', 'loose.md', 'x', { kind: 'adopted' })),
  f(5, { kind: 'item.revise', item: id('i_s'), base: fp('s'), fingerprint: fp('s2'), size: 2, held: null, claimed: true }),
  f(6, { kind: 'item.move', item: id('i_a'), from: p('notes/deep/a.md'), to: p('made/a.md'), archive: null }, { scene: 's2', actor: codex }),
  // An enter at the path an item holds is an alias of it, and gives it the origin it lacked.
  f(7, enter('i_x2', 'loose.md', 'x', { kind: 'brought', source: 'https://example.com/x', by: 'owner' }), { scene: 's2', actor: codex }),
  f(8, { kind: 'item.basis', item: id('i_x2'), fingerprint: fp('x'), basis: basis([['i_s', 's2']]) }, { scene: 's2', actor: codex }),
  f(9, { kind: 'said', flavor: 'note', text: '这是对比表', about: id('i_a') }, { scene: 's2', actor: codex }),
  f(10, { kind: 'items.enter', items: [{ item: id('i_r1'), path: p('inbox/r1.md'), fingerprint: fp('r1'), size: 1 }, { item: id('i_r2'), path: p('inbox/r2.md'), fingerprint: fp('r2'), size: 1 }], origin: { kind: 'brought', source: null, by: 'owner' } }, { scene: 's3' }),
  // A directory registered as one thing around files on record absorbs them.
  f(11, { ...enter('i_b', 'notes', 'b'), bundle: true }, { scene: 's3' }),
  f(12, { kind: 'item.remove', item: id('i_r2') }, { scene: 's3' }),
  f(13, { kind: 'item.move', item: id('i_r1'), from: p('inbox/r1.md'), to: p('_archive/inbox/r1.md'), archive: 'in' }, { scene: 's3' }),
  f(14, { kind: 'unowned.left', paths: [p('stray.md')] }, { scene: 's3' }),
  f(15, { kind: 'owner.op', command: 'grant issue', summary: '已发', destructive: false }, { scene: 's3' }),
]

/** What both say about each item: where it is, whether it counts, what it holds and was made from. */
function itemsOfFold(facts: Fact[]) {
  const ledger = fold(facts)
  return new Map(
    [...ledger.items.values()].map((i) => [
      i.id,
      { path: i.path, removed: i.removed, absorbedInto: i.absorbedInto, fingerprint: i.fingerprint, origin: i.origin.kind, unknownOrigin: i.unknownOrigin, basis: i.basis.items.map((b) => b.item) },
    ]),
  )
}

function itemsOfRows(state: LedgerState) {
  return new Map(
    [...state.items.values()].map((i) => [
      i.id,
      { path: i.path, removed: i.removed, absorbedInto: i.absorbedInto, fingerprint: i.fingerprint, origin: i.origin.kind, unknownOrigin: i.unknownOrigin, basis: i.basis.items.map((b) => b.item) },
    ]),
  )
}

/** The facts folded into fresh rows in batches of `size`, each batch after the ones before. */
function inBatches(facts: Fact[], size: number): LedgerState {
  const state = emptyState()
  const seen = new Set<string>()
  for (let i = 0; i < facts.length; i += size) {
    const batch = facts.slice(i, i + size)
    foldInto(state, batch, seen)
    for (const fact of batch) seen.add(fact.id)
  }
  return state
}

describe('the rows against the full fold', () => {
  const expected = itemsOfFold(HISTORY)

  for (const size of [HISTORY.length, 4, 1]) {
    it(`agree on every item when the facts come ${size === 1 ? 'one at a time' : `${size} at a time`}`, () => {
      const state = inBatches(HISTORY, size)
      expect(itemsOfRows(state)).toEqual(expected)
      // The paths each counting item holds, and the open directories: every directory above one of them.
      const live = liveItems(state)
      expect(new Map([...state.paths].filter(([, item]) => live.some((i) => i.id === item)))).toEqual(new Map(live.map((i) => [i.path, i.id])))
      const above = new Map<string, number>()
      for (const item of live) {
        const parts = item.path.split('/')
        for (let n = 1; n < parts.length; n++) above.set(parts.slice(0, n).join('/'), (above.get(parts.slice(0, n).join('/')) ?? 0) + 1)
      }
      expect(new Map([...state.dirs].filter(([, n]) => n > 0))).toEqual(above)
      expect([...state.left]).toEqual(['stray.md'])
    })
  }

  it('fold a fact already seen once only', () => {
    const state = inBatches(HISTORY, HISTORY.length)
    const again = foldInto(state, HISTORY.slice(4, 8), new Set(HISTORY.map((x) => x.id)))
    expect(itemsOfRows(state)).toEqual(expected)
    expect(again.rows.news ?? []).toEqual([])
  })

  it('keep the scenes with what was said and the owner’s operations, and the news newest first', () => {
    const state = emptyState()
    const folded = foldInto(state, HISTORY, new Set())
    expect([...state.scenes.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(state.scenes.get('s1' as never)?.said.map((s) => s.text)).toEqual(['整理支付资料'])
    expect(state.scenes.get('s3' as never)?.ops.map((o) => o.command)).toEqual(['grant issue'])
    // Storage gives rows in key order, so the news read from the first key are the latest first.
    const news = HISTORY.filter(mayBeNews)
    const keys = (folded.rows.news ?? []).map((r) => r.key).sort()
    expect(keys).toHaveLength(news.length)
    expect(keys[0]).toBe(newsKey(news.at(-1) as Fact))
    expect(keys.at(-1)).toBe(newsKey(news[0] as Fact))
  })
})
