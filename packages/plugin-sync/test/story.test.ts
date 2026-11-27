// C6: two libraries against one target; the second gets the same files and records, so the ledger
// in it gives the same provenance. Conflicts keep both and are reported, in sync now and in check.
// CONTEXT 2.14: what the owner deletes with a destructive command stays deleted; what is removed by
// hand is kept. Plus the commands' refusals. Each describe's libraries are made once and its tests
// run on them in order.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { contents, factsOf, machine, ok, read, tempDir, toolCalls, write } from './support.js'

type World = { m: ReturnType<typeof machine>; root: string; target: string; outside: string }

/** One machine, one shared target, and a place outside every library. */
function world(): World {
  return { m: machine(), root: tempDir(), target: join(tempDir(), 'target'), outside: tempDir('pb-sync-outside-') }
}

type Library = {
  dir: string
  agent: (args: string[], input?: string) => ReturnType<World['m']['run']>
  owner: (args: string[]) => ReturnType<World['m']['run']>
  /** The owner in their own terminal, confirming a destructive command in person. */
  confirmed: (args: string[]) => ReturnType<World['m']['run']>
}

/** A library with the ledger (init's default), the sync plugin and `plugins`, set to sync to the world's target. */
function library(w: World, name: string, plugins: string[] = []): Library {
  const dir = join(w.root, name)
  ok(w.m.run(['init', dir]))
  const owner = (args: string[]) => w.m.run([...args, '--library', dir], { cwd: w.outside })
  for (const p of ['sync', ...plugins]) ok(owner(['plugin', 'add', p]))
  ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', w.target]))
  const agent = (args: string[], input?: string) => w.m.run(['--library', dir, '--as', 'claude-code', '--session', `s-${name}`, ...args], { cwd: w.outside, ...(input === undefined ? {} : { input }) })
  const confirmed = (args: string[]) => w.m.run([...args, '--library', dir], { cwd: w.outside, confirm: true })
  return { dir, agent, owner, confirmed }
}

const factIds = (lib: string, place = 'ledger') => factsOf(lib, place).map((f) => f.id as string)

