// The fold's rules that the command line cannot easily reach: facts arrive in any order (a sync
// brings another machine's), and facts about unknown things are ignored.
import type { Fingerprint, Instant, LibraryPath } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import type { Fact, FactBody, FactId, ThingId } from '../src/facts.js'
import { fold, type Thing } from '../src/model.js'

const fp = (s: string) => s.padEnd(64, '0') as Fingerprint
const p = (s: string) => s as LibraryPath
const t = (s: string) => s as ThingId
const f = (n: number, body: FactBody): Fact => ({ id: `f_${String(n).padStart(4, '0')}` as FactId, at: `2026-11-25T00:00:${String(n).padStart(2, '0')}.000Z` as Instant, scene: 's1', by: { kind: 'agent', name: 'claude-code' }, ...body })
/** The things the facts fold into, and the one in the library at a path. */
const folded = (facts: Fact[]) => {
  const things = new Map<ThingId, Thing>()
  fold(things, facts)
  return things
}
const at = (things: Map<ThingId, Thing>, path: string) => [...things.values()].find((x) => !x.gone && x.path === path)
const v = (n: number, thing: string, print: string, path = 'a.md'): Fact =>
  f(n, { kind: 'version', thing: t(thing), path: p(path), fingerprint: fp(print), manifest: { kind: 'file', rows: [{ path: '', fingerprint: fp(print), size: 1 }] }, via: 'put' })

describe('fold', () => {
  it('orders by fact id, whatever order the files gave, and ignores facts about a thing never declared and a second declaration of one', () => {
    const facts = [v(3, 't1', 'c'), f(1, { kind: 'declare', thing: t('t1'), path: p('a.md') }), v(2, 't1', 'b'), v(4, 't1', 'b')]
    const thing = at(folded(facts), 'a.md')
    expect(thing?.versions.map((x) => [x.n, x.fingerprint.slice(0, 1), x.same])).toEqual([
      [1, 'b', null],
      [2, 'c', null],
      [3, 'b', 1],
    ])
    const things = folded([v(1, 'ghost', 'a'), f(2, { kind: 'declare', thing: t('t1'), path: p('a.md') }), f(3, { kind: 'declare', thing: t('t1'), path: p('b.md') })])
    expect([...things.keys()]).toEqual(['t1'])
    expect(at(things, 'b.md')).toBeUndefined()
  })
})
