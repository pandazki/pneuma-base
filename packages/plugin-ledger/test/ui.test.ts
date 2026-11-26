// Run 2 C3 at the ledger: the items view and the ledger's section of the item panel, through the
// kernel's viewer face, from the same fold and reconcile that inspect and check use. Views write nothing.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, viewerFace, type Actor, type Block, type Instant, type Library, type Session, type ViewResult } from '@pneuma-base/kernel'
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
  const show = (view: string, params: Record<string, string> = {}, ctx = makeContext(lib, { kind: 'owner' }, session('ui'), home, next())) => viewerFace.show({ view, params }, { ctx, table, env: {}, viaGrant: false })
  /** Later work by codex in another scene. */
  const codex = () => makeContext(lib, { kind: 'agent', name: 'codex', grant: null }, session('sess-b'), home, next())
  /** Later work by claude-code in a scene of its own. */
  const claudeIn = (id: string) => makeContext(lib, claude, session(id), home, next())
  return { root, show, codex, claudeIn }
}

function shown(r: ViewResult) {
  if (r.outcome !== 'shown') throw new Error('not shown')
  expect(r.problems).toEqual([])
  return r
}

/** The blocks of a view, nested sections opened. */
const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))
const tableIn = (blocks: Block[]) => {
  const table = flat(blocks).find((b) => b.kind === 'table')
  if (table?.kind !== 'table') throw new Error('no table')
  return table
}
const rowsOf = (r: ViewResult) => tableIn(shown(r).blocks).rows
/** A feed's rows, every group's in order. */
const feedRows = (blocks: Block[]) => {
  const feed = flat(blocks).find((b) => b.kind === 'feed')
  if (feed?.kind !== 'feed') throw new Error('no feed')
  return feed.groups.flatMap((g) => g.rows)
}
const nameOf = (actor: string | { name: string }) => (typeof actor === 'string' ? actor : actor.name)

/** A row as text: each cell's text and tag. */
const line = (cells: Record<string, { text: string; tag?: { text: string } }>) =>
  Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, [c.text, c.tag?.text].filter(Boolean).join(' ')]))

const sectionNamed = (blocks: Block[], title: string) => {
  const s = blocks.find((b) => b.kind === 'section' && b.title === title)
  if (s?.kind !== 'section') throw new Error(`no section ${title}`)
  return s
}

const listIn = (section: Block) => {
  const list = flat([section]).find((b) => b.kind === 'list')
  if (list?.kind !== 'list') throw new Error('no list')
  return list.items
}

/** The actions of the panel's bottom row, and of any other actions block. */
const actionsIn = (blocks: Block[]) => flat(blocks).flatMap((b) => (b.kind === 'actions' ? b.actions : []))

describe('the library page', () => {
  it('lists each item with its path, origin, who, its state and time, an origin and a normal state in grey words; a row opens the panel', async () => {
    const { show } = await relayed()
    const rows = rowsOf(await show('ledger.items'))
    expect(rows.map((r) => line(r.cells))).toEqual([
      { path: 'recommendation.md', origin: '做出来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'comparison.md', origin: '做出来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'src/stripe.html', origin: '带进来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
    ])
    expect(rows[0]?.cells.who).toMatchObject({ actor: { kind: 'agent', name: 'claude-code' } })
    expect(rows[0]?.cells.state).toEqual({ text: '一致', muted: true })
    expect(rows[0]?.cells.origin).toEqual({ text: '做出来的', muted: true })
    expect(rows[0]?.link).toEqual({ view: 'item', params: { path: 'recommendation.md' }, target: 'panel' })
  })

  it('shows all, brought, made or archived, each option with how many it shows', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.items'))
    expect(r.filters).toEqual([
      {
        name: 'show',
        options: [
          { value: '', label: '全部', count: 3 },
          { value: 'brought', label: '带进来的', count: 1 },
          { value: 'made', label: '做出来的', count: 2 },
          { value: 'archived', label: '已归档', count: 1 },
        ],
      },
    ])
    expect(rowsOf(await show('ledger.items', { show: 'brought' })).map((r) => r.cells.path?.text)).toEqual(['src/stripe.html'])
    const archived = rowsOf(await show('ledger.items', { show: 'archived' }))
    expect(archived.map((r) => line(r.cells).path)).toEqual(['old.md 已归档'])
    expect(archived[0]?.link?.params.path).toBe('_archive/old.md')
  })

  it('has a folder tree first, each folder with how many it holds; choosing one is the view’s dir', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.items'))
    expect(r.blocks[0]).toEqual({ kind: 'tree', param: 'dir', selected: '', nodes: [{ value: '', label: '全部文件夹', count: 3, children: [{ value: 'src', label: 'src', count: 1, children: [] }] }] })
    const inSrc = shown(await show('ledger.items', { dir: 'src' }))
    expect(rowsOf(inSrc).map((row) => row.cells.path?.text)).toEqual(['src/stripe.html'])
    expect(inSrc.blocks[0]).toMatchObject({ kind: 'tree', selected: 'src' })
  })

  it('marks what changed and what was made from it, as tags', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const states = Object.fromEntries(rowsOf(await show('ledger.items')).map((r) => [r.cells.path?.text, r.cells.state]))
    expect(states['src/stripe.html']).toEqual({ text: '', tag: { text: '已变', tone: 'warn' } })
    expect(states['comparison.md']).toEqual({ text: '', tag: { text: '可能过期', tone: 'warn' } })
    expect(states['recommendation.md']).toEqual({ text: '一致', muted: true })
  })
})

