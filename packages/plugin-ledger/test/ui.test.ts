// Run 2 C3 at the ledger: the items view and the ledger's section of the item panel, through the
// kernel's viewer face, from the same fold and reconcile that inspect and check use. Views write nothing.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, viewerFace, type Actor, type Block, type Instant, type Session, type ViewResult } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { ledger } from '../src/index.js'

const table = new Map([[ledger.name as string, ledger]])
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session = (id: string): Session => ({ id, source: 'flag', cwd: '/work/shop', machine: 'test', transcript: null })
let second = 0
const next = () => `2026-11-25T02:00:${String(second++).padStart(2, '0')}.000Z` as Instant
const text = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })

async function relayed() {
  second = 0
  const base = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-ui-')))
  const root = join(base, 'lib')
  const home = join(base, 'home')
  await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init'), home })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const ctx = () => makeContext(lib, claude, session('sess-a'), home, next())
  await agentFace.say({ kind: 'doing', about: null, text: '给小店选支付服务', args: {} }, ctx())
  await agentFace.put({ kind: 'place', from: text('stripe'), to: 'src/stripe.html', origin: { kind: 'brought', source: 'https://stripe.com/pricing', by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('old'), to: 'old.md', origin: { kind: 'brought', source: null, by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('cmp'), to: 'comparison.md', origin: { kind: 'made', from: ['src/stripe.html'], outside: ['主人说客户在欧洲'] } }, ctx())
  await agentFace.put({ kind: 'place', from: text('rec'), to: 'recommendation.md', origin: { kind: 'made', from: ['comparison.md'], outside: [] } }, ctx())
  await agentFace.say({ kind: 'decided', about: 'comparison.md', text: '用 Paddle', args: {} }, ctx())
  await agentFace.archive({ kind: 'archive', path: 'old.md' }, ctx())
  const show = (view: string, params: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: makeContext(lib, { kind: 'owner' }, session('ui'), home, next()), table })
  /** Later work by codex in another scene. */
  const codex = () => makeContext(lib, { kind: 'agent', name: 'codex', grant: null }, session('sess-b'), home, next())
  return { root, show, codex }
}

function shown(r: ViewResult) {
  if (r.outcome !== 'shown') throw new Error('not shown')
  expect(r.problems).toEqual([])
  return r
}

const rowsOf = (r: ViewResult) => {
  const table = shown(r).blocks[0]
  if (table?.kind !== 'table') throw new Error('no table')
  return table.rows
}

/** A row as text: each cell's text and tag. */
const line = (cells: Record<string, { text: string; tag?: { text: string } }>) =>
  Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, [c.text, c.tag?.text].filter(Boolean).join(' ')]))

const sectionNamed = (blocks: Block[], title: string) => {
  const s = blocks.find((b) => b.kind === 'section' && b.title === title)
  if (s?.kind !== 'section') throw new Error(`no section ${title}`)
  return s
}

describe('the items view', () => {
  it('lists each item with its path, origin, who, what was being done, its state and time; archived ones only when asked', async () => {
    const { show } = await relayed()
    const rows = rowsOf(await show('ledger.items'))
    expect(rows.map((r) => line(r.cells))).toEqual([
      { path: 'recommendation.md', origin: '做出来的', who: 'claude-code', doing: '给小店选支付服务', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'comparison.md', origin: '做出来的', who: 'claude-code', doing: '给小店选支付服务', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'src/stripe.html', origin: '带进来的', who: 'claude-code', doing: '给小店选支付服务', state: '一致', at: '2026-11-25 02:00Z' },
    ])
    expect(rows[0]?.link).toEqual({ view: 'item', params: { path: 'recommendation.md' }, target: 'panel' })
    const all = rowsOf(await show('ledger.items', { archived: 'yes' }))
    expect(all.map((r) => line(r.cells).path)).toContain('old.md 已归档')
    expect(all.find((r) => r.cells.path?.text === 'old.md')?.link?.params.path).toBe('_archive/old.md')
  })

  it('filters by origin and by state; a changed source marks what was made from it', async () => {
    const { root, show } = await relayed()
    expect(rowsOf(await show('ledger.items', { origin: 'brought' })).map((r) => r.cells.path?.text)).toEqual(['src/stripe.html'])
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    expect(rowsOf(await show('ledger.items', { state: 'changed' })).map((r) => line(r.cells))).toMatchObject([{ path: 'src/stripe.html', state: '已变' }])
    expect(rowsOf(await show('ledger.items', { state: 'marked' })).map((r) => line(r.cells))).toMatchObject([{ path: 'comparison.md', state: '一致 可能过期' }])
  })
})

