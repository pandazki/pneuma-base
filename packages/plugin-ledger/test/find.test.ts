// What the ledger tells find about a path another plugin found: the scene and origin of an item,
// nothing about a file nobody registered. Driven through the kernel with an ad hoc finder.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, pluginName, type Actor, type LibraryPath, type Plugin, type Session } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { ledger } from '../src/index.js'

const finder: Plugin = {
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

describe('a path only another plugin found', () => {
  it('gets the scene it was made in and its origin from the ledger; a file nobody registered gets nothing', async () => {
    const root = join(realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-l-'))), 'lib')
    const home = join(root, '..', 'home')
    await initLibrary(root, { plugins: ['ledger', 'finder'], table, actor: owner, session: session('init'), home })
    const lib = await openLibrary(root, table)
    if (!lib) throw new Error('no library')
    const s1 = makeContext(lib, claude, session('s1'), home)
    await agentFace.say({ kind: 'doing', about: null, text: '写咖啡笔记', args: {} }, s1)
    const content = new TextEncoder().encode('手冲咖啡要注意水温和研磨度。\n')
    await agentFace.put({ kind: 'place', from: { kind: 'stdin', content }, to: 'notes/coffee.md', origin: { kind: 'made', from: [], outside: [] } }, s1)
    writeFileSync(join(root, 'notes/loose.md'), '没人登记过\n')

    const r = await agentFace.find({ text: '怎么冲出好喝的咖啡', match: 'terms', filters: {}, includeArchived: false, skipOwnSession: false }, makeContext(lib, codex, session('s2'), home))
    expect(r.problems).toEqual([])
    const ledgerHits = r.hits.filter((h) => h.by === 'ledger')
    expect(ledgerHits).toMatchObject([{ path: 'notes/coffee.md', title: 'coffee.md', detail: '做出来的' }])
    expect(ledgerHits[0]?.group).toMatch(/^场景 s1 · claude-code · \d{4}-\d\d-\d\d \d\d:\d\dZ · 在做：写咖啡笔记$/)
    expect(r.hits.filter((h) => h.path === 'notes/loose.md').map((h) => h.by)).toEqual(['finder'])
  })
})
