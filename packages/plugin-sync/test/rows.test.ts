// C6: each row of the sync rule table (design.md 五) through the real command line. One library;
// the other side's changes are made directly in the target directory. After every sync, every
// content either side held before it is still somewhere, both sides hold the same files, and a
// second sync does nothing.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { contents, machine, ok, read, tempDir, write } from './support.js'

let m: ReturnType<typeof machine>
let lib: string
let target: string

const owner = (args: string[]) => m.run([...args, '--library', lib])
const local = {
  write: (path: string, content: string) => write(lib, path, content),
  remove: (path: string) => rmSync(join(lib, path)),
  read: (path: string) => read(lib, path),
}
const remote = {
  write: (path: string, content: string) => write(target, path, content),
  remove: (path: string) => rmSync(join(target, path)),
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
  expect(again.counts).toEqual({ pushed: 0, pulled: 0, removed: 0, kept: 0, conflicts: 0, skipped: 0 })
  expect(contents(target)).toEqual(contents(lib))
  return r.json().data
}

const counts = (partial: Record<string, number>) => ({ pushed: 0, pulled: 0, removed: 0, kept: 0, conflicts: 0, skipped: 0, ...partial })

beforeEach(() => {
  m = machine()
  lib = join(tempDir(), 'lib')
  target = join(tempDir(), 'target')
  ok(m.run(['init', lib, '--bare']))
  ok(owner(['plugin', 'add', 'sync']))
  ok(owner(['sync', 'target', 'set', '--kind', 'dir', '--to', target]))
  local.write('a.md', 'base')
  sync()
})

describe('the rule table, one test per row', () => {
  it('unchanged / unchanged: nothing moves', () => {
    const r = ok(owner(['sync', 'now']))
    expect(r.stdout).toContain('两边一样，什么都没动')
    expect(remote.read('a.md')).toBe('base')
  })

  it('changed here / unchanged there: pushed; the replaced content, kept nowhere else, goes to _archive/', () => {
    local.write('a.md', 'mine')
    expect(sync().counts).toEqual(counts({ pushed: 1, kept: 1 }))
    expect(remote.read('a.md')).toBe('mine')
    expect(remote.read('_archive/a.md')).toBe('base')
  })

  it('new here / absent there: pushed', () => {
    local.write('notes/new.md', 'new')
    expect(sync().counts).toEqual(counts({ pushed: 1 }))
    expect(remote.read('notes/new.md')).toBe('new')
  })

  it('unchanged here / changed there: pulled; the replaced content goes to _archive/', () => {
    remote.write('a.md', 'theirs')
    expect(sync().counts).toEqual(counts({ pulled: 1, kept: 1 }))
    expect(local.read('a.md')).toBe('theirs')
    expect(local.read('_archive/a.md')).toBe('base')
  })

  it('absent here / new there: pulled', () => {
    remote.write('notes/new.md', 'new')
    expect(sync().counts).toEqual(counts({ pulled: 1 }))
    expect(local.read('notes/new.md')).toBe('new')
  })

  it('changed / changed to the same content: nothing moves, and the base moves on', () => {
    local.write('a.md', 'same')
    remote.write('a.md', 'same')
    expect(sync().counts).toEqual(counts({}))
    local.write('a.md', 'later')
    expect(sync().counts).toEqual(counts({ pushed: 1, kept: 1 }))
    expect(remote.read('a.md')).toBe('later')
  })

  it('changed / changed differently: both kept, the local one in place, the target one as a conflict copy, reported', () => {
    local.write('a.md', 'mine')
    remote.write('a.md', 'theirs')
    const r = sync()
    expect(r.counts.conflicts).toBe(1)
    const [conflict] = r.conflicts
    expect(conflict.path).toBe('a.md')
    expect(conflict.copy).toMatch(/^a\.conflict-[A-Za-z0-9-]+-\d{8}T\d{6}Z\.md$/)
    expect(local.read('a.md')).toBe('mine')
    expect(local.read(conflict.copy)).toBe('theirs')
    expect(remote.read('a.md')).toBe('mine')
    expect(remote.read(conflict.copy)).toBe('theirs')
  })

  it('deleted here / unchanged there, moved here: the old path goes from the target', () => {
    renameSync(join(lib, 'a.md'), join(lib, 'b.md'))
    expect(sync().counts).toEqual(counts({ pushed: 1, removed: 1 }))
    expect(existsSync(join(target, 'a.md'))).toBe(false)
    expect(remote.read('b.md')).toBe('base')
  })

  it('deleted here / unchanged there, kept nowhere else: the target copy goes to _archive/', () => {
    local.remove('a.md')
    expect(sync().counts).toEqual(counts({ removed: 1, kept: 1 }))
    expect(existsSync(join(target, 'a.md'))).toBe(false)
    expect(remote.read('_archive/a.md')).toBe('base')
    expect(local.read('_archive/a.md')).toBe('base')
  })

  it('unchanged here / deleted there, moved there: the old path goes from here', () => {
    renameSync(join(target, 'a.md'), join(target, 'b.md'))
    expect(sync().counts).toEqual(counts({ pulled: 1, removed: 1 }))
    expect(existsSync(join(lib, 'a.md'))).toBe(false)
    expect(local.read('b.md')).toBe('base')
  })

  it('unchanged here / deleted there, kept nowhere else: the local copy goes to _archive/', () => {
    remote.remove('a.md')
    expect(sync().counts).toEqual(counts({ removed: 1, kept: 1 }))
    expect(existsSync(join(lib, 'a.md'))).toBe(false)
    expect(local.read('_archive/a.md')).toBe('base')
  })

  it('deleted here / changed there: pulled', () => {
    local.remove('a.md')
    remote.write('a.md', 'theirs')
    expect(sync().counts).toEqual(counts({ pulled: 1 }))
    expect(local.read('a.md')).toBe('theirs')
  })

  it('changed here / deleted there: pushed', () => {
    local.write('a.md', 'mine')
    remote.remove('a.md')
    expect(sync().counts).toEqual(counts({ pushed: 1 }))
    expect(remote.read('a.md')).toBe('mine')
  })
})

