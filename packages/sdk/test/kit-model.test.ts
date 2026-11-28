// The deploy kit's decision, cell by cell of src/kit/deploy/README.md "状态 × 操作": each state is a
// world of switch, archive flag, content and what the target holds; each operation changes the world;
// then the plan runs against a target that answers every step, or one that fails every step.
import { describe, expect, it } from 'vitest'
import { plan, siteName, statusOf, want, type ContentId, type SiteName, type State as Status } from '../src/kit/index.js'
import type { LibraryPath } from '../src/index.js'

const fp = (s: string) => s.padEnd(64, '0') as ContentId
const p = (s: string) => s as LibraryPath
const [OLD, F1, F2] = [fp('0'), fp('1'), fp('2')]
const P = p('sites/a')
const Q = p('sites/b')
const S = siteName(P)
const S2 = siteName(Q)

type World = { path: LibraryPath; on: boolean; archived: boolean; content: ContentId | null; target: Map<SiteName, ContentId> }

const world = (w: Partial<World>): World => ({ path: P, on: false, archived: false, content: F1, target: new Map(), ...w })
const archivedAt = (path: LibraryPath) => p(`_archive/${path}`)

const STATES = {
  未发布: () => world({}),
  已发布: () => world({ on: true, target: new Map([[S, F1]]) }),
  待发布: () => world({ on: true, target: new Map([[S, OLD]]) }),
  '已归档（开关已关闭）': () => world({ path: archivedAt(P), archived: true }),
  '已归档（开关已开启）': () => world({ path: archivedAt(P), archived: true, on: true }),
  '待取消发布（开关已关闭）': () => world({ target: new Map([[S, OLD]]) }),
  '待取消发布（已归档）': () => world({ path: archivedAt(P), archived: true, on: true, target: new Map([[S, F1]]) }),
  '待取消发布（条目缺失）': () => world({ on: true, content: null, target: new Map([[S, F1]]) }),
  条目缺失: () => world({ on: true, content: null }),
} satisfies Record<string, () => World>

