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

const lists = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'list' }> => b.kind === 'list')
const ownerCall = (action: Action | undefined) => (action?.call.face === 'owner' ? { command: action.call.command, positional: action.call.args.positional } : null)

describe('the deploy.sites view', () => {
  it('is in the navigation with the board beside it; shows the folder it publishes to, each thing in the content with its address and switch, and puts a thing online', async () => {
    expect(deploy.views).toEqual([expect.objectContaining({ id: 'deploy.sites', nav: true }), expect.objectContaining({ id: 'deploy.board', with: 'deploy.sites' })])
    const view = await deploy.onView?.({ view: 'deploy.sites', params: {} }, pctx)
    const [where, things] = lists(view?.blocks ?? [])
    expect(where?.items[0]?.cell).toMatchObject({ text: expect.stringMatching(/\/www$/), icon: 'folder', local: true })
    const byName = Object.fromEntries((things?.items ?? []).map((i) => [i.cell.text, i]))
    // The archived one is offline, so it is not on the page.
    expect(Object.keys(byName)).toEqual(['s1', 's3'])
    expect(byName.s1).toMatchObject({ note: 'sites', aside: { text: expect.stringMatching(/^file:.*\/www\/sites-s1\/$/), copy: true }, toggle: { on: true } })
    expect(byName.s1?.aside?.href).toBeUndefined()
    expect(ownerCall(byName.s1?.toggle?.action)).toEqual({ command: 'deploy off', positional: ['sites/s1'] })
    expect(byName.s3?.aside).toBeUndefined()
    expect(byName.s3?.cell.tag).toBeUndefined()
    expect(ownerCall(byName.s3?.toggle?.action)).toEqual({ command: 'deploy on', positional: ['sites/s3'] })
    const head = view?.blocks[0]
    expect(head?.kind === 'actions' && head.actions.map((a) => ownerCall(a))).toEqual([{ command: 'deploy on', positional: ['{path}'] }])
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

  it('for an archived declared thing, under its archive path, with no 上线 while its switch is off', async () => {
    const section = await deploy.onItemView?.('_archive/sites/s2' as LibraryPath, pctx)
    const fields = section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields ?? []
    expect(fields.find((f) => f.label === '状态')?.value.tag?.text).toBe('已归档')
    expect(section?.blocks.some((b) => b.kind === 'actions')).toBe(false)
  })

  it('for a directory thing nobody declared: 上线… in its menu; for no thing, or a file inside a bundle, nothing', async () => {
    const section = await deploy.onItemView?.('sites/other' as LibraryPath, pctx)
    expect(section?.blocks).toEqual([])
    expect(section?.actions?.map((a) => [a.label, ownerCall(a)])).toEqual([['上线…', { command: 'deploy on', positional: ['sites/other'] }]])
    expect(await deploy.onItemView?.('sites/nothing-here' as LibraryPath, pctx)).toBeNull()
    expect(await deploy.onItemView?.('sites/other/index.html' as LibraryPath, pctx)).toBeNull()
  })
})
