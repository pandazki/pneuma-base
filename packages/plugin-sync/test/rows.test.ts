// C6: one row of the sync rule table (design.md 五) per kind of step, through the real command line
// on real storage: a push, a pull, each archiving what it replaced on its side; a conflict copy; an old
// path removed after a move; an emptied target; a run that fails midway. rules.test.ts walks the whole
// table. The library registers what it holds; the other side's changes are made directly in the target
// directory. One library, each row on paths of its own. After every sync, every content either side
// held before it is still somewhere, both sides hold the same things, and a second sync does nothing.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { contents, machine, ok, read, tempDir, write } from './support.js'

let m: ReturnType<typeof machine>
let lib: string
let target: string

const owner = (args: string[]) => m.run([...args, '--library', lib])
const agent = (args: string[], input?: string) => ok(m.run(['--library', lib, '--as', 'claude-code', '--session', 's-rows', ...args], input === undefined ? {} : { input }))
const put = (path: string, content: string) => agent(['put', '-', '--to', path, '--made'], content)
const local = {
  write: (path: string, content: string) => write(lib, path, content),
  read: (path: string) => read(lib, path),
}
const remote = {
  write: (path: string, content: string) => write(target, path, content),
  read: (path: string) => read(target, path),
}

/** Runs sync now and checks the properties every row must keep. Returns the run's record. */
function sync(): any {
  const before = new Set([...contents(lib).values(), ...contents(target).values()])
  const r = ok(owner(['sync', 'now', '--json']))
  const after = contents(lib)
  for (const content of before) expect([...after.values()], `lost: ${content}`).toContain(content)
  expect(contents(target)).toEqual(after)
  const again = ok(owner(['sync', 'now', '--json'])).json().data
  expect(again.counts).toEqual({ pushed: 0, pulled: 0, removed: 0, deleted: 0, kept: 0, conflicts: 0, skipped: 0 })
  expect(contents(target)).toEqual(contents(lib))
  return r.json().data
}

const counts = (partial: Record<string, number>) => ({ pushed: 0, pulled: 0, removed: 0, deleted: 0, kept: 0, conflicts: 0, skipped: 0, ...partial })

beforeAll(() => {
  m = machine()
  lib = join(tempDir(), 'lib')
  target = join(tempDir(), 'target')
  ok(m.run(['init', lib, '--bare']))
  ok(owner(['plugin', 'add', 'sync']))
  ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', target]))
  // Every content written here is its own, so that no row's content is already kept at another row's path.
  for (const name of ['push', 'pull', 'conflict', 'move']) put(`${name}.md`, `${name} base`)
  sync()
})

describe('one row per kind of step', () => {
  it('unchanged / unchanged: nothing moves, and sync now says so', () => {
    expect(ok(owner(['sync', 'now'])).stdout).toContain('两边一样，什么都没动')
    expect(remote.read('push.md')).toBe('push base')
  })

  it('changed here / unchanged there: pushed; the replaced content, kept nowhere else, goes to _archive/', () => {
    local.write('push.md', 'push mine')
    expect(sync().counts).toEqual(counts({ pushed: 1, kept: 1 }))
    expect(remote.read('push.md')).toBe('push mine')
    expect(remote.read('_archive/push.md')).toBe('push base')
  })

  it('unchanged here / changed there: pulled; the replaced content goes to _archive/', () => {
    remote.write('pull.md', 'pull theirs')
    expect(sync().counts).toEqual(counts({ pulled: 1, kept: 1 }))
    expect(local.read('pull.md')).toBe('pull theirs')
    expect(local.read('_archive/pull.md')).toBe('pull base')
  })

  it('changed / changed differently: both kept, the local one in place, the target one as a conflict copy, reported', () => {
    local.write('conflict.md', 'conflict mine')
    remote.write('conflict.md', 'conflict theirs')
    const r = sync()
    expect(r.counts.conflicts).toBe(1)
    const [conflict] = r.conflicts
    expect(conflict.path).toBe('conflict.md')
    expect(conflict.copy).toMatch(/^conflict\.conflict-[A-Za-z0-9-]+-\d{8}T\d{6}Z\.md$/)
    expect(local.read('conflict.md')).toBe('conflict mine')
    expect(local.read(conflict.copy)).toBe('conflict theirs')
    expect(remote.read('conflict.md')).toBe('conflict mine')
    expect(remote.read(conflict.copy)).toBe('conflict theirs')
  })

  it('deleted here / unchanged there, moved here: the old path goes from the target', () => {
    agent(['put', 'move.md', '--to', 'moved.md'])
    expect(sync().counts).toEqual(counts({ pushed: 1, removed: 1 }))
    expect(existsSync(join(target, 'move.md'))).toBe(false)
    expect(remote.read('moved.md')).toBe('move base')
  })
})

describe('no base', () => {
  it('an emptied target is a new target: everything is pushed again, nothing archived', () => {
    rmSync(target, { recursive: true })
    write(target, 'stray.txt', 'x')
    rmSync(join(target, 'stray.txt'))
    expect(sync().counts).toMatchObject({ kept: 0, removed: 0 })
    expect(remote.read('push.md')).toBe('push mine')
    expect(local.read('push.md')).toBe('push mine')
  })
})

describe('a run the target fails in the middle of', () => {
  it('is refused by name, keeps what was done, loses nothing, and a rerun converges', () => {
    put('b/x.md', 'x')
    put('c.md', 'c')
    mkdirSync(join(target, 'b'))
    chmodSync(join(target, 'b'), 0o555)
    const before = new Set([...contents(lib).values(), ...contents(target).values()])
    const failed = owner(['sync', 'now'])
    expect(failed.code).toBe(2)
    expect(failed.stdout).toContain('拒绝（target-failed）')
    expect(failed.stdout).toContain('内容没有丢')
    expect(existsSync(join(target, 'b/x.md'))).toBe(false)
    expect(ok(owner(['sync', 'status'])).stdout).toMatch(/上次同步：.*中断/)

    chmodSync(join(target, 'b'), 0o755)
    sync()
    for (const content of before) expect([...contents(target).values()]).toContain(content)
    expect(remote.read('b/x.md')).toBe('x')
    expect(remote.read('c.md')).toBe('c')
  })
})
