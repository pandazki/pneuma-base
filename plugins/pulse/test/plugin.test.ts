// pulse against a real library: a temporary home with the built plugin installed, calls through the
// real command line, and the viewer's server. Pure helpers are imported from the sources.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Action, Block, ViewResult } from '@pneuma-base/sdk'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import plugin, { byActor, counted, DAYS, days, parseActivity, parseClear } from '../src/index.ts'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const PAGE = `${plugin.name}.heat`
let sb: Sandbox

before(async () => {
  sb = await sandbox({ plugins: [dist] })
})
after(() => sb.cleanup())

const env = (at: string, name = 'a', kind: 'agent' | 'owner' = 'agent') => ({ id: at, at: at as never, actor: { kind, name }, session: 's' })

test('stored lines that are not records say why', () => {
  assert.deepEqual(parseActivity({ what: 'put', path: 'a.md' }), { what: 'put', path: 'a.md' })
  assert.equal(parseActivity({ what: 'move', path: 'a.md' }), '不是有效的活动记录')
  assert.deepEqual(parseClear({ cleared: true }), { cleared: true })
  assert.equal(parseClear({}), '不是有效的清空记录')
})

test('a clear hides everything at or before it, also records synced in later', () => {
  const all = [env('2026-11-01T00:00:00.000Z'), env('2026-11-02T00:00:00.000Z'), env('2026-11-03T00:00:00.000Z')]
  assert.equal(counted(all, []).length, 3)
  assert.deepEqual(counted(all, ['2026-11-02T00:00:00.000Z', '2026-11-01T12:00:00.000Z']).map((r) => r.at), ['2026-11-03T00:00:00.000Z'])
})

test('the grid has 30 local days ending today, and counts per day', () => {
  const now = new Date(2026, 10, 26, 15, 0)
  const grid = days([env(new Date(2026, 10, 26, 9).toISOString()), env(new Date(2026, 10, 26, 1).toISOString()), env(new Date(2026, 9, 1).toISOString())], now)
  assert.equal(grid.length, DAYS)
  assert.equal(grid.at(-1)!.day, '2026-11-26')
  assert.equal(grid.at(-1)!.count, 2)
  assert.equal(grid[0]!.day, '2026-10-28')
  assert.equal(grid.reduce((n, d) => n + d.count, 0), 2)
})

test('actors are counted apart, the owner shown as 我, most active first', () => {
  const rows = byActor([
    { ...env('2026-11-01T00:00:00.000Z', 'codex'), what: 'put', path: 'a' },
    { ...env('2026-11-02T00:00:00.000Z', 'claude-code'), what: 'put', path: 'b' },
    { ...env('2026-11-03T00:00:00.000Z', 'claude-code'), what: 'archive', path: 'b' },
    { ...env('2026-11-04T00:00:00.000Z', 'owner', 'owner'), what: 'put', path: 'c' },
  ])
  assert.deepEqual(
    rows.map((r) => [r.name, r.total, r.put, r.archive]),
    [['claude-code', 2, 1, 1], ['codex', 1, 1, 0], ['我', 1, 1, 0]],
  )
})

type Shown = Extract<ViewResult, { outcome: 'shown' }>
async function page(): Promise<Shown> {
  const viewer = await sb.viewer()
  const shown = await viewer.view(PAGE)
  await viewer.stop()
  assert.equal(shown.outcome, 'shown')
  assert.deepEqual(shown.problems, [])
  return shown as Shown
}
const find = <K extends Block['kind']>(blocks: readonly Block[], kind: K): Extract<Block, { kind: K }> | undefined => {
  for (const b of blocks) {
    if (b.kind === kind) return b as Extract<Block, { kind: K }>
    if (b.kind === 'section') {
      const inner = find(b.blocks, kind)
      if (inner) return inner
    }
  }
  return undefined
}

