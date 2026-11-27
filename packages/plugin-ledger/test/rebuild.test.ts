// Rows derived again from nothing: a library synced in from another machine, rows of another shape,
// the cache deleted. One process rebuilds while others wait; a rebuild that stopped part way is
// started again; a long one says that it runs, how far it is, and when it is done.
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fact, SceneId } from '../src/facts.js'
import { foldAll } from '../src/look.js'
import { claude, enter, folded, memoryRecords, recordsContext, rowsOf } from './support.js'

/** `n` facts, each appended alone as one file: a said line every second, and every tenth an item entered. */
function many(n: number): Fact[] {
  const day = Date.UTC(2026, 10, 25)
  return Array.from({ length: n }, (_, i) => ({
    id: `f_${String(i).padStart(6, '0')}`,
    at: new Date(day + i * 1000).toISOString(),
    scene: `s${Math.floor(i / 100)}` as SceneId,
    actor: claude,
    where: { cwd: '/work', machine: 'm', sessionSource: 'flag', transcript: null },
    how: 'tool',
    ...(i % 10 === 0 ? enter(`i_${i}`, `notes/${i}.md`, `p${i}`) : { kind: 'said', flavor: 'doing', text: `第 ${i} 步`, about: null }),
  })) as Fact[]
}

async function appendedAlone(facts: readonly Fact[]) {
  const records = memoryRecords()
  for (const fact of facts) await records.append([fact])
  return records
}

/** What the rebuild wrote to standard error while `run` ran. */
async function said(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    lines.push(...String(text).split('\n').filter(Boolean))
    return true
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return lines
}

const TABLES = ['items', 'paths', 'dirs', 'history', 'log', 'scenes', 'sceneOrder', 'find', 'bytime', 'stats', 'meta']

afterEach(() => vi.restoreAllMocks())

describe('rows derived again from nothing', () => {
  it('say that they are being derived, from how many facts files, and when they are done', async () => {
    const records = await appendedAlone(many(5000))
    const lines = await said(() => foldAll(recordsContext(records)))
    expect(lines[0]).toBe('正在从事实重建记账的行：至少 5000 条。')
    expect(lines.at(-1)).toMatch(/^记账的行已重建：5000 条事实，\d+\.\d 秒。$/)
    expect(lines.slice(1, -1).every((l) => /^已推出 \d+ \/ 5000$/.test(l))).toBe(true)
  })

  it('pass without a word when there are few facts', async () => {
    const records = await appendedAlone(many(300))
    expect(await said(() => foldAll(recordsContext(records)))).toEqual([])
  })

  it('are derived once when two processes start at once, and both answer the same cursor', async () => {
    const facts = many(3000)
    const records = await appendedAlone(facts)
    const since = vi.spyOn(records, 'since')
    const ctx = recordsContext(records)
    const [a, b] = await Promise.all([foldAll(ctx), foldAll(ctx)])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(since.mock.calls.filter(([cursor]) => cursor === null)).toHaveLength(1)
    const whole = await folded(facts, 1000)
    for (const table of TABLES.filter((t) => t !== 'meta')) expect([table, rowsOf(records).all(table)]).toEqual([table, whole.all(table)])
  })

  it('are derived again when the rebuild that held them stopped part way', async () => {
    const facts = many(500)
    const whole = await folded(facts)
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number
    const stopped = [
      { machine: hostname(), pid: dead, at: new Date().toISOString() },
      { machine: 'another-machine', pid: process.pid, at: new Date(Date.now() - 120_000).toISOString() },
    ]
    for (const holder of stopped) {
      const records = await appendedAlone(facts)
      await records.put({ meta: [{ key: 'build', value: { claim: 'rebuild:old', facts: 500, done: 100, ...holder } }], items: [{ key: 'i_half', value: { half: true } }] }, { cursor: 'rebuild:old', expect: null })
      await foldAll(recordsContext(records))
      for (const table of TABLES) expect([table, rowsOf(records).all(table)]).toEqual([table, whole.all(table)])
    }
  })
})
