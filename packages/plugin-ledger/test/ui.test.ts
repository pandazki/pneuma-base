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
  await agentFace.say({ kind: 'task', about: null, text: '给小店选支付服务', args: {} }, ctx())
  await agentFace.put({ kind: 'place', from: text('stripe'), to: 'src/stripe.html', origin: { kind: 'imported', source: 'https://stripe.com/pricing', by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('old'), to: 'old.md', origin: { kind: 'imported', source: null, by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('cmp'), to: 'comparison.md', origin: { kind: 'generated', from: ['src/stripe.html'], outside: ['主人说客户在欧洲'] } }, ctx())
  await agentFace.put({ kind: 'place', from: text('rec'), to: 'recommendation.md', origin: { kind: 'generated', from: ['comparison.md'], outside: [] } }, ctx())
  await agentFace.say({ kind: 'decision', about: 'comparison.md', text: '用 Paddle', args: {} }, ctx())
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
      { path: 'recommendation.md', origin: '生成', who: 'Claude Code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'comparison.md', origin: '生成', who: 'Claude Code', state: '一致', at: '2026-11-25 02:00Z' },
      { path: 'stripe.html', origin: '导入', who: 'Claude Code', state: '一致', at: '2026-11-25 02:00Z' },
    ])
    // A row stands under the folder it is in, said once by the group; the name is all its cell says.
    expect(rows.map((r) => r.group)).toEqual([undefined, undefined, 'src'])
    expect(rows[0]?.cells.who).toMatchObject({ actor: { kind: 'agent', name: 'claude-code' } })
    // Made and consistent are what most things are: the page leaves them unsaid, the text form says them.
    expect(rows[0]?.cells.state).toEqual({ text: '一致', muted: true, normal: true })
    expect(rows[0]?.cells.origin).toEqual({ text: '生成', muted: true, normal: true })
    expect(rows[2]?.cells.origin).toEqual({ text: '导入', muted: true })
    expect(rows[0]?.link).toEqual({ view: 'item', params: { path: 'recommendation.md' }, target: 'panel' })
    expect(rows[2]?.link).toEqual({ view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' })

    expect(r.filters).toEqual([
      {
        name: 'show',
        options: [
          { value: '', label: '全部', count: 3 },
          { value: 'imported', label: '导入', count: 1 },
          { value: 'generated', label: '生成', count: 2 },
          { value: 'archived', label: '已归档', count: 1 },
        ],
      },
    ])
    expect(rowsOf(await show('ledger.items', { show: 'imported' })).map((r) => r.link?.params.path)).toEqual(['src/stripe.html'])
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
    expect(states['src/stripe.html']).toEqual({ text: '', tag: { text: '已修改', tone: 'warn' } })
    expect(states['comparison.md']).toEqual({ text: '', tag: { text: '可能已过期', tone: 'warn' } })
    expect(states['recommendation.md']).toEqual({ text: '一致', muted: true, normal: true })

    const accept = (blocks: Block[]) => actionsIn(blocks).filter((a) => a.label === '确认修改')
    expect(accept(shown(await show('item', { path: 'src/stripe.html' })).blocks)).toMatchObject([{ call: { face: 'agent', verb: 'say', request: { kind: 'revised', about: 'src/stripe.html', text: null, args: {} } } }])
    expect(accept(shown(await show('item', { path: 'comparison.md' })).blocks)).toEqual([])
  })
})