describe('no base: the baseline was lost, or the target is new', () => {
  const loseBaseline = () => rmSync(join(m.home, '.pneuma-base', 'cache'), { recursive: true, force: true })

  it('present on both and different: conflict, both kept; one side only: copied; equal: nothing', () => {
    local.write('a.md', 'mine')
    remote.write('a.md', 'theirs')
    local.write('only-here.md', 'h')
    remote.write('only-there.md', 't')
    local.write('same.md', 's')
    remote.write('same.md', 's')
    loseBaseline()
    const r = sync()
    expect(r.counts).toMatchObject({ conflicts: 1, kept: 0, removed: 0 })
    expect(local.read('a.md')).toBe('mine')
    expect(local.read(r.conflicts[0].copy)).toBe('theirs')
    expect(remote.read('only-here.md')).toBe('h')
    expect(local.read('only-there.md')).toBe('t')
  })

  it('a file deleted on one side comes back from the other instead of being deleted there', () => {
    local.remove('a.md')
    loseBaseline()
    expect(sync().counts).toEqual(counts({ pulled: 1 }))
    expect(local.read('a.md')).toBe('base')
  })

  it('an emptied target is a new target: everything is pushed again, nothing archived', () => {
    rmSync(target, { recursive: true })
    write(target, 'stray.txt', 'x')
    rmSync(join(target, 'stray.txt'))
    expect(sync().counts).toMatchObject({ kept: 0, removed: 0 })
    expect(remote.read('a.md')).toBe('base')
    expect(local.read('a.md')).toBe('base')
  })
})

describe('a run the target fails in the middle of', () => {
  it('is refused by name, keeps what was done, loses nothing, and a rerun converges', () => {
    local.write('b/x.md', 'x')
    local.write('c.md', 'c')
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

describe('what is synced', () => {
  it('a bundle file by file, marker included; not the configuration, the description, temporary files or OS junk', () => {
    const site = join(tempDir(), 'site')
    write(site, 'index.html', '<h1>hi</h1>')
    write(site, 'css/a.css', 'body{}')
    ok(m.run(['--library', lib, 'put', site, '--to', 'sites/one', '--made']))
    local.write('.DS_Store', 'junk')
    local.write('.pneuma-base/sync/tmp/half', 'half')
    sync()
    expect(remote.read('sites/one/index.html')).toBe('<h1>hi</h1>')
    expect(remote.read('sites/one/css/a.css')).toBe('body{}')
    expect(existsSync(join(target, 'sites/one/.pneuma-item'))).toBe(true)
    for (const left of ['.DS_Store', '.pneuma-base/config.json', 'PNEUMA-BASE.md', '.pneuma-base/sync/tmp/half']) expect(existsSync(join(target, left)), left).toBe(false)
    expect(existsSync(join(target, '.pneuma-base/sync/facts'))).toBe(true)
  })
})
