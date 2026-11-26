// The command line is the reference; the management UI is a face of it. On a library with the five
// built-in plugins and something in each of their pages, every page reached from the navigation and
// its links is checked both ways:
// - every page prints with `show`, and its words carry every cell, every button's command and, for a
//   long list, which rows of how many it shows with the commands for the pages on either side;
// - every button calls a verb, or an owner command the library runs with arguments it takes;
// - every business verb and command has a button or is the read behind a page, and every management
//   command has a place on the owner's pages; what has none is listed below with why.
import { join } from 'node:path'
import { actionFault, callableIn, openLibrary, ownerFace, type Action, type Block, type Cell, type Link, type ListedView, type Paging, type TreeNode, type ViewResult } from '@pneuma-base/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import { main, type Io } from '../dist/main.js'
import { commandOf, linkCommand, minute } from '../dist/page.js'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

type Shown = Extract<ViewResult, { outcome: 'shown' }>
type Page = { link: Link; json: Shown; text: string }

/** What a business verb or command reads, where a page shows the same: it has no button because the page is the reading. */
const READS: Record<string, string> = {
  inspect: 'item',
  'plugin list': 'config',
  'secret list': 'config',
  'ledger held list': 'ledger.held',
  'ledger stats': 'ledger.stats',
  'version list': 'version.things',
  'sync status': 'sync.status',
  'deploy list': 'deploy.sites',
  'search status': 'search.status',
  'agent list': 'agents',
  'agent detect': 'agents',
  'request list': 'home',
  'noise list': 'config',
  'pair list': 'home',
}

/** What has no button on any page, and why. */
const NO_PLACE: Record<string, string> = {
  find: '一个搜索框要一个人自己打字的页面参数，界面的页现在只从筛选的选项和链接拿参数；要等界面能问一个自由的输入。找按名字时，人翻「文件」和「库」',
  'say doing': '说的是 agent 这次会话在做什么；人在界面里的操作自成一个主人的场景，场景里记的就是做了哪些操作',
  ask: '请是 agent 请主人做一条主人命令；主人在界面里直接按那条命令的按钮，用不着请谁',
  'launcher install': '没有要主人决定的：应用每次启动时写它，接上 agent 时缺了也写；从包装的，主人在终端里跑',
  'ledger export': '它写一个库外的文件，页交不出文件，也不替主人选位置；活动页的「导出」给出这条命令，复制到终端里跑',
}

let sb: Sandbox
let lib: string
let work: string
let home: string
const pages: Page[] = []

const env = () => ({ PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: home })

/** The command line in this process, as the owner, so a crawl of every page is quick. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    env: env(),
    cwd: work,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readStdin: async () => new Uint8Array(),
    readLines: async function* () {},
    readSecret: async () => null,
    confirm: async () => false,
    untilStopped: async () => undefined,
    openBrowser: () => undefined,
  }
  const code = await main(['--library', lib, ...args], builtinPlugins, io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const flagsOf = (params: Record<string, string>) => Object.entries(params).flatMap(([k, v]) => [`--${k}`, v])

function allBlocks(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((b) => [b, ...(b.kind === 'section' ? allBlocks(b.blocks) : b.kind === 'steps' ? b.steps.flatMap((s) => allBlocks(s.blocks)) : [])])
}

function actionsOf(b: Block): Action[] {
  switch (b.kind) {
    case 'section':
    case 'actions':
      return b.actions
    case 'table':
      return b.rows.flatMap((r) => r.actions)
    case 'list':
      return b.items.flatMap((i) => i.actions)
    case 'timeline':
      return b.entries.flatMap((e) => e.actions ?? [])
    case 'custom':
      return Object.values(b.actions)
    case 'feed':
      return b.groups.flatMap((g) => g.rows.flatMap((r) => (r.action ? [r.action] : [])))
    case 'asks':
      return b.asks.flatMap((a) => a.actions)
    default:
      return []
  }
}

function cellsOf(b: Block): Cell[] {
  switch (b.kind) {
    case 'table':
      return b.rows.flatMap((r) => Object.values(r.cells))
    case 'fields':
      return b.fields.map((f) => f.value)
    case 'list':
      return b.items.map((i) => i.cell)
    case 'timeline':
      return b.entries.map((e) => e.title)
    case 'feed':
      return b.groups.flatMap((g) => g.rows.flatMap((r) => r.meta))
    default:
      return []
  }
}

/** The paging of a block that holds one page of a long list. */
function pagingOf(b: Block): Paging | undefined {
  return b.kind === 'table' || b.kind === 'list' || b.kind === 'feed' || b.kind === 'timeline' ? b.page : undefined
}