describe('the ledger’s part of the item panel', () => {
  it('says who, how it came and when, then in which scene, as lines; each source with its state, a brought one with where it came from; what happened, 决策 said once, and where a note is written; what built on it; folded, whether its content was read, where and by which grant', async () => {
    const { show } = await relayed()
    const r = shown(await show('item', { path: 'comparison.md' }))
    const provenance = sectionNamed(r.blocks, '溯源')
    // Who, how it came and when, then the scene, each a line; its state only when it departs from the record.
    expect(provenance.blocks.slice(0, 2)).toMatchObject([{ kind: 'fields', line: true }, { kind: 'fields', line: true }])
    expect(fieldsText(provenance.blocks[0])).toEqual(['执行者:Claude Code', '来源:生成', '时间:2026-11-25 02:00Z'])
    expect(fieldsText(provenance.blocks[1])).toEqual(['场景:给小店选支付服务'])
    expect(fieldIn(provenance.blocks, '场景')?.value.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(fieldIn(provenance.blocks, '状态')).toBeUndefined()
    expect(provenance.blocks.filter((b) => b.kind === 'section').map((b) => b.kind === 'section' && b.title)).toEqual(['依据', '历史记录', '被引用', '记录'])
    // Each source with its state, which a consistent one leaves unsaid.
    const came = sectionNamed(provenance.blocks, '依据')
    expect(came).toMatchObject({
      count: 2,
      blocks: [{ kind: 'list', items: [{ cell: { text: 'src/stripe.html', link: { view: 'item', params: { path: 'src/stripe.html' }, target: 'panel' } }, note: null }, { cell: { text: '主人说客户在欧洲' }, note: '外部' }] }],
    })
    expect(listIn(came)[0]?.cell.tag).toBeUndefined()
    const happened = sectionNamed(provenance.blocks, '历史记录')
    expect(happened).toMatchObject({ count: 2, blocks: [{ kind: 'timeline', entries: [{ title: { text: '用 Paddle' }, tag: { text: '决策' } }, { title: { text: '添加' } }] }] })
    // 决策 once: the tag says it, the mark says who.
    const timeline = happened.blocks[0]
    expect(timeline?.kind === 'timeline' && timeline.entries.find((e) => e.title.text === '用 Paddle')).toMatchObject({ actor: { kind: 'agent', name: 'claude-code' }, lines: [] })
    // A note is written where the history is.
    expect(happened.actions).toMatchObject([{ label: '添加备注', as: 'inline', call: { verb: 'say', request: { kind: 'note', about: 'comparison.md' } } }])
    expect(sectionNamed(provenance.blocks, '被引用')).toMatchObject({ blocks: [{ items: [{ cell: { text: 'recommendation.md', link: { params: { path: 'recommendation.md' } } } }] }] })
    // The record behind the lines, folded: whether its content was read (a put reads it), where, by which grant.
    const record = sectionNamed(provenance.blocks, '记录')
    expect(record.collapse).toBe('closed')
    expect(fieldsText(record.blocks[0])).toEqual([expect.stringMatching(/^内容:已读取 · [0-9a-f]{12}$/), '位置:/work/shop', expect.stringMatching(/^授权:未带授权/), '场景编号:sess-a'])
    // The panel's order: the actions in its head, the plugins' parts, the file's preview and facts.
    expect(r.blocks.map((b) => (b.kind === 'section' ? `section:${b.title}` : b.kind))).toEqual(['actions', 'section:溯源', 'section:预览', 'section:文件'])
    expect(r.blocks[0]).toMatchObject({ kind: 'actions', head: true })
    // The kernel's two actions come first; their words are the kernel's.
    expect(actionsIn([r.blocks[0] as Block]).map((a) => a.label)).toEqual([expect.any(String), expect.any(String), '补充依据', '添加决策'])

    const stripe = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '溯源')
    expect(fieldIn(stripe.blocks, '来源')?.value.text).toBe('导入')
    const brought = sectionNamed(stripe.blocks, '来源').blocks[0]
    expect(brought?.kind === 'fields' && brought.fields.map((f) => f.value.text || f.value.tag?.text)).toEqual(['https://stripe.com/pricing'])
  })

  it('says a file nobody registered has no known origin and offers to give it one: brought in, or made from things of the library; gives no section where neither file nor item is', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const r = shown(await show('item', { path: 'dropped.md' }))
    expect(sectionNamed(r.blocks, '溯源').blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('来源未知') }])
    expect(actionsIn(r.blocks).map((a) => a.label)).toEqual([expect.any(String), expect.any(String), '标记为导入', '标记为生成'])
    expect(actionsIn(r.blocks).filter((a) => a.label.startsWith('标记为'))).toMatchObject([
      {
        label: '标记为导入',
        inputs: [{ name: 'source' }, { name: 'by', options: [{ value: 'owner' }, { value: '' }] }],
        call: { face: 'agent', verb: 'put', request: { kind: 'register', path: 'dropped.md', origin: { kind: 'imported', source: '{source}', by: '{by}' } } },
      },
      {
        label: '标记为生成',
        inputs: [{ name: 'from', multiple: true }, { name: 'outside', multiple: true }],
        call: { face: 'agent', verb: 'put', request: { kind: 'register', path: 'dropped.md', origin: { kind: 'generated', from: ['{from}'], outside: ['{outside}'] } } },
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
    for (const view of ['home', 'ledger.scenes', 'ledger.status', 'ledger.activity']) shown(await show(view))
    shown(await show('ledger.scene', { scene: 'sess-a' }))
    expect(facts()).toBe(before)
  })
})

