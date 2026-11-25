// Run 2 C3 at the ledger: the items view and the ledger's section of the item panel, through the
// kernel's viewer face, from the same fold and reconcile that inspect and check use. Views write nothing.
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  const root = join(realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-ui-'))), 'lib')
  await initLibrary(root, { plugins: ['ledger'], table, actor: { kind: 'owner' }, session: session('init') })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const ctx = () => makeContext(lib, claude, session('sess-a'), next())
  await agentFace.say({ kind: 'doing', about: null, text: '给小店选支付服务', args: {} }, ctx())
  await agentFace.put({ kind: 'place', from: text('stripe'), to: 'src/stripe.html', origin: { kind: 'brought', source: 'https://stripe.com/pricing', by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('old'), to: 'old.md', origin: { kind: 'brought', source: null, by: null } }, ctx())
  await agentFace.put({ kind: 'place', from: text('cmp'), to: 'comparison.md', origin: { kind: 'made', from: ['src/stripe.html'], outside: ['主人说客户在欧洲'] } }, ctx())
  await agentFace.put({ kind: 'place', from: text('rec'), to: 'recommendation.md', origin: { kind: 'made', from: ['comparison.md'], outside: [] } }, ctx())
  await agentFace.say({ kind: 'decided', about: 'comparison.md', text: '用 Paddle', args: {} }, ctx())
  await agentFace.archive({ kind: 'archive', path: 'old.md' }, ctx())
  const show = (view: string, params: Record<string, string> = {}) => viewerFace.show({ view, params }, { ctx: makeContext(lib, { kind: 'owner' }, session('ui'), next()), table })
  return { root, show }
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
    expect(sectionNamed(shown(await show('item', { path: 'dropped.md' })).blocks, '来历').blocks).toMatchObject([{ kind: 'text', text: expect.stringContaining('来历不明') }])
    expect(shown(await show('item', { path: 'nothing.md' })).blocks.filter((b) => b.kind === 'section')).toEqual([])
  })

  it('writes no fact: neither view adopts, records or takes back anything', async () => {
    const { root, show } = await relayed()
    writeFileSync(join(root, 'dropped.md'), 'by hand')
    const facts = () => readdirSync(join(root, '.pneuma-base/ledger/facts'), { recursive: true }).length
    const before = facts()
    await show('ledger.items', { archived: 'yes' })
    for (const path of ['comparison.md', 'dropped.md', 'old.md']) await show('item', { path })
    expect(facts()).toBe(before)
  })
})