/** The files under a record place's own content and their text, its facts left out. */
function ownContent(lib: string, place: string): Map<string, string> {
  const dir = join(lib, '.pneuma-base', place)
  if (!existsSync(dir)) return new Map()
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((n) => !n.startsWith('facts') && !n.endsWith('/') && existsSync(join(dir, n)) && !readdirSafe(join(dir, n)))
  return new Map(files.sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]))
}
const readdirSafe = (path: string) => {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

describe('two libraries, one target (C6)', () => {
  const w = world()
  let a: Library
  let b: Library
  let factsOfA: string[]
  let configOfB: string

  beforeAll(() => {
    a = library(w, 'a', ['version'])
    const site = join(w.outside, 'site')
    write(site, 'index.html', '<h1>hi</h1>')
    write(site, 'css/a.css', 'body{}')
    ok(a.agent(['put', '-', '--to', 'sources/s.md', '--brought', '--source', 'https://example.com/s'], 'source text'))
    ok(a.agent(['put', '-', '--to', 'notes/summary.md', '--made', '--from', 'sources/s.md'], 'summary of s'))
    ok(a.agent(['put', '-', '--to', 'notes/n.md', '--made'], 'note'))
    ok(a.agent(['put', site, '--to', 'sites/one', '--made']))
    ok(a.agent(['say', 'versioned', 'sites/one', '第一版']))
    ok(a.agent(['put', '-', '--to', 'notes/moving.md', '--made'], 'moving'))
    ok(a.agent(['put', 'notes/moving.md', '--to', 'notes/moved.md']))
    ok(a.agent(['put', '-', '--to', 'notes/old.md', '--made'], 'old'))
    ok(a.agent(['archive', 'notes/old.md']))
    ok(a.agent(['put', '-', '--to', 'doc.md', '--made'], 'first version'))
    ok(a.agent(['put', '-', '--to', 'doc.md', '--made'], 'second version'))
    // The ledger records sync now itself after it ran; that record travels with the next sync.
    factsOfA = factIds(a.dir)
    ok(a.owner(['sync', 'now']))

    b = library(w, 'b', ['version'])
    configOfB = read(b.dir, '.pneuma-base/config.json')
    expect(ok(b.owner(['sync', 'now'])).stdout).toContain('已同步')
  })

  it('carries a file, a directory thing with its marker, a moved and an archived thing, the ledger facts, a held copy and a version object; the second tells their provenance as the first does', () => {
    expect(read(b.dir, 'notes/n.md')).toBe('note')
    expect(read(b.dir, 'sources/s.md')).toBe('source text')
    expect(read(b.dir, 'sites/one/index.html')).toBe('<h1>hi</h1>')
    expect(read(b.dir, 'sites/one/css/a.css')).toBe('body{}')
    expect(existsSync(join(b.dir, 'sites/one/.pneuma-item'))).toBe(true)
    expect(read(b.dir, 'notes/moved.md')).toBe('moving')
    expect(existsSync(join(b.dir, 'notes/moving.md'))).toBe(false)
    expect(read(b.dir, '_archive/notes/old.md')).toBe('old')
    expect(read(b.dir, 'doc.md')).toBe('second version')
    expect(factIds(b.dir)).toEqual(expect.arrayContaining(factsOfA))
    const held = ownContent(a.dir, 'ledger')
    expect([...held.values()]).toContain('first version')
    expect(ownContent(b.dir, 'ledger')).toEqual(held)
    expect(ownContent(a.dir, 'version').size).toBeGreaterThan(0)
    expect(ownContent(b.dir, 'version')).toEqual(ownContent(a.dir, 'version'))

    const inspect = (lib: Library, path: string) => ok(lib.agent(['inspect', path, '--json'])).json().sections
    expect(inspect(b, 'notes/summary.md')).toEqual(inspect(a, 'notes/summary.md'))
    expect(ok(b.agent(['inspect', 'notes/summary.md'])).stdout).toContain('sources/s.md')
    const ledger = (lib: Library, path: string) => inspect(lib, path).find((x: any) => x.plugin === 'ledger')?.body
    for (const path of ['notes/n.md', 'sites/one', 'notes/moved.md', '_archive/notes/old.md', 'doc.md']) expect(ledger(b, path), path).toBe(ledger(a, path))
    expect(ledger(b, 'sites/one')).toContain('现状：一致')
    expect(ok(b.agent(['version', 'list', 'sites/one'])).stdout).toContain('第 1 版')
  })

  it('never brings another library’s configuration', () => {
    expect(read(b.dir, '.pneuma-base/config.json')).toBe(configOfB)
    expect(existsSync(join(w.target, '.pneuma-base/config.json'))).toBe(false)
  })

  it('reads no content on either side in a sync with nothing changed', () => {
    ok(a.owner(['sync', 'now']))
    ok(a.owner(['sync', 'now']))
    // A target file sync tried to read would fail the run.
    for (const path of ['notes/n.md', 'sites/one/index.html']) chmodSync(join(w.target, path), 0o000)
    const log = join(w.outside, 'tools-unchanged.jsonl')
    const r = w.m.run(['sync', 'now', '--json', '--library', a.dir], { cwd: w.outside, env: { PNEUMA_BASE_TOOL_LOG: log } })
    for (const path of ['notes/n.md', 'sites/one/index.html']) chmodSync(join(w.target, path), 0o644)
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.json().data.counts).toEqual({ pushed: 0, pulled: 0, removed: 0, deleted: 0, kept: 0, conflicts: 0, skipped: 0 })
    const calls = toolCalls(log).filter((c) => c.plugin === 'sync')
    expect(calls.filter((c) => c.tool === 'lookRows').length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.tool === 'content' || c.tool === 'read' || c.tool === 'overview')).toEqual([])
  })

  it('never looks into a closed directory nobody registered, even when it cannot be read', () => {
    const closed = join(a.dir, 'downloads')
    mkdirSync(closed)
    for (let i = 0; i < 300; i++) writeFileSync(join(closed, `f${i}.bin`), `${i}`)
    chmodSync(closed, 0o000)
    const log = join(w.outside, 'tools-closed.jsonl')
    try {
      const run = (args: string[]) => w.m.run([...args, '--json', '--library', a.dir], { cwd: w.outside, env: { PNEUMA_BASE_TOOL_LOG: log } })
      for (const args of [['sync', 'now'], ['sync', 'status'], ['sync', 'now']]) {
        const r = run(args)
        expect(r.code, r.stdout + r.stderr).toBe(0)
        expect(r.stdout).not.toContain('downloads')
      }
    } finally {
      chmodSync(closed, 0o755)
    }
    expect(existsSync(join(w.target, 'downloads'))).toBe(false)
    expect(toolCalls(log).filter((c) => c.plugin === 'sync' && c.place?.startsWith('downloads'))).toEqual([])
  })

  it('both sides changed the same file: both versions on both sides, reported by sync now and by check until the copy is archived', () => {
    ok(a.agent(['put', '-', '--to', 'plan.md', '--made'], 'v1'))
    ok(a.owner(['sync', 'now']))
    ok(b.owner(['sync', 'now']))

    ok(a.agent(['put', '-', '--to', 'plan.md', '--made'], 'from a'))
    ok(a.owner(['sync', 'now']))
    ok(b.agent(['put', '-', '--to', 'plan.md', '--made'], 'from b'))
    const r = ok(b.owner(['sync', 'now']))
    expect(r.stdout).toMatch(/冲突（两份都在[^\n]*\n {2}plan\.md {2}另一份：plan\.conflict-[^\n]+\.md/)
    const copy = readdirSync(b.dir).find((n) => n.startsWith('plan.conflict-')) as string
    expect(read(b.dir, 'plan.md')).toBe('from b')
    expect(read(b.dir, copy)).toBe('from a')

    ok(a.owner(['sync', 'now']))
    expect(read(a.dir, 'plan.md')).toBe('from b')
    expect(read(a.dir, copy)).toBe('from a')

    const check = ok(b.agent(['check', '--json'])).json().sections.find((s: any) => s.title === '同步冲突')
    expect(check.data.conflicts).toEqual([{ copy, original: 'plan.md' }])
    expect(ok(b.agent(['check'])).stdout).toContain(`${copy}（plan.md 的另一份）`)
    // The ledger also lists the copy among files nobody registered; both sections end in archiving what is not wanted.
    const sections = ok(b.agent(['check', '--json'])).json().sections
    const unowned = sections.find((s: any) => s.title === '没人登记过的')
    expect(unowned.body).toContain(copy)
    expect(unowned.body).toContain('不要的归档')
    expect(check.body).toContain('再把冲突副本归档')
    ok(b.agent(['archive', copy]))
    expect(ok(b.agent(['check', '--json'])).json().sections.find((s: any) => s.title === '同步冲突')).toBeUndefined()
  })

  it('sync now is not destructive: it runs in an agent session and through a grant', () => {
    ok(a.agent(['put', '-', '--to', 'x.md', '--made'], 'x'))
    ok(w.m.run(['sync', 'now', '--library', a.dir], { env: { CLAUDE_CODE_SESSION_ID: 'session-1' } }))
    expect(read(w.target, 'x.md')).toBe('x')
    ok(a.owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    ok(a.agent(['put', '-', '--to', 'y.md', '--made'], 'y'))
    ok(w.m.run(['@claude', 'sync', 'now'], { cwd: w.outside }))
    expect(read(w.target, 'y.md')).toBe('y')
  })
})

