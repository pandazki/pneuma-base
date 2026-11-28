// The plugin against a real library: a temporary home with the built plugin installed, calls through
// the real command line, and the viewer's server. Pure helpers are imported from the sources.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import plugin, { parseMark } from '../src/index.ts'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
let sb: Sandbox

before(async () => {
  sb = await sandbox({ plugins: [dist] })
  const put = await sb.agent('claude-code', 'session-1', ['put', '-', '--to', 'notes/plan.md', '--generated'], { input: '# 计划\n' })
  assert.equal(put.code, 0, put.stderr)
})
after(() => sb.cleanup())

test('a stored line that is not a mark says why', () => {
  assert.deepEqual(parseMark({ path: 'notes/plan.md', text: '要核对' }), { path: 'notes/plan.md', text: '要核对' })
  assert.equal(parseMark({ path: 'notes/plan.md' }), '不是一条标记')
})

test('an agent marks a thing, and the owner lists the marks', async () => {
  const said = await sb.agent('claude-code', 'session-1', ['say', plugin.name, 'notes/plan.md', '第三节的数字还没核对', '--json'])
  assert.equal(said.json.outcome, 'heard', said.stdout)
  const missing = await sb.agent('claude-code', 'session-1', ['say', plugin.name, 'notes/none.md', '不在的东西', '--json'])
  assert.equal(missing.json.outcome, 'not-heard')
  const listed = await sb.owner([plugin.name, 'list', '--path', 'notes/plan.md', '--json'])
  assert.deepEqual(
    listed.json.data.marks.map((m: { text: string; by: string }) => [m.text, m.by]),
    [['第三节的数字还没核对', 'claude-code']],
  )
})

test('its page shows the marks in a table and in its own panel, whose button lists them', async () => {
  const viewer = await sb.viewer()
  const page = await viewer.view(`${plugin.name}.marks`)
  assert.equal(page.outcome, 'shown')
  if (page.outcome !== 'shown') return
  assert.deepEqual(page.problems, [])
  const table = page.blocks.find((b) => b.kind === 'table')
  assert.equal(table?.kind === 'table' && table.rows.length, 1)
  const panel = page.blocks.find((b) => b.kind === 'custom')
  assert.ok(panel?.kind === 'custom')
  // What the panel draws, in words: pneuma-base show prints it, and screen readers read it.
  assert.match(panel.text, /^1 条标记，最近一条：/)
  assert.equal((await viewer.get(`/plugin-ui/${plugin.name}/${panel.entry}`)).status, 200)
  const pressed = await viewer.act(panel.actions.list as NonNullable<typeof panel.actions.list>)
  assert.equal(pressed.result.outcome, 'done')
})
