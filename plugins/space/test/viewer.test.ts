// The plugin's page, its section of the item panel and its board page, through the viewer's server,
// with one site online on the acceptance stack and one declared and switched off.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Action, Block, ViewResult } from '@pneuma-base/sdk'
import { sandbox } from '@pneuma-base/sdk/testkit'
import type { BoardData } from '../src/views.ts'
import { ADMIN, freshPrefix, purge, unreachable } from './stack.ts'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const down = await unreachable()

/** Every block of an answer, sections opened. */
const blocks = (r: ViewResult): Block[] => {
  const walk = (list: Block[]): Block[] => list.flatMap((b) => [b, ...(b.kind === 'section' ? walk(b.blocks) : [])])
  return r.outcome === 'shown' ? walk(r.blocks) : []
}
const status = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status

test('the page, the item section and the board page', { skip: down ?? false }, async (t) => {
  const prefix = freshPrefix()
  const sb = await sandbox({ plugins: [dist] })
  t.after(async () => {
    await sb.cleanup()
    await purge(prefix)
  })
  for (const name of ['live', 'idle']) {
    await mkdir(join(sb.work, name), { recursive: true })
    await writeFile(join(sb.work, name, 'index.html'), `<h1>${name}</h1>\n`)
    assert.equal((await sb.agent('claude-code', 's1', ['put', name, '--to', `sites/${name}`, '--made'])).code, 0)
    await sb.agent('claude-code', 's1', ['say', 'deployable', `sites/${name}`])
  }
  await sb.owner(['space', 'target', 'set', '--admin', ADMIN, '--prefix', prefix])
  const url = (await sb.owner(['space', 'on', 'sites/live', '--json'])).json.data.url
  await fetch(url)
  const viewer = await sb.viewer()

  const page = await viewer.view('space.sites')
  assert.equal(page.outcome, 'shown')
  if (page.outcome !== 'shown') return
  assert.deepEqual(page.problems, [])
  assert.deepEqual((await viewer.state()).problems, [])
  assert.equal(page.refresh, 30)
  const table = blocks(page).find((b) => b.kind === 'table')
  assert.ok(table?.kind === 'table')
  assert.deepEqual(table.columns.map((c) => c.key).slice(3), ['release', 'requests', 'lastAccess'])
  const liveRow = table.rows.find((r) => r.cells.path?.text === 'sites/live')
  assert.equal(liveRow?.cells.release?.text, '第 1 版')

  await t.test('the item section has the fields, a live preview and the release history', async () => {
    const item = await viewer.item('sites/live', { plugin: 'space' })
    assert.equal(item.outcome, 'shown')
    if (item.outcome !== 'shown') return
    assert.deepEqual(item.problems, [])
    const embed = blocks(item).find((b) => b.kind === 'embed')
    assert.ok(embed?.kind === 'embed' && embed.url === url)
    const timeline = blocks(item).find((b) => b.kind === 'timeline')
    assert.ok(timeline?.kind === 'timeline')
    assert.deepEqual(timeline.entries.map((e) => [e.title.text, e.tag?.text ?? null, e.actions ?? []]), [['第 1 版', '线上', []]])
  })

  const boardPage = await viewer.view('space.board')
  assert.equal(boardPage.outcome === 'shown' && boardPage.refresh, 30)
  assert.ok((await viewer.state()).views.some((v) => v.id === 'space.board' && v.title === '看板'))

  await t.test('the board draws a card per site that is on and lists the one that is off', async () => {
    const board = blocks(boardPage).find((b) => b.kind === 'custom')
    assert.ok(board?.kind === 'custom')
    assert.equal((await viewer.get(`/plugin-ui/space/${board.entry}`)).status, 200)
    const data = board.data as BoardData
    assert.deepEqual(data.cards.map((c) => [c.path, c.url, c.release, c.spark?.length]), [['sites/live', url, 1, 24]])
    assert.deepEqual(data.off.map((o) => o.path), ['sites/idle'])
    const rowAction = (path: string) => table.rows.find((r) => r.cells.path?.text === path)?.actions[0]
    assert.deepEqual(board.actions[data.cards[0]!.key], rowAction('sites/live'), 'the board’s switch is the page’s')
    assert.deepEqual(board.actions[data.off[0]!.key], rowAction('sites/idle'))
  })

  await t.test('the board’s switches go through the viewer as any button does', async () => {
    const board = blocks(boardPage).find((b) => b.kind === 'custom')
    assert.ok(board?.kind === 'custom')
    const data = board.data as BoardData
    const off = await viewer.act(board.actions[data.cards[0]!.key] as Action)
    assert.equal(off.tone, 'good', off.text)
    assert.equal(await status(url), 404)
    const on = await viewer.act(board.actions[data.off[0]!.key] as Action)
    assert.equal(on.tone, 'good', on.text)
    const again = await viewer.view('space.board')
    const after = blocks(again).find((b) => b.kind === 'custom')
    assert.ok(after?.kind === 'custom')
    const cards = (after.data as BoardData).cards
    assert.deepEqual(cards.map((c) => c.path), ['sites/idle'])
    assert.equal(await status(cards[0]!.url!), 200)
  })
})
