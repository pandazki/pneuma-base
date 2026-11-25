// The sync rule table (design.md 五) as a pure decision per path, the plan that keeps every content
// that would vanish but what the owner deleted on purpose, and the executor over two in-memory
// sides. C6: never lose content; CONTEXT 2.14: the owner may drop it.
import { createHash } from 'node:crypto'
import type { Fingerprint, LibraryPath } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { baselineAfter, execute, settledBy, type SyncTarget } from '../src/execute.js'
import { conflictName, conflictOrigin, decide, plan, type Deletion, type Files, type Plan } from '../src/rules.js'

const fp = (content: string) => createHash('sha256').update(content).digest('hex') as Fingerprint
const A = fp('a')
const B = fp('b')
const C = fp('c')
const p = (path: string) => path as LibraryPath
const files = (entries: Record<string, string>): Files => new Map(Object.entries(entries).map(([path, content]) => [p(path), fp(content)]))
const namer = (path: LibraryPath, n: number) => conflictName(path, 'm1', '20261125T080000Z', n)
const planOf = (local: Record<string, string>, target: Record<string, string>, base: Record<string, string>, deleted: Deletion[] = []) =>
  plan({ local: files(local), target: files(target), base: files(base), deleted }, namer)
const gone = (path: string, content: string): Deletion => ({ path: p(path), fingerprint: fp(content) })

describe('decide: each cell of the table, base present', () => {
  const cases: [string, Fingerprint | null, Fingerprint | null, ReturnType<typeof decide>][] = [
    ['unchanged / unchanged: nothing', A, A, 'keep'],
    ['changed / unchanged: push', B, A, 'push'],
    ['unchanged / changed: pull', A, B, 'pull'],
    ['changed / changed, the same: nothing (base moves on)', B, B, 'keep'],
    ['changed / changed, different: conflict', B, C, 'conflict'],
    ['deleted / unchanged: drop the target copy', null, A, 'drop'],
    ['unchanged / deleted: drop the local copy', A, null, 'drop'],
    ['deleted / changed: pull', null, B, 'pull'],
    ['changed / deleted: push', B, null, 'push'],
    ['deleted / deleted: nothing', null, null, 'keep'],
  ]
  for (const [name, local, target, expected] of cases) it(name, () => expect(decide(local, target, A)).toBe(expected))
})

describe('decide: no base (first sync, or the baseline was lost)', () => {
  it('present on one side only: copy it to the other', () => {
    expect(decide(A, null, null)).toBe('push')
    expect(decide(null, A, null)).toBe('pull')
  })
  it('present on both, equal: nothing', () => expect(decide(A, A, null)).toBe('keep'))
  it('present on both, different: conflict, keep both', () => expect(decide(A, B, null)).toBe('conflict'))
})

const kinds = (r: Plan) => r.steps.map((s) => (s.kind === 'keep' ? `keep ${s.from}:${s.path} -> ${s.to} (${s.as})` : s.kind === 'copy' ? `copy ${s.from}:${s.path}` : `remove ${s.side}:${s.path}`))

