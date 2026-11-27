// The deploy plugin's page and its part of the item panel, called directly: the blocks name each
// declared thing's state and address, and their actions are the owner's switch and deploy sync.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentFace,
  initLibrary,
  makeContext,
  pluginContext,
  openLibrary,
  ownerFace,
  type Action,
  type Actor,
  type Block,
  type Instant,
  type LibraryPath,
  type PluginContext,
  type Session,
  type TableRow,
} from '@pneuma-base/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import { deploy } from '../src/index.js'

const table = new Map([[deploy.name as string, deploy]])
const owner: Actor = { kind: 'owner' }
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session: Session = { id: 'views-test', source: 'flag', cwd: '/work', machine: 'test', transcript: null }
const temp = () => realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-deploy-')))

let pctx: PluginContext

/** A library with deploy only: three declared sites and one undeclared, a dir target, s1 switched on, s2 archived. */
beforeAll(async () => {
  const dir = temp()
  const root = join(dir, 'lib')
  const home = join(dir, 'home')
  await initLibrary(root, { plugins: ['deploy'], table, actor: owner, session, home })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const as = (actor: Actor) => makeContext(lib, actor, session, home, new Date().toISOString() as Instant)
  for (const name of ['s1', 's2', 's3', 'other']) {
    const site = join(dir, name)
    mkdirSync(site)
    writeFileSync(join(site, 'index.html'), `<h1>${name}</h1>`)
    await agentFace.put({ kind: 'place', from: { kind: 'directory', path: site }, to: `sites/${name}`, origin: { kind: 'made', from: [], outside: [] } }, as(claude))
  }
  for (const name of ['s1', 's2', 's3']) await agentFace.say({ kind: 'deployable', about: `sites/${name}`, text: null, args: {} }, as(claude))
  const call = { ctx: as(owner), table, home, env: {}, viaGrant: false, confirm: async () => false }
  expect(await ownerFace.dispatch(call, 'deploy target set', { positional: [], flags: { kind: ['dir'], to: [join(dir, 'www')] } })).toMatchObject({ outcome: 'done' })
  expect(await ownerFace.dispatch(call, 'deploy on', { positional: ['sites/s1'], flags: {} })).toMatchObject({ outcome: 'done' })
  await agentFace.archive({ kind: 'archive', path: 'sites/s2' }, as(claude))
  pctx = pluginContext(as(owner), deploy.name)
})

const sections = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'section' }> => b.kind === 'section')
const tableIn = (blocks: Block[]) => blocks.find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table')
const ownerCall = (action: Action | undefined) => (action?.call.face === 'owner' ? { command: action.call.command, positional: action.call.args.positional } : null)

describe('the deploy.sites view', () => {
  it('is in the navigation, shows the target, lists each declared thing with its state, its address and a switch, and offers to reconcile', async () => {
    expect(deploy.views).toEqual([expect.objectContaining({ id: 'deploy.sites', nav: true })])
    const view = await deploy.onView?.({ view: 'deploy.sites', params: {} }, pctx)
    const target = sections(view?.blocks ?? []).find((s) => s.title === '目标')
    expect(JSON.stringify(target?.blocks)).toContain('www')
    const things = sections(view?.blocks ?? []).find((s) => s.title === '可部署的东西')
    expect(things?.count).toBe(3)
    const rows = tableIn(things?.blocks ?? [])?.rows ?? []
    const byPath = Object.fromEntries(rows.map((r: TableRow) => [r.cells.path?.text, r]))
    expect(Object.keys(byPath).sort()).toEqual(['_archive/sites/s2', 'sites/s1', 'sites/s3'])

    expect(byPath['sites/s1']?.cells.state?.tag).toEqual({ text: '在线', tone: 'good' })
    expect(byPath['sites/s1']?.cells.address?.text).toMatch(/^file:.*\/www\/sites-s1\/$/)
    expect(ownerCall(byPath['sites/s1']?.actions[0])).toEqual({ command: 'deploy off', positional: ['sites/s1'] })

    // Offline is where a thing rests: the page leaves it unsaid, the text form still says it.
    expect(byPath['sites/s3']?.cells.state).toEqual({ text: '离线', muted: true, normal: true })
    expect(byPath['sites/s3']?.cells.address).toMatchObject({ normal: true })
    expect(ownerCall(byPath['sites/s3']?.actions[0])).toEqual({ command: 'deploy on', positional: ['sites/s3'] })

    expect(byPath['_archive/sites/s2']?.cells.state?.tag?.text).toBe('已归档')
    expect(byPath['sites/s1']?.link).toEqual({ view: 'item', params: { path: 'sites/s1' }, target: 'panel' })
    expect(things?.actions.map(ownerCall)).toContainEqual({ command: 'deploy sync', positional: [] })
  })
})

describe('the deploy section of the item panel', () => {
  it('for a declared thing: its state, address and switch', async () => {
    const section = await deploy.onItemView?.('sites/s1' as LibraryPath, pctx)
    expect(section?.title).toBe('部署')
    const fields = section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields ?? []
    expect(fields.find((f) => f.label === '状态')?.value.tag).toEqual({ text: '在线', tone: 'good' })
    expect(fields.find((f) => f.label === '地址')?.value.text).toMatch(/sites-s1\/$/)
    const actions = section?.blocks.find((b): b is Extract<Block, { kind: 'actions' }> => b.kind === 'actions')?.actions ?? []
    expect(ownerCall(actions[0])).toEqual({ command: 'deploy off', positional: ['sites/s1'] })
  })

  it('for an archived declared thing, under its archive path, with no "turn on" while its switch is off', async () => {
    const section = await deploy.onItemView?.('_archive/sites/s2' as LibraryPath, pctx)
    const fields = section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields ?? []
    expect(fields.find((f) => f.label === '状态')?.value.tag?.text).toBe('已归档')
    expect(section?.blocks.some((b) => b.kind === 'actions')).toBe(false)
  })

  it('for a thing nobody declared: what that means, and the declaration as a say; for no thing, or a file inside a bundle, nothing', async () => {
    const section = await deploy.onItemView?.('sites/other' as LibraryPath, pctx)
    const actions = section?.blocks.find((b): b is Extract<Block, { kind: 'actions' }> => b.kind === 'actions')?.actions ?? []
    expect(actions.map((a) => [a.label, a.call])).toEqual([['声明可以部署', { face: 'agent', verb: 'say', request: { kind: 'deployable', about: 'sites/other', text: null, args: {} } }]])
    expect(await deploy.onItemView?.('sites/nothing-here' as LibraryPath, pctx)).toBeNull()
    expect(await deploy.onItemView?.('sites/other/index.html' as LibraryPath, pctx)).toBeNull()
  })
})