describe('the scenes page', () => {
  it('has one row per session, newest first, by day: who, what it was doing, how many things it put; a row opens its scene, whose page gives its figures that are not nothing, what happened in it, then, folded, who and where', async () => {
    const { show, codex } = await relayed()
    await agentFace.say({ kind: 'task', about: null, text: '把支付服务接进小店', args: {} }, codex())
    await agentFace.put({ kind: 'place', from: text('int'), to: 'integration.md', origin: { kind: 'generated', from: ['recommendation.md'], outside: [] } }, codex())
    const scenes = feedRows(shown(await show('ledger.scenes')).blocks)
    // The library was made at the real time, after the test's sessions at 02:00Z.
    expect(scenes.map((row) => [nameOf(row.actor), row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['我', '所有者操作：init', '无新增条目'],
      ['codex', '把支付服务接进小店', '添加 1 个条目'],
      ['claude-code', '给小店选支付服务', '添加 4 个条目'],
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
        { label: '添加', value: '4', note: '导入 2 个，生成 2 个' },
        { label: '依据', value: '3', note: '外部 1 条' },
        { label: '决策', value: '1', note: '用 Paddle' },
      ],
    })
    const record = sectionNamed(r.blocks, '记录')
    expect(record.collapse).toBe('closed')
    expect(record.blocks[0]?.kind === 'fields' && record.blocks[0].fields.map((f) => `${f.label}:${f.value.text}`)).toEqual(['执行者:claude-code', '位置:/work/shop', '场景编号:sess-a'])
    const rows = feedRows(r.blocks)
    expect(rows.map((row) => row.text)).toEqual([
      '归档 old.md',
      '决策：用 Paddle（关于 comparison.md）',
      // The act says how it came: generated, imported.
      '生成 recommendation.md',
      '生成 comparison.md',
      '导入 old.md（现位于 _archive/old.md）',
      '导入 src/stripe.html',
      // What it was doing is the page's title, not one of its acts.
    ])
    // An archive that still stands can be taken back from its row; a fact with no undo says nothing there.
    expect(rows[0]).toMatchObject({ action: { label: '取消归档', call: { verb: 'archive', request: { kind: 'unarchive', path: '_archive/old.md' } } } })
    expect(rows[1]?.action).toBeUndefined()
    expect(rows[1]?.settled).toBeUndefined()

    expect(shown(await show('ledger.scene', { scene: 'nope-nope' })).blocks).toMatchObject([{ kind: 'empty', title: '场景不存在' }])
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
    expect(r.blocks).toMatchObject([{ kind: 'empty', hint: expect.stringContaining('Agent 开始任务时') }])
  })
})

