// The viewer face on a library with no plugin (K2): the kernel's three pages and the item panel,
// given as blocks; showing a view changes nothing and sends no event. How a page prints, and a view the
// library does not have, are packages/cli/test/show.test.ts's.
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, viewerFace, type Action, type Block, type Event, type ViewResult } from '../src/index.js'
import { saveConnection } from '../src/connections.js'
import { fixture, plugin, type Fixture } from './support.js'

/** Shown as the owner, with the fixture's home as HOME and nothing on PATH, so no agent product of this machine is found. */
const show = (f: Fixture, view: string, params: Record<string, string> = {}, env: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: f.ctx, table: new Map(), env: { HOME: f.home, PATH: '', ...env }, viaGrant: false })

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
  it('are home, files, archive, agents and config in the navigation, and the item panel outside it, each the kernel’s; agents and config are the owner’s', async () => {
    const f = await fixture()
    expect(viewerFace.views(f.library)).toEqual({
      views: [
        expect.objectContaining({ id: 'home', nav: true, by: 'kernel' }),
        expect.objectContaining({ id: 'files', nav: true, by: 'kernel' }),
        expect.objectContaining({ id: 'archive', nav: true, by: 'kernel' }),
        expect.objectContaining({ id: 'agents', nav: true, by: 'kernel', ownerOnly: true }),
        expect.objectContaining({ id: 'config', nav: true, by: 'kernel', ownerOnly: true }),
        expect.objectContaining({ id: 'item', nav: false, by: 'kernel' }),
      ],
      problems: [],
    })
  })

  it('config, a page of management, and a plugin’s owner-only view are refused in an agent’s session, naming what showed it; the rest are open', async () => {
    const owned = plugin('owned', { views: [{ id: 'owned.setup', title: '设置', icon: 'settings', nav: true, filters: [], ownerOnly: true }], onView: async () => ({ title: '设置', subtitle: null, blocks: [] }) })
    const f = await fixture([owned])
    f.write('a.md', 'a')
    expect((await show(f, 'config')).outcome).toBe('shown')
    expect((await show(f, 'owned.setup')).outcome).toBe('shown')
    // The words are an owner-only command's (packages/cli/test/show.test.ts); here, what showed the session.
    expect(await show(f, 'config', {}, { CLAUDECODE: '1' })).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('（环境里有 CLAUDECODE）') })
    expect(await show(f, 'owned.setup', {}, { CODEX_THREAD_ID: 't' })).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('「show owned.setup」') })
    await f.reopen({ kind: 'agent', name: 'claude-code', grant: null })
    expect(await show(f, 'config')).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('（调用者是 agent claude-code）') })
    for (const [view, params] of [['files', {}], ['archive', {}], ['item', { path: 'a.md' }]] as const) expect((await show(f, view, params)).outcome).toBe('shown')
  })

  it('files lists one folder by name: a folder opens in the page, a file the item panel; the kernel’s files and the archive stay out', async () => {
    const f = await fixture()
    f.write('notes/a.md', 'a')
    f.write('top.txt', 't')
    f.write('_archive/old.md', 'o')
    const root = tableOf(await show(f, 'files'))
    expect(root.rows.map((r) => r.key)).toEqual(['notes', 'top.txt'])
    expect(root.rows[0]?.link).toEqual({ view: 'files', params: { dir: 'notes' }, target: 'main' })
    expect(root.rows[1]?.link).toEqual({ view: 'item', params: { path: 'top.txt' }, target: 'panel' })

    expect(shown(await show(f, 'files', { dir: 'notes' })).blocks[0]).toMatchObject({
      kind: 'actions',
      head: true,
      actions: [{ label: '从这台机器放进来', inputs: [{ name: 'from' }, { name: 'to', value: 'notes/' }, { name: 'source' }], call: { verb: 'put', request: { kind: 'place', from: { kind: 'file', path: '{from}' }, to: '{to}' } } }],
    })
    const notes = tableOf(await show(f, 'files', { dir: 'notes' }))
    expect(notes.rows.map((r) => r.key)).toEqual(['notes/a.md'])
    expect(shown(await show(f, 'files', { dir: '../outside' })).blocks).toMatchObject([{ kind: 'empty' }])
    expect(shown(await show(f, 'files', { dir: '.pneuma-base' })).blocks).toMatchObject([{ kind: 'empty' }])
  })

  it('archive lists one level of the archive at a time, each archived file with a take-back action, and offers a purge that asks first', async () => {
    const f = await fixture()
    f.write('_archive/d/old.md', 'o')
    const r = shown(await show(f, 'archive'))
    expect(tableOf(r).rows).toMatchObject([{ key: '_archive/d', cells: { name: { text: 'd/', icon: 'folder' } }, link: { view: 'archive', params: { dir: '_archive/d' } } }])
    const inner = tableOf(await show(f, 'archive', { dir: '_archive/d' }))
    expect(inner.rows).toMatchObject([
      { key: '_archive/d/old.md', cells: { name: { text: 'd/old.md' } }, actions: [{ label: '取回', call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path: '_archive/d/old.md' } } }] },
    ])
    expect(r.blocks[0]).toMatchObject({ kind: 'actions', head: true, actions: [{ tone: 'danger', confirm: expect.stringContaining('不能撤回'), call: { face: 'owner', command: 'archive purge' } }] })
  })

  it('files and archive say where they stand as a trail from their root, each folder above a link to it, the last the page itself', async () => {
    const f = await fixture()
    f.write('notes/deep/a.md', 'a')
    f.write('_archive/d/e/old.md', 'o')
    expect(shown(await show(f, 'files')).trail).toEqual([{ label: '文件', link: { view: 'files', params: {}, target: 'main' } }])
    expect(shown(await show(f, 'files', { dir: 'notes/deep' })).trail).toEqual([
      { label: '文件', link: { view: 'files', params: {}, target: 'main' } },
      { label: 'notes', link: { view: 'files', params: { dir: 'notes' }, target: 'main' } },
      { label: 'deep', link: { view: 'files', params: { dir: 'notes/deep' }, target: 'main' } },
    ])
    expect(shown(await show(f, 'archive', { dir: '_archive/d/e' })).trail?.map((c) => [c.label, c.link.params.dir ?? null])).toEqual([
      ['归档区', null],
      ['d', '_archive/d'],
      ['e', '_archive/d/e'],
    ])
  })

  it('each row of files stands for its place: a file, a directory thing or a folder, with its state token; the table offers archive, move and rename for each thing', async () => {
    const f = await fixture()
    f.write('site/.pneuma-item', '{"format":1}\n')
    f.write('site/index.html', '<h1>hi</h1>')
    f.write('notes/a.md', 'a')
    f.write('top.txt', 't')
    const table = tableOf(await show(f, 'files'))
    expect(table.rows.map((r) => [r.key, r.place?.kind])).toEqual([
      ['notes', 'open'],
      ['site', 'bundle'],
      ['top.txt', 'file'],
    ])
    expect(table.rows[2]?.place).toEqual({ path: 'top.txt', kind: 'file', token: expect.any(String) })
    expect(table.each?.actions.map((a) => [a.label, a.call.face === 'agent' ? a.call.request : null])).toEqual([
      ['归档', { kind: 'archive', path: '{path}' }],
      ['挪到', { kind: 'move', from: '{path}', to: '{to}' }],
    ])
    expect(table.each?.rename?.call).toMatchObject({ verb: 'put', request: { kind: 'move', from: '{path}', to: '{in}{name}' } })
    // The names in the archive are places too, and their rows keep their own take-back.
    f.write('_archive/old.md', 'o')
    expect(tableOf(await show(f, 'archive')).rows[0]?.place).toMatchObject({ path: '_archive/old.md', kind: 'file' })
  })

  it('files sorts a folder by name, by when it changed, by kind or by size, either way, and says how it is sorted; a sort it does not know is by name', async () => {
    const f = await fixture()
    f.write('b.md', 'bb')
    f.write('c.txt', 'c')
    f.write('a.png', 'aaaa')
    f.write('z/inner.md', 'z')
    const day = 86_400
    const now = Date.now() / 1000
    for (const [path, ago] of [['a.png', 3], ['b.md', 1], ['c.txt', 2]] as const) utimesSync(join(f.root, path), now - ago * day, now - ago * day)
    const order = async (sort?: string) => tableOf(await show(f, 'files', sort === undefined ? {} : { sort })).rows.map((r) => r.key)
    // By name, as storage lists a level: folders and things mixed.
    expect(await order()).toEqual(['a.png', 'b.md', 'c.txt', 'z'])
    expect(await order('-name')).toEqual(['z', 'c.txt', 'b.md', 'a.png'])
    expect(await order('-modified')).toEqual(['z', 'b.md', 'c.txt', 'a.png'])
    expect(await order('modified')).toEqual(['a.png', 'c.txt', 'b.md', 'z'])
    expect(await order('kind')).toEqual(['z', 'b.md', 'a.png', 'c.txt'])
    expect(await order('-size')).toEqual(['a.png', 'b.md', 'c.txt', 'z'])
    expect(await order('sideways')).toEqual(['a.png', 'b.md', 'c.txt', 'z'])
    expect(tableOf(await show(f, 'files', { sort: '-modified' })).sorted).toEqual({ by: 'modified', desc: true })
    expect(tableOf(await show(f, 'files')).sorted).toEqual({ by: 'name', desc: false })
  })

  it('a sorted folder longer than a page still comes 50 at a time, each page following the sort', async () => {
    const f = await fixture()
    for (let i = 0; i < 70; i++) f.write(`n${String(i).padStart(2, '0')}.md`, 'x'.repeat(i + 1))
    const first = shown(await show(f, 'files', { sort: '-size' }))
    const rows = tableOf(first).rows
    expect(rows).toHaveLength(50)
    expect(rows[0]?.key).toBe('n69.md')
    const next = tableOf(first).page?.next
    expect(next).toBeTruthy()
    const second = tableOf(await show(f, 'files', next?.params ?? {})).rows
    expect(second.map((r) => r.key)).toEqual(Array.from({ length: 20 }, (_, i) => `n${String(19 - i).padStart(2, '0')}.md`))
  })

  it('config shows the library, every plugin it knows with 装上 or 卸下, the grants with skill generation, and the storage providers', async () => {
    const f = await fixture()
    const table = new Map([
      ['ledger', plugin('ledger', { cognition: { title: '记账与对账', text: '' } })],
      ['pager', plugin('pager', { version: '0.2.0', summary: '一页字' })],
      ['bare', plugin('bare')],
    ])
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx: f.ctx, table, env: {}, viaGrant: false }))
    // The library's location in one line; its id in the folded record at the end.
    expect(r.blocks[0]).toMatchObject({ kind: 'fields', line: true, fields: [{ label: '位置', value: { text: f.root, copy: true } }] })
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && s.title)).toEqual(['插件', '授权与技能', '存储', '记录'])
    expect(sections[3]).toMatchObject({ collapse: 'closed', blocks: [{ kind: 'fields', fields: [{ label: '库标识', value: { text: f.library.config.id } }, { label: '说明' }] }] })
    const plugins = tableOf({ outcome: 'shown', title: '', subtitle: null, blocks: [sections[0] as Block], problems: [] })
    // Its version and what it brings, as plugin list shows them: the summary, else the cognition's title.
    // One not installed is grey, with the one icon that installs it.
    expect(plugins.columns.map((c) => c.label)).toEqual(['名字', '版本', '做什么'])
    expect(plugins.rows).toMatchObject([
      {
        key: 'ledger',
        cells: { name: { text: 'ledger', muted: true }, version: { text: '—', muted: true }, title: { text: '记账与对账', muted: true } },
        actions: [{ label: '装上', as: 'icon', icon: 'plus', call: { face: 'owner', command: 'plugin add', args: { positional: ['ledger'] } } }],
      },
      { key: 'pager', cells: { version: { text: '0.2.0' }, title: { text: '一页字' } }, actions: [{ label: '装上', call: { command: 'plugin add', args: { positional: ['pager'] } } }] },
      { key: 'bare', cells: { version: { text: '—', muted: true }, title: { text: '—', muted: true } } },
    ])
    expect(sections[1]).toMatchObject({ actions: [{ label: '发授权', call: { command: 'grant issue' } }] })
    expect(JSON.stringify(sections[1])).toContain('codex --add-dir')
    // Storage: the built-in local folder, the one this library uses, a form to install another from a
    // repository, and the library's noise inside it.
    const storage = sections[2]
    if (storage?.kind !== 'section') throw new Error('no storage section')
    expect(storage).toMatchObject({ actions: [{ label: '安装别的存储…', call: { command: 'storage install' } }] })
    expect(storage.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [{ key: 'local-folder', cells: { name: { text: 'local-folder' }, addresses: { text: '本机路径' }, came: { text: '随 pneuma-base 带着' }, state: { text: '这个库在用', icon: 'check' } }, actions: [] }],
    })
    expect(storage.blocks[1]).toMatchObject({ kind: 'section', title: '噪音' })

    // An installed plugin comes first with 卸下, and one this pneuma-base lacks says so.
    const installed = await fixture([plugin('ledger')])
    const config = { ...installed.library.config, plugins: [...installed.library.config.plugins, 'gone' as never] }
    const ctx = { ...installed.ctx, library: { ...installed.library, config, unavailable: ['gone' as never] } }
    const listed = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx, table: new Map([['ledger', plugin('ledger')], ['pager', plugin('pager')]]), env: {}, viaGrant: false }))
    const rows = tableOf(listed).rows
    expect(rows).toMatchObject([
      { key: 'ledger', cells: { name: { text: 'ledger' } }, actions: [{ label: '卸下', as: 'menu', call: { command: 'plugin remove', args: { positional: ['ledger'] } } }] },
      { key: 'gone', cells: { name: { tag: { text: '这个 pneuma-base 里没有' } } }, actions: [{ label: '卸下' }] },
      { key: 'pager', cells: { name: { muted: true } }, actions: [{ label: '装上' }] },
    ])
    expect(rows[0]?.cells.name?.muted).toBeUndefined()
  })

  it('item gives the archive and move actions, the file’s facts and a preview that folds; with no file there it says so', async () => {
    const f = await fixture()
    f.write('a.md', 'hello')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:预览', 'section:文件'])
    expect(r).toMatchObject({ icon: 'file', title: 'a.md', subtitle: 'a.md' })
    // Archive and move are the panel's head, each an icon with its key.
    expect(r.blocks[0]).toMatchObject({
      head: true,
      actions: [
        { label: '归档', as: 'icon', key: 'e', call: { verb: 'archive', request: { kind: 'archive', path: 'a.md' } } },
        { label: '挪到', as: 'icon', key: 'm', inputs: [{ name: 'to', value: 'a.md' }], call: { verb: 'put', request: { kind: 'move', from: 'a.md', to: '{to}' } } },
      ],
    })
    expect(r.blocks[1]).toMatchObject({ collapse: 'open', blocks: [{ kind: 'preview', path: 'a.md' }] })
    // The file's facts, folded. The panel reads no content: no fingerprint until something asks for one.
    expect(r.blocks[2]).toMatchObject({ collapse: 'closed', blocks: [{ kind: 'fields', fields: [{ label: '种类', value: { text: '文件' } }, { label: '大小', value: { text: '5 B' } }, { label: '改于', value: { at: expect.any(String) } }] }] })
    expect(shown(await show(f, 'item', { path: 'gone.md' })).blocks).toMatchObject([{ kind: 'text', tone: 'warn' }])
  })

  it('item of an archived file offers to take it back, and still finds it under its original path; of an archived path, it follows the file once it was taken back', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'a')
    for (const path of ['a.md', '_archive/a.md']) {
      const r = shown(await show(f, 'item', { path }))
      expect(r.blocks.slice(0, 2)).toMatchObject([
        { kind: 'actions', head: true, actions: [{ label: '取回', call: { request: { kind: 'unarchive', path: '_archive/a.md' } } }] },
        { kind: 'text', text: '已归档：取回之后才能改动。' },
      ])
    }
    f.write('b.md', 'b')
    const back = shown(await show(f, 'item', { path: '_archive/b.md' }))
    expect([back.title, back.subtitle]).toEqual(['b.md', 'b.md'])
  })
})

