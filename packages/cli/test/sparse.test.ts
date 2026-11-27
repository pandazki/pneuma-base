// tmp/run-7: the records say what is in the library, and storage is looked at only where they point.
// A directory no record points into is one line, never opened, even when nobody can read it; noise is
// never mentioned; the rows are a cache that may be thrown away; an agent's start and check are bounded.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_TEXT_LIMIT, bounded } from '../src/format.js'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

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
  agent(['put', '-', '--to', 'notes/a.md', '--made'], 'a')
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
    expect(check.sections.find((s: any) => s.title === '没登记的目录').data).toEqual({ count: 1, shown: [{ path: 'vendor' }] })
    const home = owner(['show', 'home']).stdout
    expect(home).toContain('vendor/ 没登记。')
    expect(agent(['start', '看看库里有什么']).stdout).toContain('vendor/')
  })

  it('is not mentioned again once the owner leaves it alone, which adds it to the noise', () => {
    setUp()
    owner(['noise', 'add', 'vendor'])
    // What remains is the news that the owner did it.
    expect(titles(agent(['check', '--json']))).toEqual(['自上次以来'])
    expect(owner(['noise', 'list']).stdout).toContain('vendor')
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
    expect(text).toContain('……共 30 样，看全部：show ledger.standing --kind unowned')
    const data = agent(['check', '--json']).json().sections.find((s: any) => s.title === '没人登记过的').data
    expect(data.count).toBe(30)
    expect(data.shown).toHaveLength(20)
  })

  it('print at most 8 KB, the last line saying where the rest is', () => {
    const lines = bounded(Array.from({ length: 5000 }, (_, i) => `  第 ${i} 行，一个很长的库内路径/它在这里/file-${i}.md`))
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThanOrEqual(AGENT_TEXT_LIMIT)
    expect(lines.at(-1)).toContain('后面的没有印出')
    expect(bounded(['短的一行'])).toEqual(['短的一行'])
  })
})
