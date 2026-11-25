// C6: two libraries against one target; the second gets the same files and records, so the ledger
// in it gives the same provenance. Conflicts keep both and are reported, in sync now and in check.
// C8: the description carries the sync section exactly while the plugin is installed. Plus the
// commands' refusals: no target, a target missing on this machine, a target overlapping the library.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { contents, machine, ok, read, tempDir, write } from './support.js'

let m: ReturnType<typeof machine>
let root: string
let target: string
let outside: string

beforeEach(() => {
  m = machine()
  root = tempDir()
  target = join(tempDir(), 'target')
  outside = tempDir('pb-sync-outside-')
})

/** A library with the ledger (init's default) and the sync plugin, synced to the shared target. */
function library(name: string): { dir: string; agent: (args: string[], input?: string) => ReturnType<typeof m.run>; owner: (args: string[]) => ReturnType<typeof m.run> } {
  const dir = join(root, name)
  ok(m.run(['init', dir]))
  const owner = (args: string[]) => m.run([...args, '--library', dir], { cwd: outside })
  ok(owner(['plugin', 'add', 'sync']))
  ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', target]))
  const agent = (args: string[], input?: string) => m.run(['--library', dir, '--as', 'claude-code', '--session', `s-${name}`, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
  return { dir, agent, owner }
}

const factFiles = (lib: string) => readdirSync(join(lib, '.pneuma-base/ledger/facts'), { recursive: true, encoding: 'utf8' }).filter((n) => n.endsWith('.jsonl')).sort()

describe('two libraries, one target (C6)', () => {
  it('the second gets the same files and records, and inspect gives the same provenance', () => {
    const a = library('a')
    ok(a.agent(['put', '-', '--to', 'sources/s.md', '--brought', '--source', 'https://example.com/s'], 'source text'))
    ok(a.agent(['put', '-', '--to', 'notes/summary.md', '--made', '--from', 'sources/s.md'], 'summary of s'))
    // The ledger records sync now itself after it ran; that record travels with the next sync.
    const synced = factFiles(a.dir)
    ok(a.owner(['sync', 'now']))

    const b = library('b')
    const r = ok(b.owner(['sync', 'now']))
    expect(r.stdout).toContain('已同步')
    expect(read(b.dir, 'notes/summary.md')).toBe('summary of s')
    expect(read(b.dir, 'sources/s.md')).toBe('source text')
    for (const file of synced) expect(factFiles(b.dir)).toContain(file)

    const inspect = (lib: typeof a) => ok(lib.agent(['inspect', 'notes/summary.md', '--json'])).json().sections
    expect(inspect(b)).toEqual(inspect(a))
    expect(ok(b.agent(['inspect', 'notes/summary.md'])).stdout).toContain('sources/s.md')
  })

  it('both sides changed the same file: both versions on both sides, reported by sync now and by check until the copy is archived', () => {
    const a = library('a')
    ok(a.agent(['put', '-', '--to', 'plan.md', '--made'], 'v1'))
    ok(a.owner(['sync', 'now']))
    const b = library('b')
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
    ok(b.agent(['archive', copy]))
    expect(ok(b.agent(['check', '--json'])).json().sections.find((s: any) => s.title === '同步冲突')).toBeUndefined()
  })
})

describe('sync status', () => {
  it('shows the target and what a sync would do, without doing it; after a sync, the last run and nothing pending', () => {
    const a = library('a')
    ok(a.agent(['put', '-', '--to', 'x.md', '--made'], 'x'))
    const before = ok(a.owner(['sync', 'status'])).stdout
    expect(before).toContain(`目标：目录 ${target}`)
    expect(before).toContain('上次同步：这台机器还没同步过')
    expect(before).toMatch(/待同步：推上去 [1-9]/)
    expect(existsSync(join(target, 'x.md'))).toBe(false)
    ok(a.owner(['sync', 'now']))
    const after = ok(a.owner(['sync', 'status', '--json'])).json().data
    expect(after.last).toMatchObject({ kind: 'run', outcome: 'done' })
    // The ledger records each owner command after it ran, so its record of the last one is all that waits.
    expect(after.pending).toMatchObject({ pulled: 0, removed: 0, kept: 0, conflicts: 0 })
  })
})

describe('who may sync', () => {
  it('sync now is not destructive: it runs in an agent session and through a grant', () => {
    const a = library('a')
    ok(a.agent(['put', '-', '--to', 'x.md', '--made'], 'x'))
    ok(m.run(['sync', 'now', '--library', a.dir], { env: { CLAUDE_CODE_SESSION_ID: 'session-1' } }))
    expect(read(target, 'x.md')).toBe('x')
    ok(a.owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    ok(a.agent(['put', '-', '--to', 'y.md', '--made'], 'y'))
    ok(m.run(['@claude', 'sync', 'now'], { cwd: outside }))
    expect(read(target, 'y.md')).toBe('y')
  })
})

describe('refusals', () => {
  it('without the plugin there is no sync command, and with it say still hears no sync kind', () => {
    const dir = join(root, 'bare')
    ok(m.run(['init', dir, '--bare']))
    const without = m.run(['sync', 'now', '--library', dir])
    expect(without.code).toBe(1)
    expect(without.stderr).toContain('不认识的命令')
    ok(m.run(['plugin', 'add', 'sync', '--library', dir]))
    const said = m.run(['--library', dir, 'say', 'synced', 'x', '--json'])
    expect(said.json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
  })

  it('sync now with no target refuses and says how to set one', () => {
    const dir = join(root, 'lib')
    ok(m.run(['init', dir, '--bare']))
    ok(m.run(['plugin', 'add', 'sync', '--library', dir]))
    const r = m.run(['sync', 'now', '--library', dir])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（no-target）')
    expect(r.stdout).toContain('sync target set --kind dir --to')
  })

  it('a target missing on this machine is refused by name and nothing changes; status says so', () => {
    const a = library('a')
    ok(a.agent(['put', '-', '--to', 'x.md', '--made'], 'x'))
    ok(a.owner(['sync', 'now']))
    rmSync(target, { recursive: true })
    const before = contents(a.dir)
    const r = a.owner(['sync', 'now'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（target-missing）')
    expect(r.stdout).toContain('在这台机器上不存在')
    expect(existsSync(target)).toBe(false)
    expect([...contents(a.dir).keys()].filter((k) => !k.startsWith('.pneuma-base/ledger/'))).toEqual([...before.keys()].filter((k) => !k.startsWith('.pneuma-base/ledger/')))
    expect(ok(a.owner(['sync', 'status'])).stdout).toContain('在这台机器上不存在')
  })

  it('a target inside the library or holding it is refused', () => {
    const dir = join(root, 'lib')
    ok(m.run(['init', dir, '--bare']))
    ok(m.run(['plugin', 'add', 'sync', '--library', dir]))
    for (const to of [join(dir, 'inner'), dirname(dir)]) {
      const r = m.run(['sync', 'target', 'set', '--kind', 'dir', '--to', to, '--library', dir])
      expect(r.code, to).toBe(2)
      expect(r.stdout).toContain('target-overlaps')
    }
    expect(existsSync(join(dir, 'inner'))).toBe(false)
  })

  it('an unknown kind or a missing --to is a usage error', () => {
    const dir = join(root, 'lib')
    ok(m.run(['init', dir, '--bare']))
    ok(m.run(['plugin', 'add', 'sync', '--library', dir]))
    for (const args of [['--kind', 's3', '--to', target], ['--kind', 'dir']]) {
      const r = m.run(['sync', 'target', 'set', ...args, '--library', dir])
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.stderr).toContain('用法错误')
    }
  })

  it('setting the same target again records nothing new', () => {
    const a = library('a')
    const facts = () => readdirSync(join(a.dir, '.pneuma-base/sync/facts'))
    const n = facts().length
    expect(ok(a.owner(['sync', 'target', 'set', '--kind', 'dir', '--to', target])).stdout).toContain('没有变')
    expect(facts()).toHaveLength(n)
  })
})

describe('the description (C8)', () => {
  const section = readFileSync(fileURLToPath(new URL('../cognition/2-sync-section.md', import.meta.url)), 'utf8').trimEnd().replaceAll('{{授权的名字}}', '<你的授权名>')

  it('carries the sync section while the plugin is installed, and loses it on remove', () => {
    const dir = join(root, 'lib')
    ok(m.run(['init', dir]))
    const description = () => read(dir, 'PNEUMA-BASE.md')
    const before = description()
    expect(before).not.toContain('## 同步')
    ok(m.run(['plugin', 'add', 'sync', '--library', dir]))
    expect(description()).toContain(section)
    expect(description()).toContain('- `sync`：同步')
    ok(m.run(['plugin', 'remove', 'sync', '--library', dir]))
    expect(description()).toBe(before)
  })
})

describe('scope', () => {
  it('another library’s configuration and description never arrive', () => {
    const a = library('a')
    ok(a.owner(['sync', 'now']))
    const b = library('b')
    const config = read(b.dir, '.pneuma-base/config.json')
    ok(b.owner(['sync', 'now']))
    expect(read(b.dir, '.pneuma-base/config.json')).toBe(config)
    expect(existsSync(join(target, '.pneuma-base/config.json'))).toBe(false)
    write(b.dir, 'z.md', 'z')
    ok(b.owner(['sync', 'now']))
    expect(read(target, 'z.md')).toBe('z')
  })
})
