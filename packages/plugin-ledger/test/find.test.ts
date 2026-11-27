// What the ledger tells find about a path another plugin found: the scene and origin of an item,
// nothing about a file nobody registered. A find by origin, and by the words of a put's note. Driven
// through the kernel with an ad hoc finder.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, pluginName, type Actor, type Library, type LibraryPath, type Plugin, type Session } from '@pneuma-base/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import { ledger } from '../src/index.js'

const finder: Plugin = {
  contract: 2,
  name: pluginName('finder'),
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  onFind: async () => ['notes/coffee.md', 'notes/loose.md'].map((path) => ({ path: path as LibraryPath, title: path, group: null, detail: '按意思：…' })),
}
const table = new Map([ledger, finder].map((p) => [p.name as string, p]))
const owner: Actor = { kind: 'owner' }
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const codex: Actor = { kind: 'agent', name: 'codex', grant: null }
const session = (id: string): Session => ({ id, source: 'flag', cwd: '/work', machine: 'test', transcript: null })
const text = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })

let lib: Library
let home: string
const find = (words: string, filters: Record<string, string> = {}) =>
  agentFace.find({ text: words, match: 'terms', filters, includeArchived: false, skipOwnSession: false }, makeContext(lib, codex, session('s2'), home))

beforeAll(async () => {
  const root = join(realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-l-'))), 'lib')
  home = join(root, '..', 'home')
  await initLibrary(root, { plugins: ['ledger', 'finder'], table, actor: owner, session: session('init'), home })
  lib = (await openLibrary(root, table)) as Library
  const s1 = makeContext(lib, claude, session('s1'), home)
  await agentFace.say({ kind: 'doing', about: null, text: '写咖啡笔记', args: {} }, s1)
  await agentFace.put({ kind: 'place', from: text('手冲咖啡要注意水温和研磨度。\n'), to: 'notes/coffee.md', origin: { kind: 'made', from: [], outside: [] } }, s1)
  await agentFace.put({ kind: 'place', from: text('收据\n'), to: 'misc/receipt.txt', origin: { kind: 'brought', source: null, by: null } }, makeContext(lib, claude, session('s3'), home))
  const s4 = makeContext(lib, claude, session('s4'), home)
  await agentFace.put({ kind: 'place', from: text('一\n'), to: 'tea/pot.md', origin: { kind: 'made', from: [], outside: [] }, note: '陶瓷壶初稿' }, s4)
  await agentFace.put({ kind: 'place', from: text('二\n'), to: 'tea/pot.md', origin: { kind: 'made', from: [], outside: [] }, note: '换成玻璃壶后重写' }, s4)
  writeFileSync(join(root, 'notes/loose.md'), '没人登记过\n')
})

describe('a path only another plugin found', () => {
  it('gets the scene it was made in and its origin from the ledger; a file nobody registered gets nothing', async () => {
    const r = await find('怎么冲出好喝的咖啡')
    expect(r.problems).toEqual([])
    const ledgerHits = r.hits.filter((h) => h.by === 'ledger')
    expect(ledgerHits).toMatchObject([{ path: 'notes/coffee.md', title: 'coffee.md', detail: '做出来的' }])
    expect(ledgerHits[0]?.group).toMatch(/^场景 s1 · claude-code · \d{4}-\d\d-\d\d \d\d:\d\dZ · 在做：写咖啡笔记$/)
    expect(r.hits.filter((h) => h.path === 'notes/loose.md').map((h) => h.by)).toEqual(['finder'])
  })
})

describe('a find by origin', () => {
  it('gives the ledger’s things that came that way, and no other', async () => {
    const byLedger = async (origin: string) => (await find('', { origin })).hits.filter((h) => h.by === 'ledger').map((h) => h.path)
    expect((await byLedger('made')).sort()).toEqual(['notes/coffee.md', 'tea/pot.md'])
    expect(await byLedger('brought')).toEqual(['misc/receipt.txt'])
  })
})

describe('a put’s note', () => {
  it('is matched by find, both from the first put and from a later one', async () => {
    const found = async (words: string) => (await find(words)).hits.filter((h) => h.by === 'ledger').map((h) => h.path)
    for (const words of ['陶瓷壶', '玻璃壶']) expect(await found(words), words).toContain('tea/pot.md')
    expect(await found('铁壶')).not.toContain('tea/pot.md')
  })
})
