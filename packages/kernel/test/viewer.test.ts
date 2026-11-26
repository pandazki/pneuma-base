// The viewer face on a library with no plugin (K2): the kernel's three pages and the item panel,
// given as blocks; showing a view changes nothing and sends no event.
import { describe, expect, it } from 'vitest'
import { viewerFace, type Block, type Event, type ViewResult } from '../src/index.js'
import { fixture, plugin, type Fixture } from './support.js'

const show = (f: Fixture, view: string, params: Record<string, string> = {}, env: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: f.ctx, table: new Map(), env, viaGrant: false })

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
  it('are files, archive, agents and config in the navigation, and the item panel outside it, each the kernel’s; agents and config are the owner’s', async () => {
    const f = await fixture()
    expect(viewerFace.views(f.library)).toEqual({
      views: [
        expect.objectContaining({ id: 'files', nav: true, by: 'kernel' }),
        expect.objectContaining({ id: 'archive', nav: true, by: 'kernel' }),
        expect.objectContaining({ id: 'agents', nav: true, by: 'kernel', ownerOnly: true }),
        expect.objectContaining({ id: 'config', nav: true, by: 'kernel', ownerOnly: true }),
        expect.objectContaining({ id: 'item', nav: false, by: 'kernel' }),
      ],
      problems: [],
    })
  })

  it('config, a page of management, is refused in an agent’s session in the words an owner-only command is refused in; the rest are open', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect((await show(f, 'config')).outcome).toBe('shown')
    const refusal = (sign: string) => ({
      outcome: 'refused',
      reason: 'agent-session',
      text: `「show config」是替主人做的决定，只有主人能做，不能在 agent 的会话里做（${sign}）。需要的话告诉主人；主人在自己的终端里做，或在自己的终端里运行 pneuma-base view 用界面做。`,
      problems: [],
    })
    expect(await show(f, 'config', {}, { CLAUDECODE: '1' })).toEqual(refusal('环境里有 CLAUDECODE'))
    await f.reopen({ kind: 'agent', name: 'claude-code', grant: null })
    expect(await show(f, 'config')).toEqual(refusal('调用者是 agent claude-code'))
    for (const [view, params] of [['files', {}], ['archive', {}], ['item', { path: 'a.md' }]] as const) expect((await show(f, view, params)).outcome).toBe('shown')
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

    expect(shown(await show(f, 'files', { dir: 'notes' })).blocks[0]).toMatchObject({
      kind: 'actions',
      actions: [{ label: '从这台机器放进来', inputs: [{ name: 'from' }, { name: 'to', value: 'notes/' }, { name: 'source' }], call: { verb: 'put', request: { kind: 'place', from: { kind: 'file', path: '{from}' }, to: '{to}' } } }],
    })
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

  it('config shows the library, every plugin it knows with 装上 or 卸下, and the grants with skill generation', async () => {
    const f = await fixture()
    const table = new Map([
      ['ledger', plugin('ledger', { cognition: { title: '记账与对账', text: '' } })],
      ['pager', plugin('pager', { version: '0.2.0', summary: '一页字' })],
      ['bare', plugin('bare')],
    ])
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx: f.ctx, table, env: {}, viaGrant: false }))
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && s.title)).toEqual(['插件', '授权与技能'])
    const plugins = tableOf({ outcome: 'shown', title: '', subtitle: null, blocks: [sections[0] as Block], problems: [] })
    // Its version and what it brings, as plugin list shows them: the summary, else the cognition's title.
    expect(plugins.columns.map((c) => c.label)).toEqual(['名字', '版本', '做什么', '状态'])
    expect(plugins.rows).toMatchObject([
      {
        key: 'ledger',
        cells: { name: { text: 'ledger' }, version: { text: '—', muted: true }, title: { text: '记账与对账' }, state: { tag: { text: '没装' } } },
        actions: [{ label: '装上', call: { face: 'owner', command: 'plugin add', args: { positional: ['ledger'] } } }],
      },
      { key: 'pager', cells: { version: { text: '0.2.0' }, title: { text: '一页字' } }, actions: [{ label: '装上', call: { command: 'plugin add', args: { positional: ['pager'] } } }] },
      { key: 'bare', cells: { version: { text: '—', muted: true }, title: { text: '—', muted: true } } },
    ])
    expect(sections[1]).toMatchObject({ actions: [{ label: '发授权', call: { command: 'grant issue' } }] })
    expect(JSON.stringify(sections[1])).toContain('codex --add-dir')
  })

  it('config lists an installed plugin first with 卸下, and one this pneuma-base lacks as such', async () => {
    const f = await fixture([plugin('ledger')])
    const config = { ...f.library.config, plugins: [...f.library.config.plugins, 'gone' as never] }
    const ctx = { ...f.ctx, library: { ...f.library, config, unavailable: ['gone' as never] } }
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx, table: new Map([['ledger', plugin('ledger')], ['pager', plugin('pager')]]), env: {}, viaGrant: false }))
    expect(tableOf(r).rows).toMatchObject([
      { key: 'ledger', cells: { state: { tag: { text: '已装' } } }, actions: [{ label: '卸下', call: { command: 'plugin remove', args: { positional: ['ledger'] } } }] },
      { key: 'gone', cells: { state: { tag: { text: '这个 pneuma-base 里没有' } } }, actions: [{ label: '卸下' }] },
      { key: 'pager', actions: [{ label: '装上' }] },
    ])
  })

  it('item gives the archive and move actions, the file’s facts and a preview that folds; with no file there it says so', async () => {
    const f = await fixture()
    f.write('a.md', 'hello')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:文件', 'section:预览'])
    expect(r.blocks[0]).toMatchObject({
      actions: [
        { label: '归档', call: { verb: 'archive', request: { kind: 'archive', path: 'a.md' } } },
        { label: '挪到', inputs: [{ name: 'to', value: 'a.md' }], call: { verb: 'put', request: { kind: 'move', from: 'a.md', to: '{to}' } } },
      ],
    })
    expect(r.blocks[1]).toMatchObject({ blocks: [{ kind: 'fields', fields: [{ label: '路径', value: { text: 'a.md' } }, { label: '种类', value: { text: '文件' } }, { label: '大小' }, { label: '改于', value: { at: expect.any(String) } }, { label: '指纹' }] }] })
    expect(r.blocks[2]).toMatchObject({ collapse: 'open', blocks: [{ kind: 'preview', path: 'a.md' }] })
    expect(shown(await show(f, 'item', { path: 'gone.md' })).blocks).toMatchObject([{ kind: 'text', tone: 'warn' }])
  })

  it('item of an archived file offers to take it back, and still finds it under its original path', async () => {
    const f = await fixture()
    f.write('_archive/a.md', 'a')
    for (const path of ['a.md', '_archive/a.md']) {
      const r = shown(await show(f, 'item', { path }))
      expect(r.blocks[0]).toMatchObject({ actions: [{ label: '取回', call: { request: { kind: 'unarchive', path: '_archive/a.md' } } }] })
    }
  })

  it('item of an archived path follows the file once it was taken back', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const facts = flat(shown(await show(f, 'item', { path: '_archive/a.md' })).blocks).find((b) => b.kind === 'fields')
    expect(facts?.kind === 'fields' && facts.fields[0]?.value.text).toBe('a.md')
  })

  it('an unknown view is no-such-view', async () => {
    const f = await fixture()
    expect(await show(f, 'nope')).toEqual({ outcome: 'no-such-view', problems: [] })
  })
})

