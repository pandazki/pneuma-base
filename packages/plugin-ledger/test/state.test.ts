// The rows the ledger keeps are the same however the facts arrive: all at once, a few at a time, or
// each one alone, and with a batch seen twice. tmp/run-7 architecture.md section 7: state is rows
// derived incrementally from the facts, saved with the cursor they were derived up to.
import { describe, expect, it } from 'vitest'
import { mayBeNews, newsKey, type Fact } from '../src/facts.js'
import { foldAll } from '../src/look.js'
import { live } from '../src/model.js'
import { basis, codex, enter, f, folded, fp, id, memoryRecords, p, recordsContext, rowsOf } from './support.js'

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

/** What the rows say about each item: where it is, whether it counts, what it holds and was made from. */
const itemsOf = (rows: Awaited<ReturnType<typeof folded>>) =>
  new Map(rows.items().map((i) => [i.id, { path: i.path, removed: i.removed, absorbedInto: i.absorbedInto, fingerprint: i.fingerprint, origin: i.origin.kind, unknownOrigin: i.unknownOrigin, basis: i.basis.items.map((b) => b.item), dependents: i.dependents }]))

/** The tables that hold what the facts say, apart from the counters, which a batch boundary may order differently. */
const TABLES = ['items', 'paths', 'dirs', 'alias', 'left', 'history', 'log', 'scenes', 'sceneOrder', 'actors', 'held', 'find', 'bytime', 'marks', 'stats']

describe('the rows however the facts arrive', () => {
  it('are the same when the facts come 4 at a time or one at a time', async () => {
    const whole = await folded(HISTORY)
    for (const size of [4, 1]) {
      const parts = await folded(HISTORY, size)
      for (const table of TABLES) expect([size, table, parts.all(table)]).toEqual([size, table, whole.all(table)])
    }
  })

  it('say where each item is and whether it counts', async () => {
    const rows = await folded(HISTORY)
    expect(itemsOf(rows)).toEqual(
      new Map([
        ['i_a', { path: 'made/a.md', removed: false, absorbedInto: null, fingerprint: fp('a'), origin: 'made', unknownOrigin: false, basis: ['i_s'], dependents: [] }],
        ['i_b', { path: 'notes', removed: false, absorbedInto: null, fingerprint: fp('b'), origin: 'brought', unknownOrigin: false, basis: [], dependents: [] }],
        ['i_r1', { path: '_archive/inbox/r1.md', removed: false, absorbedInto: null, fingerprint: fp('r1'), origin: 'brought', unknownOrigin: false, basis: [], dependents: [] }],
        ['i_r2', { path: 'inbox/r2.md', removed: true, absorbedInto: null, fingerprint: fp('r2'), origin: 'brought', unknownOrigin: false, basis: [], dependents: [] }],
        ['i_s', { path: 'notes/s.md', removed: false, absorbedInto: 'i_b', fingerprint: fp('s2'), origin: 'brought', unknownOrigin: false, basis: [], dependents: ['i_a', 'i_x'] }],
        ['i_x', { path: 'loose.md', removed: false, absorbedInto: null, fingerprint: fp('x'), origin: 'brought', unknownOrigin: false, basis: ['i_s'], dependents: [] }],
      ]),
    )
    // The paths each counting item holds, and the open directories: every directory above one of them, with how many.
    const counting = rows.items().filter(live)
    expect(new Map([...rows.all<{ id: string }>('paths')].filter(([, v]) => counting.some((i) => i.id === v.id)).map(([k, v]) => [k, v.id]))).toEqual(new Map(counting.map((i) => [i.path, i.id])))
    expect(rows.all('dirs')).toEqual(new Map([['_archive', 1], ['_archive/inbox', 1], ['made', 1]]))
    expect([...rows.all('left').keys()]).toEqual(['stray.md'])
  })

  it('fold a fact already seen once only', async () => {
    const records = memoryRecords()
    const ctx = recordsContext(records)
    await records.append(HISTORY)
    await foldAll(ctx)
    const before = rowsOf(records)
    const once = { log: before.all('log'), items: before.all('items'), counts: before.counts() }
    await records.append(HISTORY.slice(4, 8))
    await foldAll(ctx)
    const after = rowsOf(records)
    expect({ log: after.all('log'), items: after.all('items'), counts: after.counts() }).toEqual(once)
  })

  it('keep the scenes with what was said and the owner’s operations, and the news newest first', async () => {
    const rows = await folded(HISTORY)
    expect([...rows.all('scenes').keys()]).toEqual(['s1', 's2', 's3'])
    expect(rows.scene('s1')?.said.map((s) => s.text)).toEqual(['整理支付资料'])
    expect(rows.scene('s3')?.ops.map((o) => o.command)).toEqual(['grant issue'])
    // Storage gives rows in key order, so the news read from the first key are the latest first.
    const news = HISTORY.filter(mayBeNews)
    const keys = [...rows.records.tables.get('log')!.values()].filter((r) => r.fields?.news === 'y').map((r) => r.key).sort()
    expect(keys).toHaveLength(news.length)
    expect(keys[0]).toBe(newsKey(news.at(-1) as Fact))
    expect(keys.at(-1)).toBe(newsKey(news[0] as Fact))
  })

  it('are derived again from the facts when their cursor no longer fits, or their shape changed', async () => {
    const records = memoryRecords()
    const ctx = recordsContext(records)
    await records.append(HISTORY)
    await foldAll(ctx)
    const whole = rowsOf(records).all('items')
    await records.put({ meta: [{ key: 'version', value: -1 }] })
    await foldAll(ctx)
    expect(rowsOf(records).all('items')).toEqual(whole)
  })
})