/** The links of a block on the page of `view`: a tree's folders are that view with its parameter set; a long list's pages on either side. */
function linksOf(b: Block, view: string): Link[] {
  const page = pagingOf(b)
  const cells = [...cellsOf(b).flatMap((c) => (c.link ? [c.link] : [])), ...(page ? [page.prev, page.next].filter((l): l is Link => l !== null) : [])]
  const nodes = (list: readonly TreeNode[]): TreeNode[] => list.flatMap((n) => [n, ...nodes(n.children)])
  switch (b.kind) {
    case 'table':
      return [...cells, ...b.rows.flatMap((r) => (r.link ? [r.link] : []))]
    case 'feed':
      return [...cells, ...b.groups.flatMap((g) => [...(g.link ? [g.link] : []), ...g.rows.flatMap((r) => (r.link ? [r.link] : []))])]
    case 'tree':
      return nodes(b.nodes).map((n) => ({ view, params: { [b.param]: n.value }, target: 'main' as const }))
    case 'asks':
      return b.asks.flatMap((a) => (a.about === null ? [] : [{ view: 'item', params: { path: a.about }, target: 'panel' as const }]))
    default:
      return cells
  }
}

/** What a button does, as the coverage counts it: an owner command by name, a verb with the kind of its request. */
function capability(a: Action): string {
  const { call } = a
  if (call.face === 'owner') return call.command
  if (call.verb === 'put') return `put ${call.request.kind}`
  if (call.verb === 'say') return `say ${call.request.kind}`
  if (call.verb === 'archive') return call.request.kind
  return call.verb
}

