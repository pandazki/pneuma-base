// fold is a pure function of the facts: the ledger rows "each item has exactly one enter" and
// "the view is decided by the files and the facts alone", and ledger-design.md section 3.
import { describe, expect, it } from 'vitest'
import { fold } from '../src/fold.js'
import { basis, codex, enter, f, fp, id, p } from './support.js'

describe('fold', () => {
  it('gives the same ledger whatever order the facts come in', () => {
    const facts = [
      f(1, enter('i_s', 's.md', 's')),
      f(2, enter('i_a', 'a.md', 'a', { kind: 'made', basis: basis([['i_s', 's']]) })),
      f(3, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('b.md'), archive: null }),
      f(4, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('a2'), size: 2, held: null, claimed: false }),
      f(5, { kind: 'said', flavor: 'note', text: 'n', about: id('i_a') }),
    ]
    const forward = fold(facts)
    const backward = fold([...facts].reverse())
    expect(backward.items).toEqual(forward.items)
    expect(backward.pathIndex).toEqual(forward.pathIndex)
    expect(backward.facts).toEqual(forward.facts)
  })

  it('takes the current path from the latest enter or move, and the fingerprint from the latest enter or revise', () => {
    const ledger = fold([
      f(1, enter('i_a', 'a.md', 'a')),
      f(2, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('d/a.md'), archive: null }),
      f(3, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('b'), size: 1, held: null, claimed: true }),
    ])
    expect(ledger.items.get(id('i_a'))).toMatchObject({ path: 'd/a.md', fingerprint: fp('b') })
    expect(ledger.pathIndex).toEqual(new Map([[p('d/a.md'), id('i_a')]]))
    expect(ledger.items.get(id('i_a'))?.versions.map((v) => [v.fingerprint, v.claimed])).toEqual([[fp('a'), false], [fp('b'), true]])
  })

  it('makes a later enter of a path an item holds an alias, so the item has one enter and every fact lands on it', () => {
    const ledger = fold([
      f(1, enter('i_one', 'shared.md', 's', { kind: 'adopted' })),
      f(2, enter('i_two', 'shared.md', 's', { kind: 'adopted' }), { scene: 's2', actor: codex }),
      f(3, enter('i_b', 'b.md', 'b', { kind: 'made', basis: basis([['i_two', 's']]) }), { scene: 's2', actor: codex }),
      f(4, { kind: 'said', flavor: 'note', text: 'about the alias', about: id('i_two') }),
    ])
    expect([...ledger.items.keys()]).toEqual([id('i_one'), id('i_b')])
    expect(ledger.items.get(id('i_b'))?.basis.items[0]?.item).toBe(id('i_one'))
    expect(ledger.items.get(id('i_one'))?.said.map((s) => s.text)).toEqual(['about the alias'])
  })

  it('lets an alias that knows the origin fill in an adopted item, and item.basis too', () => {
    const brought = fold([f(1, enter('i_a', 'a.md', 'a', { kind: 'adopted' })), f(2, enter('i_x', 'a.md', 'a', { kind: 'brought', source: 'https://x', by: null }))])
    expect(brought.items.get(id('i_a'))).toMatchObject({ unknownOrigin: false, origin: { kind: 'brought', source: 'https://x' } })
    const based = fold([f(1, enter('i_a', 'a.md', 'a', { kind: 'adopted' })), f(2, { kind: 'item.basis', item: id('i_a'), fingerprint: fp('a'), basis: basis([['i_s', 's']]) })])
    expect(based.items.get(id('i_a'))).toMatchObject({ unknownOrigin: false, basis: basis([['i_s', 's']]) })
  })

  it('does not alias onto an item that moved away or was removed', () => {
    const ledger = fold([
      f(1, enter('i_a', 'a.md', 'a')),
      f(2, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('b.md'), archive: null }),
      f(3, enter('i_c', 'a.md', 'c')),
      f(4, enter('i_d', 'd.md', 'd')),
      f(5, { kind: 'item.remove', item: id('i_d') }),
      f(6, enter('i_e', 'd.md', 'e')),
    ])
    expect([...ledger.items.keys()]).toEqual(['i_a', 'i_c', 'i_d', 'i_e'])
    expect(ledger.pathIndex.get(p('a.md'))).toBe('i_c')
    expect(ledger.pathIndex.get(p('d.md'))).toBe('i_e')
    expect(ledger.items.get(id('i_d'))?.removed).toBe(true)
  })

  it('keeps the basis across a revise, replacing the rows of the sources it names; item.basis replaces it all', () => {
    const start = [
      f(1, enter('i_a', 'a.md', 'a', { kind: 'made', basis: basis([['i_s', 's'], ['i_t', 't']], ['said']) })),
      f(2, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('a2'), size: 1, basis: basis([['i_t', 't2'], ['i_u', 'u']]), held: null, claimed: false }),
    ]
    expect(fold(start).items.get(id('i_a'))?.basis).toEqual(basis([['i_s', 's'], ['i_t', 't2'], ['i_u', 'u']], ['said']))
    const replaced = fold([...start, f(3, { kind: 'item.basis', item: id('i_a'), fingerprint: fp('a2'), basis: basis([['i_v', 'v']]) })])
    expect(replaced.items.get(id('i_a'))?.basis).toEqual(basis([['i_v', 'v']]))
  })

  it('gathers each scene: actors, directories, what was said, the items it touched', () => {
    const ledger = fold([
      f(1, { kind: 'said', flavor: 'doing', text: '选支付服务', about: null }),
      f(2, enter('i_a', 'a.md', 'a')),
      f(3, { kind: 'said', flavor: 'decided', text: '用 Paddle', about: null }),
    ])
    expect(ledger.scenes.get('s1' as never)).toMatchObject({ first: f(1, enter('x', 'x', 'x')).at, actors: [{ name: 'claude-code' }], cwds: ['/work'], items: ['i_a'] })
    expect(ledger.scenes.get('s1' as never)?.said.map((s) => s.text)).toEqual(['选支付服务', '用 Paddle'])
  })
})
