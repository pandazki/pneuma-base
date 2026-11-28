// The records say what is in the library, and storage is looked at only where they point (ARCHITECTURE.md,
// 「领域怎样建在存储上」). A directory no record points into is one line, never opened, even when nobody
// can read it; noise is never mentioned; the rows are a cache that may be thrown away; an agent's start
// and check are bounded, as text and as JSON.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_JSON_LIMIT, AGENT_TEXT_LIMIT } from '../src/format.js'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'
import { call, connect } from './mcp-cases.js'

let sb: Sandbox
let lib: string
let closed = ''

const ok = (r: Run) => {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}
const agent = (args: string[], input?: string) => ok(sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], input === undefined ? {} : { input }))
const owner = (args: string[]) => ok(sb.run(['--library', lib, ...args]))
const titles = (r: Run) => (r.json().sections as { title: string }[]).map((s) => s.title)

/** A library with one registered file and a folder nobody registered and nobody may read. */
function setUp() {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  ok(sb.run(['init', lib]))
  agent(['put', '-', '--to', 'notes/a.md', '--generated'], 'a')
  // A folder nobody registered and nobody may read: opening it would fail, so nothing may open it.
  closed = join(lib, 'vendor')
  mkdirSync(join(closed, 'pkg'), { recursive: true })
  writeFileSync(join(closed, 'pkg/index.js'), 'x')
  chmodSync(closed, 0o000)
}

afterEach(() => {
  if (closed !== '') chmodSync(closed, 0o755)
  closed = ''
})

describe('a directory no record points into', () => {
  it('is one line in check and one question on the home page, and is never opened', () => {
    setUp()
    const check = agent(['check', '--json']).json()
    expect(check.problems).toEqual([])
    expect(check.sections.find((s: any) => s.title === '未登记的目录').data).toEqual({ count: 1, shown: [{ path: 'vendor' }] })
    const home = owner(['show', 'home']).stdout
    expect(home).toContain('vendor/ 未登记。')
    expect(agent(['start', '看看库里有什么']).stdout).toContain('vendor/')
  })

  it('is not mentioned again once the owner leaves it alone, which adds it to the noise', () => {
    setUp()
    owner(['ignore', 'add', 'vendor'])
    // What remains is the news that the owner did it.
    expect(titles(agent(['check', '--json']))).toEqual(['最近动态'])
    expect(owner(['ignore', 'list']).stdout).toContain('vendor')
    expect(owner(['show', 'home']).stdout).not.toContain('vendor')
  })
})

describe('the rows', () => {
  it('may be thrown away: check says the same after storage’s cache is gone', () => {
    setUp()
    writeFileSync(join(lib, 'notes/a.md'), 'edited by hand')
    writeFileSync(join(lib, 'loose.md'), 'nobody registered me')
    const before = agent(['check', '--json']).json().sections
    rmSync(join(lib, '.pneuma-base/cache'), { recursive: true, force: true })
    // The baselines go with the cache: a thing first seen again is taken as recorded when its size fits, so the edit shows only when the size differs.
    expect(agent(['check', '--json']).json().sections).toEqual(before)
  })
})

describe('an agent’s start and check', () => {
  it('name at most twenty of a kind, then how many and where they all are', () => {
    setUp()
    for (let i = 0; i < 30; i++) writeFileSync(join(lib, `loose-${String(i).padStart(2, '0')}.md`), `${i}`)
    const text = agent(['check']).stdout
    expect(text).toContain('loose-19.md')
    expect(text).not.toContain('loose-20.md')
    expect(text).toContain('……共 30 个，查看全部：show ledger.status --kind unowned')
    const data = agent(['check', '--json']).json().sections.find((s: any) => s.title === '未登记').data
    expect(data.count).toBe(30)
    expect(data.shown).toHaveLength(20)
  })

  it('answer within 8 KB of text and 32 KB of JSON on every face, the JSON naming what the text names', async () => {
    setUp()
    // Thousands of registered things changed by hand, of files nobody registered, and hundreds of directories nobody registered.
    for (let i = 0; i < 1000; i++) writeFileSync(join(lib, 'notes', `n${i}.md`), `${i}`)
    for (let i = 0; i < 6; i++) agent(['put', 'notes', '--generated'])
    for (let i = 0; i < 1000; i++) writeFileSync(join(lib, 'notes', `n${i}.md`), `${i} changed by hand`)
    for (let i = 0; i < 2000; i++) writeFileSync(join(lib, `loose-${i}.md`), `${i}`)
    for (let i = 0; i < 300; i++) {
      mkdirSync(join(lib, `dir-${i}`))
      writeFileSync(join(lib, `dir-${i}`, 'x.md'), 'x')
    }
    const since = ['--since', '2000-01-01T00:00:00Z']
    const text = agent(['check', ...since]).stdout
    const json = agent(['check', '--json', ...since])
    const check = json.json()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(AGENT_TEXT_LIMIT)
    expect(Buffer.byteLength(json.stdout)).toBeLessThanOrEqual(AGENT_JSON_LIMIT)
    // Both forms stop at the same place and say where the rest is.
    expect(text.match(/^- .*（ledger）$/gm)).toHaveLength(check.asks.length)
    expect(check.cut.where).toContain('show ledger.status')
    for (const s of check.sections.filter((s: any) => s.data?.count > 20)) expect(s.data).toMatchObject({ more: expect.stringMatching(/^show ledger\.status --kind /) })
    expect(Buffer.byteLength(agent(['start', '--json', '看看库里有什么']).stdout)).toBeLessThanOrEqual(AGENT_JSON_LIMIT)
    // find gives a page of 20 and the command for the next; the last page names no next.
    const first = agent(['find', '--json', 'notes']).json()
    expect(new Set(first.hits.map((h: { path: string }) => h.path)).size).toBe(20)
    expect(first.more.next).toContain('--page 2')
    const last = agent(['find', '--json', 'notes', '--page', String(Math.ceil(first.more.count / 20))]).json()
    expect(last.more.next).toBeNull()
    owner(['grant', 'create', 'g', '--agent', 'claude-code'])
    const client = await connect(sb, 'g', 'legacy')
    try {
      const r = await call(client, 'check', { since: '2000-01-01T00:00:00Z' })
      expect(Buffer.byteLength(JSON.stringify(r.structuredContent))).toBeLessThanOrEqual(AGENT_JSON_LIMIT)
    } finally {
      await client.close()
    }
  })
})