const write = async (path: string, content: string) => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(async () => {
  sb = sandbox()
  home = join(sb.home, '.pneuma-base')
  lib = join(tempDir(), 'lib')
  work = tempDir('pb-work-')
  const owner = (args: string[]) => {
    const r = sb.run(['--library', lib, ...args], { cwd: work })
    expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
  }
  const agent = (args: string[], input?: string) => {
    const r = sb.run(['@claude', ...args], { cwd: work, env: { PNEUMA_BASE_SESSION: 'pages' }, ...(input === undefined ? {} : { input }) })
    expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
  }
  expect(sb.run(['init', lib]).code).toBe(0)
  for (const p of ['version', 'deploy', 'sync', 'search']) owner(['plugin', 'add', p])
  owner(['grant', 'issue', 'claude', '--agent', 'claude-code'])
  // One agent product connected and one found and not connected, so the agents page has 断开 and 接上.
  await write(join(sb.home, '.claude/settings.json'), '{}\n')
  await write(join(sb.home, '.cursor/argv.json'), '{}\n')
  owner(['agent', 'connect', 'claude-code'])
  owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-www-'), 'www')])
  owner(['sync', 'target', 'set', '--kind', 'dir', '--to', tempDir('pb-sync-')])
  owner(['search', 'embedder', 'set', '--kind', 'hash'])
  await write(join(work, 'shop/index.html'), '<h1>小店</h1>\n')
  await write(join(work, 'blog/index.html'), '<h1>博客</h1>\n')
  agent(['say', 'doing', '整理小店的资料'])
  agent(['put', 'shop', '--to', 'sites/shop', '--made'])
  agent(['put', 'blog', '--to', 'sites/blog', '--made'])
  agent(['say', 'deployable', 'sites/shop'])
  agent(['say', 'deployable', 'sites/blog'])
  owner(['deploy', 'on', 'sites/shop'])
  agent(['put', '-', '--to', 'sources/pricing.html', '--brought', '--source', 'https://example.com/pricing'], '<p>价格</p>\n')
  agent(['put', '-', '--to', 'notes/plan.md', '--made', '--from', 'sources/pricing.html', '--note', '第一版'], '# 计划\n')
  agent(['say', 'versioned', 'notes/plan.md', '开始记版本'])
  agent(['put', '-', '--to', 'notes/plan.md', '--made', '--note', '改了'], '# 计划 v2\n')
  agent(['put', '-', '--to', 'notes/draft.md', '--made'], '草稿\n')
  agent(['put', 'notes/draft.md', '--to', 'notes/draft-moved.md'])
  agent(['put', '-', '--to', 'notes/old.md', '--made'], '旧的\n')
  agent(['archive', 'notes/old.md'])
  // A request waiting on the owner, so the home page has 批准 and 拒绝.
  agent(['ask', '要给博客也设一个部署目标', 'deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-www2-'), 'www')])
  // An agent asking to be connected, so the home page has 允许 and 拒绝.
  expect(sb.run(['pair', 'request', 'codex', '想接上这个库', '--library', lib], { cwd: work }).code).toBe(0)
  // A plugin on this machine the library has not installed, and a secret set, so their buttons are on the config page.
  await write(join(work, 'extra/index.js'), "export default { contract: 1, name: 'extra', cognition: null, storage: [], statements: [], ownerCommands: [] }\n")
  expect(sb.run(['plugin', 'install', join(work, 'extra')], { cwd: work }).code).toBe(0)
  expect(sb.run(['secret', 'set', 'search', 'key'], { cwd: work, input: 'sk-test\n' }).code).toBe(0)
  await write(join(lib, 'notes/dropped.md'), '主人直接放进来的\n')
  await write(join(lib, 'sources/pricing.html'), '<p>价格，手改过</p>\n')
  // More things in one folder than a page of show holds, so the library's table comes in pages; and a
  // directory nobody registered anything in, so the files page and home have its three answers.
  for (let i = 1; i <= 25; i++) await write(join(lib, `inbox/scan-${String(i).padStart(2, '0')}.pdf`), `scan ${i}\n`)
  owner(['ledger', 'register', 'inbox', '--inside'])
  await write(join(lib, 'scans/receipt.pdf'), '收据\n')

  // Every view in the list with its filters' defaults, then every page a link on one of them opens, a few
  // of each view in each folder, so a long folder does not use up a view's share.
  const listed = JSON.parse((await cli(['show', '--json'])).out) as { views: ListedView[] }
  const queue: Link[] = listed.views.filter((v) => v.nav).map((v) => ({ view: v.id, params: {}, target: 'main' }))
  const seen = new Set<string>()
  const perView = new Map<string, number>()
  while (queue.length > 0) {
    const link = queue.shift() as Link
    const key = JSON.stringify([link.view, link.params])
    const share = `${link.view} ${(link.params.path ?? '').split('/')[0]}`
    if (seen.has(key) || (perView.get(share) ?? 0) >= 12) continue
    seen.add(key)
    perView.set(share, (perView.get(share) ?? 0) + 1)
    const args = ['show', link.view, ...flagsOf(link.params)]
    const json = await cli([...args, '--json'])
    const text = await cli(args)
    expect(json.code, `${args.join(' ')}\n${json.out}${json.err}`).toBe(0)
    expect(text.code, `${args.join(' ')}\n${text.err}`).toBe(0)
    const page: Page = { link, json: JSON.parse(json.out) as Shown, text: text.out }
    pages.push(page)
    queue.push(...allBlocks(page.json.blocks).flatMap((b) => linksOf(b, link.view)))
  }
}, 120_000)

