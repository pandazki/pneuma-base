// Run 2 C3 at the ledger: the items view and the ledger's section of the item panel, through the
// kernel's viewer face, from the same fold and reconcile that inspect and check use. Views write nothing.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, viewerFace, type Actor, type Block, type FeedGroup, type FeedRow, type Instant, type Library, type Session, type ViewResult } from '@pneuma-base/kernel'
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
  const rowsIn = (g: FeedGroup): FeedRow[] => [...g.rows, ...(g.groups ?? []).flatMap(rowsIn)]
  return feed.groups.flatMap(rowsIn)
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

/** The actions of the panel's head, and of any other actions block. */
const actionsIn = (blocks: Block[]) => flat(blocks).flatMap((b) => (b.kind === 'actions' ? b.actions : []))

/** A field of any fields block in these blocks, nested sections opened, by its label. */
const fieldIn = (blocks: Block[], label: string) => flat(blocks).flatMap((b) => (b.kind === 'fields' ? b.fields : [])).find((f) => f.label === label)

/** A line of fields as text: each label with its value's text and tag. */
const fieldsText = (block: Block | undefined) => (block?.kind === 'fields' ? block.fields.map((f) => `${f.label}:${[f.value.text, f.value.tag?.text].filter(Boolean).join(' ')}`) : null)

describe('the library page', () => {
  it('lists each item under its folder with its name, origin, who, its state and time, a usual origin and state marked as such; a folder tree first and filters, each saying how many; a row opens the panel', async () => {
    const { show } = await relayed()
    const r = shown(await show('ledger.items'))
    const rows = rowsOf(r)
    expect(rows.map((r) => line(r.cells))).toEqual([
      { path: 'recommendation.md', origin: '做出来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'comparison.md', origin: '做出来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'stripe.html', origin: '带进来的', who: 'claude-code', state: '一致', at: '2026-11-25 02:00Z' },
    ])
    // A row stands under the folder it is in, said once by the group; the name is all its cell says.
    expect(rows.map((r) => r.group)).toEqual([undefined, undefined, 'src'])
    expect(rows[0]?.cells.who).toMatchObject({ actor: { kind: 'agent', name: 'claude-code' } })
    // Made and consistent are what most things are: the page leaves them unsaid, the text form says them.
    expect(rows[0]?.cells.state).toEqual({ text: '一致', muted: true, normal: true })
    expect(rows[0]?.cells.origin).toEqual({ text: '做出来的', muted: true, normal: true })
    expect(rows[2]?.cells.origin).toEqual({ text: '带进来的', muted: true })
    expect(rows[0]?.link).toEqual({ view: 'item', params: { path: 'recommendation.md' }, target: 'panel' })
    expect(rows[2]?.link).toEqual({ view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' })

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
    expect(rowsOf(await show('ledger.items', { show: 'brought' })).map((r) => r.link?.params.path)).toEqual(['src/stripe.html'])
    const archived = rowsOf(await show('ledger.items', { show: 'archived' }))
    expect(archived.map((r) => line(r.cells).path)).toEqual(['old.md 已归档'])
    expect(archived[0]?.link?.params.path).toBe('_archive/old.md')

    // How many in all, the tabs say; the tree's root says nothing more.
    expect(r.subtitle).toBeNull()
    expect(r.blocks[0]).toEqual({ kind: 'tree', param: 'dir', selected: '', nodes: [{ value: '', label: '全部', count: null, children: [{ value: 'src', label: 'src', count: 1, children: [] }] }] })
    const inSrc = shown(await show('ledger.items', { dir: 'src' }))
    // Right in the folder shown, a row needs no group: its name is its path after that folder.
    expect(rowsOf(inSrc).map((row) => [row.cells.path?.text, row.group, row.link?.params.path])).toEqual([['stripe.html', undefined, 'src/stripe.html']])
    expect(inSrc.blocks[0]).toMatchObject({ kind: 'tree', selected: 'src' })
  })

  it('marks what changed and what was made from it, as tags; the changed thing’s panel offers to accept it as a new version, as say revised', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const states = Object.fromEntries(rowsOf(await show('ledger.items')).map((r) => [r.link?.params.path, r.cells.state]))
    expect(states['src/stripe.html']).toEqual({ text: '', tag: { text: '已变', tone: 'warn' } })
    expect(states['comparison.md']).toEqual({ text: '', tag: { text: '可能过期', tone: 'warn' } })
    expect(states['recommendation.md']).toEqual({ text: '一致', muted: true, normal: true })

    const accept = (blocks: Block[]) => actionsIn(blocks).filter((a) => a.label === '认下这次改动')
    expect(accept(shown(await show('item', { path: 'src/stripe.html' })).blocks)).toMatchObject([{ call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: 'src/stripe.html', text: null, args: {} } } }])
    expect(accept(shown(await show('item', { path: 'comparison.md' })).blocks)).toEqual([])
  })
})