describe('the item panel’s provenance section', () => {
  it('gives provenance, scene, basis with each source’s state and a link to it, dependents, decisions, versions', async () => {
    const { show } = await relayed()
    const r = shown(await show('item', { path: 'comparison.md' }))
    const provenance = sectionNamed(r.blocks, '来历')
    const fields = provenance.blocks[0]
    expect(fields?.kind === 'fields' && fields.fields.map((f) => `${f.label}:${[f.value.text, f.value.tag?.text].filter(Boolean).join(' ')}`)).toEqual([
      '怎么来的:做出来的',
      '谁:claude-code',
      '何时:2026-11-25 02:00Z',
      '在哪:/work/shop',
      '场景:sess-a',
      '当时在做:给小店选支付服务',
      '现状:一致',
      expect.stringMatching(/^条目号:i_/),
    ])
    const basis = sectionNamed(provenance.blocks, '依据')
    expect(basis).toMatchObject({
      count: 2,
      blocks: [{ kind: 'list', items: [{ cell: { text: 'src/stripe.html', tag: { text: '一致' }, link: { view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' } } }, { cell: { text: '主人说客户在欧洲' }, note: '库外' }] }],
    })
    expect(sectionNamed(provenance.blocks, '被什么依据')).toMatchObject({ blocks: [{ items: [{ cell: { text: 'recommendation.md', link: { params: { path: 'recommendation.md' } } } }] }] })
    expect(sectionNamed(provenance.blocks, '决定与备注')).toMatchObject({ blocks: [{ kind: 'timeline', entries: [{ title: { text: '用 Paddle' }, tag: { text: '决定' } }] }] })
    expect(sectionNamed(provenance.blocks, '版本')).toMatchObject({ count: 1, blocks: [{ kind: 'timeline', entries: [{ tag: { text: '当前' } }] }] })
  })

  it('shows a brought source with where it came from', async () => {
    const { show } = await relayed()
    const fields = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历').blocks[0]
    expect(fields?.kind === 'fields' && fields.fields.slice(0, 2).map((f) => f.value.text || f.value.tag?.text)).toEqual(['带进来的', 'https://stripe.com/pricing'])
  })

  it('says a file nobody registered has no known origin, and gives no section where neither file nor item is', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    expect(sectionNamed(shown(await show('item', { path: 'dropped.md' })).blocks, '来历').blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('来历不明') }, { kind: 'actions' }])
    expect(shown(await show('item', { path: 'nothing.md' })).blocks.filter((b) => b.kind === 'section')).toEqual([])
  })

  it('writes no fact: no view adopts, records or takes back anything, not even a move it sees', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    renameSync(join(root, 'recommendation.md'), join(root, 'moved-recommendation.md'))
    const facts = () => readdirSync(join(root, '.pneuma-base/ledger/facts'), { recursive: true }).length
    const before = facts()
    await show('ledger.items', { archived: 'yes' })
    for (const path of ['comparison.md', 'dropped.md', 'old.md']) await show('item', { path })
    for (const view of ['ledger.scenes', 'ledger.standing', 'ledger.activity']) shown(await show(view))
    shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(facts()).toBe(before)
  })
})

/** The blocks of a view, nested sections opened. */
const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))
const tableIn = (blocks: Block[]) => {
  const table = flat(blocks).find((b) => b.kind === 'table')
  if (table?.kind !== 'table') throw new Error('no table')
  return table
}

const listIn = (section: Block) => {
  const list = flat([section]).find((b) => b.kind === 'list')
  if (list?.kind !== 'list') throw new Error('no list')
  return list.items
}