describe('the ledger’s part of the item panel', () => {
  it('says when, who and in which scene; how it came, each source with its state; what happened; by which grant; what built on it', async () => {
    const { show } = await relayed()
    const r = shown(await show('item', { path: 'comparison.md' }))
    const provenance = sectionNamed(r.blocks, '来历')
    const fields = provenance.blocks[0]
    expect(fields?.kind === 'fields' && fields.fields.map((f) => `${f.label}:${[f.value.text, f.value.tag?.text].filter(Boolean).join(' ')}`)).toEqual([
      '何时:2026-11-25 02:00Z',
      '谁:claude-code',
      '场景:给小店选支付服务',
      '在哪:/work/shop',
    ])
    expect(fields?.kind === 'fields' && fields.fields[2]?.value.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(provenance.blocks.filter((b) => b.kind === 'section').map((b) => b.kind === 'section' && b.title)).toEqual(['怎么来的', '发生过什么', '凭什么', '被什么依据'])
    const came = sectionNamed(provenance.blocks, '怎么来的')
    expect(came).toMatchObject({
      count: 2,
      blocks: [
        { kind: 'fields', fields: [{ label: '来历', value: { text: '做出来的', muted: true } }] },
        { kind: 'list', items: [{ cell: { text: 'src/stripe.html', link: { view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' } }, note: '一致' }, { cell: { text: '主人说客户在欧洲' }, note: '库外' }] },
      ],
    })
    expect(listIn(came)[0]?.cell.tag).toBeUndefined()
    expect(sectionNamed(provenance.blocks, '发生过什么')).toMatchObject({ count: 2, blocks: [{ kind: 'timeline', entries: [{ title: { text: '用 Paddle' }, tag: { text: '决定' } }, { title: { text: '放进来' } }] }] })
    expect(sectionNamed(provenance.blocks, '凭什么')).toMatchObject({ blocks: [{ kind: 'text', text: expect.stringContaining('没带授权') }] })
    expect(sectionNamed(provenance.blocks, '被什么依据')).toMatchObject({ blocks: [{ items: [{ cell: { text: 'recommendation.md', link: { params: { path: 'recommendation.md' } } } }] }] })
    // The panel's order: what it is, the plugins' parts, the file, then the actions in one row at the bottom.
    expect(r.blocks[0]).toMatchObject({ kind: 'text', text: expect.stringMatching(/^文件 · /) })
    expect(r.blocks.at(-1)).toMatchObject({ kind: 'actions' })
    expect(actionsIn([r.blocks.at(-1) as Block]).map((a) => a.label)).toEqual(['归档', '挪到', '补上依据', '记一条决定', '记一条备注'])
  })

  it('says 决定 once: the tag says it, the grey line under it says who and in which scene', async () => {
    const { show } = await relayed()
    const happened = sectionNamed(sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历').blocks, '发生过什么').blocks[0]
    const decision = happened?.kind === 'timeline' ? happened.entries.find((e) => e.title.text === '用 Paddle') : undefined
    expect(decision?.tag?.text).toBe('决定')
    expect(decision?.lines).toEqual(['claude-code · 场景 sess-a'])
  })

  it('shows a brought source with where it came from', async () => {
    const { show } = await relayed()
    const came = sectionNamed(sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历').blocks, '怎么来的').blocks[0]
    expect(came?.kind === 'fields' && came.fields.map((f) => f.value.text || f.value.tag?.text)).toEqual(['带进来的', 'https://stripe.com/pricing'])
  })

  it('says a file nobody registered has no known origin, and gives no section where neither file nor item is', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const r = shown(await show('item', { path: 'dropped.md' }))
    expect(sectionNamed(r.blocks, '来历').blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('来历不明') }])
    expect(actionsIn(r.blocks).map((a) => a.label)).toEqual(['归档', '挪到', '记为带进来的', '记为做出来的'])
    expect(shown(await show('item', { path: 'nothing.md' })).blocks.filter((b) => b.kind === 'section')).toEqual([])
  })

  it('writes no fact: no view adopts, records or takes back anything, not even a move it sees', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    renameSync(join(root, 'recommendation.md'), join(root, 'moved-recommendation.md'))
    const facts = () => readdirSync(join(root, '.pneuma-base/ledger/facts'), { recursive: true }).length
    const before = facts()
    await show('ledger.items', { show: 'archived' })
    for (const path of ['comparison.md', 'dropped.md', 'old.md']) await show('item', { path })
    for (const view of ['home', 'ledger.scenes', 'ledger.standing', 'ledger.activity']) shown(await show(view))
    shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(facts()).toBe(before)
  })
})

describe('the scenes page', () => {
  it('has one row per session, newest first, by day: who, what it was doing, how many things it put, where; a row opens its scene', async () => {
    const { show, codex } = await relayed()
    await agentFace.say({ kind: 'doing', about: null, text: '把支付服务接进小店', args: {} }, codex())
    await agentFace.put({ kind: 'place', from: text('int'), to: 'integration.md', origin: { kind: 'made', from: ['recommendation.md'], outside: [] } }, codex())
    const rows = feedRows(shown(await show('ledger.scenes')).blocks)
    // The library was made at the real time, after the test's sessions at 02:00Z.
    expect(rows.map((row) => [nameOf(row.actor), row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['主人', '主人面的操作：init', '没放东西', '/work/shop'],
      ['codex', '把支付服务接进小店', '放入 1 样', '/work/shop'],
      ['claude-code', '给小店选支付服务', '放入 4 样', '/work/shop'],
    ])
    expect(rows[1]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-b' }, target: 'panel' })
    expect(rows[1]?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)
  })

  it('says what to do when there is no scene yet', async () => {
    const base = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-ui-')))
    const home = join(base, 'home')
    const root = join(base, 'lib')
    await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init'), home })
    rmSync(join(root, '.pneuma-base/ledger/facts'), { recursive: true, force: true })
    const lib = await openLibrary(root, table)
    if (!lib) throw new Error('no library')
    const r = shown(await viewerFace.show({ view: 'ledger.scenes', params: {} }, { ctx: makeContext(lib, { kind: 'owner' }, session('ui'), home, next()), table, env: {}, viaGrant: false }))
    expect(r.blocks).toMatchObject([{ kind: 'empty', hint: expect.stringContaining('start') }])
  })
})

describe('a scene’s page', () => {
  it('gives four figures, who and where, then what happened in it, newest first', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(r.title).toBe('给小店选支付服务')
    expect(r.blocks.map((b) => b.kind)).toEqual(['stats', 'fields', 'feed'])
    expect(r.blocks[0]).toEqual({
      kind: 'stats',
      stats: [
        { label: '时长', value: '不到 1 分钟', note: '2026-11-25 02:00Z 开始' },
        { label: '放入', value: '4', note: '带进来 2 样，做出来 2 样' },
        { label: '依据', value: '3', note: '库外 1 句' },
        { label: '决定', value: '1', note: '用 Paddle' },
      ],
    })
    const fields = r.blocks[1]
    expect(fields?.kind === 'fields' && fields.fields.map((f) => `${f.label}:${f.value.text}`)).toEqual(['谁:claude-code', '在哪:/work/shop', '场景号:sess-a'])
    const rows = feedRows(r.blocks)
    expect(rows.map((row) => row.text)).toEqual([
      '归档 old.md',
      '决定：用 Paddle（关于 comparison.md）',
      '放入 recommendation.md（做出来的）',
      '放入 comparison.md（做出来的）',
      '放入 old.md（现在在 _archive/old.md）（带进来的）',
      '放入 src/stripe.html（带进来的）',
      '在做：给小店选支付服务',
    ])
    // An archive that still stands can be taken back from its row; a fact with no undo says nothing there.
    expect(rows[0]).toMatchObject({ action: { label: '取回', call: { verb: 'archive', request: { kind: 'unarchive', path: '_archive/old.md' } } } })
    expect(rows[1]?.action).toBeUndefined()
    expect(rows[1]?.settled).toBeUndefined()
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
    renameSync(join(root, 'moving.md'), join(root, 'src/here.md'))

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
    expect(itemsOf('挪过的')).toEqual([{ path: 'moving.md', note: '挪到了 src/here.md', open: 'src/here.md' }])
    expect(listIn(sectionNamed(r.blocks, '可能过期'))[0]?.cell.link).toEqual({ view: 'item', params: { path: 'comparison.md' }, target: 'panel' })

    // The panel at the new path knows the thing that moved there.
    const panel = sectionNamed(shown(await show('item', { path: 'src/here.md' })).blocks, '来历').blocks[0]
    expect(panel?.kind === 'fields' && panel.fields.find((f) => f.label === '现状')?.value.tag?.text).toBe('已搬到 src/here.md')
  })

  // tmp/run-7: nothing below a directory no record points into is opened, so a thing moved there is
  // not followed: it is not where it was, and the directory is one line to answer.
  it('does not follow a thing into a directory nobody looked into', async () => {
    const { root, show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('moving'), to: 'moving.md', origin: { kind: 'brought', source: null, by: null } }, codex())
    mkdirSync(join(root, 'moved'))
    renameSync(join(root, 'moving.md'), join(root, 'moved/here.md'))
    const r = shown(await show('ledger.standing'))
    expect(r.blocks.filter((b) => b.kind === 'section').map((s) => s.kind === 'section' && `${s.title}:${s.count}`)).toEqual(['没登记的目录:1', '不在了的:1'])
    expect(listIn(sectionNamed(r.blocks, '没登记的目录')).map((i) => [i.cell.text, i.actions?.map((a) => a.label)])).toEqual([['moved/', ['登记成一样东西', '登记里面的文件', '不用管']]])
  })

  it('says there is nothing to look at when all is in order', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.standing'))
    expect(r.blocks).toMatchObject([{ kind: 'empty', title: '没有要处理的事' }])
  })
})

describe('the activity page', () => {
  it('has the facts newest first by day, owner operations included: who, the sentence, in which scene, by which grant; a fact about a thing opens it', async () => {
    const { show } = await relayed()
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    // The library was made at the real time, after the test's session at 02:00Z, so its init is newest.
    expect(rows[0]).toMatchObject({ actor: { kind: 'owner', name: '主人' }, whose: 'owner', text: expect.stringContaining('主人面的操作 init') })
    expect(rows.slice(1, 4).map((row) => [nameOf(row.actor), row.whose, row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['claude-code', 'agent', '归档 old.md', '给小店选支付服务', '没带授权'],
      ['claude-code', 'agent', '决定：用 Paddle（关于 comparison.md）', '给小店选支付服务', '没带授权'],
      ['claude-code', 'agent', '放入 recommendation.md（做出来的）', '给小店选支付服务', '没带授权'],
    ])
    expect(rows[1]?.link).toEqual({ view: 'item', params: { path: '_archive/old.md' }, target: 'panel' })
    expect(rows[1]?.meta[0]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(rows[1]?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)
  })

  it('keeps the agents’ or the owner’s, or one agent’s; each option says how many it keeps', async () => {
    const { show, codex } = await relayed()
    await agentFace.say({ kind: 'note', about: 'comparison.md', text: '看过了', args: {} }, codex())
    const r = shown(await show('ledger.activity'))
    expect(r.filters).toEqual([
      { name: 'who', options: [{ value: '', label: '全部', count: 9 }, { value: 'agent', label: 'agent 做的', count: 8 }, { value: 'owner', label: '主人做的', count: 1 }] },
      { name: 'agent', options: [{ value: '', label: '全部 agent', count: 9 }, { value: 'claude-code', label: 'claude-code', count: 7 }, { value: 'codex', label: 'codex', count: 1 }] },
    ])
    expect(feedRows(shown(await show('ledger.activity', { who: 'owner' })).blocks).map((row) => nameOf(row.actor))).toEqual(['主人'])
    expect(feedRows(shown(await show('ledger.activity', { agent: 'codex' })).blocks).map((row) => row.text)).toEqual(['备注：看过了（关于 comparison.md）'])
  })
})

describe('the ledger’s part of the home page', () => {
  /** The home page as an agent sees it, which is what the owner sees of the agents. */
  it('tells what others did since the last look, by scene under what it was doing, with 都看过了, which is a check; then what needs looking at', async () => {
    const { root, show, codex } = await relayed()
    const asCodex = () => show('home', {}, codex())
    const first = shown(await asCodex())
    // No agent is connected on this machine, so the page opens with 开始; the ledger's step in it is done.
    expect(first.blocks.map((b) => (b.kind === 'section' ? b.title : b.kind))).toEqual(['开始', '等你决定', '自上次以来', '需要留意'])
    const since = sectionNamed(first.blocks, '自上次以来')
    expect(since.actions).toMatchObject([{ label: '都看过了', call: { face: 'agent', verb: 'check', request: { since: 'last', includeArchived: false } } }])
    const feed = since.blocks[0]
    if (feed?.kind !== 'feed') throw new Error('no feed')
    // init is setup, already told by PNEUMA-BASE.md, so it is no news.
    expect(feed.groups.map((g) => [g.title, g.count])).toEqual([['给小店选支付服务', 6]])
    expect(feed.groups[0]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(feed.groups[0]?.rows.map((r) => r.text)).not.toContain('在做：给小店选支付服务')
    expect(sectionNamed(first.blocks, '需要留意').blocks).toMatchObject([{ kind: 'text', tone: 'neutral' }])

    await agentFace.check({ since: 'last', includeArchived: false }, codex())
    // Nothing since: when that look was, and the way to all that ever happened.
    const seen = sectionNamed(shown(await asCodex()).blocks, '自上次以来')
    expect(seen).toMatchObject({ actions: [], note: '上次看过：2026-11-25 02:00Z', blocks: [{ kind: 'feed', groups: [], empty: '那之后还没有谁做过什么。' }, { kind: 'list' }] })
    expect(listIn(seen).map((i) => [i.cell.text, i.cell.link])).toEqual([['看全部活动', { view: 'ledger.activity', params: {}, target: 'main' }]])

    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const attention = sectionNamed(shown(await asCodex()).blocks, '需要留意')
    expect(listIn(attention).map((i) => [i.cell.text, i.cell.link])).toEqual([
      ['1 样可能过期', { view: 'ledger.standing', params: { kind: 'stale' }, target: 'main' }],
      ['1 样上游有标记', { view: 'ledger.standing', params: { kind: 'upstream' }, target: 'main' }],
      ['1 样被直接改过的', { view: 'ledger.standing', params: { kind: 'changed' }, target: 'main' }],
    ])
    expect(sectionNamed(shown(await show('ledger.standing', { kind: 'changed' })).blocks, '被直接改过的').count).toBe(1)
    expect(shown(await show('ledger.standing', { kind: 'changed' })).blocks).toHaveLength(1)
  })
})

describe('the ledger’s part of the home page, when a scene only said what it was doing', () => {
  it('tells that sentence as the group’s row, and counts it', async () => {
    const { show, codex, claudeIn } = await relayed()
    await agentFace.check({ since: 'last', includeArchived: false }, codex())
    await agentFace.say({ kind: 'doing', about: null, text: '整理首页文案', args: {} }, claudeIn('sess-c'))
    const since = sectionNamed(shown(await show('home', {}, codex())).blocks, '自上次以来')
    const feed = since.blocks[0]
    expect(feed?.kind === 'feed' && feed.groups.map((g) => [g.title, g.count, g.rows.map((r) => r.text)])).toEqual([['整理首页文案', 1, ['在做：整理首页文案']]])
    expect(since.note).toBe('claude-code 做了 1 件事')
  })
})

describe('things nobody registered', () => {
  /** A folder with files in it that becomes a library, and the owner's way to its pages and commands. */
  async function folderWithFiles(count: number) {
    second = 0
    const base = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-ui-')))
    const root = join(base, 'lib')
    const home = join(base, 'home')
    mkdirSync(join(root, 'notes'), { recursive: true })
    for (let i = 0; i < count; i++) writeFileSync(join(root, i % 2 ? `notes/n${i}.md` : `f${i}.txt`), `file ${i}`)
    // The files were there a while before the folder became a library.
    for (let i = 0; i < count; i++) utimesSync(join(root, i % 2 ? `notes/n${i}.md` : `f${i}.txt`), new Date('2026-01-01'), new Date('2026-01-01'))
    await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init'), home })
    const lib = (await openLibrary(root, table)) as Library
    const owner = () => makeContext(lib, { kind: 'owner' }, session('ui'), home, new Date().toISOString() as Instant)
    const show = (view: string, params: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: owner(), table, env: {}, viaGrant: false })
    const run = (call: { command: string; args: { positional: string[]; flags: Record<string, string[] | true> } }) =>
      ownerFace.dispatch({ ctx: owner(), table, env: {}, viaGrant: false, confirm: async () => true }, call.command, call.args)
    const asks = async () => (flat(shown(await show('home')).blocks).find((b) => b.kind === 'asks') as Extract<Block, { kind: 'asks' }>).asks
    return { root, show, run, asks }
  }

  // tmp/run-7 section 7: asked per place. The loose files of an open directory are one question; a
  // directory nothing registered is in is another, with its three answers, and is never opened.
  it('is one question per place on the home page, not something to look at', async () => {
    const { show, asks } = await folderWithFiles(3)
    const [loose, closed, ...more] = await asks()
    expect(more).toEqual([])
    expect(loose).toMatchObject({ by: '记账与对账', text: '库的根目录有 2 个文件还没登记。都记为你带进来的吗？', suggested: 0 })
    expect(loose?.actions.map((a) => [a.label, a.call])).toEqual([
      ['都记为我带进来的', { face: 'owner', command: 'ledger register', args: { positional: ['.'], flags: {} } }],
      ['不登记，不再问', { face: 'owner', command: 'ledger leave', args: { positional: ['.'], flags: {} } }],
    ])
    expect(closed).toMatchObject({ text: 'notes/ 没登记。', about: 'notes' })
    expect(closed?.actions.map((a) => [a.label, a.call])).toEqual([
      ['登记成一样东西', { face: 'agent', verb: 'put', request: { kind: 'register', path: 'notes', origin: { kind: 'brought', source: null, by: 'owner' }, note: null } }],
      ['登记里面的文件', { face: 'owner', command: 'ledger register', args: { positional: ['notes'], flags: { inside: true } } }],
      ['不用管', { face: 'owner', command: 'noise add', args: { positional: ['notes'], flags: {} } }],
    ])
    // Nothing else to look at, said without claiming the unregistered things match a record.
    expect(sectionNamed(shown(await show('home')).blocks, '需要留意').blocks).toEqual([{ kind: 'text', tone: 'neutral', text: '没有要留意的：登记过的东西都和记录的一样。' }])
  })

  it('registered place by place: each is the owner’s, brought in; the activity has one row for each act; nothing is asked any more', async () => {
    const { show, run, asks } = await folderWithFiles(3)
    const register = (await asks())[0]?.actions[0]?.call
    if (register?.face !== 'owner') throw new Error('no owner call')
    expect(await run(register)).toMatchObject({ outcome: 'done', text: '已把 2 样东西记为主人带进来的。', data: { registered: 2 } })
    const inside = (await asks()).find((a) => a.about === 'notes')?.actions[1]?.call
    if (inside?.face !== 'owner') throw new Error('no owner call')
    expect(await run(inside)).toMatchObject({ outcome: 'done', text: '已把 notes/里的 1 个文件记为主人带进来的。', data: { registered: 1 } })
    expect(await asks()).toEqual([])
    const came = sectionNamed(sectionNamed(shown(await show('item', { path: 'notes/n1.md' })).blocks, '来历').blocks, '怎么来的').blocks[0]
    expect(came?.kind === 'fields' && came.fields[0]?.value.text).toBe('带进来的，主人给的')
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    expect(rows.map((r) => r.text).filter((t) => t.includes('ledger register') || t.includes('放入'))).toEqual([
      '主人面的操作 ledger register：已把 notes/里的 1 个文件记为主人带进来的。',
      '主人面的操作 ledger register：已把 2 样东西记为主人带进来的。',
    ])
    expect(shown(await show('ledger.standing')).blocks).toMatchObject([{ kind: 'empty' }])
  })

  it('left as they are: not asked about again, still on the standing page; a later pile is asked about anew', async () => {
    const { root, show, run, asks } = await folderWithFiles(4)
    const leave = (await asks())[0]?.actions[1]?.call
    if (leave?.face !== 'owner') throw new Error('no owner call')
    expect(await run(leave)).toMatchObject({ outcome: 'done', data: { left: 2 } })
    const closedOnly = ['notes/ 没登记。']
    expect((await asks()).map((a) => a.text)).toEqual(closedOnly)
    expect(sectionNamed(shown(await show('ledger.standing')).blocks, '没人登记过的').count).toBe(2)
    writeFileSync(join(root, 'later.md'), 'dropped in later')
    expect((await asks()).map((a) => a.text)).toEqual(['库的根目录有 1 个文件还没登记。都记为你带进来的吗？', ...closedOnly])
  })
})

describe('the owner’s operations on the ledger’s blocks', () => {
  it('a held copy can be taken back to a new path, as the owner command ledger held restore', async () => {
    const { show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('cmp v2'), to: 'comparison.md', origin: { kind: 'made', from: ['src/stripe.html'], outside: [] } }, codex())
    const held = sectionNamed(sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历').blocks, '留存')
    expect(held.blocks.find((b) => b.kind === 'list')).toMatchObject({
      items: [
        {
          // Whose content it was, not where the plugin keeps it.
          note: 'claude-code 放进来的那份内容',
          actions: [
            {
              label: '取回到新路径',
              inputs: [{ name: 'to', value: expect.stringMatching(/^comparison\.[0-9a-f]{8}\.md$/) }],
              call: { face: 'owner', command: 'ledger held restore', args: { positional: [expect.stringMatching(/^i_/)], flags: { fingerprint: [expect.stringMatching(/^[0-9a-f]{64}$/)], to: ['{to}'] } } },
            },
          ],
        },
      ],
    })
  })

  it('a file nobody registered can be given its provenance: brought in, or made from things of the library', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const panel = shown(await show('item', { path: 'dropped.md' }))
    expect(actionsIn(panel.blocks).filter((a) => a.label.startsWith('记为'))).toMatchObject([
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
    const accept = (blocks: Block[]) => actionsIn(blocks).filter((a) => a.label === '认下这次改动')
    expect(accept(shown(await show('item', { path: 'src/stripe.html' })).blocks)).toMatchObject([{ call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: 'src/stripe.html', text: null, args: {} } } }])
    expect(accept(shown(await show('item', { path: 'comparison.md' })).blocks)).toEqual([])
  })

  it('an edit the owner made and an agent recorded names both, in the panel and in the activity', async () => {
    const { root, show, codex } = await relayed()
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    await agentFace.say({ kind: 'revised', about: 'src/stripe.html', text: null, args: { by: ['owner'] } }, codex())
    const activity = feedRows(shown(await show('ledger.activity')).blocks)
    expect(activity.filter((row) => row.text === '记下 src/stripe.html 是主人直接改的').map((row) => nameOf(row.actor))).toEqual(['codex'])
    await agentFace.put({ kind: 'place', from: text('stripe v3'), to: 'src/stripe.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    const provenance = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历')
    expect(sectionNamed(provenance.blocks, '发生过什么').blocks[0]).toMatchObject({ entries: [{ tag: { text: '当前' } }, { title: { text: '主人直接改的' }, lines: [expect.stringMatching(/^主人，codex 代记 · 场景 sess-b · [0-9a-f]{8}$/)] }, {}] })
    expect(sectionNamed(provenance.blocks, '留存').blocks.find((b) => b.kind === 'list')).toMatchObject({ items: [{ note: '主人直接改的那份内容，codex 代记' }] })
  })

  it('a put’s note is a line of that content’s entry in the panel, and ends its row in the activity', async () => {
    const { show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('cmp v2'), to: 'comparison.md', origin: { kind: 'made', from: [], outside: [] }, note: '换了结论' }, codex())
    const provenance = sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历')
    const changes = sectionNamed(provenance.blocks, '发生过什么').blocks[0]
    const lines = changes?.kind === 'timeline' ? changes.entries.filter((e) => e.title.text !== '用 Paddle').map((e) => e.lines) : []
    expect(lines).toEqual([[expect.stringMatching(/^codex · 场景 sess-b · [0-9a-f]{8}$/), '换了结论'], [expect.stringMatching(/^claude-code · 场景 sess-a · [0-9a-f]{8}$/)]])
    const activity = feedRows(shown(await show('ledger.activity')).blocks)
    expect(activity.filter((row) => nameOf(row.actor) === 'codex').map((row) => row.text)).toEqual(['comparison.md 换了新内容：换了结论'])
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
    // Each kind lists its rows by path, as the rows are asked for.
    expect(items('没人登记过的').map((i) => [i.cell.text, i.note, i.actions.map((a) => a.label), i.actions.map((a) => a.call.face === 'agent' && a.call.verb === 'put' && a.call.request.kind === 'register' && a.call.request.path)])).toEqual([
      ['adopted.md', '入了册，来历不明', ['记为带进来的', '记为做出来的'], ['adopted.md', 'adopted.md']],
      ['dropped.md', null, ['记为带进来的', '记为做出来的'], ['dropped.md', 'dropped.md']],
    ])
    expect(items('被直接改过的')[0]?.actions).toMatchObject([{ label: '认下这次改动', call: { verb: 'say', request: { kind: 'revised', about: 'src/stripe.html' } } }])
    expect(items('可能过期')[0]?.actions).toEqual([])
    // Nobody knowing where it came from is the one origin worth a tag.
    const adopted = rowsOf(await show('ledger.items')).find((row) => row.cells.path?.text === 'adopted.md')
    expect(adopted?.cells.origin).toMatchObject({ text: '', tag: { tone: 'warn' } })
  })
})

describe('bundles in the ledger’s blocks', () => {
  it('the items table marks a bundle and leaves out the things it absorbed', async () => {
    const { root, show, codex } = await relayed()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>')
    await agentFace.put({ kind: 'register', path: 'site/index.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    // A directory holding a registered thing is open: registering it takes its loose files, unless its marker makes it one thing.
    writeFileSync(join(root, 'site/.pneuma-item'), '')
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
    writeFileSync(join(root, 'site/.pneuma-item'), '')
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'brought', source: null, by: null } }, codex())
    writeFileSync(join(root, 'site/later.css'), 'h1{}')
    const absorbed = sectionNamed(shown(await show('item', { path: 'site/index.html' })).blocks, '来历').blocks[0]
    expect(absorbed?.kind === 'fields' && absorbed.fields.find((f) => f.label === '并入')?.value).toMatchObject({ text: 'site', link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    const part = sectionNamed(shown(await show('item', { path: 'site/later.css' })).blocks, '来历').blocks
    expect(part).toMatchObject([{ kind: 'fields', fields: [{ label: '是谁的一部分', value: { text: 'site', link: { params: { path: 'site' } } } }] }, { kind: 'text' }])
  })
})