describe('the ledger’s part of the item panel', () => {
  it('says who, how it came and when, then in which scene, as lines; each source with its state, a brought one with where it came from; what happened, 决定 said once, and where a note is written; what built on it; folded, whether its content was read, where and by which grant', async () => {
    const { show } = await relayed()
    const r = shown(await show('item', { path: 'comparison.md' }))
    const provenance = sectionNamed(r.blocks, '来历')
    // Who, how it came and when, then the scene, each a line; its state only when it departs from the record.
    expect(provenance.blocks.slice(0, 2)).toMatchObject([{ kind: 'fields', line: true }, { kind: 'fields', line: true }])
    expect(fieldsText(provenance.blocks[0])).toEqual(['谁:claude-code', '来历:做出来的', '何时:2026-11-25 02:00Z'])
    expect(fieldsText(provenance.blocks[1])).toEqual(['场景:给小店选支付服务'])
    expect(fieldIn(provenance.blocks, '场景')?.value.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(fieldIn(provenance.blocks, '现状')).toBeUndefined()
    expect(provenance.blocks.filter((b) => b.kind === 'section').map((b) => b.kind === 'section' && b.title)).toEqual(['依据', '发生过什么', '被什么依据', '记录'])
    // Each source with its state, which a consistent one leaves unsaid.
    const came = sectionNamed(provenance.blocks, '依据')
    expect(came).toMatchObject({
      count: 2,
      blocks: [{ kind: 'list', items: [{ cell: { text: 'src/stripe.html', link: { view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' } }, note: null }, { cell: { text: '主人说客户在欧洲' }, note: '库外' }] }],
    })
    expect(listIn(came)[0]?.cell.tag).toBeUndefined()
    const happened = sectionNamed(provenance.blocks, '发生过什么')
    expect(happened).toMatchObject({ count: 2, blocks: [{ kind: 'timeline', entries: [{ title: { text: '用 Paddle' }, tag: { text: '决定' } }, { title: { text: '放进来' } }] }] })
    // 决定 once: the tag says it, the mark says who.
    const timeline = happened.blocks[0]
    expect(timeline?.kind === 'timeline' && timeline.entries.find((e) => e.title.text === '用 Paddle')).toMatchObject({ actor: { kind: 'agent', name: 'claude-code' }, lines: [] })
    // A note is written where the history is.
    expect(happened.actions).toMatchObject([{ label: '记一条备注', as: 'inline', call: { verb: 'say', request: { kind: 'note', about: 'comparison.md' } } }])
    expect(sectionNamed(provenance.blocks, '被什么依据')).toMatchObject({ blocks: [{ items: [{ cell: { text: 'recommendation.md', link: { params: { path: 'recommendation.md' } } } }] }] })
    // The record behind the lines, folded: whether its content was read (a put reads it), where, by which grant.
    const record = sectionNamed(provenance.blocks, '记录')
    expect(record.collapse).toBe('closed')
    expect(fieldsText(record.blocks[0])).toEqual([expect.stringMatching(/^内容:读过 · [0-9a-f]{12}$/), '在哪:/work/shop', expect.stringMatching(/^凭什么:没带授权/), '场景号:sess-a'])
    // The panel's order: the actions in its head, the plugins' parts, the file's preview and facts.
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:来历', 'section:预览', 'section:文件'])
    expect(r.blocks[0]).toMatchObject({ kind: 'actions', head: true })
    expect(actionsIn([r.blocks[0] as Block]).map((a) => a.label)).toEqual(['归档', '挪到', '补上依据', '记一条决定'])

    const stripe = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历')
    expect(fieldIn(stripe.blocks, '来历')?.value.text).toBe('带进来的')
    const brought = sectionNamed(stripe.blocks, '怎么来的').blocks[0]
    expect(brought?.kind === 'fields' && brought.fields.map((f) => f.value.text || f.value.tag?.text)).toEqual(['https://stripe.com/pricing'])
  })

  it('says a file nobody registered has no known origin and offers to give it one: brought in, or made from things of the library; gives no section where neither file nor item is', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const r = shown(await show('item', { path: 'dropped.md' }))
    expect(sectionNamed(r.blocks, '来历').blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('来历不明') }])
    expect(actionsIn(r.blocks).map((a) => a.label)).toEqual(['归档', '挪到', '记为带进来的', '记为做出来的'])
    expect(actionsIn(r.blocks).filter((a) => a.label.startsWith('记为'))).toMatchObject([
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
  it('has one row per session, newest first, by day: who, what it was doing, how many things it put; a row opens its scene, whose page gives its figures that are not nothing, what happened in it, then, folded, who and where', async () => {
    const { show, codex } = await relayed()
    await agentFace.say({ kind: 'doing', about: null, text: '把支付服务接进小店', args: {} }, codex())
    await agentFace.put({ kind: 'place', from: text('int'), to: 'integration.md', origin: { kind: 'made', from: ['recommendation.md'], outside: [] } }, codex())
    const scenes = feedRows(shown(await show('ledger.scenes')).blocks)
    // The library was made at the real time, after the test's sessions at 02:00Z.
    expect(scenes.map((row) => [nameOf(row.actor), row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['主人', '主人面的操作：init', '没放东西'],
      ['codex', '把支付服务接进小店', '放入 1 样'],
      ['claude-code', '给小店选支付服务', '放入 4 样'],
    ])
    expect(scenes[1]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-b' }, target: 'panel' })
    expect(scenes[1]?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)

    const r = shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(r.title).toBe('给小店选支付服务')
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['stats', 'feed', 'section:记录'])
    // Under a minute long says nothing: the figures that are not nothing.
    expect(r.blocks[0]).toEqual({
      kind: 'stats',
      stats: [
        { label: '放入', value: '4', note: '带进来 2 样，做出来 2 样' },
        { label: '依据', value: '3', note: '库外 1 句' },
        { label: '决定', value: '1', note: '用 Paddle' },
      ],
    })
    const record = sectionNamed(r.blocks, '记录')
    expect(record.collapse).toBe('closed')
    expect(record.blocks[0]?.kind === 'fields' && record.blocks[0].fields.map((f) => `${f.label}:${f.value.text}`)).toEqual(['谁:claude-code', '在哪:/work/shop', '场景号:sess-a'])
    const rows = feedRows(r.blocks)
    expect(rows.map((row) => row.text)).toEqual([
      '归档 old.md',
      '决定：用 Paddle（关于 comparison.md）',
      // Made and put by its maker is the usual way in: a page's row leaves it unsaid.
      '放入 recommendation.md',
      '放入 comparison.md',
      '放入 old.md（现在在 _archive/old.md）（带进来的）',
      '放入 src/stripe.html（带进来的）',
      // What it was doing is the page's title, not one of its acts.
    ])
    // An archive that still stands can be taken back from its row; a fact with no undo says nothing there.
    expect(rows[0]).toMatchObject({ action: { label: '取回', call: { verb: 'archive', request: { kind: 'unarchive', path: '_archive/old.md' } } } })
    expect(rows[1]?.action).toBeUndefined()
    expect(rows[1]?.settled).toBeUndefined()

    expect(shown(await show('ledger.scene', { scene: 'nope-nope' })).blocks).toMatchObject([{ kind: 'empty', title: '没有这个场景' }])
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

describe('the standing view', () => {
  it('says there is nothing to look at when all is in order; then has a section for each kind of thing to look at, each row opening the item panel and offering what settles it', async () => {
    const { root, show, codex } = await relayed()
    expect(shown(await show('ledger.standing')).blocks).toMatchObject([{ kind: 'actions', head: true, actions: [{ label: '按内容查', call: { verb: 'check', request: { deep: { dir: null } } } }] }, { kind: 'empty', title: '没有要处理的事' }])

    await agentFace.put({ kind: 'place', from: text('src'), to: 'gone-src.md', origin: { kind: 'brought', source: null, by: null } }, codex())
    await agentFace.put({ kind: 'place', from: text('uses'), to: 'uses-gone.md', origin: { kind: 'made', from: ['gone-src.md'], outside: [] } }, codex())
    await agentFace.put({ kind: 'place', from: text('moving'), to: 'moving.md', origin: { kind: 'brought', source: null, by: null } }, codex())
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    // A file nobody registered that an archive adopted: in the ledger, origin unknown.
    writeFileSync(join(root, 'adopted.md'), 'adopted')
    await agentFace.archive({ kind: 'archive', path: 'adopted.md' }, codex())
    await agentFace.archive({ kind: 'unarchive', path: '_archive/adopted.md' }, codex())
    rmSync(join(root, 'gone-src.md'))
    renameSync(join(root, 'moving.md'), join(root, 'src/here.md'))

    const r = shown(await show('ledger.standing'))
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && `${s.title}:${s.count}`)).toEqual(['可能过期:1', '来源不在:1', '上游有标记:1', '没人登记过的:2', '被直接改过的:1', '不在了的:1', '挪过的:1'])
    // Each a list of things: the path opening the item panel, a note only where it says more than the section.
    const items = (title: string) => listIn(sectionNamed(r.blocks, title))
    const itemsOf = (title: string) => items(title).map((i) => ({ path: i.cell.text, note: i.note, open: i.cell.link?.params.path }))
    expect(itemsOf('可能过期')).toEqual([{ path: 'comparison.md', note: '依据 src/stripe.html 变了', open: 'comparison.md' }])
    expect(itemsOf('来源不在')).toEqual([{ path: 'uses-gone.md', note: '依据 gone-src.md 不在了', open: 'uses-gone.md' }])
    expect(itemsOf('上游有标记')).toEqual([{ path: 'recommendation.md', note: '上游 comparison.md 有标记', open: 'recommendation.md' }])
    expect(itemsOf('被直接改过的')).toEqual([{ path: 'src/stripe.html', note: null, open: 'src/stripe.html' }])
    expect(itemsOf('不在了的')).toEqual([{ path: 'gone-src.md', note: null, open: 'gone-src.md' }])
    expect(itemsOf('挪过的')).toEqual([{ path: 'moving.md', note: '挪到了 src/here.md', open: 'src/here.md' }])
    expect(items('可能过期')[0]?.cell.link).toEqual({ view: 'item', params: { path: 'comparison.md' }, target: 'panel' })
    // The same operations as the panel's on its rows: provenance for things nobody registered, accepting a direct change.
    expect(items('没人登记过的').map((i) => [i.cell.text, i.note, i.cell.link?.params.path, i.actions.map((a) => a.label), i.actions.map((a) => a.call.face === 'agent' && a.call.verb === 'put' && a.call.request.kind === 'register' && a.call.request.path)])).toEqual([
      ['adopted.md', '入了册，来历不明', 'adopted.md', ['记为带进来的', '记为做出来的'], ['adopted.md', 'adopted.md']],
      ['dropped.md', null, 'dropped.md', ['记为带进来的', '记为做出来的'], ['dropped.md', 'dropped.md']],
    ])
    expect(items('被直接改过的')[0]?.actions).toMatchObject([{ label: '认下这次改动', call: { verb: 'say', request: { kind: 'revised', about: 'src/stripe.html' } } }])
    expect(items('可能过期')[0]?.actions).toEqual([])
    // Nobody knowing where it came from is the one origin worth a tag.
    const adopted = rowsOf(await show('ledger.items')).find((row) => row.cells.path?.text === 'adopted.md')
    expect(adopted?.cells.origin).toMatchObject({ text: '', tag: { tone: 'warn' } })

    // The panel at the new path knows the thing that moved there.
    const panel = sectionNamed(shown(await show('item', { path: 'src/here.md' })).blocks, '来历').blocks
    expect(fieldIn(panel, '现状')?.value).toMatchObject({ text: 'src/here.md', tag: { text: '挪到了' } })
  })

  // ARCHITECTURE.md「怎么看库」: nothing below a directory no record points into is opened, so a thing moved there is
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
})

describe('the activity page', () => {
  it('has the acts newest first by day and in a day by scene, owner operations included: who, the act, the thing and the note, the sentence, by which grant; a scene of several acts under what it was doing, which is no row; a fact about a thing opens it; it keeps the agents’ or the owner’s, or one agent’s, each option saying how many rows', async () => {
    const { show, codex } = await relayed()
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    // The library was made at the real time, after the test's session at 02:00Z, so its init is newest.
    expect(rows[0]).toMatchObject({ actor: { kind: 'owner', name: '主人' }, whose: 'owner', act: 'created', path: 'lib', text: expect.stringMatching(/^pneuma-base init \/.+\/lib$/) })
    expect(rows.slice(1, 4).map((row) => [nameOf(row.actor), row.whose, row.act, row.path, row.note, row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['claude-code', 'agent', 'archived', 'old.md', undefined, '归档 old.md', '没带授权'],
      ['claude-code', 'agent', 'decision', 'comparison.md', '用 Paddle', '决定：用 Paddle（关于 comparison.md）', '没带授权'],
      ['claude-code', 'agent', 'made', 'recommendation.md', undefined, '放入 recommendation.md', '没带授权'],
    ])
    expect(rows[1]?.link).toEqual({ view: 'item', params: { path: '_archive/old.md' }, target: 'panel' })
    expect(rows.find((row) => row.act === 'doing')).toBeUndefined()
    const feed = flat(shown(await show('ledger.activity')).blocks).find((b) => b.kind === 'feed')
    const scenes = feed?.kind === 'feed' ? feed.groups.flatMap((day) => day.groups ?? []) : []
    expect(scenes.filter((g) => g.title !== '').map((g) => [g.title, g.count, g.link])).toEqual([['给小店选支付服务', 6, { view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' }]])
    expect(rows[1]?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)

    await agentFace.say({ kind: 'note', about: 'comparison.md', text: '看过了', args: {} }, codex())
    const r = shown(await show('ledger.activity'))
    expect(r.filters).toEqual([
      { name: 'who', options: [{ value: '', label: '全部', count: 8 }, { value: 'agent', label: 'agent 做的', count: 7 }, { value: 'owner', label: '主人做的', count: 1 }] },
      { name: 'agent', options: [{ value: '', label: '全部 agent', count: 8 }, { value: 'claude-code', label: 'claude-code', count: 6 }, { value: 'codex', label: 'codex', count: 1 }] },
    ])
    expect(feedRows(shown(await show('ledger.activity', { who: 'owner' })).blocks).map((row) => nameOf(row.actor))).toEqual(['主人'])
    expect(feedRows(shown(await show('ledger.activity', { agent: 'codex' })).blocks).map((row) => row.text)).toEqual(['备注：看过了（关于 comparison.md）'])
  })
})

describe('the ledger’s part of the home page', () => {
  /** The home page as an agent sees it, which is what the owner sees of the agents. */
  it('tells what others did since the last look, by scene under what it was doing, with 都看过了, which is a check; then what needs looking at', async () => {
    const { root, show, codex, claudeIn } = await relayed()
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

    // A scene saying what it is doing is no act, so nothing yet; its one act is then that row, naming the scene, in a list without a heading; the section counts it.
    await agentFace.say({ kind: 'doing', about: null, text: '整理首页文案', args: {} }, claudeIn('sess-c'))
    expect(sectionNamed(shown(await asCodex()).blocks, '自上次以来')).toMatchObject({ count: null, blocks: [{ kind: 'feed', groups: [] }, { kind: 'list' }] })
    await agentFace.say({ kind: 'note', about: null, text: '首页先不动', args: {} }, claudeIn('sess-c'))
    const doing = sectionNamed(shown(await asCodex()).blocks, '自上次以来')
    const doingFeed = doing.blocks[0]
    expect(doingFeed?.kind === 'feed' && doingFeed.groups.map((g) => [g.title, g.count, g.rows.map((r) => [r.act, r.note, r.text, r.meta.map((c) => c.text)])])).toEqual([['', null, [['note', '首页先不动', '备注：首页先不动', ['整理首页文案', '没带授权']]]]])
    expect(doing).toMatchObject({ count: 1, note: null })

    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const attention = sectionNamed(shown(await asCodex()).blocks, '需要留意')
    expect(listIn(attention).map((i) => [i.cell.text, i.cell.link])).toEqual([
      ['1 样可能过期', { view: 'ledger.standing', params: { kind: 'stale' }, target: 'main' }],
      ['1 样上游有标记', { view: 'ledger.standing', params: { kind: 'upstream' }, target: 'main' }],
      ['1 样被直接改过的', { view: 'ledger.standing', params: { kind: 'changed' }, target: 'main' }],
    ])
    expect(sectionNamed(shown(await show('ledger.standing', { kind: 'changed' })).blocks, '被直接改过的').count).toBe(1)
    // One kind alone: the deep pass that tells a real change from a touch, then that kind's section.
    expect(shown(await show('ledger.standing', { kind: 'changed' })).blocks.map((b) => b.kind)).toEqual(['actions', 'section'])
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

  // ARCHITECTURE.md「问主人」: asked per place. The loose files of an open directory are one question; a
  // directory nothing registered is in is another, with its three answers, and is never opened.
  it('are one question per place on the home page, not something to look at; registered place by place, each is the owner’s, brought in, the activity has one row for each act, and nothing is asked any more', async () => {
    const { show, run, asks } = await folderWithFiles(3)
    const [loose, closed, ...more] = await asks()
    expect(more).toEqual([])
    expect(loose).toMatchObject({ by: '记账与对账', text: '库的根目录有 2 个文件还没登记。都记为你带进来的吗？', suggested: 0 })
    expect(loose?.actions.map((a) => [a.label, a.call])).toEqual([
      ['都记为我带进来的', { face: 'owner', command: 'ledger register', args: { positional: ['.'], flags: {} } }],
      ['不登记，不再问', { face: 'owner', command: 'ledger leave', args: { positional: ['.'], flags: {} } }],
    ])
    expect(closed).toMatchObject({ text: 'notes/ 没登记：1 个文件。', about: 'notes' })
    expect(closed?.actions[1]?.confirm).toBe('要登记 notes/ 里任意深处的全部文件：1 个，不含噪音。')
    expect(closed?.actions.map((a) => [a.label, a.call])).toEqual([
      ['登记成一样东西', { face: 'agent', verb: 'put', request: { kind: 'register', path: 'notes', origin: { kind: 'brought', source: null, by: 'owner' }, note: null } }],
      ['登记里面的文件', { face: 'owner', command: 'ledger register', args: { positional: ['notes'], flags: { inside: true } } }],
      ['不用管', { face: 'owner', command: 'noise add', args: { positional: ['notes'], flags: {} } }],
    ])
    // Nothing else to look at, said without claiming the unregistered things match a record.
    expect(sectionNamed(shown(await show('home')).blocks, '需要留意').blocks).toEqual([{ kind: 'text', tone: 'neutral', text: '没有要留意的：登记过的东西都和记录的一样。' }])

    const register = loose?.actions[0]?.call
    if (register?.face !== 'owner') throw new Error('no owner call')
    expect(await run(register)).toMatchObject({ outcome: 'done', text: '已把 2 样东西记为主人带进来的。', data: { registered: 2 } })
    const inside = (await asks()).find((a) => a.about === 'notes')?.actions[1]?.call
    if (inside?.face !== 'owner') throw new Error('no owner call')
    expect(await run(inside)).toMatchObject({ outcome: 'done', text: '已把 notes/里的 1 个文件记为主人带进来的。', data: { registered: 1 } })
    expect(await asks()).toEqual([])
    const came = sectionNamed(shown(await show('item', { path: 'notes/n1.md' })).blocks, '来历').blocks
    expect(fieldIn(came, '来历')?.value.text).toBe('带进来的，主人给的')
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    expect(rows.map((r) => r.text).filter((t) => t.includes('ledger register') || t.includes('放入'))).toEqual([
      'pneuma-base ledger register notes --inside',
      'pneuma-base ledger register .',
    ])
    // Each says what it did to what: brought in, the folder.
    expect(rows.filter((r) => r.text.includes('ledger register')).map((r) => [r.act, r.path])).toEqual([
      ['brought', 'notes'],
      ['brought', '.'],
    ])
    expect(shown(await show('ledger.standing')).blocks).toMatchObject([{ kind: 'actions' }, { kind: 'empty' }])
  })

  it('left as they are: not asked about again, still on the standing page; a later pile is asked about anew', async () => {
    const { root, show, run, asks } = await folderWithFiles(4)
    const leave = (await asks())[0]?.actions[1]?.call
    if (leave?.face !== 'owner') throw new Error('no owner call')
    expect(await run(leave)).toMatchObject({ outcome: 'done', data: { left: 2 } })
    const closedOnly = ['notes/ 没登记：2 个文件。']
    expect((await asks()).map((a) => a.text)).toEqual(closedOnly)
    expect(sectionNamed(shown(await show('ledger.standing')).blocks, '没人登记过的').count).toBe(2)
    writeFileSync(join(root, 'later.md'), 'dropped in later')
    expect((await asks()).map((a) => a.text)).toEqual(['库的根目录有 1 个文件还没登记。都记为你带进来的吗？', ...closedOnly])
  })
})

describe('held copies and changes in the ledger’s blocks', () => {
  it('say whose content each was: a held copy can be taken back to a new path, as ledger held restore; a put’s note ends its entry and its activity row; an edit the owner made and an agent recorded names both', async () => {
    const { root, show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('cmp v2'), to: 'comparison.md', origin: { kind: 'made', from: ['src/stripe.html'], outside: [] }, note: '换了结论' }, codex())
    const provenance = sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '来历')
    expect(sectionNamed(provenance.blocks, '留存').blocks.find((b) => b.kind === 'list')).toMatchObject({
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
    const changes = sectionNamed(provenance.blocks, '发生过什么').blocks[0]
    // Each change: who, as its mark, and the sentence it came with.
    const lines = changes?.kind === 'timeline' ? changes.entries.filter((e) => e.title.text !== '用 Paddle').map((e) => [e.actor === undefined ? null : nameOf(e.actor), e.lines]) : []
    expect(lines).toEqual([
      ['codex', ['换了结论']],
      ['claude-code', []],
    ])
    const activity = async () => feedRows(shown(await show('ledger.activity')).blocks)
    expect((await activity()).filter((row) => nameOf(row.actor) === 'codex').map((row) => row.text)).toEqual(['comparison.md 换了新内容：换了结论'])

    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    await agentFace.say({ kind: 'revised', about: 'src/stripe.html', text: null, args: { by: ['owner'] } }, codex())
    expect((await activity()).filter((row) => row.text === '记下 src/stripe.html 是主人直接改的').map((row) => nameOf(row.actor))).toEqual(['codex'])
    await agentFace.put({ kind: 'place', from: text('stripe v3'), to: 'src/stripe.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    const stripe = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '来历')
    expect(sectionNamed(stripe.blocks, '发生过什么').blocks[0]).toMatchObject({ entries: [{ tag: { text: '当前' } }, { title: { text: '主人直接改的' }, actor: { kind: 'owner' }, lines: ['codex 代记'] }, {}] })
    expect(sectionNamed(stripe.blocks, '留存').blocks.find((b) => b.kind === 'list')).toMatchObject({ items: [{ note: '主人直接改的那份内容，codex 代记' }] })
  })
})

describe('bundles in the ledger’s blocks', () => {
  it('the items table marks a bundle and leaves out the things it absorbed; the panel of a file inside it says what it is part of, absorbed or never registered', async () => {
    const { root, show, codex } = await relayed()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>')
    await agentFace.put({ kind: 'register', path: 'site/index.html', origin: { kind: 'brought', source: null, by: null } }, codex())
    // A directory holding a registered thing is open: registering it takes its loose files, unless its marker makes it one thing.
    writeFileSync(join(root, 'site/.pneuma-item'), '')
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'made', from: ['comparison.md'], outside: [] } }, codex())
    writeFileSync(join(root, 'site/later.css'), 'h1{}')
    const rows = rowsOf(await show('ledger.items'))
    expect(rows.map((r) => r.link?.params.path)).not.toContain('site/index.html')
    expect(rows.find((r) => r.cells.path?.text === 'site')?.cells.path).toMatchObject({ icon: 'package' })
    expect(rows.find((r) => r.cells.path?.text === 'comparison.md')?.cells.path).toMatchObject({ icon: 'file' })

    const absorbed = sectionNamed(shown(await show('item', { path: 'site/index.html' })).blocks, '来历').blocks
    expect(fieldIn(absorbed, '现状')?.value).toMatchObject({ text: 'site', tag: { text: '并入了' }, link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    const part = sectionNamed(shown(await show('item', { path: 'site/later.css' })).blocks, '来历').blocks
    expect(part).toEqual([{ kind: 'fields', line: true, fields: [{ label: '来历记在', value: { text: '来历记在 site', icon: 'package', link: { view: 'item', params: { path: 'site' }, target: 'panel' } } }] }])
  })
})
