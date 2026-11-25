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

  it('config shows the library, every plugin it knows with 装上 or 卸下, and the grants with skill generation', async () => {
    const f = await fixture()
    const table = new Map([
      ['ledger', plugin('ledger', { cognition: { title: '记账与对账', text: '' } })],
      ['pager', plugin('pager', { version: '0.2.0', summary: '一页字' })],
      ['bare', plugin('bare')],
    ])
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx: f.ctx, table }))
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
    const r = shown(await viewerFace.show({ view: 'config', params: {} }, { ctx, table: new Map([['ledger', plugin('ledger')], ['pager', plugin('pager')]]) }))
    expect(tableOf(r).rows).toMatchObject([
      { key: 'ledger', cells: { state: { tag: { text: '已装' } } }, actions: [{ label: '卸下', call: { command: 'plugin remove', args: { positional: ['ledger'] } } }] },
      { key: 'gone', cells: { state: { tag: { text: '这个 pneuma-base 里没有' } } }, actions: [{ label: '卸下' }] },
      { key: 'pager', actions: [{ label: '装上' }] },
    ])
  })

  it('item gives the archive action, the file’s facts and a preview that folds; with no file there it says so', async () => {
    const f = await fixture()
    f.write('a.md', 'hello')
    const r = shown(await show(f, 'item', { path: 'a.md' }))
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:文件', 'section:预览'])
    expect(r.blocks[0]).toMatchObject({ actions: [{ label: '归档', call: { verb: 'archive', request: { kind: 'archive', path: 'a.md' } } }] })
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
    views: [{ id: 'pager.page', title: '测试页', icon: 'flask', nav: true, filters: [] }],
    onView: async (req) => ({ title: '测试页', subtitle: req.params.q ?? null, blocks: [{ kind: 'text', text: 'from pager', tone: 'info' }] }),
    onItemView: async (path) => ({ title: '测试插件知道的', blocks: [{ kind: 'text', text: `pager knows ${path}`, tone: 'neutral' }] }),
  })
  const thrower = plugin('thrower', {
    views: [{ id: 'thrower.page', title: '出错的页', icon: 'x', nav: true, filters: [] }],
    onView: async () => {
      throw new Error('thrower failed in onView')
    },
    onItemView: async () => {
      throw new Error('thrower failed in onItemView')
    },
  })

  it('lists plugin views first, in configuration order, then the kernel’s; a view outside the plugin’s name is a problem', async () => {
    const stray = plugin('stray', { views: [{ id: 'files', title: '冒名的页', icon: 'x', nav: true, filters: [] }] })
    const f = await fixture([pager, thrower, stray])
    const { views, problems } = viewerFace.views(f.library)
    expect(views.map((v) => v.id)).toEqual(['pager.page', 'thrower.page', 'files', 'archive', 'config', 'item'])
    expect(problems).toEqual([{ plugin: 'stray', message: 'view files does not start with stray.' }])
  })

  it('shows a plugin’s view with its parameters', async () => {
    const f = await fixture([pager])
    expect(await show(f, 'pager.page', { q: 'x' })).toEqual({ outcome: 'shown', title: '测试页', subtitle: 'x', blocks: [{ kind: 'text', text: 'from pager', tone: 'info' }], problems: [] })
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
    const broken = plugin('broken', { views: [{ id: 'broken.page', title: '坏页', icon: 'x', nav: true, filters: [] }], onView: async () => ({ title: 'x' }) as never })
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
      views: [{ id: `${name}.page`, title: '一页', icon: 'x', nav: true, filters: [] }],
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
    const custom = (entry: string): Block => ({ kind: 'custom', entry, height: 200, data: { n: 1 }, actions: {}, plugin: 'someone-else' as never })
    const answer = { title: '一页', subtitle: null, blocks: [custom('page.html'), custom('../other/page.html')] }
    const f = await fixture([answering('drawn', answer, { ui: '/somewhere/ui' }), answering('plain', answer)])
    const drawn = shown(await show(f, 'drawn.page'))
    expect(drawn.blocks[0]).toEqual({ kind: 'custom', entry: 'page.html', height: 200, data: { n: 1 }, actions: {}, plugin: 'drawn' })
    expect(drawn.blocks[1]).toMatchObject({ kind: 'text', tone: 'bad', text: expect.stringContaining('entry') })
    const plain = shown(await show(f, 'plain.page'))
    expect(plain.blocks.map((b) => b.kind)).toEqual(['text', 'text'])
    expect(plain.problems[0]?.message).toContain('ui')
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
    const act = { label: '放回', tone: 'default', confirm: '放回这一版？', inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-z]+', hint: '小写字母' }], call: { face: 'owner', command: 'x', args: { positional: [], flags: {} } } }
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
    const act = { label: '设', tone: 'default', confirm: null, inputs: [{ name: 'p', label: '前缀', placeholder: null, value: null, options: null, pattern: '[a-' }], call: { face: 'owner', command: 'x', args: { positional: [], flags: {} } } }
    const f = await fixture([answering('regex', { title: '一页', subtitle: null, blocks: [{ kind: 'actions', actions: [act] }] })])
    const r = shown(await show(f, 'regex.page'))
    expect(r.blocks).toMatchObject([{ kind: 'text', tone: 'bad', text: expect.stringContaining('pattern') }])
  })
})
