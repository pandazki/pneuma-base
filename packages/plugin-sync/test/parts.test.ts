// The scope, the target each machine uses, and the blocks the sync gives the UI and check, called
// directly on a real library (the viewer's wiring is another slice's).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  initLibrary,
  makeContext,
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
import { currentTarget, type SyncFact } from '../src/facts.js'
import { sync } from '../src/index.js'
import { scopeOf } from '../src/scope.js'
import { tempDir } from './support.js'

describe('scope', () => {
  const withCache: Plugin = { contract: 1, name: pluginName('search'), cognition: null, storage: [{ dir: 'index', kind: 'cache' }, { dir: 'facts', kind: 'body' }], statements: [], ownerCommands: [] }
  const inScope = scopeOf([sync, withCache])

  it('takes content, the archive, records and bundle markers', () => {
    for (const path of ['a.md', 'sites/one/.pneuma-item', '_archive/old.md', '.pneuma-base/ledger/facts/s/1.jsonl', '.pneuma-base/sync/facts/1.jsonl', '.pneuma-base/search/facts/x']) expect(inScope(path), path).toBe(true)
  })

  it('leaves out this machine’s configuration, caches, temporary files, OS junk and what is not content', () => {
    for (const path of [
      '.pneuma-base/config.json',
      'PNEUMA-BASE.md',
      '.pneuma-base/tmp/x.partial',
      '.pneuma-base/sync/tmp/1',
      '.pneuma-base/search/index/db.sqlite',
      '.pneuma-base/ledger/facts/s/.tmp-1.jsonl',
      'notes/.DS_Store',
      'notes/._a.md',
      'site/.git/HEAD',
      'site/node_modules/x/index.js',
      '.pneuma-sync/id',
    ]) expect(inScope(path), path).toBe(false)
  })
})

describe('the target a machine uses', () => {
  const set = (at: string, machine: string, path: string): SyncFact => ({ kind: 'target.set', id: at, at: at as Instant, machine, by: 'owner', target: { kind: 'dir', path } })

  it('is the one this machine set last; a machine that set none uses the one set last anywhere', () => {
    const facts = [set('2026-11-25T01:00:00Z', 'm1', '/m1/old'), set('2026-11-25T02:00:00Z', 'm1', '/m1/new'), set('2026-11-25T03:00:00Z', 'm2', '/m2/t')]
    expect(currentTarget(facts, 'm1')?.target.path).toBe('/m1/new')
    expect(currentTarget(facts, 'm2')?.target.path).toBe('/m2/t')
    expect(currentTarget(facts, 'm3')?.target.path).toBe('/m2/t')
    expect(currentTarget([], 'm1')).toBeNull()
  })
})

// ---- the blocks, on a real library ----

const session: Session = { id: 'test-session', source: 'flag', cwd: '/', machine: 'test-machine', transcript: null }

async function fixture() {
  const root = join(tempDir(), 'lib')
  const home = tempDir('pb-sync-home-')
  const target = join(tempDir(), 'target')
  const table = new Map([[sync.name as string, sync]])
  const init = await initLibrary(root, { plugins: ['sync'], table, actor: { kind: 'owner' }, session, home })
  if (init.outcome !== 'done') throw new Error(init.text)
  const library = await openLibrary(root, table)
  if (!library) throw new Error('no library')
  const ctx = makeContext(library, { kind: 'owner' }, session, home)
  const pctx: PluginContext = { ...ctx, dir: join(root, '.pneuma-base', 'sync'), cacheDir: join(home, 'cache', library.config.id, 'sync') }
  const owner = async (name: string, flags: Record<string, string[]> = {}) => {
    const r = await ownerFace.dispatch({ ctx, table, env: {}, viaGrant: false, confirm: async () => false }, name, { positional: [], flags })
    if (r.outcome !== 'done') throw new Error(r.text)
    return r
  }
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return { root, target, pctx, owner, write, view: () => sync.onView?.({ view: 'sync.status', params: {} }, pctx) }
}

const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))
const sectionNamed = (blocks: Block[], title: string) => blocks.find((b): b is Extract<Block, { kind: 'section' }> => b.kind === 'section' && b.title === title)