describe('plan: what would vanish is kept', () => {
  it('a move on this side removes the old path on the target and pushes the new one', () => {
    expect(kinds(planOf({ 'b.md': 'x' }, { 'a.md': 'x' }, { 'a.md': 'x' }))).toEqual(['copy local:b.md', 'remove target:a.md'])
  })

  it('a move on the other side removes the old path here and pulls the new one', () => {
    expect(kinds(planOf({ 'a.md': 'x' }, { 'b.md': 'x' }, { 'a.md': 'x' }))).toEqual(['copy target:b.md', 'remove local:a.md'])
  })

  it('deleted here with no other copy: the target copy goes to _archive/ on both sides', () => {
    const r = planOf({}, { 'n/a.md': 'x' }, { 'n/a.md': 'x' })
    expect(kinds(r)).toEqual(['keep target:n/a.md -> _archive/n/a.md (archive)', 'remove target:n/a.md'])
    expect([...r.end]).toEqual([[p('_archive/n/a.md'), fp('x')]])
  })

  it('deleted on the target with no other copy: the local copy goes to _archive/', () => {
    expect(kinds(planOf({ 'a.md': 'x' }, {}, { 'a.md': 'x' }))).toEqual(['keep local:a.md -> _archive/a.md (archive)', 'remove local:a.md'])
  })

  it('two deleted paths with the same content keep it once, not zero times', () => {
    const r = planOf({}, { 'a.md': 'x', 'b.md': 'x' }, { 'a.md': 'x', 'b.md': 'x' })
    expect(kinds(r)).toEqual(['keep target:a.md -> _archive/a.md (archive)', 'remove target:a.md', 'remove target:b.md'])
  })

  it('a push over content that survives nowhere else archives the overwritten content first', () => {
    expect(kinds(planOf({ 'a.md': 'new' }, { 'a.md': 'old' }, { 'a.md': 'old' }))).toEqual(['keep target:a.md -> _archive/a.md (archive)', 'copy local:a.md'])
  })

  it('a push over content kept elsewhere (a held copy that goes along) archives nothing', () => {
    const r = planOf({ 'a.md': 'new', '.pneuma-base/ledger/held/i/a.md': 'old' }, { 'a.md': 'old' }, { 'a.md': 'old' })
    expect(kinds(r)).toEqual(['copy local:.pneuma-base/ledger/held/i/a.md', 'copy local:a.md'])
  })

  it('a conflict keeps the local version in place and the target version as a conflict copy on both sides', () => {
    const r = planOf({ 'n/plan.md': 'mine' }, { 'n/plan.md': 'theirs' }, { 'n/plan.md': 'base' })
    expect(kinds(r)).toEqual(['keep target:n/plan.md -> n/plan.conflict-m1-20261125T080000Z.md (conflict)', 'copy local:n/plan.md'])
    expect(r.conflicts).toEqual([{ path: 'n/plan.md', copy: 'n/plan.conflict-m1-20261125T080000Z.md' }])
  })

  it('a conflict whose target version is already kept (a rerun after a crash) makes no second copy', () => {
    const copy = 'plan.conflict-m1-20261125T070000Z.md'
    const r = planOf({ 'plan.md': 'mine', [copy]: 'theirs' }, { 'plan.md': 'theirs' }, { 'plan.md': 'base' })
    expect(kinds(r)).toEqual([`copy local:${copy}`, 'copy local:plan.md'])
    expect(r.conflicts).toEqual([{ path: 'plan.md', copy }])
  })

  it('an archive name already taken gets the first eight characters of the fingerprint', () => {
    const r = planOf({ '_archive/a.md': 'older' }, { '_archive/a.md': 'older', 'a.md': 'x' }, { '_archive/a.md': 'older', 'a.md': 'x' })
    expect(kinds(r)).toEqual([`keep target:a.md -> _archive/a.${fp('x').slice(0, 8)}.md (archive)`, 'remove target:a.md'])
  })

  it('archived or kernel files the other side deleted are restored in place, not archived again', () => {
    const base = { '_archive/old.md': 'o', '.pneuma-base/ledger/held/i/f/a.md': 'h' }
    expect(kinds(planOf({}, base, base))).toEqual([
      'keep target:.pneuma-base/ledger/held/i/f/a.md -> .pneuma-base/ledger/held/i/f/a.md (restore)',
      'keep target:_archive/old.md -> _archive/old.md (restore)',
    ])
  })
})

describe('plan: what the owner deleted on purpose goes', () => {
  const held = '.pneuma-base/ledger/held/i/f/a.md'
  const base = { 'n/a.md': 'x', '_archive/old.md': 'o', [held]: 'h' }
  const all = [gone('n/a.md', 'x'), gone('_archive/old.md', 'o'), gone(held, 'h')]

  it('deleted here: the target copies are removed, in the content, the archive and the records alike, and nothing is kept', () => {
    const r = planOf({}, base, base, all)
    expect(kinds(r)).toEqual([`remove target:${held}`, 'remove target:_archive/old.md', 'remove target:n/a.md'])
    expect(r.steps.map((s) => s.kind === 'remove' && s.as)).toEqual(['deleted', 'deleted', 'deleted'])
    expect([...r.end]).toEqual([])
  })

  it('deleted on the other side: the copies here are removed', () => {
    expect(kinds(planOf(base, {}, base, all))).toEqual([`remove local:${held}`, 'remove local:_archive/old.md', 'remove local:n/a.md'])
  })

  it('other content put at the path afterwards replaces the deleted content, which is not kept', () => {
    expect(kinds(planOf({ '_archive/old.md': 'new' }, { '_archive/old.md': 'o' }, base, all))).toEqual(['copy local:_archive/old.md'])
    expect(kinds(planOf({ '_archive/old.md': 'o' }, { '_archive/old.md': 'new' }, base, all))).toEqual(['copy target:_archive/old.md'])
  })

  it('reaching a side that changed the file: the change is not the deleted content and goes over', () => {
    expect(kinds(planOf({ 'a.md': 'changed' }, {}, { 'a.md': 'x' }, [gone('a.md', 'x')]))).toEqual(['copy local:a.md'])
  })

  it('once the base no longer holds the deleted content, content put back follows the ordinary rules', () => {
    expect(kinds(planOf({}, { 'a.md': 'x' }, {}, [gone('a.md', 'x')]))).toEqual(['copy target:a.md'])
    const removedByHand = planOf({}, { 'a.md': 'y' }, { 'a.md': 'y' }, [gone('a.md', 'x')])
    expect(kinds(removedByHand)).toEqual(['keep target:a.md -> _archive/a.md (archive)', 'remove target:a.md'])
  })

  it('without a base the deleted content cannot be told from content put back, so it is copied as new', () => {
    expect(kinds(planOf({ 'a.md': 'x' }, {}, {}, [gone('a.md', 'x')]))).toEqual(['copy local:a.md'])
  })

  it('the same content at a path removed by hand, not on purpose, is still kept once', () => {
    const both = { 'a.md': 'x', 'b.md': 'x' }
    expect(kinds(planOf({}, both, both, [gone('a.md', 'x')]))).toEqual(['keep target:b.md -> _archive/b.md (archive)', 'remove target:a.md', 'remove target:b.md'])
  })
})

