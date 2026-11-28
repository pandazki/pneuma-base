// The statistics' figures, each against a ledger built by hand: what was put and by whom, what was
// built on earlier work, who did what, what needs looking at and how that moved, counted by local day.
import type { Instant } from '@pneuma-base/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Fact, FactActor, FactBody, SceneId } from '../src/facts.js'
import { statsFrom, type Period } from '../src/stats.js'
import { basis, claude, codex, enter, folded, fp, id, p } from './support.js'

/** The figures of `period` ending `now`, from the rows the facts fold into. */
const statsOf = async (facts: readonly Fact[], period: Period, now: Instant) => statsFrom((await folded(facts)).records, period, now)

const gemini: FactActor = { kind: 'agent', name: 'gemini', grant: null }
const owner: FactActor = { kind: 'owner', name: 'owner', grant: null }

// Days are the machine's: these tests run in a zone eight hours ahead of UTC.
const zone = process.env.TZ
beforeAll(() => void (process.env.TZ = 'Asia/Shanghai'))
afterAll(() => void (zone === undefined ? delete process.env.TZ : (process.env.TZ = zone)))

let counter = 0
/** A fact at a moment of local time in Shanghai, `2026-11-20 09:00` style. */
function on(local: string, body: FactBody, opts: { scene?: string; actor?: FactActor; how?: Fact['how'] } = {}): Fact {
  const at = new Date(`${local.replace(' ', 'T')}:00+08:00`).toISOString() as Instant
  return {
    id: `f_${String(counter++).padStart(6, '0')}`,
    at,
    scene: (opts.scene ?? 's1') as SceneId,
    actor: opts.actor ?? claude,
    where: { cwd: '/work', machine: 'm', sessionSource: 'flag', transcript: null },
    how: opts.how ?? 'tool',
    ...body,
  }
}
const NOW = new Date('2026-11-26T10:00:00+08:00').toISOString() as Instant
const made = (rows: [string, string][], outside: string[] = []) => ({ kind: 'made' as const, basis: basis(rows, outside) })
const said = (flavor: 'doing' | 'decided' | 'note', text: string): FactBody => ({ kind: 'said', flavor, text, about: null })

describe('the period and its buckets', () => {
  it('counts nothing in a library with no facts: thirty empty days, or for all, today alone', async () => {
    const month = await statsOf([], '30d', NOW)
    expect(month).toMatchObject({ facts: 0, grain: 'day', put: { imported: 0, generated: 0 }, sessions: { total: 0, byAgent: [] }, agents: [], reuse: { generated: 0, top: [] } })
    expect(month.buckets).toHaveLength(30)
    expect(month.buckets.at(-1)).toBe('11月26日')
    expect(month.order).toMatchObject({ now: { stale: 0, changed: 0, unknown: 0, archived: 0 }, archived: 0 })
    const all = await statsOf([], 'all', NOW)
    expect(all.buckets).toEqual(['11月26日'])
    expect(all.from).toBe(new Date('2026-11-26T00:00:00+08:00').toISOString())
  })

  it('starts each period at local midnight: the last 7 days are today and the six before', async () => {
    const facts = [
      on('2026-11-19 23:59', enter('i_out', 'out.md', 'o')),
      on('2026-11-20 00:00', enter('i_first', 'first.md', 'f')),
      on('2026-11-26 01:00', enter('i_today', 'today.md', 't')),
    ]
    const week = await statsOf(facts, '7d', NOW)
    expect(week.from).toBe(new Date('2026-11-20T00:00:00+08:00').toISOString())
    expect(week.buckets).toEqual(['11月20日', '11月21日', '11月22日', '11月23日', '11月24日', '11月25日', '11月26日'])
    expect(week.put.imported).toBe(2)
    expect(week.put.byBucket.imported).toEqual([1, 0, 0, 0, 0, 0, 1])
    // 01:00 on the 26th in Shanghai is the 25th in UTC: the local day decides.
    expect((await statsOf(facts, '30d', NOW)).put.byBucket.imported.slice(-8)).toEqual([1, 1, 0, 0, 0, 0, 0, 1])
  })

  it('counts all of one day as one bucket, a couple of months by week and years by month, the bars adding up to the totals', async () => {
    const day = await statsOf([on('2026-11-26 08:00', enter('i_a', 'a.md', 'a')), on('2026-11-26 09:00', enter('i_b', 'b.md', 'b', made([['i_a', 'a']])))], 'all', NOW)
    expect(day.buckets).toEqual(['11月26日'])
    expect(day.put).toMatchObject({ imported: 1, generated: 1, byBucket: { imported: [1], generated: [1] } })
    const years = Array.from({ length: 40 }, (_, i) => on(`${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-15 12:00`, enter(`i_${i}`, `n/${i}.md`, `${i}`), { scene: `s${i}` }))
    const all = await statsOf(years.filter((f) => f.at <= NOW), 'all', NOW)
    expect(all.grain).toBe('month')
    expect(all.buckets[0]).toBe('2023年1月')
    expect(all.buckets.at(-1)).toBe('2026年11月')
    expect(all.put.imported).toBe(all.put.byBucket.imported.reduce((a, b) => a + b, 0))
    expect(all.sessions.total).toBe(all.put.imported)
    const weeks = await statsOf([on('2026-09-30 12:00', enter('i_a', 'a.md', 'a')), on('2026-11-25 12:00', enter('i_b', 'b.md', 'b'))], 'all', NOW)
    expect(weeks.grain).toBe('week')
    expect(weeks.buckets[0]).toBe('9月28日那周')
    expect(weeks.put.byBucket.imported.filter((x) => x > 0)).toEqual([1, 1])
  })
})

