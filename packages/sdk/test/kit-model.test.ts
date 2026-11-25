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
  离线: () => world({}),
  在线: () => world({ on: true, target: new Map([[S, F1]]) }),
  待发布: () => world({ on: true, target: new Map([[S, OLD]]) }),
  '已归档（开关关）': () => world({ path: archivedAt(P), archived: true }),
  '已归档（开关开）': () => world({ path: archivedAt(P), archived: true, on: true }),
  '待下线（开关关）': () => world({ target: new Map([[S, OLD]]) }),
  '待下线（已归档）': () => world({ path: archivedAt(P), archived: true, on: true, target: new Map([[S, F1]]) }),
  '待下线（不在）': () => world({ on: true, content: null, target: new Map([[S, F1]]) }),
  不在: () => world({ on: true, content: null }),
} satisfies Record<string, () => World>

const OPS = {
  开: (w: World) => ({ ...w, on: true }),
  关: (w: World) => ({ ...w, on: false }),
  内容变了: (w: World) => ({ ...w, content: F2 }),
  归档: (w: World) => ({ ...w, path: archivedAt(w.path), archived: true }),
  取回: (w: World) => ({ ...w, path: p(w.path.replace(/^_archive\//, '')), archived: false }),
  挪: (w: World) => ({ ...w, path: Q }),
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

/** The target holds the current content under the current path's name, and nothing else. */
const servesCurrent = (w: World) => new Map([[siteName(w.path), w.content as ContentId]])

type Cell = [state: keyof typeof STATES, op: keyof typeof OPS, ok: Status, failed: Status]

// The applicable cells of the table; the README says why the others cannot happen.
const CELLS: Cell[] = [
  ['离线', '开', 'online', 'pending'],
  ['离线', '关', 'offline', 'offline'],
  ['离线', '内容变了', 'offline', 'offline'],
  ['离线', '归档', 'archived', 'archived'],
  ['离线', '挪', 'offline', 'offline'],
  ['在线', '开', 'online', 'online'],
  ['在线', '关', 'offline', 'retiring'],
  ['在线', '内容变了', 'online', 'pending'],
  ['在线', '归档', 'archived', 'retiring'],
  ['在线', '挪', 'online', 'pending'],
  ['待发布', '开', 'online', 'pending'],
  ['待发布', '关', 'offline', 'retiring'],
  ['待发布', '内容变了', 'online', 'pending'],
  ['待发布', '归档', 'archived', 'retiring'],
  ['待发布', '挪', 'online', 'pending'],
  ['已归档（开关关）', '开', 'archived', 'archived'],
  ['已归档（开关开）', '关', 'archived', 'archived'],
  ['已归档（开关开）', '取回', 'online', 'pending'],
  ['已归档（开关关）', '取回', 'offline', 'offline'],
  ['待下线（开关关）', '开', 'online', 'pending'],
  ['待下线（开关关）', '关', 'offline', 'retiring'],
  ['待下线（开关关）', '内容变了', 'offline', 'retiring'],
  ['待下线（开关关）', '归档', 'archived', 'retiring'],
  ['待下线（开关关）', '挪', 'offline', 'retiring'],
  ['待下线（已归档）', '开', 'archived', 'retiring'],
  ['待下线（已归档）', '关', 'archived', 'retiring'],
  ['待下线（已归档）', '取回', 'online', 'online'],
  ['待下线（不在）', '关', 'offline', 'retiring'],
  ['待下线（不在）', '内容变了', 'online', 'pending'],
  ['不在', '开', 'missing', 'missing'],
  ['不在', '关', 'offline', 'offline'],
  ['不在', '内容变了', 'online', 'pending'],
]

describe('the state × operation table', () => {
  it.each(CELLS)('%s, %s: %s, or %s when the target fails', (state, op, ok, failed) => {
    const after = OPS[op](STATES[state]())
    const done = reconcile(after, false)
    expect(status(done)).toBe(ok)
    expect(done.target).toEqual(ok === 'online' ? servesCurrent(done) : new Map())
    const stuck = reconcile(after, true)
    expect(status(stuck)).toBe(failed)
    expect(stuck.target).toEqual(after.target)
  })

  it('names each starting state as the table does', () => {
    expect(Object.fromEntries(Object.entries(STATES).map(([name, make]) => [name, status(make())]))).toEqual({
      离线: 'offline',
      在线: 'online',
      待发布: 'pending',
      '已归档（开关关）': 'archived',
      '已归档（开关开）': 'archived',
      '待下线（开关关）': 'retiring',
      '待下线（已归档）': 'retiring',
      '待下线（不在）': 'retiring',
      不在: 'missing',
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