describe('conflict copy names', () => {
  it('put the marker before the extension, and read back the original', () => {
    for (const [path, copy] of [
      ['n/plan.md', 'n/plan.conflict-m1-20261125T080000Z.md'],
      ['Makefile', 'Makefile.conflict-m1-20261125T080000Z'],
      ['.env', '.env.conflict-m1-20261125T080000Z'],
      ['a/b.tar.gz', 'a/b.tar.conflict-m1-20261125T080000Z.gz'],
    ]) {
      expect(namer(p(path as string), 1)).toBe(copy)
      expect(conflictOrigin(p(copy as string))).toBe(path)
    }
    expect(namer(p('n/plan.md'), 2)).toBe('n/plan.conflict-m1-20261125T080000Z-2.md')
    expect(conflictOrigin(p('n/plan.conflict-m1-20261125T080000Z-2.md'))).toBe('n/plan.md')
    expect(conflictOrigin(p('n/plan.md'))).toBeNull()
  })
})

// ---- the executor, against two in-memory sides ----

class Memory implements SyncTarget {
  readonly files = new Map<string, Uint8Array>()
  constructor(entries: Record<string, string>) {
    for (const [path, content] of Object.entries(entries)) this.files.set(path, Buffer.from(content))
  }
  async list() {
    return new Map([...this.files].map(([path, bytes]) => [p(path), createHash('sha256').update(bytes).digest('hex') as Fingerprint]))
  }
  async read(path: LibraryPath) {
    const bytes = this.files.get(path)
    if (!bytes) throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' })
    return bytes
  }
  async write(path: LibraryPath, bytes: Uint8Array) {
    this.files.set(path, bytes)
  }
  async remove(path: LibraryPath) {
    this.files.delete(path)
  }
}

const contents = (side: Memory) => new Set([...side.files.values()].map((b) => Buffer.from(b).toString()))
const sorted = (m: ReadonlyMap<string, string>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1))

/** Every combination of absent, x and y for each of three paths on each of the local side, the target and the base. */
function* states(): Generator<[Record<string, string>, Record<string, string>, Record<string, string>]> {
  const paths = ['a.md', '_archive/a.md', '.pneuma-base/k/f.json']
  const values = [null, 'x', 'y']
  const total = values.length ** (paths.length * 3)
  for (let n = 0; n < total; n++) {
    const pick: (string | null)[] = []
    for (let i = 0, rest = n; i < paths.length * 3; i++, rest = Math.floor(rest / values.length)) pick.push(values[rest % values.length] ?? null)
    const side = (k: number) => Object.fromEntries(paths.flatMap((path, i) => (pick[k * paths.length + i] ? [[path, pick[k * paths.length + i] as string]] : [])))
    yield [side(0), side(1), side(2)]
  }
}

