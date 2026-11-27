// C2 and the no-plugin half of C15 through the real command line, plus the @grant form. Each cell of put
// and archive is the kernel's (packages/kernel/test/put-table.test.ts, archive-table.test.ts,
// bundle.test.ts, positions.test.ts); here is what only the command line shows: exit codes and text,
// how the words of put name a request, a path relative to the caller, a put killed midway, @grant.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

// One library with no plugin for the file; each test works on paths of its own.
let sb: Sandbox
let lib: string
let outside: string

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
})

const agent = (args: string[], input?: string) => sb.run(['--library', lib, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

describe('put through the command line', () => {
  it('refuses a different file at the same path with exit 2 and the named reason; the target bytes stay', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'original bytes')
    writeFileSync(join(outside, 'new.md'), 'other bytes')
    const r = agent(['put', 'new.md', '--to', 'a.md', '--made'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('would-overwrite')
    expect(readFileSync(join(lib, 'a.md'), 'utf8')).toBe('original bytes')
  })

  it('reads its words by where the paths are: a file next to the caller is copied in, a library path alone is registered from any directory, a library path with --to is moved', () => {
    writeFileSync(join(outside, 'next.md'), 'next to the caller')
    expect(agent(['put', 'next.md', '--to', 'words/next.md', '--made', '--json']).json()).toMatchObject({ outcome: 'accepted', path: 'words/next.md', copied: true })
    writeFileSync(join(lib, 'words/dropped.md'), 'x')
    expect(agent(['put', 'words/dropped.md', '--brought', '--by', 'owner', '--json']).json()).toMatchObject({ outcome: 'accepted', path: 'words/dropped.md', copied: false })
    expect(agent(['put', 'words/next.md', '--to', 'words/dropped.md']).code).toBe(2)
    expect(agent(['put', 'words/next.md', '--to', 'words/moved.md', '--json']).json()).toMatchObject({ outcome: 'accepted', path: 'words/moved.md' })
    expect(existsSync(join(lib, 'words/next.md'))).toBe(false)
    expect(readFileSync(join(lib, 'words/dropped.md'), 'utf8')).toBe('x')
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
})

describe('a directory as one thing through the command line', () => {
  it('a directory next to the caller is placed as one thing; inspect prints its kind and first level; a path inside it is no target, and the refusal says why', () => {
    write(join(outside, 'site-b'), { 'index.html': '<h1>a</h1>', 'css/site.css': 'body{}', 'img/logo.svg': '<svg/>', '.git/HEAD': 'ref: main' })
    expect(agent(['put', 'site-b', '--to', 'sites/b', '--brought'])).toMatchObject({ code: 0 })
    expect(existsSync(join(lib, 'sites/b/.pneuma-item'))).toBe(true)
    expect(agent(['inspect', 'sites/b']).stdout).toMatch(/^sites\/b · 一样东西（带标记的目录），改于 \d{4}-\d\d-\d\d \d\d:\d\dZ\n第一层，3 项：\n {2}css\/\n {2}img\/\n {2}index\.html {2}10 字节\n$/)
    const inside = agent(['archive', 'sites/b/index.html'])
    expect(inside.code).toBe(2)
    expect(inside.stdout).toContain('sites/b 是一样东西')
  })
})

describe('archive through the command line, no plugin (C15)', () => {
  it('keeps the file in _archive/; inspect finds it by either path and says so; unarchive is refused with exit 2 while a file holds the original path', () => {
    agent(['put', '-', '--to', 'drafts/old-plan.md', '--made'], 'old plan')
    expect(agent(['archive', 'drafts/old-plan.md']).code).toBe(0)
    expect(readFileSync(join(lib, '_archive/drafts/old-plan.md'), 'utf8')).toBe('old plan')
    expect(existsSync(join(lib, 'drafts/old-plan.md'))).toBe(false)
    for (const target of ['drafts/old-plan.md', '_archive/drafts/old-plan.md']) {
      expect(agent(['inspect', target, '--json']).json().file).toMatchObject({ path: '_archive/drafts/old-plan.md', archived: true })
    }
    expect(agent(['inspect', 'drafts/old-plan.md']).stdout).toContain('已归档')

    agent(['put', '-', '--to', 'drafts/old-plan.md', '--made'], 'a newer one')
    const r = agent(['unarchive', 'drafts/old-plan.md'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('original-path-taken')
    expect(readFileSync(join(lib, 'drafts/old-plan.md'), 'utf8')).toBe('a newer one')
  })
})

describe('@grant', () => {
  it('binds the library and the agent from any directory, and refuses writes outside its area; an unknown grant name is refused with exit 2', () => {
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

    const unknown = sb.run(['@nobody', 'find', 'x'])
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toContain('no-such-grant')
  })

  it('issuing the same grant again keeps its id', () => {
    const first = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex', '--json']).json()
    const again = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'codex', '--json']).json()
    expect(again.data.grant.id).toBe(first.data.grant.id)
    const clash = sb.run(['grant', 'issue', 'codex', '--library', lib, '--agent', 'claude-code'])
    expect(clash.code).toBe(2)
  })
})
