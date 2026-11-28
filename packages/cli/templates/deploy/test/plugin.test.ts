// The plugin against a real library: a temporary home with the built plugin installed, calls through
// the real command line, and the viewer's server.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import plugin from '../src/index.ts'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
let sb: Sandbox
let published: string

before(async () => {
  sb = await sandbox({ plugins: [dist] })
  published = join(sb.work, 'published')
  await mkdir(join(sb.work, 'shop'), { recursive: true })
  await writeFile(join(sb.work, 'shop', 'index.html'), '<h1>小店</h1>\n')
  const put = await sb.agent('claude-code', 'session-1', ['put', 'shop', '--to', 'sites/shop', '--generated'])
  assert.equal(put.code, 0, put.stderr)
})
after(() => sb.cleanup())

test('an agent declares a site; only the owner can switch it on, and then it is published', async () => {
  const declared = await sb.agent('claude-code', 'session-1', ['say', 'deployable', 'sites/shop', '--json'])
  assert.equal(declared.json.outcome, 'heard', declared.stdout)
  assert.equal((await sb.owner([plugin.name, 'target', 'set', '--to', published, '--json'])).json.outcome, 'done')
  const byAgent = await sb.agent('claude-code', 'session-1', [plugin.name, 'on', 'sites/shop', '--json'])
  assert.equal(byAgent.json.outcome, 'refused')
  const on = await sb.owner([plugin.name, 'on', 'sites/shop', '--json'])
  assert.equal(on.json.outcome, 'done', on.stdout)
  const site = join(published, 'sites-shop', 'index.html')
  assert.equal(await readFile(site, 'utf8'), '<h1>小店</h1>\n')
  assert.equal((await sb.owner([plugin.name, 'off', 'sites/shop', '--json'])).json.outcome, 'done')
  assert.equal(existsSync(site), false)
})

test('its page has the kit’s rows and its own panel, whose switches are the rows’', async () => {
  const viewer = await sb.viewer()
  const page = await viewer.view(`${plugin.name}.sites`)
  assert.equal(page.outcome, 'shown')
  if (page.outcome !== 'shown') return
  assert.deepEqual(page.problems, [])
  const panel = page.blocks.find((b) => b.kind === 'custom')
  assert.ok(panel?.kind === 'custom')
  // What the panel draws, in words: pneuma-base show prints it, and screen readers read it.
  assert.match(panel.text, / 在线，发布到 /)
  assert.equal((await viewer.get(`/plugin-ui/${plugin.name}/${panel.entry}`)).status, 200)
  const things = page.blocks.find((b) => b.kind === 'list' && b.items.some((i) => i.toggle))
  assert.ok(things?.kind === 'list')
  assert.deepEqual(Object.values(panel.actions), things.items.map((i) => i.toggle?.action))
})