describe('is it used', () => {
  it('counts each thing once when it first enters, by how it came; aliases, adoptions and the owner registering what was there are not puts', async () => {
    const facts = [
      on('2026-11-25 09:00', enter('i_a', 'a.md', 'a')),
      on('2026-11-25 09:01', enter('i_b', 'b.md', 'b', made([['i_a', 'a']]))),
      on('2026-11-25 09:02', enter('i_c', 'c.md', 'c', { kind: 'adopted' })),
      on('2026-11-25 09:03', enter('i_c2', 'c.md', 'c')),
      on('2026-11-25 09:04', { kind: 'items.enter', items: [{ item: id('i_r1'), path: p('r1.md'), fingerprint: fp('r1'), size: 1 }, { item: id('i_r2'), path: p('r2.md'), fingerprint: fp('r2'), size: 1 }], origin: { kind: 'brought', source: null, by: 'owner' } }, { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-25 09:05', enter('i_o', 'o.md', 'o', { kind: 'brought', source: null, by: 'owner' }), { actor: owner, scene: 'adhoc-owner', how: 'observed' }),
    ]
    const s = await statsOf(facts, '7d', NOW)
    expect(s.put).toMatchObject({ imported: 2, generated: 1 })
    expect(s.owner).toMatchObject({ imported: 1, registered: 2 })
    expect(s.agents).toMatchObject([{ name: 'claude-code', imported: 1, generated: 1 }])
  })

  it('counts a session on the day an agent first acted in it, under that agent; a look alone, and a session begun before the period, are not counted', async () => {
    const facts = [
      on('2026-11-10 09:00', said('doing', '旧的一件事'), { scene: 'old' }),
      on('2026-11-24 09:00', said('doing', '还在做旧的'), { scene: 'old' }),
      on('2026-11-24 10:00', said('doing', '比价'), { scene: 'a1' }),
      on('2026-11-24 11:00', said('doing', '接入'), { scene: 'b1', actor: codex }),
      on('2026-11-25 11:00', said('doing', '再接入'), { scene: 'b2', actor: codex }),
      on('2026-11-25 12:00', { kind: 'checked' }, { scene: 'g1', actor: gemini }),
      on('2026-11-25 13:00', { kind: 'owner.op', command: 'grant create', summary: '已发', destructive: false }, { scene: 'adhoc-owner', actor: owner }),
    ]
    const s = await statsOf(facts, '7d', NOW)
    expect(s.sessions.total).toBe(3)
    expect(s.sessions.byAgent).toEqual([
      { agent: 'codex', total: 2, byBucket: [0, 0, 0, 0, 1, 1, 0] },
      { agent: 'claude-code', total: 1, byBucket: [0, 0, 0, 0, 1, 0, 0] },
    ])
  })
})

describe('is earlier work built on', () => {
  // claude-code brings a and makes b from it in one session; later it makes c from b; codex makes d
  // from c and a, and e from what was said outside the library alone.
  const facts = [
    on('2026-11-21 09:00', enter('i_a', 'src/a.md', 'a'), { scene: 's1' }),
    on('2026-11-21 09:10', enter('i_b', 'b.md', 'b', made([['i_a', 'a']])), { scene: 's1' }),
    on('2026-11-22 09:00', enter('i_c', 'c.md', 'c', made([['i_b', 'b']])), { scene: 's2' }),
    on('2026-11-23 09:00', enter('i_d', 'd.md', 'd', made([['i_c', 'c'], ['i_a', 'a']])), { scene: 's3', actor: codex }),
    on('2026-11-23 09:30', enter('i_e', 'e.md', 'e', made([], ['主人说的'])), { scene: 's3', actor: codex }),
  ]

  it('says how many things made in the period were made from the library, from another session, from another agent', async () => {
    const s = await statsOf(facts, '7d', NOW)
    expect(s.reuse).toMatchObject({ generated: 4, fromLibrary: 3, otherSession: 2, otherAgent: 1 })
    expect(s.reuse.byBucket).toEqual({ otherSession: [0, 0, 1, 1, 0, 0, 0], rest: [0, 1, 0, 1, 0, 0, 0] })
    // Three days later, the 21st and the 22nd have left the period.
    const later = await statsOf(facts, '7d', new Date('2026-11-29T10:00:00+08:00').toISOString() as Instant)
    expect(later.reuse).toMatchObject({ generated: 2, fromLibrary: 1, otherSession: 1, otherAgent: 1 })
  })

  it('counts a source given later with say basis, and never the thing itself', async () => {
    const later = [...facts, on('2026-11-24 09:00', { kind: 'item.basis', item: id('i_e'), fingerprint: fp('e'), basis: basis([['i_b', 'b'], ['i_e', 'e']]) }), on('2026-11-24 10:00', enter('i_f', 'f.md', 'f', made([['i_f', 'f']])), { scene: 's4', actor: gemini })]
    expect((await statsOf(later, '7d', NOW)).reuse).toMatchObject({ generated: 5, fromLibrary: 4, otherSession: 3, otherAgent: 2 })
  })

  it('ranks the most built-upon things by how many things made in the period name them, with who built on them', async () => {
    expect((await statsOf(facts, '7d', NOW)).reuse.top).toEqual([
      { item: 'i_a', path: 'src/a.md', uses: 2, by: ['claude-code', 'codex'] },
      { item: 'i_b', path: 'b.md', uses: 1, by: ['claude-code'] },
      { item: 'i_c', path: 'c.md', uses: 1, by: ['codex'] },
    ])
  })
})

describe('who did what', () => {
  it('counts each agent’s sessions, things, decisions and notes, and how its requests were decided; the owner’s own acts', async () => {
    const op = (command: string, extra: object = {}): FactBody => ({ kind: 'owner.op', command, summary: '做了', destructive: false, ...extra })
    const ask = (request: string, act: 'asked' | 'withdrawn' = 'asked'): FactBody => ({ kind: 'request', act, request, line: 'deploy online site' })
    const facts = [
      on('2026-11-24 09:00', said('decided', '用 Paddle'), { scene: 'a1' }),
      on('2026-11-24 09:01', said('note', '税要另算'), { scene: 'a1' }),
      on('2026-11-24 09:02', said('note', '再看一下'), { scene: 'a1' }),
      on('2026-11-24 09:03', ask('r-00000001'), { scene: 'a1' }),
      on('2026-11-24 09:04', ask('r-00000002'), { scene: 'a1' }),
      on('2026-11-24 09:05', ask('r-00000003'), { scene: 'a1' }),
      on('2026-11-24 09:06', ask('r-00000004'), { scene: 'a1' }),
      on('2026-11-24 09:07', ask('r-00000005'), { scene: 'a1' }),
      on('2026-11-24 09:08', ask('r-00000006'), { scene: 'a1' }),
      on('2026-11-24 10:00', op('deploy online', { request: { id: 'r-00000001', by: claude } }), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-24 10:01', op('deploy online', { request: { id: 'r-00000002', by: claude }, refused: 'not-deployable' }), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-24 10:02', op('request decline', { declined: { id: 'r-00000003', by: claude } }), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-24 10:03', op('request decline', { summary: '已拒绝 claude-code 的请求 r-00000004：deploy online site。claude-code 下次 check 时会看到。' }), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-24 10:04', ask('r-00000005', 'withdrawn'), { scene: 'a1' }),
      on('2026-11-24 10:05', op('ledger copies list', { readOnly: true }), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-24 10:06', said('note', '主人记的一句'), { actor: owner, scene: 'adhoc-owner' }),
      on('2026-11-25 09:00', said('doing', '接入'), { scene: 'b1', actor: codex }),
    ]
    const s = await statsOf(facts, '7d', NOW)
    expect(s.agents).toEqual([
      { name: 'claude-code', sessions: 1, imported: 0, generated: 0, decisions: 1, notes: 2, asked: 6, approved: 1, refused: 1, declined: 2, withdrawn: 1, pending: 1 },
      { name: 'codex', sessions: 1, imported: 0, generated: 0, decisions: 0, notes: 0, asked: 0, approved: 0, refused: 0, declined: 0, withdrawn: 0, pending: 0 },
    ])
    expect(s.owner).toEqual({ commands: 4, approved: 2, declined: 2, imported: 0, generated: 0, said: 1, registered: 0 })
  })
})

describe('is it kept in order', () => {
  const revise = (item: string, from: string, to: string, extra: object = {}): FactBody => ({ kind: 'item.revise', item: id(item), base: fp(from), fingerprint: fp(to), size: 1, held: null, claimed: false, ...extra })
  const facts = [
    on('2026-11-22 09:00', enter('i_s', 's.md', 's')),
    on('2026-11-22 09:01', enter('i_m', 'm.md', 'm', made([['i_s', 's']]))),
    on('2026-11-22 09:02', enter('i_u', 'u.md', 'u', { kind: 'adopted' })),
    on('2026-11-22 09:03', enter('i_x', 'x.md', 'x')),
    // The 23rd: the source changes, so m may be out of date; x is changed directly and only seen.
    on('2026-11-23 09:00', revise('i_s', 's', 's2')),
    on('2026-11-23 09:01', revise('i_x', 'x', 'x2', { claimed: true }), { actor: owner, scene: 'adhoc-owner', how: 'observed' }),
    // The 24th: m is made again from the new source; u gets its origin; codex says it changed x.
    on('2026-11-24 09:00', revise('i_m', 'm', 'm2', { basis: basis([['i_s', 's2']]) })),
    on('2026-11-24 09:01', enter('i_u2', 'u.md', 'u')),
    on('2026-11-24 09:02', revise('i_x', 'x', 'x2', { claimed: true }), { actor: codex, scene: 'b1', how: 'reported' }),
    // The 25th: s is archived, and taken back; x is archived.
    on('2026-11-25 09:00', { kind: 'item.move', item: id('i_s'), from: p('s.md'), to: p('_archive/s.md'), archive: 'in' }),
    on('2026-11-25 09:01', { kind: 'item.move', item: id('i_s'), from: p('_archive/s.md'), to: p('s.md'), archive: 'out' }),
    on('2026-11-25 09:02', { kind: 'item.move', item: id('i_x'), from: p('x.md'), to: p('_archive/x.md'), archive: 'in' }),
  ]

  it('counts what needs looking at as recorded at the end of each day, and now, starting from how things stood when the period began', async () => {
    const s = await statsOf(facts, '7d', NOW)
    expect(s.order.byBucket.map((o) => [o.stale, o.changed, o.unknown, o.archived])).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 1, 0],
      [1, 1, 1, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ])
    expect(s.order.start).toEqual({ stale: 0, changed: 0, unknown: 0, archived: 0 })
    expect(s.order.now).toEqual({ stale: 0, changed: 0, unknown: 0, archived: 1 })
    expect(s.order).toMatchObject({ archived: 2, takenBack: 1, purged: 0, changes: 2 })
    expect((await statsOf(facts.slice(0, 6), '7d', new Date('2026-11-30T10:00:00+08:00').toISOString() as Instant)).order.start).toEqual({ stale: 1, changed: 1, unknown: 1, archived: 0 })
  })

  it('counts a thing whose source is gone as possibly out of date, and leaves out what was removed', async () => {
    const gone = [...facts.slice(0, 4), on('2026-11-23 09:00', { kind: 'item.remove', item: id('i_s') })]
    expect((await statsOf(gone, '7d', NOW)).order.now).toMatchObject({ stale: 1, unknown: 1 })
  })
})