describe('what the owner deletes with a destructive command stays deleted (CONTEXT 2.14)', () => {
  const w = world()
  let a: Library
  let b: Library

  /** The text of every file under `dir`, things and records and the target's own folder alike; storage's cache left out. */
  const texts = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !join(e.parentPath, e.name).includes('/.pneuma-base/cache/'))
      .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
  /** A syncs, then B; B's run. */
  const both = () => {
    ok(a.owner(['sync', 'now']))
    return ok(b.owner(['sync', 'now', '--json'])).json().data
  }

  beforeAll(() => {
    a = library(w, 'a')
    ok(a.agent(['put', '-', '--to', 'notes/keep.md', '--made'], 'kept'))
    ok(a.agent(['put', '-', '--to', 'notes/old.md', '--made'], 'archived before the sync'))
    ok(a.agent(['put', '-', '--to', 'notes/late.md', '--made'], 'archived after the sync'))
    ok(a.agent(['archive', 'notes/old.md']))
    ok(a.agent(['put', '-', '--to', 'notes/n.md', '--made'], 'removed by hand'))
    ok(a.agent(['put', '-', '--to', 'notes/o.md', '--made'], 'archived, then removed by hand'))
    ok(a.agent(['archive', 'notes/o.md']))
    ok(a.agent(['put', '-', '--to', 'doc.md', '--made'], 'first version'))
    ok(a.agent(['put', '-', '--to', 'doc.md', '--made'], 'second version'))
    ok(a.owner(['sync', 'now']))
    b = library(w, 'b')
    ok(b.owner(['sync', 'now']))
    ok(a.owner(['sync', 'now']))
  })

  it('a file removed by hand is kept as before, even when a destructive command was refused', () => {
    rmSync(join(a.dir, 'notes/n.md'))
    rmSync(join(a.dir, '_archive/notes/o.md'))
    const refused = a.owner(['archive', 'purge'])
    expect(refused.code).toBe(2)
    expect(refused.stdout).toContain('not-confirmed')

    both()
    for (const dir of [a.dir, b.dir, w.target]) {
      expect(read(dir, '_archive/notes/o.md')).toBe('archived, then removed by hand')
      expect(read(dir, '_archive/notes/n.md')).toBe('removed by hand')
    }
  })

  it('archive purge on A: the purged files leave the target and B, and stay gone', () => {
    expect(read(b.dir, '_archive/notes/old.md')).toBe('archived before the sync')
    ok(a.agent(['archive', 'notes/late.md']))
    ok(a.confirmed(['archive', 'purge']))
    const purged = ['archived before the sync', 'archived after the sync', 'removed by hand', 'archived, then removed by hand']

    for (let round = 0; round < 2; round++) {
      const run = both()
      if (round === 0) expect(run.counts).toMatchObject({ deleted: 4, kept: 0 })
      for (const dir of [a.dir, b.dir, w.target]) {
        for (const text of purged) expect(texts(dir), `${dir} round ${round}`).not.toContain(text)
        expect(read(dir, 'notes/keep.md')).toBe('kept')
        expect([...contents(dir).keys()].filter((k) => k.startsWith('_archive/'))).toEqual([])
      }
    }
  })

  // The held copies are a record place's own content, not things in the library.
  it('ledger held drop on A: the held copies leave the target and B, and stay gone', () => {
    expect(texts(b.dir)).toContain('first version')
    ok(a.confirmed(['ledger', 'held', 'drop']))

    for (let round = 0; round < 2; round++) {
      both()
      for (const dir of [a.dir, b.dir, w.target]) {
        expect(texts(dir), `${dir} round ${round}`).not.toContain('first version')
        expect(read(dir, 'doc.md')).toBe('second version')
      }
    }
  })
})