describe('the standing view', () => {
  it('says there is nothing to look at when all is in order; then has a section for each kind of thing to look at, each row opening the item panel and offering what settles it', async () => {
    const { root, show, codex } = await relayed()
    expect(shown(await show('ledger.status')).blocks).toMatchObject([{ kind: 'actions', head: true, actions: [{ label: '深度检查', call: { verb: 'check', request: { deep: { dir: null } } } }] }, { kind: 'empty', title: '暂无待处理事项' }])

    await agentFace.put({ kind: 'place', from: text('src'), to: 'gone-src.md', origin: { kind: 'imported', source: null, by: null } }, codex())
    await agentFace.put({ kind: 'place', from: text('uses'), to: 'uses-gone.md', origin: { kind: 'generated', from: ['gone-src.md'], outside: [] } }, codex())
    await agentFace.put({ kind: 'place', from: text('moving'), to: 'moving.md', origin: { kind: 'imported', source: null, by: null } }, codex())
    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    // A file nobody registered that an archive adopted: in the ledger, origin unknown.
    writeFileSync(join(root, 'adopted.md'), 'adopted')
    await agentFace.archive({ kind: 'archive', path: 'adopted.md' }, codex())
    await agentFace.archive({ kind: 'unarchive', path: '_archive/adopted.md' }, codex())
    rmSync(join(root, 'gone-src.md'))
    renameSync(join(root, 'moving.md'), join(root, 'src/here.md'))

    const r = shown(await show('ledger.status'))
    const sections = r.blocks.filter((b) => b.kind === 'section')
    expect(sections.map((s) => s.kind === 'section' && `${s.title}:${s.count}`)).toEqual(['可能已过期:1', '来源缺失:1', '上游已标记:1', '未登记:2', '外部修改:1', '已缺失:1', '已移动:1'])
    // Each a list of things: the path opening the item panel, a note only where it says more than the section.
    const items = (title: string) => listIn(sectionNamed(r.blocks, title))
    const itemsOf = (title: string) => items(title).map((i) => ({ path: i.cell.text, note: i.note, open: i.cell.link?.params.path }))
    expect(itemsOf('可能已过期')).toEqual([{ path: 'comparison.md', note: '依据 src/stripe.html 已修改', open: 'comparison.md' }])
    expect(itemsOf('来源缺失')).toEqual([{ path: 'uses-gone.md', note: '依据 gone-src.md 已缺失', open: 'uses-gone.md' }])
    expect(itemsOf('上游已标记')).toEqual([{ path: 'recommendation.md', note: '上游 comparison.md 已标记', open: 'recommendation.md' }])
    expect(itemsOf('外部修改')).toEqual([{ path: 'src/stripe.html', note: null, open: 'src/stripe.html' }])
    expect(itemsOf('已缺失')).toEqual([{ path: 'gone-src.md', note: null, open: 'gone-src.md' }])
    expect(itemsOf('已移动')).toEqual([{ path: 'moving.md', note: '已移动到 src/here.md', open: 'src/here.md' }])
    expect(items('可能已过期')[0]?.cell.link).toEqual({ view: 'item', params: { path: 'comparison.md' }, target: 'panel' })
    // The same operations as the panel's on its rows: provenance for things nobody registered, accepting a direct change.
    expect(items('未登记').map((i) => [i.cell.text, i.note, i.cell.link?.params.path, i.actions.map((a) => a.label), i.actions.map((a) => a.call.face === 'agent' && a.call.verb === 'put' && a.call.request.kind === 'register' && a.call.request.path)])).toEqual([
      ['adopted.md', '已登记，来源未知', 'adopted.md', ['标记为导入', '标记为生成'], ['adopted.md', 'adopted.md']],
      ['dropped.md', null, 'dropped.md', ['标记为导入', '标记为生成'], ['dropped.md', 'dropped.md']],
    ])
    expect(items('外部修改')[0]?.actions).toMatchObject([{ label: '确认修改', call: { verb: 'say', request: { kind: 'revised', about: 'src/stripe.html' } } }])
    expect(items('可能已过期')[0]?.actions).toEqual([])
    // Nobody knowing where it came from is the one origin worth a tag.
    const adopted = rowsOf(await show('ledger.items')).find((row) => row.cells.path?.text === 'adopted.md')
    expect(adopted?.cells.origin).toMatchObject({ text: '', tag: { tone: 'warn' } })

    // The panel at the new path knows the thing that moved there.
    const panel = sectionNamed(shown(await show('item', { path: 'src/here.md' })).blocks, '溯源').blocks
    expect(fieldIn(panel, '状态')?.value).toMatchObject({ text: 'src/here.md', tag: { text: '已移动到' } })
  })

  // ARCHITECTURE.md「怎么看库」: nothing below a directory no record points into is opened, so a thing moved there is
  // not followed: it is not where it was, and the directory is one line to answer.
  it('does not follow a thing into a directory nobody looked into', async () => {
    const { root, show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('moving'), to: 'moving.md', origin: { kind: 'imported', source: null, by: null } }, codex())
    mkdirSync(join(root, 'moved'))
    renameSync(join(root, 'moving.md'), join(root, 'moved/here.md'))
    const r = shown(await show('ledger.status'))
    expect(r.blocks.filter((b) => b.kind === 'section').map((s) => s.kind === 'section' && `${s.title}:${s.count}`)).toEqual(['未登记的目录:1', '已缺失:1'])
    expect(listIn(sectionNamed(r.blocks, '未登记的目录')).map((i) => [i.cell.text, i.actions?.map((a) => a.label)])).toEqual([['moved/', ['登记为条目', '登记目录内的文件', '忽略']]])
  })
})