describe('the scenes view', () => {
  it('lists each session newest first: when, who, where, what was being done, how many things; a row opens its scene card', async () => {
    const { show, codex } = await relayed()
    await agentFace.say({ kind: 'doing', about: null, text: '把支付服务接进小店', args: {} }, codex())
    await agentFace.put({ kind: 'place', from: text('int'), to: 'integration.md', origin: { kind: 'made', from: ['recommendation.md'], outside: [] } }, codex())
    const r = shown(await show('ledger.scenes'))
    // The library was made at the real time, after the test's sessions at 02:00Z.
    const rows = tableIn(r.blocks).rows
    expect(rows.map((row) => line(row.cells))).toEqual([
      { at: expect.any(String), who: '主人', where: '/work/shop', doing: '主人面的操作：init', things: '—' },
      { at: '2026-11-25 02:00Z', who: 'codex', where: '/work/shop', doing: '把支付服务接进小店', things: '1' },
      { at: '2026-11-25 02:00Z', who: 'claude-code', where: '/work/shop', doing: '给小店选支付服务', things: '4' },
    ])
    expect(rows[1]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-b' }, target: 'panel' })
    expect(rows[1]?.cells.at?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)
  })

  it('says what to do when there is no scene yet', async () => {
    const base = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-ui-')))
    const home = join(base, 'home')
    const root = join(base, 'lib')
    await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init'), home })
    rmSync(join(root, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
    const lib = await openLibrary(root, table)
    if (!lib) throw new Error('no library')
    const r = shown(await viewerFace.show({ view: 'ledger.scenes', params: {} }, { ctx: makeContext(lib, { kind: 'owner' }, session('ui'), home, next()), table }))
    expect(r.blocks).toMatchObject([{ kind: 'empty', hint: expect.stringContaining('start') }])
  })
})

describe('the scene card', () => {
  it('gives who, when, where, what was said and the things entered, changed or moved in it', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(r.title).toBe('场景 sess-a')
    const fields = r.blocks[0]
    expect(fields?.kind === 'fields' && fields.fields.map((f) => `${f.label}:${f.value.text}`)).toEqual([
      '谁:claude-code',
      expect.stringMatching(/^开始:2026-11-25 02:00Z$/),
      expect.stringMatching(/^最后:2026-11-25 02:00Z$/),
      '在哪:/work/shop',
      '场景号:sess-a',
    ])
    expect(sectionNamed(r.blocks, '说过的话')).toMatchObject({ blocks: [{ kind: 'timeline', entries: [{ title: { text: '给小店选支付服务' }, tag: { text: '在做' } }, { title: { text: '用 Paddle' }, tag: { text: '决定' } }] }] })
    const things = sectionNamed(r.blocks, '条目')
    expect(things.count).toBe(4)
    // A list, as the panel is narrow: each path whole, what happened to it in this scene below.
    const items = listIn(things)
    expect(items.map((i) => [i.cell.text, i.cell.tag?.text ?? null, i.note])).toEqual([
      ['src/stripe.html', null, '放入 · 带进来的'],
      ['old.md', '已归档', '放入 · 带进来的'],
      ['comparison.md', null, '放入 · 做出来的'],
      ['recommendation.md', null, '放入 · 做出来的'],
    ])
    expect(items[1]?.cell.link).toEqual({ view: 'item', params: { path: '_archive/old.md' }, target: 'panel' })
  })

  it('says so when there is no such scene', async () => {
    const { show } = await relayed()
    expect(shown(await show('ledger.scene', { scene: 'nope-nope' })).blocks).toMatchObject([{ kind: 'empty', title: '没有这个场景' }])
  })
})

describe('the standing view', () => {
  it('has a section for each kind of thing to look at, each row opening the item panel', async () => {
    const { root, show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('src'), to: 'gone-src.md', origin: { kind: 'brought', source: null, by: null } }, codex())
    await agentFace.put({ kind: 'place', from: text('uses'), to: 'uses-gone.md', origin: { kind: 'made', from: ['gone-src.md'], outside: [] } }, codex())
    await agentFace.put({ kind: 'place', from: text('moving'), to: 'moving.md', origin: { kind: 'brought', source: null, by: null } }, codex())
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    rmSync(join(root, 'gone-src.md'))
    mkdirSync(join(root, 'moved'))
    renameSync(join(root, 'moving.md'), join(root, 'moved/here.md'))

    const r = shown(await show('ledger.standing'))
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && `${s.title}:${s.count}`)).toEqual(['可能过期:1', '来源不在:1', '上游有标记:1', '没人登记过的:1', '被直接改过的:1', '不在了的:1', '挪过的:1'])
    // Each a list of things: the path opening the item panel, a note only where it says more than the section.
    const itemsOf = (title: string) => listIn(sectionNamed(r.blocks, title)).map((i) => ({ path: i.cell.text, note: i.note, open: i.cell.link?.params.path }))
    expect(itemsOf('可能过期')).toEqual([{ path: 'comparison.md', note: '依据 src/stripe.html 变了', open: 'comparison.md' }])
    expect(itemsOf('来源不在')).toEqual([{ path: 'uses-gone.md', note: '依据 gone-src.md 不在了', open: 'uses-gone.md' }])
    expect(itemsOf('上游有标记')).toEqual([{ path: 'recommendation.md', note: '上游 comparison.md 有标记', open: 'recommendation.md' }])
    expect(itemsOf('没人登记过的')).toEqual([{ path: 'dropped.md', note: null, open: 'dropped.md' }])
    expect(itemsOf('被直接改过的')).toEqual([{ path: 'src/stripe.html', note: null, open: 'src/stripe.html' }])
    expect(itemsOf('不在了的')).toEqual([{ path: 'gone-src.md', note: null, open: 'gone-src.md' }])
    expect(itemsOf('挪过的')).toEqual([{ path: 'moving.md', note: '挪到了 moved/here.md', open: 'moved/here.md' }])
    expect(listIn(sectionNamed(r.blocks, '可能过期'))[0]?.cell.link).toEqual({ view: 'item', params: { path: 'comparison.md' }, target: 'panel' })

    // The panel at the new path knows the thing that moved there.
    const panel = sectionNamed(shown(await show('item', { path: 'moved/here.md' })).blocks, '来历').blocks[0]
    expect(panel?.kind === 'fields' && panel.fields.find((f) => f.label === '现状')?.value.tag?.text).toBe('已搬到 moved/here.md')
  })

  it('says there is nothing to look at when all is in order', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.standing'))
    expect(r.blocks).toMatchObject([{ kind: 'empty', title: '没有要处理的事' }])
  })
})

