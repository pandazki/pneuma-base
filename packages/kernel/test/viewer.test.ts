// The viewer face on a library with no plugin (K2): the kernel's three pages and the item panel,
// given as blocks; showing a view changes nothing and sends no event.
import { describe, expect, it } from 'vitest'
import { viewerFace, type Block, type Event, type ViewResult } from '../src/index.js'
import { fixture, plugin, type Fixture } from './support.js'

const show = (f: Fixture, view: string, params: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: f.ctx, table: new Map() })

function shown(r: ViewResult) {
  if (r.outcome !== 'shown') throw new Error(`not shown: ${r.outcome}`)
  return r
}

/** Every block, nested sections opened. */
const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))
const tableOf = (r: ViewResult) => {
  const table = flat(shown(r).blocks).find((b) => b.kind === 'table')
  if (table?.kind !== 'table') throw new Error('no table')
  return table
}

describe('the views of a library with no plugin', () => {
  it('are files, archive and config in the navigation, and the item panel outside it', async () => {
    const f = await fixture()
    expect(viewerFace.views(f.library)).toEqual({
      views: [
        expect.objectContaining({ id: 'files', nav: true }),
        expect.objectContaining({ id: 'archive', nav: true }),
        expect.objectContaining({ id: 'config', nav: true }),
        expect.objectContaining({ id: 'item', nav: false }),
      ],
      problems: [],
    })
  })

  it('files lists one folder: folders first, then files that open the item panel; the kernel’s files and the archive stay out', async () => {
    const f = await fixture()
    f.write('notes/a.md', 'a')
    f.write('top.txt', 't')
    f.write('_archive/old.md', 'o')
    const root = tableOf(await show(f, 'files'))
    expect(root.rows.map((r) => r.key)).toEqual(['notes', 'top.txt'])
    expect(root.rows[0]?.link).toEqual({ view: 'files', params: { dir: 'notes' }, target: 'main' })
    expect(root.rows[1]?.link).toEqual({ view: 'item', params: { path: 'top.txt' }, target: 'panel' })

    const notes = tableOf(await show(f, 'files', { dir: 'notes' }))
    expect(notes.rows.map((r) => r.key)).toEqual(['..', 'notes/a.md'])
    expect(notes.rows[0]?.cells.name?.link).toEqual({ view: 'files', params: {}, target: 'main' })
    expect(shown(await show(f, 'files', { dir: '../outside' })).blocks).toMatchObject([{ kind: 'empty' }])
    expect(shown(await show(f, 'files', { dir: '.pneuma-base' })).blocks).toMatchObject([{ kind: 'empty' }])
  })

  it('archive lists each archived file with a take-back action, and offers a purge that asks first', async () => {
    const f = await fixture()
    f.write('_archive/d/old.md', 'o')
    const r = shown(await show(f, 'archive'))
    const table = tableOf(r)
    expect(table.rows).toMatchObject([
      { key: '_archive/d/old.md', cells: { original: { text: 'd/old.md' } }, actions: [{ label: '取回', call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path: '_archive/d/old.md' } } }] },
    ])
    expect(r.blocks[0]).toMatchObject({ kind: 'section', actions: [{ tone: 'danger', confirm: expect.stringContaining('不能撤回'), call: { face: 'owner', command: 'archive purge' } }] })
  })

  it('config shows the library, its plugins with the ones that can be added, and the grants with skill generation', async () => {
    const f = await fixture()
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx: f.ctx, table: new Map([['ledger', plugin('ledger')]]) }))
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && s.title)).toEqual(['插件', '授权与技能'])
    expect(sections[0]).toMatchObject({ actions: [{ label: '装上插件', inputs: [{ name: 'plugin', options: [{ value: 'ledger' }] }], call: { command: 'plugin add', args: { positional: ['{plugin}'] } } }] })
    expect(sections[1]).toMatchObject({ actions: [{ label: '发授权', call: { command: 'grant issue' } }] })
    expect(JSON.stringify(sections[1])).toContain('codex --add-dir')
  })

  it('item gives the file’s facts, the archive action and a preview; with no file there it says so', async () => {
    const f = await fixture()
    f.write('a.md', 'hello')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => b.kind)).toEqual(['fields', 'actions', 'preview'])
    expect(r.blocks[1]).toMatchObject({ actions: [{ label: '归档', call: { verb: 'archive', request: { kind: 'archive', path: 'a.md' } } }] })
    expect(r.blocks[2]).toEqual({ kind: 'preview', path: 'a.md' })
    expect(shown(await show(f, 'item', { path: 'gone.md' })).blocks).toMatchObject([{ kind: 'text', tone: 'warn' }])
  })

  it('item of an archived file offers to take it back, and still finds it under its original path', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'a')
    for (const path of ['a.md', '_archive/a.md']) {
      const r = shown(await show(f, 'item', { path }))
      expect(r.blocks[1]).toMatchObject({ actions: [{ label: '取回', call: { request: { kind: 'unarchive', path: '_archive/a.md' } } }] })
    }
  })

  it('item of an archived path follows the file once it was taken back', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const fields = shown(await show(f, 'item', { path: '_archive/a.md' })).blocks[0]
    expect(fields?.kind === 'fields' && fields.fields[0]?.value.text).toBe('a.md')
  })

  it('an unknown view is no-such-view', async () => {
    const f = await fixture()
    expect(await show(f, 'nope')).toEqual({ outcome: 'no-such-view', problems: [] })
  })
})

describe('showing a view', () => {
  it('sends no event', async () => {
    const events: Event[] = []
    const f = await fixture([plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0
    f.write('a.md', 'a')
    for (const view of ['files', 'archive', 'config']) await show(f, view)
    await show(f, 'item', { path: 'a.md' })
    expect(events).toEqual([])
  })
})