describe('bundles in the views', () => {
  const site = (f: Fixture, at = 'site') => {
    f.write(`${at}/.pneuma-item`, '{"format":1}\n')
    f.write(`${at}/index.html`, '<h1>hi</h1>')
    f.write(`${at}/css/main.css`, 'h1{}')
    f.write(`${at}/logo.svg`, '<svg/>')
  }

  it('files shows a bundle as one row with its own icon and file count, opening the item panel, not a folder', async () => {
    const f = await fixture()
    site(f)
    f.write('notes/a.md', 'a')
    f.write('top.txt', 't')
    const rows = tableOf(await show(f, 'files')).rows
    expect(rows.map((r) => r.key)).toEqual(['notes', 'site', 'top.txt'])
    expect(rows[0]?.cells.name).toMatchObject({ icon: 'folder' })
    expect(rows[1]).toMatchObject({ cells: { name: { text: 'site', icon: 'package', tag: { text: '3 个文件' } } }, link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    expect(rows[2]?.cells.name).toMatchObject({ icon: 'file' })
  })

  it('the item panel of a bundle gives its kind, file count, size and fingerprint, and lists its files, each opening its own panel', async () => {
    const f = await fixture()
    site(f)
    const r = shown(await show(f, 'item', { path: 'site' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:文件', 'section:里面的文件'])
    const facts = r.blocks[1]?.kind === 'section' ? r.blocks[1].blocks[0] : undefined
    expect(facts?.kind === 'fields' && facts.fields.map((x) => `${x.label}:${x.value.text}`)).toEqual(['路径:site', '种类:一样东西（带标记的目录）', '文件数:3', expect.stringMatching(/^大小:\d+ B$/), expect.stringMatching(/^改于:/), expect.stringMatching(/^指纹:[0-9a-f]{16}$/)])
    const inner = tableOf({ outcome: 'shown', title: '', subtitle: null, blocks: [r.blocks[2] as Block], problems: [] })
    expect(inner.rows.map((row) => [row.cells.path?.text, row.link?.params.path])).toEqual([
      ['css/main.css', 'site/css/main.css'],
      ['index.html', 'site/index.html'],
      ['logo.svg', 'site/logo.svg'],
    ])
  })

  it('the item panel of a file inside a bundle names the bundle, offers no archive, and previews it', async () => {
    const f = await fixture()
    site(f)
    const r = shown(await show(f, 'item', { path: 'site/index.html' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:文件', 'section:预览'])
    const facts = r.blocks[0]?.kind === 'section' ? r.blocks[0].blocks : []
    expect(facts).toMatchObject([
      { kind: 'fields', fields: expect.arrayContaining([expect.objectContaining({ label: '在', value: expect.objectContaining({ text: 'site', icon: 'package', link: { view: 'item', params: { path: 'site' }, target: 'panel' } }) })]) },
      { kind: 'text' },
    ])
  })

  it('a plugin’s section of the panel of a file inside a bundle is asked about that file, not the bundle', async () => {
    const asked: string[] = []
    const f = await fixture([plugin('knower', { onItemView: async (path) => (asked.push(path), { title: '知道的', blocks: [] }) })])
    site(f)
    const r = shown(await show(f, 'item', { path: 'site/css/main.css' }))
    expect(asked).toEqual(['site/css/main.css'])
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['section:知道的', 'section:文件', 'section:预览'])
  })

  it('archive lists an archived bundle as one row', async () => {
    const f = await fixture()
    site(f, '_archive/site')
    const rows = tableOf(await show(f, 'archive')).rows
    expect(rows).toMatchObject([{ key: '_archive/site', cells: { original: { text: 'site', icon: 'package', tag: { text: '3 个文件' } } } }])
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
    expect(views.map((v) => v.id)).toEqual(['pager.page', 'thrower.page', 'files', 'archive', 'agents', 'config', 'item'])
    expect(problems).toEqual([{ plugin: 'stray', message: 'view files does not start with stray.' }])
  })

  it('shows a plugin’s view with its parameters', async () => {
    const f = await fixture([pager])
    expect(await show(f, 'pager.page', { q: 'x' })).toEqual({ outcome: 'shown', title: '测试页', subtitle: 'x', blocks: [{ kind: 'text', text: 'from pager', tone: 'info' }], problems: [] })
  })

  it('gives a filter left out its default, as the page does', async () => {
    const filtered = plugin('filtered', {
      views: [{ id: 'filtered.page', title: '筛', icon: 'list', nav: true, filters: [{ name: 'who', label: '谁', options: [{ value: 'all', label: '全部' }, { value: 'me', label: '我' }], default: 'all' }] }],
      onView: async (req) => ({ title: '筛', subtitle: JSON.stringify(req.params), blocks: [] }),
    })
    const f = await fixture([filtered])
    expect(shown(await show(f, 'filtered.page')).subtitle).toBe('{"who":"all"}')
    expect(shown(await show(f, 'filtered.page', { who: 'me' })).subtitle).toBe('{"who":"me"}')
  })

  it('refuses a plugin’s owner-only view in an agent’s session too', async () => {
    const owned = plugin('owned', { views: [{ id: 'owned.setup', title: '设置', icon: 'settings', nav: true, filters: [], ownerOnly: true }], onView: async () => ({ title: '设置', subtitle: null, blocks: [] }) })
    const f = await fixture([owned])
    expect((await show(f, 'owned.setup')).outcome).toBe('shown')
    expect(await show(f, 'owned.setup', {}, { CODEX_THREAD_ID: 't' })).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('「show owned.setup」是替主人做的决定') })
  })

  it('a plugin that throws in onView gets a page that says so and a problem; the other views still work (K8)', async () => {
    const f = await fixture([thrower, pager])
    const r = shown(await show(f, 'thrower.page'))
    expect(r).toMatchObject({ title: '出错的页', blocks: [{ kind: 'empty', title: expect.stringContaining('thrower'), hint: 'thrower failed in onView' }] })
    expect(r.problems).toEqual([{ plugin: 'thrower', message: 'thrower failed in onView' }])
    expect(shown(await show(f, 'pager.page')).problems).toEqual([])
    expect(shown(await show(f, 'files')).problems).toEqual([])
  })

  it('a plugin that answers no view at all is failing too', async () => {
    const broken = plugin('broken', { views: [{ id: 'broken.page', title: '坏页', icon: 'triangle-alert', nav: true, filters: [] }], onView: async () => ({ title: 'x' }) as never })
    const f = await fixture([broken])
    expect(shown(await show(f, 'broken.page')).problems).toMatchObject([{ plugin: 'broken' }])
  })

  it('the item panel adds one section per plugin, in configuration order, a failing one saying it failed', async () => {
    const f = await fixture([thrower, pager])
    f.write('a.md', 'a')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:插件 thrower', 'section:测试插件知道的', 'section:文件', 'section:预览'])
    expect(r.blocks[2]).toMatchObject({ blocks: [{ text: 'pager knows a.md' }] })
    expect(r.problems).toEqual([{ plugin: 'thrower', message: 'thrower failed in onItemView' }])
  })

  it('with no file at the path the panel says so, and the plugins still give their sections', async () => {
    const f = await fixture([pager])
    const r = shown(await show(f, 'item', { path: 'gone.md' }))
    expect(r.blocks).toMatchObject([{ kind: 'text', tone: 'warn' }, { kind: 'section', title: '测试插件知道的', blocks: [{ text: 'pager knows gone.md' }] }])
  })

  it('a plugin view sends no event either', async () => {
    const events: Event[] = []
    const f = await fixture([pager, plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0
    f.write('a.md', 'a')
    await show(f, 'pager.page')
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

  it('a block of a kind no one knows, or lacking a required field, is replaced by one saying whose and why; the rest stands', async () => {
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
  })

  it('checks the blocks of a plugin’s section in the item panel the same way', async () => {
    const f = await fixture([answering('odd', { title: '一页', subtitle: null, blocks: [{ kind: 'embed', url: 'file:///etc/passwd', title: '本机文件', height: 200 }] })])
    f.write('a.md', 'a')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks[1]).toMatchObject({ kind: 'section', title: '它知道的', blocks: [{ kind: 'text', tone: 'bad', text: expect.stringContaining('http') }] })
    expect(r.problems).toMatchObject([{ plugin: 'odd' }])
  })

  it('stamps a custom block with the plugin that gave it, and refuses one from a plugin without ui or with an entry that climbs out', async () => {
    const custom = (entry: string): Block => ({ kind: 'custom', entry, height: 200, text: '一条小图', data: { n: 1 }, actions: {}, plugin: 'someone-else' as never })
    const answer = { title: '一页', subtitle: null, blocks: [custom('page.html'), custom('../other/page.html')] }
    const f = await fixture([answering('drawn', answer, { ui: '/somewhere/ui' }), answering('plain', answer)])
    const drawn = shown(await show(f, 'drawn.page'))
    expect(drawn.blocks[0]).toEqual({ kind: 'custom', entry: 'page.html', height: 200, text: '一条小图', data: { n: 1 }, actions: {}, plugin: 'drawn' })
    expect(drawn.blocks[1]).toMatchObject({ kind: 'text', tone: 'bad', text: expect.stringContaining('entry') })
    const plain = shown(await show(f, 'plain.page'))
    expect(plain.blocks.map((b) => b.kind)).toEqual(['text', 'text'])
    expect(plain.problems[0]?.message).toContain('ui')
  })

  it('refuses a custom block that does not say in words what it draws', async () => {
    const wordless = { kind: 'custom', entry: 'page.html', height: 200, data: null, actions: {} }
    const f = await fixture([answering('mute', { title: '一页', subtitle: null, blocks: [wordless] }, { ui: '/somewhere/ui' })])
    const r = shown(await show(f, 'mute.page'))
    expect(r.blocks).toMatchObject([{ kind: 'text', tone: 'bad', text: expect.stringContaining('缺少 text') }])
    expect(r.problems).toMatchObject([{ plugin: 'mute', message: expect.stringContaining('缺少 text') }])
  })

  it('refuses a block whose action calls nothing the library runs, arguments its command does not take, a 「说」 no plugin hears, or an input it does not ask for', async () => {
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
    ]
    const f = await fixture([answering('tagger', page(actions), { statements: ['heard'], onSay: async () => ({ outcome: 'heard', note: '' }), ownerCommands: [tag] })])
    const r = shown(await show(f, 'tagger.page'))
    expect(r.blocks.map((b) => b.kind)).toEqual(['actions', 'actions', 'actions', 'text', 'text', 'text', 'text', 'text', 'text', 'text'])
    expect(r.problems.map((p) => p.message)).toEqual([
      expect.stringContaining('主人命令「tagger nothing」这个库里没有'),
      expect.stringContaining('少了 <库内路径>'),
      expect.stringContaining('--color 只能是 red'),
      expect.stringContaining('多了参数：b.md'),
      expect.stringContaining('写了 {path}，却没有叫这个名字的输入'),
      expect.stringContaining('说的「unheard」这个库里没有插件听'),
      expect.stringContaining('不是一个动词或一条主人命令的调用'),
    ])
  })

  it('keeps a refresh of at least five seconds, raises a shorter one to five, and drops one that is not a number as a problem', async () => {
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
  })

  it('lets the new fields through: link cells, embeds, timeline actions, patterned inputs', async () => {
    const act = { label: '放回', tone: 'default', confirm: '放回这一版？', inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-z]+', hint: '小写字母' }], call: { face: 'owner', command: 'grant revoke', args: { positional: ['{p}'], flags: {} } } }
    const blocks = [
      { kind: 'fields', fields: [{ label: '地址', value: { text: 'https://example.com/', href: 'https://example.com/', copy: true } }] },
      { kind: 'embed', url: 'http://127.0.0.1:18080/apps/demo/', title: '预览', height: 320 },
      { kind: 'timeline', entries: [{ at: '2026-11-25T01:00:00.000Z', title: { text: '第 1 版' }, lines: [], tag: null, actions: [act] }] },
    ]
    const f = await fixture([answering('fine', { title: '好', subtitle: null, blocks })])
    const r = shown(await show(f, 'fine.page'))
    expect(r.problems).toEqual([])
    expect(r.blocks).toEqual(blocks)
  })

  it('refuses an input pattern that is not a regular expression', async () => {
    const act = { label: '设', tone: 'default', confirm: null, inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-' }], call: { face: 'owner', command: 'grant revoke', args: { positional: ['{p}'], flags: {} } } }
    const f = await fixture([answering('regex', { title: '一页', subtitle: null, blocks: [{ kind: 'actions', actions: [act] }] })])
    const r = shown(await show(f, 'regex.page'))
    expect(r.blocks).toMatchObject([{ kind: 'text', tone: 'bad', text: expect.stringContaining('pattern') }])
  })
})
