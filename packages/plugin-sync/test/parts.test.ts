// The own content a sync carries, the target each machine uses, and the blocks the sync gives the UI
// and check, called directly on a real library (the viewer's wiring is another slice's).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  agentFace,
  initLibrary,
  makeContext,
  pluginContext,
  openLibrary,
  ownerFace,
  pluginName,
  type Block,
  type Instant,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type Session,
} from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { writeFacts, type SyncFact } from '../src/facts.js'
import { sync } from '../src/index.js'
import { targetOf } from '../src/sync.js'
import { tempDir } from './support.js'

const session: Session = { id: 'test-session', source: 'flag', cwd: '/', machine: 'test-machine', transcript: null }

/** A plugin that keeps an index it declares a cache, and notes it does not. */
const keeper: Plugin = { contract: 2, name: pluginName('keeper'), cognition: null, storage: [{ dir: 'index', kind: 'cache' }, { dir: 'notes', kind: 'body' }], statements: [], ownerCommands: [] }

async function fixture() {
  const root = join(tempDir(), 'lib')
  const home = tempDir('pb-sync-home-')
  const target = join(tempDir(), 'target')
  const table = new Map<string, Plugin>([[sync.name, sync], [keeper.name, keeper]])
  const init = await initLibrary(root, { plugins: ['sync', 'keeper'], table, actor: { kind: 'owner' }, session, home })
  if (init.outcome !== 'done') throw new Error(init.text)
  const library = await openLibrary(root, table)
  if (!library) throw new Error('no library')
  const ctx = makeContext(library, { kind: 'owner' }, session, home)
  const pctx: PluginContext = pluginContext(ctx, sync.name)
  const owner = async (name: string, flags: Record<string, string[]> = {}) => {
    const r = await ownerFace.dispatch({ ctx, table, env: {}, viaGrant: false, confirm: async () => false }, name, { positional: [], flags })
    if (r.outcome !== 'done') throw new Error(r.text)
    return r
  }
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const register = async (path: string, content: string) => {
    write(path, content)
    const r = await agentFace.put({ kind: 'register', path, origin: { kind: 'made', from: [], outside: [] } }, ctx)
    if (r.outcome !== 'accepted') throw new Error(r.reason)
  }
  return { root, target, pctx, owner, write, register, view: () => sync.onView?.({ view: 'sync.status', params: {} }, pctx) }
}

const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))
const sectionNamed = (blocks: Block[], title: string) => blocks.find((b): b is Extract<Block, { kind: 'section' }> => b.kind === 'section' && b.title === title)

const conflict = (copy: string, original: string): SyncFact => ({ kind: 'conflict', id: copy, at: '2026-11-25T08:00:00.000Z' as Instant, machine: 'other', by: 'owner', copy: copy as LibraryPath, original: original as LibraryPath })

describe('own content', () => {
  it('a record place’s own content travels, but for the directories its plugin declares a cache', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    f.write('.pneuma-base/keeper/notes/a.md', 'kept note')
    f.write('.pneuma-base/keeper/index/db', 'rebuilt anywhere')
    await f.owner('sync now')
    expect(readFileSync(join(f.target, '.pneuma-sync/own/keeper/notes/a.md'), 'utf8')).toBe('kept note')
    expect(existsSync(join(f.target, '.pneuma-sync/own/keeper/index'))).toBe(false)
  })
})

describe('the target a machine uses', () => {
  const set = (at: string, machine: string, path: string): SyncFact => ({ kind: 'target.set', id: at, at: at as Instant, machine, by: 'owner', target: { kind: 'dir', path } })

  it('is the one this machine set last; a machine that set none uses the one set last anywhere', async () => {
    const f = await fixture()
    expect((await targetOf(f.pctx)).record).toBeNull()
    await writeFacts(f.pctx, [set('2026-11-25T02:00:00Z', 'test-machine', '/m1/new'), set('2026-11-25T01:00:00Z', 'test-machine', '/m1/old'), set('2026-11-25T03:00:00Z', 'm2', '/m2/t')])
    expect((await targetOf(f.pctx)).record?.target.path).toBe('/m1/new')
    const elsewhere = pluginContext(makeContext(f.pctx.library, { kind: 'owner' }, { ...session, machine: 'm3' }, f.pctx.home), sync.name)
    expect((await targetOf(elsewhere)).record?.target.path).toBe('/m2/t')
  })

  it('is read from the facts an earlier version wrote, one file each, right in its facts folder', async () => {
    const f = await fixture()
    f.write('.pneuma-base/sync/facts/20261125T020000Z-1a2b3c4d-9f.jsonl', `${JSON.stringify(set('2026-11-25T02:00:00Z', 'test-machine', '/m1/before'))}\n`)
    expect((await targetOf(f.pctx)).record?.target.path).toBe('/m1/before')
  })
})