describe('refusals', () => {
  it('sync refuses, changing nothing: no target, a usage error, a target overlapping the library or one that cannot be made, the same target again, a target missing on this machine', () => {
    const w = world()
    const dir = join(w.root, 'lib')
    const owner = (args: string[]) => w.m.run([...args, '--library', dir])
    ok(w.m.run(['init', dir, '--bare']))
    ok(owner(['plugin', 'add', 'sync']))

    const noTarget = owner(['sync', 'now'])
    expect(noTarget.code).toBe(2)
    expect(noTarget.stdout).toContain('拒绝（no-target）')
    expect(noTarget.stdout).toContain('sync target set --kind dir --to')

    for (const args of [['--kind', 's3', '--to', w.target], ['--kind', 'dir']]) {
      const r = owner(['sync', 'target', 'set', ...args])
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.stderr).toContain('用法错误')
    }
    for (const to of [join(dir, 'inner'), dirname(dir)]) {
      const r = owner(['sync', 'target', 'set', '--kind', 'dir', '--to', to])
      expect(r.code, to).toBe(2)
      expect(r.stdout).toContain('target-overlaps')
    }
    expect(existsSync(join(dir, 'inner'))).toBe(false)
    const locked = join(w.root, 'locked')
    mkdirSync(locked, { mode: 0o555 })
    const unreachable = owner(['sync', 'target', 'set', '--kind', 'dir', '--to', join(locked, 'disk', 'base')])
    expect(unreachable.code).toBe(2)
    expect(unreachable.stdout).toContain('拒绝（target-unreachable）：建不了这个目录')

    ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', w.target]))
    const facts = () => factsOf(dir, 'sync')
    const n = facts().length
    expect(ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', w.target])).stdout).toContain('没有变')
    expect(facts()).toHaveLength(n)

    ok(w.m.run(['--library', dir, '--as', 'claude-code', 'put', '-', '--to', 'x.md', '--made'], { input: 'x' }))
    ok(owner(['sync', 'now']))
    rmSync(w.target, { recursive: true })
    const before = contents(dir)
    const missing = owner(['sync', 'now'])
    expect(missing.code).toBe(2)
    expect(missing.stdout).toContain('拒绝（target-missing）')
    expect(existsSync(w.target)).toBe(false)
    expect(contents(dir)).toEqual(before)
    expect(ok(owner(['sync', 'status'])).stdout).toContain('在这台机器上不存在')
  })
})