describe('the activity view', () => {
  it('lists recent facts newest first, owner operations included; a fact about a thing opens it', async () => {
    const { show } = await relayed()
    const rows = tableIn(shown(await show('ledger.activity')).blocks).rows
    // The library was made at the real time, after the test's session at 02:00Z, so its init is newest.
    expect(line(rows[0]?.cells ?? {})).toMatchObject({ who: '主人', kind: '主人面', what: expect.stringContaining('主人面的操作 init') })
    expect(rows.slice(1, 4).map((row) => line(row.cells))).toEqual([
      { at: '2026-11-25 02:00Z', who: 'claude-code', kind: '归档', what: '归档 old.md', scene: 'sess-a' },
      { at: '2026-11-25 02:00Z', who: 'claude-code', kind: '决定', what: '决定：用 Paddle（关于 comparison.md）', scene: 'sess-a' },
      { at: '2026-11-25 02:00Z', who: 'claude-code', kind: '放入', what: '放入 recommendation.md（做出来的）', scene: 'sess-a' },
    ])
    expect(rows[1]?.link).toEqual({ view: 'item', params: { path: '_archive/old.md' }, target: 'panel' })
    expect(rows[1]?.cells.scene?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(rows[1]?.cells.at?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)
  })

  it('filters by who did it', async () => {
    const { show } = await relayed()
    const rows = tableIn(shown(await show('ledger.activity', { who: 'owner' })).blocks).rows
    expect(rows.map((row) => row.cells.who?.text)).toEqual(['主人'])
    expect(tableIn(shown(await show('ledger.activity', { who: 'agent' })).blocks).rows.every((row) => row.cells.who?.text === 'claude-code')).toBe(true)
  })
})

describe('the owner’s operations on the ledger’s blocks', () => {
  const actionsIn = (blocks: Block[]) => flat(blocks).flatMap((b) => (b.kind === 'actions' ? b.actions : []))

  it('a held copy can be taken back to a new path, as the owner command held restore', async () => {
    const { show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('cmp v2'), to: 'comparison.md', origin: { kind: 'made', from: ['src/stripe.html'], outside: [] } }, codex())
    const held = sectionNamed(sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历').blocks, '留存的旧版')
    expect(held.blocks.find((b) => b.kind === 'list')).toMatchObject({
      items: [
        {
          actions: [
            {
              label: '取回到新路径',
              inputs: [{ name: 'to', value: expect.stringMatching(/^comparison\.[0-9a-f]{8}\.md$/) }],
              call: { face: 'owner', command: 'held restore', args: { positional: [expect.stringMatching(/^i_/)], flags: { fingerprint: [expect.stringMatching(/^[0-9a-f]{64}$/)], to: ['{to}'] } } },
            },
          ],
        },
      ],
    })
  })

  it('a file nobody registered can be given its provenance: brought in, or made from things of the library', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const provenance = sectionNamed(shown(await show('item', { path: 'dropped.md' })).blocks, '来历')
    expect(actionsIn(provenance.blocks)).toMatchObject([
      {
        label: '记为带进来的',
        inputs: [{ name: 'source' }, { name: 'by', options: [{ value: 'owner' }, { value: '' }] }],
        call: { face: 'agent', verb: 'put', request: { kind: 'register', path: 'dropped.md', origin: { kind: 'brought', source: '{source}', by: '{by}' } } },
      },
      {
        label: '记为做出来的',
        inputs: [{ name: 'from', multiple: true }, { name: 'outside', multiple: true }],
        call: { face: 'agent', verb: 'put', request: { kind: 'register', path: 'dropped.md', origin: { kind: 'made', from: ['{from}'], outside: ['{outside}'] } } },
      },
    ])
  })

  it('a thing changed directly can be accepted as a new version, as say revised', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const provenance = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历')
    expect(actionsIn(provenance.blocks)).toMatchObject([{ label: '认下这次改动', call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: 'src/stripe.html', text: null, args: {} } } }])
    expect(actionsIn(sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历').blocks)).toEqual([])
  })

  it('the standing page offers the same on its rows: provenance for things nobody registered, accepting a direct change', async () => {
    const { root, show, codex } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    // A file nobody registered that an archive adopted: in the ledger, origin unknown.
    writeFileSync(join(root, 'adopted.md'), 'adopted')
    await agentFace.archive({ kind: 'archive', path: 'adopted.md' }, codex())
    await agentFace.archive({ kind: 'unarchive', path: '_archive/adopted.md' }, codex())
    const r = shown(await show('ledger.standing'))
    const items = (title: string) => listIn(sectionNamed(r.blocks, title))
    expect(items('没人登记过的').map((i) => [i.cell.text, i.note, i.actions.map((a) => a.label), i.actions.map((a) => a.call.face === 'agent' && a.call.verb === 'put' && a.call.request.kind === 'register' && a.call.request.path)])).toEqual([
      ['dropped.md', null, ['记为带进来的', '记为做出来的'], ['dropped.md', 'dropped.md']],
      ['adopted.md', '入了册，来历不明', ['记为带进来的', '记为做出来的'], ['adopted.md', 'adopted.md']],
    ])
    expect(items('被直接改过的')[0]?.actions).toMatchObject([{ label: '认下这次改动', call: { verb: 'say', request: { kind: 'revised', about: 'src/stripe.html' } } }])
    expect(items('可能过期')[0]?.actions).toEqual([])
  })
})