describe('the sync.status view', () => {
  it('without a target says so and offers to set one', async () => {
    const f = await fixture()
    const v = await f.view()
    expect(v?.blocks).toMatchObject([
      { kind: 'empty', title: '未设置同步目标' },
      { kind: 'actions', head: true, actions: [{ as: 'primary', inputs: [{ name: 'to' }], call: { face: 'owner', command: 'sync target set', args: { flags: { kind: ['dir'], to: ['{to}'] } } } }] },
    ])
  })

  it('shows the target, what a sync would do with a 立即同步 button, and after the sync the last run and nothing pending', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    await f.register('a.md', 'a')
    f.write('stray.md', 'nobody registered it')
    const shownBefore = await f.view()
    const before = shownBefore?.blocks ?? []
    // The target is the subtitle; changing it is the head's menu.
    expect(shownBefore?.subtitle).toBe(`目录 ${f.target}`)
    expect(before[0]).toMatchObject({ kind: 'actions', head: true, actions: [{ as: 'menu', call: { face: 'owner', command: 'sync target set' } }] })
    expect(before[1]).toMatchObject({ kind: 'fields', fields: [{ label: '上次同步', value: { text: '本机尚未同步' } }, { label: '设置时间' }] })
    const pending = sectionNamed(before, '待同步')
    expect(pending?.actions).toMatchObject([{ label: '立即同步', call: { face: 'owner', command: 'sync now' } }])
    const table = flat(before).find((b) => b.kind === 'table')
    expect(table?.kind === 'table' && table.rows.find((r) => r.key === 'pushed')?.cells.count?.text).toBe('1')
    expect(existsSync(join(f.target, 'a.md'))).toBe(false)

    await f.owner('sync now')
    const after = (await f.view())?.blocks ?? []
    expect(after[1]).toMatchObject({ kind: 'fields', fields: [{ label: '上次同步', value: { text: expect.stringContaining('上传 1') } }, {}] })
    expect(sectionNamed(after, '待同步')).toMatchObject({ count: 0, note: '已同步' })
    expect(existsSync(join(f.target, 'stray.md'))).toBe(false)
  })

  it('names a target missing on this machine', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    rmSync(f.target, { recursive: true })
    const blocks = (await f.view())?.blocks ?? []
    expect(flat(blocks).find((b) => b.kind === 'text')).toMatchObject({ tone: 'warn', text: expect.stringContaining(`${f.target} 在本机不存在`) })
  })

  it('lists the conflict copies a sync made that are still where it made them, each with an archive button', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    const copy = 'n/plan.conflict-other-20261125T080000Z.md'
    f.write(copy, 'theirs')
    f.write('n/look.conflict-other-20261125T080000Z.md', 'named like one, made by nobody')
    await writeFacts(f.pctx, [conflict(copy, 'n/plan.md'), conflict('gone.conflict-other-20261125T070000Z.md', 'gone.md')])
    const conflicts = sectionNamed((await f.view())?.blocks ?? [], '冲突副本')
    expect(conflicts).toMatchObject({
      count: 1,
      blocks: [{ kind: 'list', items: [{ cell: { text: copy, link: { view: 'item', params: { path: copy } } }, note: 'n/plan.md 的另一侧版本', actions: [{ label: '归档', call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path: copy } } }] }] }],
    })
  })
})

describe('the item panel and check', () => {
  it('a conflict copy names its file and offers to archive it; the file lists its copies; anything else gets nothing', async () => {
    const f = await fixture()
    const copy = 'plan.conflict-other-20261125T080000Z.md' as LibraryPath
    f.write('plan.md', 'mine')
    f.write(copy, 'theirs')
    f.write('other.md', 'o')
    await writeFacts(f.pctx, [conflict(copy, 'plan.md')])
    expect(await sync.onItemView?.(copy, f.pctx)).toMatchObject({ title: '同步', blocks: [{ kind: 'text', text: expect.stringContaining('plan.md 的冲突副本') }, { kind: 'actions', actions: [{ label: '归档' }] }] })
    expect(await sync.onItemView?.('plan.md' as LibraryPath, f.pctx)).toMatchObject({ blocks: [{ kind: 'text' }, { kind: 'list', items: [{ cell: { text: copy } }] }] })
    expect(await sync.onItemView?.('other.md' as LibraryPath, f.pctx)).toBeNull()
  })

  it('check reports conflict copies still around, and nothing when there are none', async () => {
    const f = await fixture()
    const req = { since: null, includeArchived: false }
    const copy = 'plan.conflict-other-20261125T080000Z.md'
    expect(await sync.onCheck?.(req, f.pctx)).toEqual([])
    f.write(copy, 'theirs')
    await writeFacts(f.pctx, [conflict(copy, 'plan.md')])
    expect(await sync.onCheck?.(req, f.pctx)).toMatchObject([{ title: '同步冲突', data: { conflicts: [{ copy, original: 'plan.md' }] } }])
    rmSync(join(f.root, copy))
    expect(await sync.onCheck?.(req, f.pctx)).toEqual([])
  })
})