const OPS = {
  发布: (w: World) => ({ ...w, on: true }),
  取消发布: (w: World) => ({ ...w, on: false }),
  内容修改: (w: World) => ({ ...w, content: F2 }),
  归档: (w: World) => ({ ...w, path: archivedAt(w.path), archived: true }),
  取消归档: (w: World) => ({ ...w, path: p(w.path.replace(/^_archive\//, '')), archived: false }),
  移动: (w: World) => ({ ...w, path: Q }),
} satisfies Record<string, (w: World) => World>

/** Runs the plan for the world against a target that does every step, or fails at the first. */
function reconcile(w: World, targetFails: boolean): World {
  const target = new Map(w.target)
  for (const step of plan(want(siteName(w.path), w), target)) {
    if (targetFails) break
    if (step.kind === 'publish') target.set(step.site, step.content)
    else target.delete(step.site)
  }
  return { ...w, target }
}

const status = (w: World): Status => statusOf(siteName(w.path), w, w.target)

type Cell = [state: keyof typeof STATES, op: keyof typeof OPS, ok: Status, failed: Status]

// The applicable cells of the table; the README says why the others cannot happen.
const CELLS: Cell[] = [
  ['未发布', '发布', 'published', 'pending'],
  ['未发布', '取消发布', 'unpublished', 'unpublished'],
  ['未发布', '内容修改', 'unpublished', 'unpublished'],
  ['未发布', '归档', 'archived', 'archived'],
  ['未发布', '移动', 'unpublished', 'unpublished'],
  ['已发布', '发布', 'published', 'published'],
  ['已发布', '取消发布', 'unpublished', 'pending-unpublish'],
  ['已发布', '内容修改', 'published', 'pending'],
  ['已发布', '归档', 'archived', 'pending-unpublish'],
  ['已发布', '移动', 'published', 'pending'],
  ['待发布', '发布', 'published', 'pending'],
  ['待发布', '取消发布', 'unpublished', 'pending-unpublish'],
  ['待发布', '内容修改', 'published', 'pending'],
  ['待发布', '归档', 'archived', 'pending-unpublish'],
  ['待发布', '移动', 'published', 'pending'],
  ['已归档（开关已关闭）', '发布', 'archived', 'archived'],
  ['已归档（开关已开启）', '取消发布', 'archived', 'archived'],
  ['已归档（开关已开启）', '取消归档', 'published', 'pending'],
  ['已归档（开关已关闭）', '取消归档', 'unpublished', 'unpublished'],
  ['待取消发布（开关已关闭）', '发布', 'published', 'pending'],
  ['待取消发布（开关已关闭）', '取消发布', 'unpublished', 'pending-unpublish'],
  ['待取消发布（开关已关闭）', '内容修改', 'unpublished', 'pending-unpublish'],
  ['待取消发布（开关已关闭）', '归档', 'archived', 'pending-unpublish'],
  ['待取消发布（开关已关闭）', '移动', 'unpublished', 'pending-unpublish'],
  ['待取消发布（已归档）', '发布', 'archived', 'pending-unpublish'],
  ['待取消发布（已归档）', '取消发布', 'archived', 'pending-unpublish'],
  ['待取消发布（已归档）', '取消归档', 'published', 'published'],
  ['待取消发布（条目缺失）', '取消发布', 'unpublished', 'pending-unpublish'],
  ['待取消发布（条目缺失）', '内容修改', 'published', 'pending'],
  ['条目缺失', '发布', 'missing', 'missing'],
  ['条目缺失', '取消发布', 'unpublished', 'unpublished'],
  ['条目缺失', '内容修改', 'published', 'pending'],
]

describe('the state × operation table', () => {
  // One row per cell, so a failure's diff names the cells that went wrong: the state with a target
  // that answers and what it then holds (the current content under the current name when online,
  // nothing otherwise); the state with a target that fails and what it then holds (what it held).
  it('ends each applicable cell in the state it names, with a target that answers and with one that fails', () => {
    const held = (target: Map<SiteName, ContentId>) => Object.fromEntries(target)
    const got = CELLS.map(([state, op]) => {
      const after = OPS[op](STATES[state]())
      const [done, stuck] = [reconcile(after, false), reconcile(after, true)]
      return [state, op, status(done), held(done.target), status(stuck), held(stuck.target)]
    })
    const expected = CELLS.map(([state, op, ok, failed]) => {
      const after = OPS[op](STATES[state]())
      return [state, op, ok, ok === 'published' ? { [siteName(after.path)]: after.content } : {}, failed, held(after.target)]
    })
    expect(got).toEqual(expected)
  })

  it('names each starting state as the table does', () => {
    expect(Object.fromEntries(Object.entries(STATES).map(([name, make]) => [name, status(make())]))).toEqual({
      未发布: 'unpublished',
      已发布: 'published',
      待发布: 'pending',
      '已归档（开关已关闭）': 'archived',
      '已归档（开关已开启）': 'archived',
      '待取消发布（开关已关闭）': 'pending-unpublish',
      '待取消发布（已归档）': 'pending-unpublish',
      '待取消发布（条目缺失）': 'pending-unpublish',
      条目缺失: 'missing',
    })
  })
})

describe('the plan', () => {
  it('is empty once the target holds what is wanted, so a second run changes nothing', () => {
    const w = world({ on: true, target: new Map([[S, OLD], [S2, F1]]) })
    const once = reconcile(w, false)
    expect(plan(want(siteName(once.path), once), once.target)).toEqual([])
  })

  it('on a move, publishes under the new name before taking the old one down', () => {
    expect(plan(want(S2, { on: true, archived: false, content: F1 }), new Map([[S, F1]]))).toEqual([
      { kind: 'publish', site: S2, content: F1 },
      { kind: 'unpublish', site: S },
    ])
  })
})

describe('site names', () => {
  const DNS_LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/

  it('is the path with slashes as dashes when the path is already lower-case letters, digits and single dashes', () => {
    expect(siteName(p('sites/shop'))).toBe('sites-shop')
    expect(siteName(p('my-site'))).toBe('my-site')
  })

  it('adds six characters of the path’s hash when the slug would lose something', () => {
    expect(siteName(p('Sites/Shop'))).toMatch(/^sites-shop-[0-9a-f]{6}$/)
    expect(siteName(p('网站/首页'))).toMatch(/^site-[0-9a-f]{6}$/)
    expect(siteName(p('a--b'))).toMatch(/^a-b-[0-9a-f]{6}$/)
    expect(siteName(p('Sites/Shop'))).not.toBe(siteName(p('sites/SHOP')))
  })

  it('stays within 58 characters and is always a DNS label', () => {
    const long = siteName(p(`sites/${'x'.repeat(80)}`))
    expect(long.length).toBeLessThanOrEqual(58)
    expect(long).toMatch(/-[0-9a-f]{6}$/)
    for (const path of ['sites/shop', 'Sites/Shop', '网站/首页', 'a--b', 'x/-y-/z', `sites/${'x'.repeat(80)}`, 'a b/c.d']) {
      expect(siteName(p(path))).toMatch(DNS_LABEL)
    }
  })
})