describe('the activity page', () => {
  it('has the acts newest first by day and in a day by scene, owner operations included: who, the act, the thing and the note, the sentence, by which grant; a scene of several acts under what it was doing, which is no row; a fact about a thing opens it; it keeps the agents’ or the owner’s, or one agent’s, each option saying how many rows', async () => {
    const { show, codex } = await relayed()
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    // The library was made at the real time, after the test's session at 02:00Z, so its init is newest.
    expect(rows[0]).toMatchObject({ actor: { kind: 'owner', name: '我' }, whose: 'owner', act: 'created', path: 'lib', text: expect.stringMatching(/^pneuma-base init \/.+\/lib$/) })
    expect(rows.slice(1, 4).map((row) => [nameOf(row.actor), row.whose, row.act, row.path, row.note, row.text, ...row.meta.map((c) => c.text)])).toEqual([
      ['claude-code', 'agent', 'archived', 'old.md', undefined, '归档 old.md', '未带授权'],
      ['claude-code', 'agent', 'decision', 'comparison.md', '用 Paddle', '决策：用 Paddle（关于 comparison.md）', '未带授权'],
      ['claude-code', 'agent', 'generated', 'recommendation.md', undefined, '生成 recommendation.md', '未带授权'],
    ])
    expect(rows[1]?.link).toEqual({ view: 'item', params: { path: '_archive/old.md' }, target: 'panel' })
    expect(rows.find((row) => row.act === 'task')).toBeUndefined()
    const feed = flat(shown(await show('ledger.activity')).blocks).find((b) => b.kind === 'feed')
    const scenes = feed?.kind === 'feed' ? feed.groups.flatMap((day) => day.groups ?? []) : []
    expect(scenes.filter((g) => g.title !== '').map((g) => [g.title, g.count, g.link])).toEqual([['给小店选支付服务', 6, { view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' }]])
    expect(rows[1]?.at).toMatch(/^2026-11-25T02:00:\d\d\.000Z$/)

    await agentFace.say({ kind: 'note', about: 'comparison.md', text: '看过了', args: {} }, codex())
    const r = shown(await show('ledger.activity'))
    expect(r.filters).toEqual([
      { name: 'who', options: [{ value: '', label: '全部', count: 8 }, { value: 'agent', label: 'Agent', count: 7 }, { value: 'owner', label: '我', count: 1 }] },
      { name: 'agent', options: [{ value: '', label: '全部 Agent', count: 8 }, { value: 'claude-code', label: 'claude-code', count: 6 }, { value: 'codex', label: 'codex', count: 1 }] },
    ])
    expect(feedRows(shown(await show('ledger.activity', { who: 'owner' })).blocks).map((row) => nameOf(row.actor))).toEqual(['我'])
    expect(feedRows(shown(await show('ledger.activity', { agent: 'codex' })).blocks).map((row) => row.text)).toEqual(['备注：看过了（关于 comparison.md）'])
  })
})

describe('the ledger’s part of the home page', () => {
  /** The home page as an agent sees it, which is what the owner sees of the agents. */
  it('tells what others did since the last look, by scene under what it was doing, with 全部标为已读, which is a check; then what needs looking at', async () => {
    const { root, show, codex, claudeIn } = await relayed()
    const asCodex = () => show('home', {}, codex())
    const first = shown(await asCodex())
    // No agent is connected on this machine, so the page opens with the kernel's first steps and requests; the ledger's step in it is done.
    expect(first.blocks.map((b) => (b.kind === 'section' ? b.title : b.kind))).toEqual([expect.any(String), expect.any(String), '最近动态', '需要关注'])
    const since = sectionNamed(first.blocks, '最近动态')
    expect(since.actions).toMatchObject([{ label: '全部标为已读', call: { face: 'agent', verb: 'check', request: { since: 'last', includeArchived: false } } }])
    const feed = since.blocks[0]
    if (feed?.kind !== 'feed') throw new Error('no feed')
    // init is setup, already told by PNEUMA-BASE.md, so it is no news.
    expect(feed.groups.map((g) => [g.title, g.count])).toEqual([['给小店选支付服务', 6]])
    expect(feed.groups[0]?.link).toEqual({ view: 'ledger.scene', params: { scene: 'sess-a' }, target: 'panel' })
    expect(feed.groups[0]?.rows.map((r) => r.text)).not.toContain('任务：给小店选支付服务')
    expect(sectionNamed(first.blocks, '需要关注').blocks).toMatchObject([{ kind: 'text', tone: 'neutral' }])

    await agentFace.check({ since: 'last', includeArchived: false }, codex())
    // Nothing since: when that look was, and the way to all that ever happened.
    const seen = sectionNamed(shown(await asCodex()).blocks, '最近动态')
    expect(seen).toMatchObject({ actions: [], note: '上次查看：2026-11-25 02:00Z', blocks: [{ kind: 'feed', groups: [], empty: '暂无新动态' }, { kind: 'list' }] })
    expect(listIn(seen).map((i) => [i.cell.text, i.cell.link])).toEqual([['查看全部活动', { view: 'ledger.activity', params: {}, target: 'main' }]])

    // A scene saying what it is doing is no act, so nothing yet; its one act is then that row, naming the scene, in a list without a heading; the section counts it.
    await agentFace.say({ kind: 'task', about: null, text: '整理首页文案', args: {} }, claudeIn('sess-c'))
    expect(sectionNamed(shown(await asCodex()).blocks, '最近动态')).toMatchObject({ count: null, blocks: [{ kind: 'feed', groups: [] }, { kind: 'list' }] })
    await agentFace.say({ kind: 'note', about: null, text: '首页先不动', args: {} }, claudeIn('sess-c'))
    const doing = sectionNamed(shown(await asCodex()).blocks, '最近动态')
    const doingFeed = doing.blocks[0]
    expect(doingFeed?.kind === 'feed' && doingFeed.groups.map((g) => [g.title, g.count, g.rows.map((r) => [r.act, r.note, r.text, r.meta.map((c) => c.text)])])).toEqual([['', null, [['note', '首页先不动', '备注：首页先不动', ['整理首页文案', '未带授权']]]]])
    expect(doing).toMatchObject({ count: 1, note: null })

    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    const attention = sectionNamed(shown(await asCodex()).blocks, '需要关注')
    expect(listIn(attention).map((i) => [i.cell.text, i.cell.link])).toEqual([
      ['可能已过期：1 个', { view: 'ledger.status', params: { kind: 'stale' }, target: 'main' }],
      ['上游已标记：1 个', { view: 'ledger.status', params: { kind: 'upstream' }, target: 'main' }],
      ['外部修改：1 个', { view: 'ledger.status', params: { kind: 'changed' }, target: 'main' }],
    ])
    expect(sectionNamed(shown(await show('ledger.status', { kind: 'changed' })).blocks, '外部修改').count).toBe(1)
    // One kind alone: the deep pass that tells a real change from a touch, then that kind's section.
    expect(shown(await show('ledger.status', { kind: 'changed' })).blocks.map((b) => b.kind)).toEqual(['actions', 'section'])
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
    expect(loose).toMatchObject({ by: '溯源', text: '资料库根目录中有 2 个未登记的文件。', suggested: 0 })
    expect(loose?.actions.map((a) => [a.label, a.call])).toEqual([
      ['全部标记为我导入', { face: 'owner', command: 'ledger register', args: { positional: ['.'], flags: {} } }],
      ['忽略且不再提示', { face: 'owner', command: 'ledger dismiss', args: { positional: ['.'], flags: {} } }],
    ])
    expect(closed).toMatchObject({ text: 'notes/ 未登记：1 个文件。', about: 'notes' })
    expect(closed?.actions[1]?.confirm).toBe('将登记 notes/ 中所有层级的全部文件：1 个，不含已忽略的。')
    expect(closed?.actions.map((a) => [a.label, a.call])).toEqual([
      ['登记为条目', { face: 'agent', verb: 'put', request: { kind: 'register', path: 'notes', origin: { kind: 'imported', source: null, by: 'owner' }, note: null } }],
      ['登记目录内的文件', { face: 'owner', command: 'ledger register', args: { positional: ['notes'], flags: { recursive: true } } }],
      ['忽略', { face: 'owner', command: 'ignore add', args: { positional: ['notes'], flags: {} } }],
    ])
    // Nothing else to look at, said without claiming the unregistered things match a record.
    expect(sectionNamed(shown(await show('home')).blocks, '需要关注').blocks).toEqual([{ kind: 'text', tone: 'neutral', text: '已登记条目均与记录一致。' }])

    const register = loose?.actions[0]?.call
    if (register?.face !== 'owner') throw new Error('no owner call')
    expect(await run(register)).toMatchObject({ outcome: 'done', text: '已将 2 个文件标记为所有者导入。', data: { registered: 2 } })
    const inside = (await asks()).find((a) => a.about === 'notes')?.actions[1]?.call
    if (inside?.face !== 'owner') throw new Error('no owner call')
    expect(await run(inside)).toMatchObject({ outcome: 'done', text: '已将 notes/ 中的 1 个文件标记为所有者导入。', data: { registered: 1 } })
    expect(await asks()).toEqual([])
    const came = sectionNamed(shown(await show('item', { path: 'notes/n1.md' })).blocks, '溯源').blocks
    expect(fieldIn(came, '来源')?.value.text).toBe('导入（所有者提供）')
    const rows = feedRows(shown(await show('ledger.activity')).blocks)
    expect(rows.map((r) => r.text).filter((t) => t.includes('ledger register') || /^(导入|生成) /.test(t))).toEqual([
      'pneuma-base ledger register notes --recursive',
      'pneuma-base ledger register .',
    ])
    // Each says what it did to what: brought in, the folder.
    expect(rows.filter((r) => r.text.includes('ledger register')).map((r) => [r.act, r.path])).toEqual([
      ['imported', 'notes'],
      ['imported', '.'],
    ])
    expect(shown(await show('ledger.status')).blocks).toMatchObject([{ kind: 'actions' }, { kind: 'empty' }])
  })

  it('left as they are: not asked about again, still on the standing page; a later pile is asked about anew', async () => {
    const { root, show, run, asks } = await folderWithFiles(4)
    const leave = (await asks())[0]?.actions[1]?.call
    if (leave?.face !== 'owner') throw new Error('no owner call')
    expect(await run(leave)).toMatchObject({ outcome: 'done', data: { left: 2 } })
    const closedOnly = ['notes/ 未登记：2 个文件。']
    expect((await asks()).map((a) => a.text)).toEqual(closedOnly)
    expect(sectionNamed(shown(await show('ledger.status')).blocks, '未登记').count).toBe(2)
    writeFileSync(join(root, 'later.md'), 'dropped in later')
    expect((await asks()).map((a) => a.text)).toEqual(['资料库根目录中有 1 个未登记的文件。', ...closedOnly])
  })
})

describe('held copies and changes in the ledger’s blocks', () => {
  it('say whose content each was: a held copy can be taken back to a new path, as ledger copies restore; a put’s note ends its entry and its activity row; an edit the owner made and an agent recorded names both', async () => {
    const { root, show, codex } = await relayed()
    await agentFace.put({ kind: 'place', from: text('cmp v2'), to: 'comparison.md', origin: { kind: 'generated', from: ['src/stripe.html'], outside: [] }, note: '换了结论' }, codex())
    const provenance = sectionNamed(shown(await show('item', { path: 'comparison.md' })).blocks, '溯源')
    expect(sectionNamed(provenance.blocks, '历史副本').blocks.find((b) => b.kind === 'list')).toMatchObject({
      items: [
        {
          // Whose content it was, not where the plugin keeps it.
          note: 'claude-code 添加的内容',
          actions: [
            {
              label: '恢复到新路径',
              inputs: [{ name: 'to', value: expect.stringMatching(/^comparison\.[0-9a-f]{8}\.md$/) }],
              call: { face: 'owner', command: 'ledger copies restore', args: { positional: [expect.stringMatching(/^i_/)], flags: { fingerprint: [expect.stringMatching(/^[0-9a-f]{64}$/)], to: ['{to}'] } } },
            },
          ],
        },
      ],
    })
    const changes = sectionNamed(provenance.blocks, '历史记录').blocks[0]
    // Each change: who, as its mark, and the sentence it came with.
    const lines = changes?.kind === 'timeline' ? changes.entries.filter((e) => e.title.text !== '用 Paddle').map((e) => [e.actor === undefined ? null : nameOf(e.actor), e.lines]) : []
    expect(lines).toEqual([
      ['codex', ['换了结论']],
      ['claude-code', []],
    ])
    const activity = async () => feedRows(shown(await show('ledger.activity')).blocks)
    expect((await activity()).filter((row) => nameOf(row.actor) === 'codex').map((row) => row.text)).toEqual(['comparison.md 内容已更新：换了结论'])

    writeFileSync(join(root, 'src/stripe.html'), 'stripe, new prices')
    await agentFace.say({ kind: 'revised', about: 'src/stripe.html', text: null, args: { by: ['owner'] } }, codex())
    expect((await activity()).filter((row) => row.text === '记录 src/stripe.html 为所有者直接修改').map((row) => nameOf(row.actor))).toEqual(['codex'])
    await agentFace.put({ kind: 'place', from: text('stripe v3'), to: 'src/stripe.html', origin: { kind: 'imported', source: null, by: null } }, codex())
    const stripe = sectionNamed(shown(await show('item', { path: 'src/stripe.html' })).blocks, '溯源')
    expect(sectionNamed(stripe.blocks, '历史记录').blocks[0]).toMatchObject({ entries: [{ tag: { text: '当前' } }, { title: { text: '所有者直接修改' }, actor: { kind: 'owner' }, lines: ['codex 代为记录'] }, {}] })
    expect(sectionNamed(stripe.blocks, '历史副本').blocks.find((b) => b.kind === 'list')).toMatchObject({ items: [{ note: '所有者直接修改的内容，codex 代为记录' }] })
  })
})

describe('bundles in the ledger’s blocks', () => {
  it('the items table marks a bundle and leaves out the things it absorbed; the panel of a file inside it says what it is part of, absorbed or never registered', async () => {
    const { root, show, codex } = await relayed()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>')
    await agentFace.put({ kind: 'register', path: 'site/index.html', origin: { kind: 'imported', source: null, by: null } }, codex())
    // A directory holding a registered thing is open: registering it takes its loose files, unless its marker makes it one thing.
    writeFileSync(join(root, 'site/.pneuma-item'), '')
    await agentFace.put({ kind: 'register', path: 'site', origin: { kind: 'generated', from: ['comparison.md'], outside: [] } }, codex())
    writeFileSync(join(root, 'site/later.css'), 'h1{}')
    const rows = rowsOf(await show('ledger.items'))
    expect(rows.map((r) => r.link?.params.path)).not.toContain('site/index.html')
    expect(rows.find((r) => r.cells.path?.text === 'site')?.cells.path).toMatchObject({ icon: 'package' })
    expect(rows.find((r) => r.cells.path?.text === 'comparison.md')?.cells.path).toMatchObject({ icon: 'file' })

    const absorbed = sectionNamed(shown(await show('item', { path: 'site/index.html' })).blocks, '溯源').blocks
    expect(fieldIn(absorbed, '状态')?.value).toMatchObject({ text: 'site', tag: { text: '已合并到' }, link: { view: 'item', params: { path: 'site' }, target: 'panel' } })
    const part = sectionNamed(shown(await show('item', { path: 'site/later.css' })).blocks, '溯源').blocks
    expect(part).toEqual([{ kind: 'fields', line: true, fields: [{ label: '来源记录于', value: { text: '来源记录于 site', icon: 'package', link: { view: 'item', params: { path: 'site' }, target: 'panel' } } }] }])
  })
})