describe('the sync.status view', () => {
  it('is declared in the navigation', () => {
    expect(sync.views).toEqual([expect.objectContaining({ id: 'sync.status', nav: true })])
  })

  it('without a target says so and offers to set one', async () => {
    const f = await fixture()
    const v = await f.view()
    expect(v?.blocks).toMatchObject([
      { kind: 'empty', title: '还没设同步目标' },
      { kind: 'actions', actions: [{ inputs: [{ name: 'to' }], call: { face: 'owner', command: 'sync target set', args: { flags: { kind: ['dir'], to: ['{to}'] } } } }] },
    ])
  })

  it('shows the target, what a sync would do with a 现在同步 button, and after the sync the last run and nothing pending', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    f.write('a.md', 'a')
    const before = (await f.view())?.blocks ?? []
    expect(before[0]).toMatchObject({ kind: 'fields', fields: [{ label: '目标', value: { text: f.target } }, { label: '设于' }, { label: '上次同步', value: { text: '这台机器还没同步过' } }] })
    const pending = sectionNamed(before, '待同步')
    expect(pending?.actions).toMatchObject([{ label: '现在同步', call: { face: 'owner', command: 'sync now' } }])
    const table = flat(before).find((b) => b.kind === 'table')
    expect(table?.kind === 'table' && table.rows.find((r) => r.key === 'pushed')?.cells.count?.text).toBe('2') // a.md and the target record

    await f.owner('sync now')
    const after = (await f.view())?.blocks ?? []
    expect(after[0]).toMatchObject({ kind: 'fields', fields: [{}, {}, { label: '上次同步', value: { tag: { text: '完成' } } }] })
    expect(sectionNamed(after, '待同步')).toMatchObject({ count: 0, note: '两边一样' })
  })

  it('names a target missing on this machine', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    rmSync(f.target, { recursive: true })
    const blocks = (await f.view())?.blocks ?? []
    expect(blocks[0]).toMatchObject({ kind: 'fields', fields: [{ value: { tag: { text: '这台机器上没有', tone: 'warn' } } }, {}, {}] })
    expect(flat(blocks).find((b) => b.kind === 'text')).toMatchObject({ tone: 'warn', text: expect.stringContaining('在这台机器上不存在') })
  })

  it('lists conflict copies outside the archive, each with an archive button', async () => {
    const f = await fixture()
    await f.owner('sync target set', { kind: ['dir'], to: [f.target] })
    const copy = 'n/plan.conflict-other-20261125T080000Z.md'
    f.write(copy, 'theirs')
    f.write('_archive/old.conflict-other-20261125T070000Z.md', 'resolved')
    const conflicts = sectionNamed((await f.view())?.blocks ?? [], '冲突副本')
    expect(conflicts).toMatchObject({
      count: 1,
      blocks: [{ kind: 'list', items: [{ cell: { text: copy, link: { view: 'item', params: { path: copy } } }, note: 'n/plan.md 的另一份', actions: [{ label: '归档', call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path: copy } } }] }] }],
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
    expect(await sync.onItemView?.(copy, f.pctx)).toMatchObject({ title: '同步', blocks: [{ kind: 'text', text: expect.stringContaining('plan.md 的冲突副本') }, { kind: 'actions', actions: [{ label: '归档' }] }] })
    expect(await sync.onItemView?.('plan.md' as LibraryPath, f.pctx)).toMatchObject({ blocks: [{ kind: 'text' }, { kind: 'list', items: [{ cell: { text: copy } }] }] })
    expect(await sync.onItemView?.('other.md' as LibraryPath, f.pctx)).toBeNull()
  })

  it('check reports conflict copies still around, and nothing when there are none', async () => {
    const f = await fixture()
    const req = { since: null, includeArchived: false }
    expect(await sync.onCheck?.(req, f.pctx)).toEqual([])
    f.write('plan.conflict-other-20261125T080000Z.md', 'theirs')
    expect(await sync.onCheck?.(req, f.pctx)).toMatchObject([{ title: '同步冲突', data: { conflicts: [{ copy: 'plan.conflict-other-20261125T080000Z.md', original: 'plan.md' }] } }])
  })
})