describe('bundles in the views', () => {
  const site = (f: Fixture, at = 'site') => {
    f.write(`${at}/.pneuma-item`, '{"format":1}\n')
    f.write(`${at}/index.html`, '<h1>hi</h1>')
    f.write(`${at}/css/main.css`, 'h1{}')
    f.write(`${at}/logo.svg`, '<svg/>')
  }

  it('files and archive show a bundle as one row with its own icon and how many entries its first level has; in files it opens the item panel, not a folder', async () => {
    const f = await fixture()
    site(f)
    site(f, '_archive/old')
    f.write('notes/a.md', 'a')
    f.write('top.txt', 't')
    const rows = tableOf(await show(f, 'files')).rows
    expect(rows.map((r) => r.key)).toEqual(['notes', 'site', 'top.txt'])
    // With no plugin keeping records of what is registered, a folder is only a folder.
    expect(rows[0]).toMatchObject({ cells: { name: { icon: 'folder' } }, link: { view: 'files', params: { dir: 'notes' } }, actions: [] })
    expect(rows[1]).toMatchObject({ cells: { name: { text: 'site', icon: 'package', tag: { text: '3 项' } } }, link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    expect(rows[2]?.cells.name).toMatchObject({ icon: 'file' })
    expect(tableOf(await show(f, 'archive')).rows).toMatchObject([{ key: '_archive/old', cells: { name: { text: 'old', icon: 'package', tag: { text: '3 项' } } } }])
  })

  it('with a plugin keeping records, a folder with nothing registered in it is one row: what a look found, the kernel’s two answers, and it still opens', async () => {
    const f = await fixture([plugin('keeper', { openDirs: async () => ['kept' as never] })])
    f.write('kept/a.md', 'a')
    f.write('proj/package.json', '{}')
    f.write('proj/src/main.ts', 'x')
    const rows = tableOf(await show(f, 'files')).rows
    expect(rows.map((r) => [r.key, r.cells.name?.icon, r.cells.name?.tag?.text ?? null])).toEqual([
      ['kept', 'folder', null],
      ['proj', 'folder-dot', '没登记'],
    ])
    expect(rows[1]).toMatchObject({ cells: { size: { text: '2 个文件，像一个项目（package.json）' } }, link: { view: 'files', params: { dir: 'proj' } } })
    expect(rows[1]?.actions.map((a) => [a.label, a.call.face === 'owner' ? a.call.command : a.call.verb])).toEqual([
      ['登记成一样东西', 'put'],
      ['不用管', 'noise add'],
    ])
    // Its panel says the same, with the icon of a folder nobody looked into, and lists its first level.
    const panel = shown(await show(f, 'item', { path: 'proj' }))
    expect(panel).toMatchObject({ title: 'proj/', icon: 'folder-dot' })
    expect(panel.blocks.slice(0, 3)).toMatchObject([{ kind: 'text', tone: 'warn', text: '没登记。2 个文件，像一个项目（package.json）。' }, { kind: 'actions' }, { kind: 'section', title: '里面' }])
    const kept = shown(await show(f, 'item', { path: 'kept' }))
    expect([kept.icon, kept.blocks[0]]).toMatchObject(['folder', { kind: 'text', text: '文件夹，里面有登记过的东西。' }])
  })

  it('the item panel of a bundle gives its kind and moment, and lists its first level: a file opens its own panel, a folder the files page', async () => {
    const f = await fixture()
    site(f)
    const r = shown(await show(f, 'item', { path: 'site' }))
    expect(r.icon).toBe('package')
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:里面', 'section:文件'])
    const facts = r.blocks[2]?.kind === 'section' ? r.blocks[2].blocks[0] : undefined
    expect(facts?.kind === 'fields' && facts.fields.map((x) => `${x.label}:${x.value.text}`)).toEqual(['种类:一样东西（带标记的目录）', expect.stringMatching(/^改于:/)])
    const inner = tableOf({ outcome: 'shown', title: '', subtitle: null, blocks: [r.blocks[1] as Block], problems: [] })
    expect(inner.rows.map((row) => [row.cells.path?.text, row.link?.view, row.link?.params.path ?? row.link?.params.dir])).toEqual([
      ['css/', 'files', 'site/css'],
      ['index.html', 'item', 'site/index.html'],
      ['logo.svg', 'item', 'site/logo.svg'],
    ])
  })

  it('the item panel of a file inside a bundle names the bundle, offers no archive, and previews it', async () => {
    const f = await fixture()
    site(f)
    const r = shown(await show(f, 'item', { path: 'site/index.html' }))
    // No head of actions: the bundle changes only as a whole.
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:预览', 'section:文件'])
    const facts = r.blocks[1]?.kind === 'section' ? r.blocks[1].blocks : []
    expect(facts).toMatchObject([
      { kind: 'fields', fields: expect.arrayContaining([expect.objectContaining({ label: '在', value: expect.objectContaining({ text: 'site', icon: 'package', link: { view: 'item', params: { path: 'site' }, target: 'panel' } }) })]) },
    ])
  })

  it('a plugin’s section of the panel of a file inside a bundle is asked about that file, not the bundle', async () => {
    const asked: string[] = []
    const f = await fixture([plugin('knower', { onItemView: async (path) => (asked.push(path), { title: '知道的', blocks: [] }) })])
    site(f)
    const r = shown(await show(f, 'item', { path: 'site/css/main.css' }))
    expect(asked).toEqual(['site/css/main.css'])
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:知道的', 'section:预览', 'section:文件'])
  })
})

describe('the view slot', () => {
  const pager = plugin('pager', {
    views: [{ id: 'pager.page', title: '测试页', icon: 'flask-conical', nav: true, filters: [] }],
    onView: async (req) => ({ title: '测试页', subtitle: req.params.q ?? null, blocks: [{ kind: 'text', text: 'from pager', tone: 'info' }] }),
    onItemView: async (path) => ({ title: '测试插件知道的', blocks: [{ kind: 'text', text: `pager knows ${path}`, tone: 'neutral' }] }),
  })
  const thrower = plugin('thrower', {
    views: [{ id: 'thrower.page', title: '出错的页', icon: 'triangle-alert', nav: true, filters: [] }],
    onView: async () => {
      throw new Error('thrower failed in onView')
    },
    onItemView: async () => {
      throw new Error('thrower failed in onItemView')
    },
  })

  it('lists plugin views first, in configuration order, then the kernel’s; a view outside the plugin’s name is a problem', async () => {
    const stray = plugin('stray', { views: [{ id: 'files', title: '冒名的页', icon: 'triangle-alert', nav: true, filters: [] }] })
    const f = await fixture([pager, thrower, stray])
    const { views, problems } = viewerFace.views(f.library)
    expect(views.map((v) => v.id)).toEqual(['pager.page', 'thrower.page', 'home', 'files', 'archive', 'agents', 'config', 'item'])
    expect(problems).toEqual([{ plugin: 'stray', message: 'view files does not start with stray.' }])
  })

  it('shows a plugin’s view with its parameters, a filter left out at its default, as the page does', async () => {
    const filtered = plugin('filtered', {
      views: [{ id: 'filtered.page', title: '筛', icon: 'list', nav: true, filters: [{ name: 'who', label: '谁', options: [{ value: 'all', label: '全部' }, { value: 'me', label: '我' }], default: 'all' }] }],
      onView: async (req) => ({ title: '筛', subtitle: JSON.stringify(req.params), blocks: [] }),
    })
    const f = await fixture([pager, filtered])
    expect(await show(f, 'pager.page', { q: 'x' })).toEqual({ outcome: 'shown', title: '测试页', subtitle: 'x', blocks: [{ kind: 'text', text: 'from pager', tone: 'info' }], problems: [] })
    expect(shown(await show(f, 'filtered.page')).subtitle).toBe('{"who":"all"}')
    expect(shown(await show(f, 'filtered.page', { who: 'me' })).subtitle).toBe('{"who":"me"}')
  })

  it('a plugin that throws in onView, or answers no view at all, gets a page that says so and a problem; the other views still work (K8)', async () => {
    const broken = plugin('broken', { views: [{ id: 'broken.page', title: '坏页', icon: 'triangle-alert', nav: true, filters: [] }], onView: async () => ({ title: 'x' }) as never })
    const f = await fixture([thrower, pager, broken])
    const r = shown(await show(f, 'thrower.page'))
    expect(r).toMatchObject({ title: '出错的页', blocks: [{ kind: 'empty', title: expect.stringContaining('thrower'), hint: 'thrower failed in onView' }] })
    expect(r.problems).toEqual([{ plugin: 'thrower', message: 'thrower failed in onView' }])
    expect(shown(await show(f, 'broken.page')).problems).toMatchObject([{ plugin: 'broken' }])
    expect(shown(await show(f, 'pager.page')).problems).toEqual([])
    expect(shown(await show(f, 'files')).problems).toEqual([])
  })

  it('the item panel adds one section per plugin, in configuration order, a failing one saying it failed; with no file at the path it says so, and the plugins still give their sections', async () => {
    const f = await fixture([thrower, pager])
    f.write('a.md', 'a')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:插件 thrower', 'section:测试插件知道的', 'section:预览', 'section:文件'])
    expect(r.blocks[2]).toMatchObject({ blocks: [{ text: 'pager knows a.md' }] })
    expect(r.problems).toEqual([{ plugin: 'thrower', message: 'thrower failed in onItemView' }])
    const gone = shown(await show(f, 'item', { path: 'gone.md' }))
    expect(gone.blocks).toMatchObject([{ kind: 'text', tone: 'warn' }, { kind: 'section', title: '插件 thrower' }, { kind: 'section', title: '测试插件知道的', blocks: [{ text: 'pager knows gone.md' }] }])
  })

  it('showing a view sends no event: the kernel’s views, a plugin’s view, the item panel', async () => {
    const events: Event[] = []
    const f = await fixture([pager, plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0
    f.write('a.md', 'a')
    for (const view of ['files', 'archive', 'config', 'pager.page']) await show(f, view)
    await show(f, 'item', { path: 'a.md' })
    expect(events).toEqual([])
  })
})

describe('what a plugin’s view answers is checked (D7)', () => {
  const answering = (name: string, answer: unknown, extra: Partial<Parameters<typeof plugin>[1]> = {}) =>
    plugin(name, {
      views: [{ id: `${name}.page`, title: '一页', icon: 'triangle-alert', nav: true, filters: [] }],
      onView: async () => answer as never,
      onItemView: async () => ({ title: '它知道的', blocks: (answer as { blocks: Block[] }).blocks }),
      ...extra,
    })
  const text = (t: string): Block => ({ kind: 'text', text: t, tone: 'neutral' })

  it('a block of a kind no one knows, or lacking a required field, is replaced by one saying whose and why, in a view or in the item panel; the rest stands', async () => {
    const blocks = [
      text('前面的'),
      { kind: 'sparkle' },
      { kind: 'table', columns: [{ key: 'a', label: 'A' }], empty: '空' },
      { kind: 'section', title: '一节', note: null, count: null, actions: [], blocks: [text('节里的'), { kind: 'list', items: [{ cell: { text: 1 }, note: null, actions: [] }] }] },
      text('后面的'),
    ]
    const f = await fixture([answering('odd', { title: '一页', subtitle: null, blocks })])
    const r = shown(await show(f, 'odd.page'))
    expect(r.blocks).toMatchObject([
      { kind: 'text', text: '前面的' },
      { kind: 'text', tone: 'bad', text: expect.stringMatching(/^插件 odd 的一块没法显示：.*sparkle/) },
      { kind: 'text', tone: 'bad', text: expect.stringMatching(/^插件 odd 的一块没法显示：.*rows/) },
      { kind: 'section', title: '一节', blocks: [{ kind: 'text', text: '节里的' }, { kind: 'text', tone: 'bad', text: expect.stringContaining('text') }] },
      { kind: 'text', text: '后面的' },
    ])
    expect(r.problems).toHaveLength(3)
    expect(r.problems.every((p) => p.plugin === 'odd')).toBe(true)

    // The blocks of a plugin's section in the item panel are checked the same way.
    const g = await fixture([answering('odd', { title: '一页', subtitle: null, blocks: [{ kind: 'embed', url: 'file:///etc/passwd', title: '本机文件', height: 200 }] })])
    g.write('a.md', 'a')
    const panel = shown(await show(g, 'item', { path: 'a.md' }))
    expect(panel.blocks[1]).toMatchObject({ kind: 'section', title: '它知道的', blocks: [{ kind: 'text', tone: 'bad', text: expect.stringContaining('http') }] })
    expect(panel.problems).toMatchObject([{ plugin: 'odd' }])
  })

  it('stamps a custom block with the plugin that gave it, and refuses one from a plugin without ui, with an entry that climbs out, or that does not say in words what it draws', async () => {
    const custom = (entry: string): Block => ({ kind: 'custom', entry, height: 200, text: '一条小图', data: { n: 1 }, actions: {}, plugin: 'someone-else' as never })
    const answer = { title: '一页', subtitle: null, blocks: [custom('page.html'), custom('../other/page.html')] }
    const f = await fixture([answering('drawn', answer, { ui: '/somewhere/ui' }), answering('plain', answer)])
    const drawn = shown(await show(f, 'drawn.page'))
    expect(drawn.blocks[0]).toEqual({ kind: 'custom', entry: 'page.html', height: 200, text: '一条小图', data: { n: 1 }, actions: {}, plugin: 'drawn' })
    expect(drawn.blocks[1]).toMatchObject({ kind: 'text', tone: 'bad', text: expect.stringContaining('entry') })
    const plain = shown(await show(f, 'plain.page'))
    expect(plain.blocks.map((b) => b.kind)).toEqual(['text', 'text'])
    expect(plain.problems[0]?.message).toContain('ui')

    const wordless = { kind: 'custom', entry: 'page.html', height: 200, data: null, actions: {} }
    const g = await fixture([answering('mute', { title: '一页', subtitle: null, blocks: [wordless] }, { ui: '/somewhere/ui' })])
    const mute = shown(await show(g, 'mute.page'))
    expect(mute.blocks).toMatchObject([{ kind: 'text', tone: 'bad', text: expect.stringContaining('缺少 text') }])
    expect(mute.problems).toMatchObject([{ plugin: 'mute', message: expect.stringContaining('缺少 text') }])
  })

  it('refuses a block whose action calls nothing the library runs, arguments its command does not take, a 「说」 no plugin hears, an input it does not ask for, or an input pattern that is not a regular expression', async () => {
    const tag = { name: 'tagger tag', summary: '打标签', params: { positional: [{ name: 'path', hint: '库内路径', required: true }], flags: [{ name: 'color', hint: '颜色', kind: 'value' as const, options: [{ value: 'red', label: '红' }] }] }, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done' as const, text: '' }) }
    const owner = (args: { positional: string[]; flags: Record<string, string[] | true> }, inputs: string[] = []) => ({
      label: '按钮',
      tone: 'default',
      confirm: null,
      inputs: inputs.map((name) => ({ name, label: name, placeholder: null, value: null, options: null })),
      call: { face: 'owner', command: 'tagger tag', args },
    })
    const say = (kind: string) => ({ label: '说', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'say', request: { kind, about: 'a.md', text: null, args: {} } } })
    const page = (actions: unknown[]) => ({ title: '一页', subtitle: null, blocks: actions.map((a) => ({ kind: 'actions', actions: [a] })) })
    const actions = [
      owner({ positional: ['a.md'], flags: { color: ['red'] } }),
      owner({ positional: ['{path}'], flags: { color: ['{color}'] } }, ['path', 'color']),
      say('heard'),
      { ...owner({ positional: ['a.md'], flags: {} }), call: { face: 'owner', command: 'tagger nothing', args: { positional: [], flags: {} } } },
      owner({ positional: [], flags: {} }),
      owner({ positional: ['a.md'], flags: { color: ['blue'] } }),
      owner({ positional: ['a.md', 'b.md'], flags: {} }),
      owner({ positional: ['{path}'], flags: {} }),
      say('unheard'),
      { ...say('heard'), call: { face: 'agent', verb: 'shout', request: {} } },
      { ...owner({ positional: ['{p}'], flags: {} }, ['p']), inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-' }] },
    ]
    const f = await fixture([answering('tagger', page(actions), { statements: ['heard'], onSay: async () => ({ outcome: 'heard', note: '' }), ownerCommands: [tag] })])
    const r = shown(await show(f, 'tagger.page'))
    expect(r.blocks.map((b) => b.kind)).toEqual(['actions', 'actions', 'actions', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'])
    expect(r.problems.map((p) => p.message)).toEqual([
      expect.stringContaining('主人命令「tagger nothing」这个库里没有'),
      expect.stringContaining('少了 <库内路径>'),
      expect.stringContaining('--color 只能是 red'),
      expect.stringContaining('多了参数：b.md'),
      expect.stringContaining('写了 {path}，却没有叫这个名字的输入'),
      expect.stringContaining('说的「unheard」这个库里没有插件听'),
      expect.stringContaining('不是一个动词或一条主人命令的调用'),
      expect.stringContaining('pattern'),
    ])
  })

  it('keeps a refresh of at least five seconds, raises a shorter one to five, and drops one that is not a number as a problem; keeps an open that links to a panel, and drops one that does not', async () => {
    const f = await fixture([
      answering('slow', { title: '慢', subtitle: null, blocks: [], refresh: 30 }),
      answering('eager', { title: '急', subtitle: null, blocks: [], refresh: 1 }),
      answering('wrong', { title: '错', subtitle: null, blocks: [], refresh: 'often' }),
      answering('quiet', { title: '静', subtitle: null, blocks: [] }),
    ])
    expect(shown(await show(f, 'slow.page')).refresh).toBe(30)
    expect(shown(await show(f, 'eager.page')).refresh).toBe(5)
    const wrong = shown(await show(f, 'wrong.page'))
    expect(wrong.refresh).toBeUndefined()
    expect(wrong.problems).toMatchObject([{ plugin: 'wrong', message: expect.stringContaining('refresh') }])
    expect('refresh' in shown(await show(f, 'quiet.page'))).toBe(false)

    const panel = { view: 'item', params: { path: 'a.md' }, target: 'panel' }
    const g = await fixture([
      answering('opener', { title: '开', subtitle: null, blocks: [], open: panel }),
      answering('closer', { title: '错', subtitle: null, blocks: [], open: { ...panel, target: 'main' } }),
    ])
    expect(shown(await show(g, 'opener.page')).open).toEqual(panel)
    const closer = shown(await show(g, 'closer.page'))
    expect(closer.open).toBeUndefined()
    expect(closer.problems).toMatchObject([{ plugin: 'closer', message: expect.stringContaining('open') }])
  })
})

describe('what a plugin says of files is checked too (D7)', () => {
  const answering = (name: string, answer: unknown) => plugin(name, { views: [{ id: `${name}.page`, title: '一页', icon: 'triangle-alert', nav: true, filters: [] }], onView: async () => answer as never })
  const archive = (path: string) => ({ label: '归档', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path } } })
  const table = (extra: object) => ({ kind: 'table', columns: [{ key: 'name', label: '名字' }], rows: [{ key: 'a.md', cells: { name: { text: 'a.md' } }, link: null, actions: [], place: { path: 'a.md', kind: 'file', token: null } }], empty: '', ...extra })

  it('lets a table’s each actions take {path} and {in} and no other input it does not ask for; a row’s place and a cell’s reopen must have their shape', async () => {
    const f = await fixture([
      answering('fine', { title: '一页', subtitle: null, blocks: [table({ each: { actions: [archive('{path}')], rename: { ...archive('{in}{name}'), inputs: [{ name: 'name', label: '名字', placeholder: null, value: null, options: null }] } } })] }),
      answering('stray', { title: '一页', subtitle: null, blocks: [table({ each: { actions: [archive('{where}')], rename: null } })] }),
      answering('placeless', { title: '一页', subtitle: null, blocks: [{ ...table({}), rows: [{ key: 'a', cells: {}, link: null, actions: [], place: { path: 'a.md' } }] }] }),
      answering('reopener', { title: '一页', subtitle: null, blocks: [{ kind: 'fields', fields: [{ label: '场景', value: { text: 's', reopen: { url: 1 } } }] }] }),
    ])
    expect(shown(await show(f, 'fine.page')).blocks[0]?.kind).toBe('table')
    for (const [view, words] of [['stray.page', '{where}'], ['placeless.page', 'place'], ['reopener.page', 'reopen']] as const) {
      const r = shown(await show(f, view))
      expect([r.blocks[0]?.kind, r.problems.map((p) => p.message).join('\n')]).toEqual(['text', expect.stringContaining(words)])
    }
  })

  it('keeps a trail of names and links, and drops one that is not as a problem', async () => {
    const crumb = { label: '根', link: { view: 'files', params: {}, target: 'main' } }
    const f = await fixture([answering('trailing', { title: '一页', subtitle: null, blocks: [], trail: [crumb] }), answering('lost', { title: '一页', subtitle: null, blocks: [], trail: [{ label: '根' }] })])
    expect(shown(await show(f, 'trailing.page')).trail).toEqual([crumb])
    const lost = shown(await show(f, 'lost.page'))
    expect(lost.trail).toBeUndefined()
    expect(lost.problems).toMatchObject([{ plugin: 'lost', message: expect.stringContaining('trail') }])
  })
})

describe('the new blocks are checked too (D7)', () => {
  const answering = (name: string, answer: unknown) =>
    plugin(name, { views: [{ id: `${name}.page`, title: '一页', icon: 'triangle-alert', nav: true, filters: [{ name: 'who', label: '谁', options: [{ value: '', label: '全部' }], default: '' }] }], onView: async () => answer as never })
  const page = (blocks: unknown[], extra: object = {}) => ({ title: '一页', subtitle: null, blocks, ...extra })
  const archive = { label: '取回', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path: '_archive/a.md' } } }
  const row = (extra: object = {}) => ({ key: 'f1', at: '2026-11-25T01:00:00.000Z', actor: { kind: 'agent', name: 'claude-code', grant: 'g' }, text: '归档 a.md', meta: [{ text: '场景 s' }], whose: 'agent', link: null, ...extra })
  const good = [
    { kind: 'feed', groups: [{ title: '今天', count: 2, rows: [row({ action: archive }), row({ key: 'f2', actor: '记账', whose: 'observed', settled: '已定' })] }], empty: '没有' },
    { kind: 'stats', stats: [{ label: '放入', value: '4', note: null }, { label: '时长', value: '3 分钟', note: '刚开始' }] },
    { kind: 'tree', param: 'dir', selected: 'a', nodes: [{ value: '', label: '全部', count: 3, children: [{ value: 'a', label: 'a', count: null, children: [] }] }] },
    { kind: 'asks', asks: [{ key: 'k', by: { kind: 'owner', name: '主人' }, text: '要上线吗？', about: 'a.md', actions: [archive, archive], suggested: 1 }], empty: '没有' },
    { kind: 'fields', fields: [{ label: '谁', value: { text: 'claude-code', actor: { kind: 'agent', name: 'claude-code' } } }] },
    { kind: 'chart', form: 'line', text: '要收拾的从 3 样降到 1 样。', unit: '样', x: ['周一', '周二'], series: [{ label: '可能过期', values: [3, 1] }, { label: '来历不明', values: [0, -0.5] }] },
    { kind: 'chart', form: 'stacked', text: '放进 4 样。', unit: '', x: ['今天'], series: [{ label: 'a', values: [1] }, { label: 'b', values: [0] }, { label: 'c', values: [2] }, { label: 'd', values: [1] }] },
  ]

  it('lets a feed, stats, a tree, asks, charts, an actor on a cell, link cells, embeds, timeline actions and patterned inputs through as they are, with the filter options the view answered', async () => {
    const options = [{ value: '', label: '全部', count: 3 }, { value: 'x', label: '某个', count: 1 }]
    const act = { label: '放回', tone: 'default', confirm: '放回这一版？', inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-z]+', hint: '小写字母' }], call: { face: 'owner', command: 'grant revoke', args: { positional: ['{p}'], flags: {} } } }
    const blocks = [
      { kind: 'fields', fields: [{ label: '地址', value: { text: 'https://example.com/', href: 'https://example.com/', copy: true } }] },
      { kind: 'embed', url: 'http://127.0.0.1:18080/apps/demo/', title: '预览', height: 320 },
      { kind: 'timeline', entries: [{ at: '2026-11-25T01:00:00.000Z', title: { text: '第 1 版' }, lines: [], tag: null, actions: [act] }] },
    ]
    const f = await fixture([answering('fine', page([...good, ...blocks], { filters: [{ name: 'who', options }] }))])
    const r = shown(await show(f, 'fine.page'))
    expect(r.problems).toEqual([])
    expect(r.blocks).toEqual([...good, ...blocks])
    expect(r.filters).toEqual([{ name: 'who', options }])
  })

  it('replaces a malformed one with a block saying why, and drops filter options for a filter the view does not declare', async () => {
    const bad = [
      { kind: 'feed', groups: [{ title: '今天', count: 1, rows: [row({ action: archive, settled: '已定' })] }], empty: '没有' },
      { kind: 'feed', groups: [{ title: '今天', count: 1, rows: [row({ whose: 'someone' })] }], empty: '没有' },
      { kind: 'stats', stats: [{ label: '放入', value: 4, note: null }] },
      { kind: 'tree', param: 'dir', selected: '', nodes: [{ value: '', label: '全部', count: 3 }] },
      { kind: 'asks', asks: [{ key: 'k', by: '某人', text: '要吗？', about: null, actions: [archive], suggested: 1 }], empty: '没有' },
      { kind: 'fields', fields: [{ label: '谁', value: { text: 'x', actor: { kind: 'robot', name: 'x' } } }] },
      { kind: 'chart', form: 'pie', text: '一句', unit: '样', x: ['a'], series: [{ label: 's', values: [1] }] },
      { kind: 'chart', form: 'bars', text: '一句', unit: '样', x: ['a', 'b'], series: [{ label: 's', values: [1] }] },
      { kind: 'chart', form: 'bars', text: '一句', unit: '样', x: ['a'], series: [] },
      { kind: 'chart', form: 'bars', text: '一句', unit: '样', x: ['a'], series: ['1', '2', '3', '4', '5'].map((label) => ({ label, values: [1] })) },
      { kind: 'chart', form: 'stacked', text: '一句', unit: '样', x: ['a'], series: [{ label: 's', values: [-1] }] },
      { kind: 'chart', form: 'line', text: '一句', unit: '样', x: ['a'], series: [{ label: 's', values: ['1'] }] },
      { kind: 'chart', form: 'line', unit: '样', x: ['a'], series: [{ label: 's', values: [1] }] },
    ]
    const f = await fixture([answering('odd', page(bad, { filters: [{ name: 'nope', options: [] }] }))])
    const r = shown(await show(f, 'odd.page'))
    expect(r.blocks.map((b) => b.kind === 'text' && b.tone)).toEqual(Array(bad.length).fill('bad'))
    expect(r.problems).toHaveLength(bad.length + 1)
    expect(r.problems.at(-1)?.message).toContain('nope')
    expect(r.filters).toEqual([])
  })
})

describe('the home page', () => {
  const asker = (name: string, asks: unknown) => plugin(name, { onAsks: async () => asks as never })
  const off: Action = { label: '不上线', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path: 'a.md' } } }

  it('with no plugin, says so under what waits on the owner, and shows the files', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const r = shown(await show(f, 'home'))
    expect(r.title).toBe('首页')
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:开始', 'section:等你决定', 'text', 'section:库里的文件'])
    expect(r.blocks[1]).toMatchObject({ count: null, blocks: [{ kind: 'asks', asks: [], empty: '没有要你决定的事。' }] })
    expect(r.blocks[2]).toMatchObject({ tone: 'neutral', text: expect.stringContaining('没装插件') })
    expect(tableOf(r).rows.map((row) => row.key)).toEqual(['a.md'])
  })

  it('stands each plugin’s asks first, by the plugin’s title, then the blocks of each view a plugin gives the home page, in configuration order', async () => {
    const part = (name: string) =>
      plugin(name, {
        cognition: { title: `插件${name}`, text: '它做的事。' },
        views: [{ id: `${name}.home`, title: '一部分', icon: 'house', nav: false, filters: [], home: true }],
        onView: async () => ({ title: '一部分', subtitle: null, blocks: [{ kind: 'text', text: `${name} 的部分`, tone: 'neutral' }] }),
        onAsks: async () => [{ key: `${name}:a`, text: `${name} 问`, about: null, actions: [off] }],
      })
    const f = await fixture([part('one'), part('two')])
    const r = shown(await show(f, 'home'))
    expect(r.problems).toEqual([])
    expect(r.blocks[1]).toMatchObject({ title: '等你决定', count: 2, blocks: [{ kind: 'asks', asks: [{ key: 'one:a', by: '插件one', text: 'one 问' }, { key: 'two:a', by: '插件two' }] }] })
    expect(r.blocks.slice(2)).toMatchObject([{ text: 'one 的部分' }, { text: 'two 的部分' }])
  })

  it('leaves out an ask that is not one, as the plugin’s problem; check carries the same asks, each with whose it is', async () => {
    const f = await fixture([asker('good', [{ key: 'k', text: '要上线吗？', about: 'a.md', actions: [off], suggested: 0 }]), asker('bad', [{ key: 'k', text: 3, about: null, actions: [] }]), asker('worse', 'nothing')])
    const r = shown(await show(f, 'home'))
    expect(r.blocks[1]).toMatchObject({ blocks: [{ asks: [{ key: 'k', by: 'good' }] }] })
    expect(r.problems.map((p) => p.plugin)).toEqual(['bad', 'worse'])
    const check = await agentFace.check({ since: 'last', includeArchived: false }, f.ctx)
    expect(check.asks).toMatchObject([{ key: 'k', by: 'good', text: '要上线吗？', suggested: 0 }])
    expect(check.problems.map((p) => p.plugin)).toEqual(['bad', 'worse'])
  })

  const stepper = (name: string, done: boolean, inner: unknown[] = [{ kind: 'text', text: `${name} 的一步`, tone: 'neutral' }]) =>
    plugin(name, {
      views: [{ id: `${name}.home`, title: '一部分', icon: 'house', nav: false, filters: [], home: true }],
      onView: async () => ({ title: '一部分', subtitle: null, blocks: [{ kind: 'steps', steps: [{ key: name, title: `${name} 这一步`, done, summary: done ? '做了' : null, blocks: inner }] }, { kind: 'text', text: `${name} 的部分`, tone: 'neutral' }] as never }),
    })

  it('opens with 开始 while a step is left: the kernel’s two, then the steps the home parts give, which leave those parts; drops it once every step is done, the parts’ steps included', async () => {
    const f = await fixture([stepper('one', false)])
    const r = shown(await show(f, 'home'))
    expect(r.problems).toEqual([])
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:开始', 'section:等你决定', 'text'])
    expect(r.blocks[0]).toMatchObject({ note: '0 / 3', blocks: [{ kind: 'steps', steps: [{ key: 'connect', done: false }, { key: 'first', done: false }, { key: 'one', title: 'one 这一步', blocks: [{ text: 'one 的一步' }] }] }] })
    expect(r.blocks[2]).toMatchObject({ text: 'one 的部分' })

    const g = await fixture([stepper('one', true)])
    g.write('a.md', 'a')
    expect(shown(await show(g, 'home')).blocks[0]).toMatchObject({ title: '开始', note: '2 / 3' })
    await saveConnection(g.home, { format: 1, grant: 'claude-code', grantId: 'g', product: 'claude-code', library: g.root, way: 'skill', at: g.ctx.now, wrote: { kind: 'skill', file: `${g.home}/SKILL.md`, fingerprint: 'x', dirs: [] }, command: null })
    expect(shown(await show(g, 'home')).blocks.map((b) => (b.kind === 'section' ? b.title : b.kind))).toEqual(['等你决定', 'text'])
  })

  it('checks the blocks inside a part’s steps as a section’s, and a drop as a block of its own', async () => {
    const f = await fixture([stepper('one', false, [{ kind: 'nope' }, { kind: 'drop', to: 'inbox', command: 'pneuma-base put <文件> --to inbox/<名字>' }])])
    const r = shown(await show(f, 'home'))
    expect(r.problems).toEqual([{ plugin: 'one', message: expect.stringContaining('steps[0].blocks[0] 是不认识的块：nope') }])
    const steps = flat(r.blocks).find((b) => b.kind === 'steps')
    expect(steps?.kind === 'steps' && steps.steps.find((s) => s.key === 'one')).toMatchObject({ blocks: [{ kind: 'text', tone: 'bad' }, { kind: 'drop', to: 'inbox' }] })
  })
})
