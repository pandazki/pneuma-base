// The kit's append-only record store: each write is one new file that never replaces another, ids
// sort by time, then writer, then order, and the reader leaves out a broken line and says which.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordStore } from '../src/kit/index.js'
import type { Actor, Instant, PluginContext } from '../src/index.js'

// The first two random draws are the writer's id and the first file's name; the name is made to
// collide with a file that is already there.
const draws = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>()
  return { ...real, randomBytes: (size: number) => (draws.n++ < 2 ? Buffer.alloc(size, 0xab) : real.randomBytes(size)) }
})

type Body = { kind: string; n: number }
const parse = (raw: Record<string, unknown>): Body | string => (typeof raw.kind === 'string' && typeof raw.n === 'number' ? { kind: raw.kind, n: raw.n } : '不是这个插件的记录')
const ctx = (now: string, actor: Actor = { kind: 'owner' }) => ({ actor, now: now as Instant, session: { id: 's1' } }) as unknown as PluginContext

let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-records-')), 'facts')
})

describe('the record store', () => {
  it('reads nothing from a directory that is not there', async () => {
    expect(await recordStore(dir, parse).read()).toEqual({ records: [], skipped: [] })
  })

  it('writes each append as one new file and never replaces a file that has the name', async () => {
    const store = recordStore<Body>(dir, parse)
    const now = '2026-11-26T01:02:03.456Z'
    mkdirSync(dir, { recursive: true })
    const taken = '20261126010203456-abababab.jsonl'
    writeFileSync(join(dir, taken), 'someone else’s\n')

    await store.append([store.stamp(ctx(now), { kind: 'a', n: 1 })])
    await store.append([store.stamp(ctx(now), { kind: 'b', n: 2 }), store.stamp(ctx(now), { kind: 'c', n: 3 })])
    await store.append([])

    const files = readdirSync(dir).sort()
    expect(files).toHaveLength(3)
    expect(files.every((f) => f.endsWith('.jsonl') && !f.startsWith('.'))).toBe(true)
    expect(readFileSync(join(dir, taken), 'utf8')).toBe('someone else’s\n')
    const { records, skipped } = await store.read()
    expect(records.map((r) => r.kind)).toEqual(['a', 'b', 'c'])
    expect(skipped).toEqual([{ file: taken, line: 1, reason: '不是一行 JSON' }])
  })

  it('stamps the actor, the session and the time, with ids that sort by time and then by order of writing', async () => {
    const store = recordStore<Body>(dir, parse)
    const later = store.stamp(ctx('2026-11-26T00:00:02.000Z', { kind: 'agent', name: 'codex', grant: null }), { kind: 'later', n: 1 })
    const first = store.stamp(ctx('2026-11-26T00:00:01.000Z'), { kind: 'first', n: 2 })
    const second = store.stamp(ctx('2026-11-26T00:00:01.000Z'), { kind: 'second', n: 3 })
    await store.append([later])
    await store.append([second, first])
    const { records } = await store.read()
    expect(records.map((r) => r.kind)).toEqual(['first', 'second', 'later'])
    expect(records[2]).toMatchObject({ actor: { kind: 'agent', name: 'codex' }, session: 's1', at: '2026-11-26T00:00:02.000Z' })
    expect(records[0]?.actor).toEqual({ kind: 'owner', name: 'owner' })
  })

  it('skips a line that is not a record, says which and why, and reads the rest', async () => {
    mkdirSync(dir, { recursive: true })
    const good = { id: 'f_1', at: '2026-11-26T00:00:00.000Z', actor: { kind: 'owner', name: 'owner' }, session: 's', kind: 'k', n: 1 }
    const lines = [JSON.stringify(good), '{not json', '', JSON.stringify({ kind: 'k', n: 2 }), JSON.stringify({ ...good, id: 'f_2', n: 'two' })]
    writeFileSync(join(dir, 'x.jsonl'), `${lines.join('\n')}\n`)
    writeFileSync(join(dir, '.tmp-y.jsonl'), '{half')
    const { records, skipped } = await recordStore<Body>(dir, parse).read()
    expect(records.map((r) => r.id)).toEqual(['f_1'])
    expect(skipped).toEqual([
      { file: 'x.jsonl', line: 2, reason: '不是一行 JSON' },
      { file: 'x.jsonl', line: 4, reason: '缺 id、at、actor 或 session' },
      { file: 'x.jsonl', line: 5, reason: '不是这个插件的记录' },
    ])
  })
})
