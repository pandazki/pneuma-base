// The plugin's page, its section of the item panel and its board page, through the viewer's server,
// with one site online on the acceptance stack and one declared and switched off. Skipped unless
// SPACE_ADMIN names a PneumaSpace that answers (stack.ts).
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action, Block, ViewResult } from '@pneuma-base/sdk'
import { sandbox, type Sandbox, type Viewer } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { BoardData } from '../src/views.js'
import { ADMIN, freshPrefix, purge, unreachable } from './stack.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const down = await unreachable()

/** Every block of an answer, sections opened. */
const blocks = (r: ViewResult): Block[] => {
  const walk = (list: Block[]): Block[] => list.flatMap((b) => [b, ...(b.kind === 'section' ? walk(b.blocks) : [])])
  return r.outcome === 'shown' ? walk(r.blocks) : []
}
const status = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status

describe.skipIf(down !== null)('the page, the item section and the board page', () => {
  const prefix = freshPrefix()
  let sb: Sandbox
  let url = ''
  let viewer: Viewer
  let page: ViewResult
  let boardPage: ViewResult
  beforeAll(async () => {
    sb = await sandbox({ builtins: ['deploy'], cli })
    for (const name of ['live', 'idle']) {
      await mkdir(join(sb.work, name), { recursive: true })
      await writeFile(join(sb.work, name, 'index.html'), `<h1>${name}</h1>\n`)
      assert.equal((await sb.agent('claude-code', 's1', ['put', name, '--to', `sites/${name}`, '--generated'])).code, 0)
      await sb.agent('claude-code', 's1', ['say', 'deployable', `sites/${name}`])
    }
    await sb.owner(['deploy', 'target', 'set', '--kind', 'self-hosted', '--admin', ADMIN, '--prefix', prefix])
    url = (await sb.owner(['deploy', 'publish', 'sites/live', '--json'])).json.data.url
    await fetch(url)
    viewer = await sb.viewer()
    page = await viewer.view('deploy.sites')
    boardPage = await viewer.view('deploy.board')
  })
  afterAll(async () => {
    await sb?.cleanup()
    await purge(prefix)
  })
  /** The page's table, with PneumaSpace's columns. */
  const tableOf = () => {
    const table = blocks(page).find((b) => b.kind === 'table')
    assert.ok(table?.kind === 'table')
    return table
  }

  it('the page has the release, requests and last access columns', async () => {
    assert.equal(page.outcome, 'shown')
    if (page.outcome !== 'shown') return
    assert.deepEqual(page.problems, [])
    assert.deepEqual((await viewer.state()).problems, [])
    assert.equal(page.refresh, 30)
    const table = tableOf()
    assert.deepEqual(table.columns.map((c) => c.key).slice(3), ['release', 'requests', 'lastAccess'])
    const liveRow = table.rows.find((r) => r.cells.path?.text === 'sites/live')
    assert.equal(liveRow?.cells.release?.text, '版本 1')
  })

  it('the item section has the fields, a live preview and the release history', async () => {
    const item = await viewer.item('sites/live', { plugin: 'deploy' })
    assert.equal(item.outcome, 'shown')
    if (item.outcome !== 'shown') return
    assert.deepEqual(item.problems, [])
    const embed = blocks(item).find((b) => b.kind === 'embed')
    assert.ok(embed?.kind === 'embed' && embed.url === url)
    const timeline = blocks(item).find((b) => b.kind === 'timeline')
    assert.ok(timeline?.kind === 'timeline')
    assert.deepEqual(timeline.entries.map((e) => [e.title.text, e.tag?.text ?? null, e.actions ?? []]), [['版本 1', '当前', []]])
  })

  it('the board page is a page of its own', async () => {
    assert.equal(boardPage.outcome === 'shown' && boardPage.refresh, 30)
    assert.ok((await viewer.state()).views.some((v) => v.id === 'deploy.board' && v.title === '看板'))
  })

  it('the board draws a card per site that is on and lists the one that is off', async () => {
    const board = blocks(boardPage).find((b) => b.kind === 'custom')
    assert.ok(board?.kind === 'custom')
    assert.equal((await viewer.get(`/plugin-ui/deploy/${board.entry}`)).status, 200)
    const data = board.data as BoardData
    assert.deepEqual(data.cards.map((c) => [c.path, c.url, c.release, c.spark?.length]), [['sites/live', url, 1, 24]])
    assert.deepEqual(data.off.map((o) => o.path), ['sites/idle'])
    // The same board in words, for the command line and screen readers: each card, then what is switched off.
    const lines = board.text.split('\n')
    assert.ok(lines[0]?.startsWith(`sites/live：已发布 · ${url} · 版本 1 · `), board.text)
    assert.match(lines[0] as string, /过去 24 小时每小时请求数 (\d+ ){23}\d+$/)
    assert.equal(lines.at(-1), '开关已关闭：sites/idle（未发布）')
    const rowAction = (path: string) => tableOf().rows.find((r) => r.cells.path?.text === path)?.actions[0]
    assert.deepEqual(board.actions[data.cards[0]!.key], rowAction('sites/live'), 'the board’s switch is the page’s')
    assert.deepEqual(board.actions[data.off[0]!.key], rowAction('sites/idle'))
  })

  it('the board’s switches go through the viewer as any button does', async () => {
    const board = blocks(boardPage).find((b) => b.kind === 'custom')
    assert.ok(board?.kind === 'custom')
    const data = board.data as BoardData
    const off = await viewer.act(board.actions[data.cards[0]!.key] as Action)
    assert.equal(off.tone, 'good', off.text)
    assert.equal(await status(url), 404)
    const on = await viewer.act(board.actions[data.off[0]!.key] as Action)
    assert.equal(on.tone, 'good', on.text)
    const again = await viewer.view('deploy.board')
    const after = blocks(again).find((b) => b.kind === 'custom')
    assert.ok(after?.kind === 'custom')
    const cards = (after.data as BoardData).cards
    assert.deepEqual(cards.map((c) => c.path), ['sites/idle'])
    assert.equal(await status(cards[0]!.url!), 200)
  })
})
