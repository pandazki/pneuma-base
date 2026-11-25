// The fold's rules that the command line cannot easily reach: facts arrive in any order (a sync
// brings another machine's), facts about unknown things are ignored, numbers never change.
import type { Fingerprint, Instant, LibraryPath } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import type { Fact, FactBody, FactId, ThingId } from '../src/facts.js'
import { declaredAt, fold, latest } from '../src/model.js'

const fp = (s: string) => s.padEnd(64, '0') as Fingerprint
const p = (s: string) => s as LibraryPath
const t = (s: string) => s as ThingId
const f = (n: number, body: FactBody): Fact => ({ id: `f_${String(n).padStart(4, '0')}` as FactId, at: `2026-11-25T00:00:${String(n).padStart(2, '0')}.000Z` as Instant, scene: 's1', by: { kind: 'agent', name: 'claude-code' }, ...body })
const v = (n: number, thing: string, print: string, path = 'a.md'): Fact =>
  f(n, { kind: 'version', thing: t(thing), path: p(path), fingerprint: fp(print), manifest: { kind: 'file', rows: [{ path: '', fingerprint: fp(print), size: 1 }] }, via: 'put' })

describe('fold', () => {
  it('orders by fact id, whatever order the files gave', () => {
    const facts = [v(3, 't1', 'c'), f(1, { kind: 'declare', thing: t('t1'), path: p('a.md') }), v(2, 't1', 'b'), v(4, 't1', 'b')]
    const thing = declaredAt(fold(facts), p('a.md'))
    expect(thing?.versions.map((x) => [x.n, x.fingerprint.slice(0, 1), x.same])).toEqual([
      [1, 'b', null],
      [2, 'c', null],
      [3, 'b', 1],
    ])
  })

  it('ignores facts about a thing never declared, and a second declaration of one', () => {
    const model = fold([v(1, 'ghost', 'a'), f(2, { kind: 'declare', thing: t('t1'), path: p('a.md') }), f(3, { kind: 'declare', thing: t('t1'), path: p('b.md') })])
    expect([...model.things.keys()]).toEqual(['t1'])
    expect(declaredAt(model, p('b.md'))).toBeUndefined()
  })

  it('keeps numbers after a prune; latest skips pruned versions; a note sticks to its version; a move and gone re-index', () => {
    const model = fold([
      f(1, { kind: 'declare', thing: t('t1'), path: p('a.md') }),
      v(2, 't1', 'a'),
      v(3, 't1', 'b'),
      f(4, { kind: 'note', thing: t('t1'), version: 'f_0002' as FactId, text: '初稿' }),
      f(5, { kind: 'prune', thing: t('t1'), versions: ['f_0003' as FactId] }),
      f(6, { kind: 'move', thing: t('t1'), from: p('a.md'), to: p('_archive/a.md') }),
    ])
    const thing = declaredAt(model, p('a.md'))
    expect(thing?.path).toBe('_archive/a.md')
    expect(thing?.versions.map((x) => [x.n, x.note, x.pruned])).toEqual([
      [1, '初稿', false],
      [2, null, true],
    ])
    expect(latest(thing!)?.n).toBe(1)
    const gone = fold([f(1, { kind: 'declare', thing: t('t1'), path: p('a.md') }), v(2, 't1', 'a'), f(3, { kind: 'gone', thing: t('t1') })])
    expect(declaredAt(gone, p('a.md'))).toBeUndefined()
    expect(gone.things.get(t('t1'))?.versions).toHaveLength(1)
  })
})
