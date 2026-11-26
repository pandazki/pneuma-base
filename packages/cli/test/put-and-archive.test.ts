// C2 and the no-plugin half of C15 through the real command line, plus the @grant form.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
})

const agent = (args: string[], input?: string) => sb.run(['--library', lib, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })

describe('put through the command line', () => {
  it('refuses a different file at the same path with exit 2 and the named reason; the target bytes stay', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'original bytes')
    writeFileSync(join(outside, 'new.md'), 'other bytes')
    const r = agent(['put', 'new.md', '--to', 'a.md', '--made'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('would-overwrite')
    expect(readFileSync(join(lib, 'a.md'), 'utf8')).toBe('original bytes')
  })

  it('accepts the same content again without copying', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'same')
    const r = agent(['put', '-', '--to', 'a.md', '--made', '--json'], 'same')
    expect(r.code).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', copied: false })
  })

  it('registers a file already inside, from any directory', () => {
    writeFileSync(join(lib, 'dropped.md'), 'x')
    const r = agent(['put', 'dropped.md', '--brought', '--by', 'owner', '--json'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'dropped.md', copied: false })
  })

  it('moves inside the library, and refuses to move onto an existing file', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'a')
    agent(['put', '-', '--to', 'b.md', '--made'], 'b')
    expect(agent(['put', 'a.md', '--to', 'b.md']).code).toBe(2)
    const r = agent(['put', 'a.md', '--to', 'moved/a.md', '--json'])
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'moved/a.md' })
    expect(existsSync(join(lib, 'a.md'))).toBe(false)
    expect(readFileSync(join(lib, 'b.md'), 'utf8')).toBe('b')
  })

  it('requires exactly one of --brought and --made, with a helpful message', () => {
    writeFileSync(join(outside, 'x.md'), 'x')
    for (const flags of [[], ['--brought', '--made']]) {
      const r = agent(['put', 'x.md', '--to', 'x.md', ...flags])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('--brought')
      expect(r.stderr).toContain('--made')
    }
    expect(existsSync(join(lib, 'x.md'))).toBe(false)
  })

  it('a put killed midway leaves no half file at the target, and the library stays usable', async () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 'x')
    // Delays sweep across the write: on the reference machine kills at about 55 to 75 ms land
    // while the scratch copy is half written.
    for (const delay of [10, 30, ...Array.from({ length: 16 }, (_, i) => 40 + i * 4), 200]) {
      const child = sb.start(['--library', lib, 'put', '-', '--to', `big-${delay}.bin`, '--made'])
      const exited = new Promise((done) => child.on('exit', done))
      child.stdin.on('error', () => undefined)
      child.stdin.end(big)
      await new Promise((done) => setTimeout(done, delay))
      child.kill('SIGKILL')
      await exited
      const target = join(lib, `big-${delay}.bin`)
      if (existsSync(target)) expect(statSync(target).size).toBe(big.length)
    }
    const r = agent(['find', 'big', '--json'])
    expect(r.code).toBe(0)
    for (const hit of r.json().hits) expect(statSync(join(lib, hit.path)).size).toBe(big.length)
  })

  it('refuses writing into the kernel files or the archive', () => {
    writeFileSync(join(outside, 'x.md'), 'x')
    expect(agent(['put', 'x.md', '--to', '.pneuma-base/config.json', '--made']).code).toBe(2)
    expect(agent(['put', 'x.md', '--to', '_archive/x.md', '--made']).code).toBe(2)
    expect(agent(['put', 'x.md', '--to', '../escape.md', '--made']).code).toBe(2)
  })
})

describe('archive through the command line, no plugin (C15)', () => {
  beforeEach(() => {
    agent(['put', '-', '--to', 'drafts/old-plan.md', '--made'], 'old plan')
    agent(['put', '-', '--to', 'drafts/new-plan.md', '--made'], 'new plan')
    expect(agent(['archive', 'drafts/old-plan.md']).code).toBe(0)
  })

  it('keeps the file, in _archive/', () => {
    expect(readFileSync(join(lib, '_archive/drafts/old-plan.md'), 'utf8')).toBe('old plan')
    expect(existsSync(join(lib, 'drafts/old-plan.md'))).toBe(false)
  })

  it('default find leaves it out; the switch brings it in', () => {
    const paths = (args: string[]) => agent(['find', ...args, '--json']).json().hits.map((h: { path: string }) => h.path)
    expect(paths(['plan'])).toEqual(['drafts/new-plan.md'])
    expect(paths(['plan', '--include-archived'])).toEqual(['_archive/drafts/old-plan.md', 'drafts/new-plan.md'])
  })

  it('check answers with and without the switch', () => {
    expect(agent(['check', '--json']).json()).toEqual({ sections: [], asks: [], problems: [] })
    expect(agent(['check', '--include-archived', '--json']).json()).toEqual({ sections: [], asks: [], problems: [] })
  })

  it('inspect marks it archived, by its original path or its archived path', () => {
    for (const target of ['drafts/old-plan.md', '_archive/drafts/old-plan.md']) {
      const r = agent(['inspect', target, '--json'])
      expect(r.json().file).toMatchObject({ path: '_archive/drafts/old-plan.md', archived: true })
    }
    expect(agent(['inspect', 'drafts/old-plan.md']).stdout).toContain('已归档')
  })

  it('unarchive puts it back at the original path', () => {
    const r = agent(['unarchive', 'drafts/old-plan.md', '--json'])
    expect(r.json()).toMatchObject({ outcome: 'accepted', from: '_archive/drafts/old-plan.md', to: 'drafts/old-plan.md', moved: true })
    expect(readFileSync(join(lib, 'drafts/old-plan.md'), 'utf8')).toBe('old plan')
  })

  it('refuses to unarchive over a file that took the original path', () => {
    agent(['put', '-', '--to', 'drafts/old-plan.md', '--made'], 'a newer one')
    const r = agent(['unarchive', 'drafts/old-plan.md'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('original-path-taken')
    expect(readFileSync(join(lib, 'drafts/old-plan.md'), 'utf8')).toBe('a newer one')
  })
})

describe('@grant', () => {
  it('binds the library and the agent from any directory, and refuses writes outside its area', () => {
    const issued = sb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code', '--area', 'work', '--json'])
    expect(issued.code, issued.stderr).toBe(0)
    const file = JSON.parse(readFileSync(join(sb.home, '.pneuma-base', 'grants', 'claude.json'), 'utf8'))
    expect(file).toMatchObject({ name: 'claude', library: lib })
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')).grants).toEqual([
      { id: file.grant, name: 'claude', agent: 'claude-code', area: 'work', readOnly: false },
    ])

    const inside = sb.run(['@claude', 'put', '-', '--to', 'work/a.md', '--made', '--json'], { cwd: outside, input: 'a' })
    expect(inside.code, inside.stderr).toBe(0)
    const outsideArea = sb.run(['@claude', 'put', '-', '--to', 'other/a.md', '--made'], { cwd: outside, input: 'a' })
    expect(outsideArea.code).toBe(2)
    expect(outsideArea.stdout).toContain('outside-grant')
    expect(existsSync(join(lib, 'other/a.md'))).toBe(false)
  })

  it('refuses an unknown grant name with exit 2', () => {
    const r = sb.run(['@nobody', 'find', 'x'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('no-such-grant')
  })

  it('issuing the same grant again keeps its id', () => {
    const first = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex', '--json']).json()
    const again = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex', '--json']).json()
    expect(again.data.grant.id).toBe(first.data.grant.id)
    const clash = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'claude-code'])
    expect(clash.code).toBe(2)
  })
})