describe('bundles in the ledger’s blocks', () => {
  it('the items table marks a bundle and leaves out the things it absorbed', async () => {
    const { root, show, codex } = await relayed()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>')
    await agentFace.put({ kind: 'register', path: 'site/index.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'made', from: ['comparison.md'], outside: [] } }, codex())
    const rows = rowsOf(await show('ledger.items'))
    expect(rows.map((r) => r.cells.path?.text)).not.toContain('site/index.html')
    expect(rows.find((r) => r.cells.path?.text === 'site')?.cells.path).toMatchObject({ icon: 'package' })
    expect(rows.find((r) => r.cells.path?.text === 'comparison.md')?.cells.path).toMatchObject({ icon: 'file' })
  })

  it('the panel of a file inside a bundle says what it is part of, absorbed or never registered', async () => {
    const { root, show, codex } = await relayed()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>')
    await agentFace.put({ kind: 'register', path: 'site/index.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'brought', source: null, by: null } }, codex())
    writeFileSync(join(root, 'site/later.css'), 'h1{}')
    const absorbed = sectionNamed(shown(await show('item', { path: 'site/index.html' })).blocks, '来历').blocks[0]
    expect(absorbed?.kind === 'fields' && absorbed.fields.find((f) => f.label === '并入')?.value).toMatchObject({ text: 'site', link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    const part = sectionNamed(shown(await show('item', { path: 'site/later.css' })).blocks, '来历').blocks
    expect(part).toMatchObject([{ kind: 'fields', fields: [{ label: '是谁的一部分', value: { text: 'site', link: { params: { path: 'site' } } } }] }, { kind: 'text' }])
  })
})