describe('every page of a library with every built-in plugin', () => {
  it('is reached: each view in the list, the item panel of a file, a bundle, a file inside one and an archived file, and a scene card', () => {
    const views = new Set(pages.map((p) => p.link.view))
    for (const id of ['home', 'ledger.items', 'ledger.stats', 'ledger.scenes', 'ledger.standing', 'ledger.activity', 'ledger.held', 'ledger.scene', 'version.things', 'deploy.sites', 'sync.status', 'search.status', 'files', 'archive', 'agents', 'config', 'item']) expect(views, id).toContain(id)
    const items = pages.filter((p) => p.link.view === 'item').map((p) => p.link.params.path)
    expect(items).toEqual(expect.arrayContaining(['notes/plan.md', 'sites/shop', 'sites/shop/index.html', '_archive/notes/old.md']))
  })

  it('prints with show: the words carry every cell, every custom block’s text and every button as its command', async () => {
    const library = await openLibrary(lib, builtinPlugins)
    const commands = ownerFace.commands(library?.plugins ?? [])
    for (const { link, json, text } of pages) {
      const where = `show ${link.view} ${flagsOf(link.params).join(' ')}`
      for (const block of allBlocks(json.blocks)) {
        for (const cell of cellsOf(block)) {
          const words = cell.at === undefined ? cell.text : minute(cell.at)
          expect(text, `${where}: ${words}`).toContain(words)
          if (cell.tag) expect(text, `${where}: ${cell.tag.text}`).toContain(`[${cell.tag.text}]`)
          if (cell.href) expect(text, `${where}: ${cell.href}`).toContain(cell.href)
        }
        if (block.kind === 'custom') expect(text, where).toContain(block.text)
        if (block.kind === 'section') expect(text, where).toContain(block.title)
        if (block.kind === 'text') expect(text, where).toContain(block.text)
        if (block.kind === 'feed') for (const row of block.groups.flatMap((g) => g.rows)) expect(text, `${where}: ${row.text}`).toContain(row.text)
        if (block.kind === 'asks') for (const ask of block.asks) expect(text, `${where}: ${ask.text}`).toContain(`${ask.text}${ask.command === undefined ? '' : `（${typeof ask.by === 'string' ? ask.by : ask.by.name}）\n    ${ask.command}`}`)
        if (block.kind === 'stats') for (const stat of block.stats) expect(text, `${where}: ${stat.label}`).toContain(`${stat.label}：${stat.value}`)
        if (block.kind === 'tree') for (const node of block.nodes) expect(text, `${where}: ${node.label}`).toContain(node.label)
        if (block.kind === 'steps') for (const step of block.steps) expect(text, `${where}: ${step.title}`).toContain(`] ${step.title}`)
        if (block.kind === 'drop') expect(text, where).toContain(`$ ${block.command}`)
        if (block.kind === 'chart') for (const words of [block.text, ...block.series.map((x) => x.label), ...block.x]) expect(text, `${where}: ${words}`).toContain(words)
        for (const action of actionsOf(block)) expect(text, `${where}: ${action.label}`).toContain(`$ ${commandOf(action, commands)}  # ${action.label}`)
        const page = pagingOf(block)
        if (page && (page.prev !== null || page.next !== null)) {
          expect(text, where).toContain(`第 ${page.first}–${page.first + page.shown - 1} 项，${page.atLeast ? '至少' : '共'} ${page.total} 项`)
          if (page.next) expect(text, where).toContain(`下一页 → ${linkCommand(page.next)}`)
          if (page.prev) expect(text, where).toContain(`上一页 → ${linkCommand(page.prev)}`)
        }
      }
    }
  })

  it('pages a long list in show as it does on the page: the next page starts where this one stops, and leads back', () => {
    const items = (p: Page) => allBlocks(p.json.blocks).find((b) => b.kind === 'table' && b.page !== undefined)
    const first = pages.find((p) => p.link.view === 'ledger.items' && p.link.params.dir === 'inbox' && p.link.params.after === undefined)
    const firstTable = first && items(first)
    if (firstTable?.kind !== 'table' || firstTable.page?.next == null) throw new Error('no first page of inbox with a next page')
    expect(firstTable.page).toMatchObject({ first: 1, shown: 20, total: 25 })
    const next = firstTable.page.next
    const second = pages.find((p) => linkCommand(p.link) === linkCommand(next))
    const secondTable = second && items(second)
    if (secondTable?.kind !== 'table') throw new Error('the next page of inbox was not reached')
    expect(secondTable.page).toMatchObject({ first: 21, shown: 5, total: 25, next: null })
    // Its previous page is the first: the same folder, from the start.
    expect(secondTable.page?.prev?.params).toMatchObject({ dir: 'inbox' })
    expect(secondTable.page?.prev?.params.after).toBeUndefined()
    expect(new Set([...firstTable.rows, ...secondTable.rows].map((r) => r.key)).size).toBe(25)
  })

  it('gives a directory nobody registered anything in as one row with what a look found and its three answers, as commands too', () => {
    const files = pages.find((p) => p.link.view === 'files' && Object.keys(p.link.params).length === 0)
    if (!files) throw new Error('no files page')
    const scans = allBlocks(files.json.blocks).flatMap((b) => (b.kind === 'table' ? b.rows : [])).find((r) => r.key === 'scans')
    expect(scans).toMatchObject({ cells: { name: { tag: { text: '没登记' } }, size: { text: '1 个文件' } } })
    expect(scans?.actions.map((a) => a.label)).toEqual(['登记成一样东西', '登记里面的文件', '不用管'])
    expect(files.text).toContain('$ ledger register scans --inside  # 登记里面的文件（只给主人）；先问：要登记 scans/ 里任意深处的全部文件：1 个，不含噪音。')
  })

  it('has buttons that each call a verb, or an owner command the library runs with arguments its params take, and no problem', async () => {
    const library = await openLibrary(lib, builtinPlugins)
    if (library === null) throw new Error('no library')
    const callable = callableIn(library)
    for (const { link, json } of pages) {
      expect(json.problems, link.view).toEqual([])
      for (const action of allBlocks(json.blocks).flatMap(actionsOf)) expect(actionFault(action, callable), `${link.view}: ${action.label}`).toBeNull()
    }
  })

  it('reaches every business verb and command from a button or a page that reads the same, and every management command from the owner’s pages', async () => {
    const library = await openLibrary(lib, builtinPlugins)
    if (library === null) throw new Error('no library')
    const buttons = new Set(pages.flatMap((p) => allBlocks(p.json.blocks).flatMap(actionsOf).map(capability)))
    const shown = new Set(pages.map((p) => p.link.view))
    const said = library.plugins.flatMap((p) => (p.onSay ? p.statements.map((k) => `say ${k}`) : []))
    const verbs = ['put register', 'put place', 'put move', 'find', 'inspect', 'check', 'archive', 'unarchive', 'ask', ...said]
    const commands = ownerFace.commands(library.plugins)
    const business = [...verbs, ...commands.filter((c) => !c.ownerOnly && !c.destructive).map((c) => c.name)]
    const management = commands.filter((c) => c.ownerOnly || c.destructive).map((c) => c.name)
    const placed = (name: string) => buttons.has(name) || (READS[name] !== undefined && shown.has(READS[name] as string)) || NO_PLACE[name] !== undefined
    expect({ business: business.filter((name) => !placed(name)), management: management.filter((name) => !placed(name)) }).toEqual({ business: [], management: [] })
    // What is listed as having no place, or a page that reads it, has none of its own buttons, so the lists stay true.
    for (const name of Object.keys(NO_PLACE)) expect(buttons.has(name), `${name} has a button now`).toBe(false)
    for (const name of Object.keys(READS)) expect(buttons.has(name), `${name} has a button now`).toBe(false)
  })
})