test('puts and archives are counted per actor; moves and taking back are not', async () => {
  const ok = async (r: Promise<{ code: number; stderr: string; stdout: string }>) => {
    const done = await r
    assert.equal(done.code, 0, done.stderr || done.stdout)
  }
  await ok(sb.agent('claude-code', 's1', ['put', '-', '--to', 'notes/a.md', '--generated'], { input: '# a\n' }))
  await ok(sb.agent('claude-code', 's1', ['put', '-', '--to', 'notes/b.md', '--generated'], { input: '# b\n' }))
  await ok(sb.agent('codex', 's2', ['put', '-', '--to', 'notes/c.md', '--generated'], { input: '# c\n' }))
  await ok(sb.agent('codex', 's2', ['archive', 'notes/c.md']))
  await ok(sb.agent('codex', 's2', ['unarchive', 'notes/c.md']))
  await ok(sb.agent('claude-code', 's1', ['put', 'notes/b.md', '--to', 'notes/b2.md']))

  const shown = await page()
  assert.equal(shown.subtitle, `最近 ${DAYS} 天 4 次`)
  const heat = find(shown.blocks, 'custom')
  assert.ok(heat)
  const data = heat.data as { days: { count: number }[]; total: number }
  assert.equal(data.days.length, DAYS)
  assert.equal(data.days.at(-1)!.count, 4)
  // The same days in words, for the command line and screen readers: the total, the active days, the busiest, each day's count.
  const today = (data.days.at(-1) as unknown as { day: string }).day
  const label = `${Number(today.slice(5, 7))} 月 ${Number(today.slice(8))} 日`
  assert.equal(heat.text, `最近 ${DAYS} 天的添加和归档：4 次，活跃天数：1。最活跃的一天：${label}，4 次。\n每日（按本机时区）：${label} 4 次`)
  const table = find(shown.blocks, 'table')
  assert.deepEqual(
    table?.rows.map((r) => [r.cells.who!.text, r.cells.total!.text, r.cells.put!.text, r.cells.archive!.text]),
    [['claude-code', '2', '2', '0'], ['codex', '2', '1', '1']],
  )
  const viewer = await sb.viewer()
  const ui = await viewer.get(`/plugin-ui/${plugin.name}/${heat.entry}`)
  assert.equal(ui.status, 200)
  assert.match(await ui.text(), /plugin-kit\/frame\.js/)
  await viewer.stop()
})

test('clearing is destructive: refused for an agent and without confirmation, done after the page asks', async () => {
  const byAgent = await sb.agent('claude-code', 's1', [plugin.name, 'clear', '--json'])
  assert.equal(byAgent.code, 2)
  assert.equal(byAgent.json.reason, 'agent-session')

  const unconfirmed = await sb.owner([plugin.name, 'clear', '--json'])
  assert.equal(unconfirmed.code, 2)
  assert.equal(unconfirmed.json.reason, 'not-confirmed')
  assert.equal((await page()).subtitle, `最近 ${DAYS} 天 4 次`)

  const actions = find((await page()).blocks, 'actions')
  const clear = actions?.actions.find((a) => a.call.face === 'owner' && a.call.command === `${plugin.name} clear`) as Action
  assert.equal(clear.tone, 'danger')
  assert.ok(clear.confirm)
  const viewer = await sb.viewer()
  const pressed = await viewer.act(clear)
  await viewer.stop()
  assert.equal(pressed.result.outcome, 'done', pressed.text)
  assert.equal(pressed.result.text, '已清空 4 条活动记录，此后的活动从现在开始计算。')

  const after = await page()
  assert.equal(after.subtitle, `最近 ${DAYS} 天 0 次`)
  assert.equal(find(after.blocks, 'table')?.rows.length, 0)

  const put = await sb.agent('codex', 's3', ['put', '-', '--to', 'notes/d.md', '--generated'], { input: '# d\n' })
  assert.equal(put.code, 0, put.stderr)
  assert.equal((await page()).subtitle, `最近 ${DAYS} 天 1 次`)
})

test('records an earlier version wrote in activity/ still count, beside the ones in the record place', async () => {
  const own = await sandbox({ plugins: [dist] })
  try {
    const dir = join(own.library, '.pneuma-base', plugin.name, 'activity')
    mkdirSync(dir, { recursive: true })
    const at = new Date(Date.now() - 60_000).toISOString()
    writeFileSync(join(dir, '20261101000000000-abcdef01.jsonl'), `${JSON.stringify({ id: 'f_old', at, actor: { kind: 'agent', name: 'codex' }, session: 'old', what: 'put', path: 'notes/old.md' })}\n`)
    const put = await own.agent('claude-code', 's1', ['put', '-', '--to', 'notes/new.md', '--generated'], { input: '# new\n' })
    assert.equal(put.code, 0, put.stderr)
    const viewer = await own.viewer()
    const shown = (await viewer.view(PAGE)) as Shown
    await viewer.stop()
    assert.equal(shown.subtitle, `最近 ${DAYS} 天 2 次`)
    assert.deepEqual(find(shown.blocks, 'table')?.rows.map((r) => r.cells.who!.text).sort(), ['claude-code', 'codex'])
  } finally {
    await own.cleanup()
  }
})
