// The kit's record store and configuration file on storage, through the real kernel: stores that
// share one record place, what the earlier kit wrote on disk read with them, facts read page by page,
// and a configuration replaced whole with the expectation of what was read.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLibrary, makeContext, openLibrary, pluginContext, type Actor, type Instant, type PluginContext, type PluginName, type Session } from '@pneuma-base/kernel'
import { configFile, recordStore } from '@pneuma-base/sdk/kit'
import { beforeEach, describe, expect, it } from 'vitest'

const owner: Actor = { kind: 'owner' }
const session: Session = { id: 'kit-storage', source: 'flag', cwd: '/work', machine: 'test', transcript: null }
type Body = { n: number }
const parse = (raw: Record<string, unknown>): Body | string => (typeof raw.n === 'number' ? { n: raw.n } : '没有 n')

let ctx: PluginContext
beforeEach(async () => {
  const dir = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-kit-storage-')))
  const root = join(dir, 'lib')
  await initLibrary(root, { plugins: [], table: new Map(), actor: owner, session, home: join(dir, 'home') })
  const lib = await openLibrary(root, new Map())
  if (!lib) throw new Error('no library')
  ctx = pluginContext(makeContext(lib, owner, session, join(dir, 'home'), '2026-11-27T00:00:00.000Z' as Instant), 'notes' as PluginName)
})

const ns = (records: readonly Body[]) => records.map((r) => r.n)

describe('the record store on storage', () => {
  it('keeps several stores in the one record place, each reading its own; a fact without a store’s name is the facts store’s', async () => {
    const activity = recordStore(ctx, 'activity', parse)
    const facts = recordStore(ctx, 'facts', parse)
    await activity.append([activity.stamp(ctx, { n: 1 }), activity.stamp(ctx, { n: 2 })])
    await facts.append([facts.stamp(ctx, { n: 3 })])
    await ctx.tools.storage.records.append([{ id: 'f_0', at: ctx.now, actor: { kind: 'owner', name: 'owner' }, session: 's', n: 4 }])
    expect(ns((await activity.read()).records)).toEqual([1, 2])
    expect(ns((await facts.read()).records)).toEqual([4, 3])
  })

  it('reads what the earlier kit wrote in the plugin’s directory with the first page only, and says which line is no record', async () => {
    // As the earlier kit wrote them: one file per write, one object per line, in a directory of the store's name.
    const line = (id: string, n: number) => `${JSON.stringify({ id, at: '2026-11-25T00:00:00.000Z', actor: { kind: 'owner', name: 'owner' }, session: 's', n })}\n`
    mkdirSync(join(ctx.dir, 'activity'), { recursive: true })
    writeFileSync(join(ctx.dir, 'activity', '20261125000000001-bb.jsonl'), line('f_2', 2))
    writeFileSync(join(ctx.dir, 'activity', '20261125000000000-aa.jsonl'), line('f_1', 1))
    writeFileSync(join(ctx.dir, 'activity', 'broken.jsonl'), '{half\n')
    const store = recordStore(ctx, 'activity', parse)
    await store.append([store.stamp(ctx, { n: 3 })])

    const first = await store.since(null)
    expect(first && ns(first.records)).toEqual([1, 2, 3])
    expect(first?.skipped).toEqual([{ at: 'activity/broken.jsonl#1', reason: '不是一行 JSON' }])
    await store.append([store.stamp(ctx, { n: 4 })])
    const next = await store.since(first?.cursor ?? null)
    expect(next && ns(next.records)).toEqual([4])
    expect(ns((await store.read()).records)).toEqual([1, 2, 3, 4])
  })

  it('reads the facts store’s files the earlier kit wrote directly in facts/, through storage', async () => {
    const line = (id: string, n: number) => JSON.stringify({ id, at: '2026-11-25T00:00:00.000Z', actor: { kind: 'owner', name: 'owner' }, session: 's', n })
    mkdirSync(join(ctx.dir, 'facts'), { recursive: true })
    writeFileSync(join(ctx.dir, 'facts', '20261125000000000-aa.jsonl'), `${line('f_2', 2)}\n${line('f_1', 1)}\n`)
    const store = recordStore(ctx, 'facts', parse)
    await store.append([store.stamp(ctx, { n: 3 })])
    expect(ns((await store.read()).records)).toEqual([1, 2, 3])
  })

  it('reads a page of at most the facts asked for, and the next from its cursor', async () => {
    const store = recordStore(ctx, 'activity', parse)
    for (const n of [1, 2, 3, 4, 5]) await store.append([store.stamp(ctx, { n })])
    const seen: number[] = []
    let cursor: string | null = null
    for (let pages = 1; ; pages++) {
      const page: Awaited<ReturnType<typeof store.since>> = await store.since(cursor, 2)
      if (page === null) throw new Error('the cursor no longer fits')
      expect(page.records.length).toBeLessThanOrEqual(2)
      seen.push(...ns(page.records))
      if (!page.more) {
        expect(pages).toBe(3)
        break
      }
      cursor = page.cursor
    }
    expect(seen).toEqual([1, 2, 3, 4, 5])
  })
})

describe('the configuration file on storage', () => {
  type Config = { format: 1; to: string }
  const parseConfig = (raw: unknown): Config => {
    const to = (raw as { to?: unknown } | null)?.to
    if (typeof to !== 'string') throw new Error('没有 to')
    return { format: 1, to }
  }
  const file = () => join(ctx.dir, 'config.json')

  it('reads nothing until written, then what the earlier kit wrote; writes it whole in the same layout', async () => {
    const config = configFile(ctx, 'config.json', parseConfig)
    expect(await config.read()).toBeNull()
    // As the earlier kit wrote it; `config` read nothing, so its write meets this file and writes over it.
    mkdirSync(ctx.dir, { recursive: true })
    writeFileSync(file(), `${JSON.stringify({ format: 1, to: 'old' }, null, 2)}\n`)
    expect(await configFile(ctx, 'config.json', parseConfig).read()).toEqual({ format: 1, to: 'old' })
    await config.write({ format: 1, to: 'new' })
    expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify({ format: 1, to: 'new' }, null, 2)}\n`)
  })

  it('writes over a write that came in after it read, as the last write wins', async () => {
    const a = configFile(ctx, 'config.json', parseConfig)
    const b = configFile(ctx, 'config.json', parseConfig)
    await a.write({ format: 1, to: 'a' })
    expect(await b.read()).toEqual({ format: 1, to: 'a' })
    await a.write({ format: 1, to: 'a2' })
    await b.write({ format: 1, to: 'b' })
    expect(await a.read()).toEqual({ format: 1, to: 'b' })
  })

  it('throws when the file is not JSON or the parser refuses it', async () => {
    const config = configFile(ctx, 'config.json', parseConfig)
    await configFile(ctx, 'config.json', (raw) => raw).write({ to: 1 })
    await expect(config.read()).rejects.toThrow('没有 to')
    writeFileSync(file(), '{"to":')
    await expect(config.read()).rejects.toThrow(SyntaxError)
  })
})