describe('the executor', () => {
  it('in every combination, ends with both sides equal to the plan, loses no content, and a second plan does nothing', async () => {
    let count = 0
    for (const [l, t, b] of states()) {
      const local = new Memory(l)
      const target = new Memory(t)
      const before = new Set([...Object.values(l), ...Object.values(t)])
      const r = plan({ local: await local.list(), target: await target.list(), base: files(b), deleted: [] }, namer)
      const done = await execute(r, { local, target })
      const label = JSON.stringify({ l, t, b })
      expect(done.failure, label).toBeNull()
      expect(done.skipped, label).toEqual([])
      expect(sorted(await local.list()), label).toEqual(sorted(r.end))
      expect(sorted(await target.list()), label).toEqual(sorted(r.end))
      for (const content of before) expect(contents(local).has(content), `${label} lost ${content}`).toBe(true)
      const again = plan({ local: await local.list(), target: await target.list(), base: baselineAfter(r, files(b), done.done), deleted: [] }, namer)
      expect(again.steps, label).toEqual([])
      count++
    }
    expect(count).toBe(3 ** 9)
  })

  it('in every combination, with x deleted on purpose at every path, loses only x where it was the base, and a second plan does nothing', async () => {
    const paths = ['a.md', '_archive/a.md', '.pneuma-base/k/f.json']
    const deleted = paths.map((path) => gone(path, 'x'))
    for (const [l, t, b] of states()) {
      const local = new Memory(l)
      const target = new Memory(t)
      const r = plan({ local: await local.list(), target: await target.list(), base: files(b), deleted }, namer)
      const done = await execute(r, { local, target })
      const label = JSON.stringify({ l, t, b })
      expect(done.failure, label).toBeNull()
      expect(done.skipped, label).toEqual([])
      expect(sorted(await local.list()), label).toEqual(sorted(r.end))
      expect(sorted(await target.list()), label).toEqual(sorted(r.end))
      // A content may go only when every copy of it sat at a path whose base it was.
      for (const content of new Set([...Object.values(l), ...Object.values(t)])) {
        if (contents(local).has(content)) continue
        const at = paths.filter((path) => l[path] === content || t[path] === content)
        expect(content === 'x' && at.every((path) => b[path] === 'x'), `${label} lost ${content}`).toBe(true)
      }
      const again = plan({ local: await local.list(), target: await target.list(), base: baselineAfter(r, files(b), done.done), deleted }, namer)
      expect(again.steps, label).toEqual([])
    }
  })

  it('a run settles the deletion records whose steps all ran, and leaves one with a skipped step open', async () => {
    const local = new Memory({})
    const target = new Memory({ 'a.md': 'x', 'b.md': 'y' })
    const records = [
      { id: 'ran', deleted: [gone('a.md', 'x')] },
      { id: 'skipped', deleted: [gone('b.md', 'y')] },
      { id: 'nothing to do', deleted: [gone('c.md', 'z')] },
    ]
    const r = plan({ local: await local.list(), target: await target.list(), base: files({ 'a.md': 'x', 'b.md': 'y' }), deleted: records.flatMap((d) => d.deleted) }, namer)
    target.files.set('b.md', Buffer.from('changed meanwhile'))
    const done = await execute(r, { local, target })
    expect(settledBy(r, done.done, records)).toEqual(['ran', 'nothing to do'])
    expect(Buffer.from(target.files.get('b.md') as Uint8Array).toString()).toBe('changed meanwhile')
  })

  it('skips a step whose file changed after the plan, and leaves that path out of the new baseline', async () => {
    const local = new Memory({ 'a.md': 'new' })
    const target = new Memory({ 'a.md': 'old' })
    const r = plan({ local: await local.list(), target: await target.list(), base: files({ 'a.md': 'old' }), deleted: [] }, namer)
    target.files.set('a.md', Buffer.from('edited meanwhile'))
    const done = await execute(r, { local, target })
    expect(Buffer.from(target.files.get('a.md') as Uint8Array).toString()).toBe('edited meanwhile')
    expect(done.skipped.map((s) => s.kind)).toEqual(['keep', 'copy'])
    expect(baselineAfter(r, files({ 'a.md': 'old' }), done.done).get(p('a.md'))).toBe(fp('old'))
  })

  it('stops at the first failure and keeps what was done', async () => {
    const local = new Memory({ 'a.md': 'a', 'b.md': 'b' })
    const target = new Memory({})
    let writes = 0
    target.write = async (path, bytes) => {
      if (++writes > 1) throw new Error('target unreachable')
      target.files.set(path, bytes)
    }
    const r = plan({ local: await local.list(), target: new Map(), base: new Map(), deleted: [] }, namer)
    const done = await execute(r, { local, target })
    expect(done.failure).toContain('target unreachable')
    expect(done.done).toHaveLength(1)
    expect([...baselineAfter(r, new Map(), done.done).keys()]).toEqual(['a.md'])
  })
})
