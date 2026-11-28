// Driven through the kernel's faces with an injected confirmation, as a terminal would give: the
// confirmed prune, the archive purge, and the blocks the UI shows (onItemView, onView).
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentFace,
  initLibrary,
  makeContext,
  pluginContext,
  openLibrary,
  ownerFace,
  type Actor,
  type Block,
  type Context,
  type Instant,
  type LibraryPath,
  type OwnerCall,
  type PluginContext,
  type Session,
} from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { version } from '../src/index.js'
import { readTree, tempDir, writeTree } from './run.js'

const table = new Map([[version.name as string, version]])
const owner: Actor = { kind: 'owner' }
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session = (id: string): Session => ({ id, source: 'flag', cwd: '/work', machine: 'test', transcript: null })
let second = 0
const next = () => `2026-11-25T02:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second++ % 60).padStart(2, '0')}.000Z` as Instant

async function library() {
  const dir = tempDir()
  const root = join(dir, 'lib')
  const home = join(dir, 'home')
  await initLibrary(root, { plugins: ['version'], table, actor: owner, session: session('init'), home })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const as = (actor: Actor = claude): Context => makeContext(lib, actor, session('s1'), home, next())
  const plugin = (): PluginContext => pluginContext(as(owner), version.name)
  const call = (): OwnerCall => ({ ctx: as(owner), table, env: {}, viaGrant: false, confirm: async () => true })
  const owned = (name: string, positional: string[], flags: Record<string, string[]> = {}) => ownerFace.dispatch(call(), name, { positional, flags })
  const put = (content: string, to: string) =>
    agentFace.put({ kind: 'place', from: { kind: 'stdin', content: new TextEncoder().encode(content) }, to, origin: { kind: 'made', from: [], outside: [] } }, as())
  const declare = (path: string) => agentFace.say({ kind: 'versioned', about: null, text: path, args: {} }, as())
  return { root, dir, owned, put, declare, plugin, as }
}

const objects = (root: string) => Object.keys(readTree(join(root, '.pneuma-base/version'))).filter((f) => f.startsWith('objects/'))

describe('version prune, confirmed', () => {
  it('drops the oldest versions and the content only they held; numbers stay; shared content stays', async () => {
    const { root, owned, put, declare } = await library()
    await put('one', 'a.md')
    await declare('a.md')
    await put('two', 'a.md')
    await put('three', 'a.md')
    await put('one', 'b.md')
    await declare('b.md')
    expect(objects(root)).toHaveLength(3)

    const pruned = await owned('version prune', ['a.md'], { keep: ['1'] })
    expect(pruned).toMatchObject({ outcome: 'done', data: { pruned: [1, 2], kept: [3], deleted: 1 } })
    expect(objects(root)).toHaveLength(2)
    expect(await owned('version export', ['a.md'], { version: ['1'], to: [join(root, '..', 'v1.md')] })).toMatchObject({ outcome: 'refused', reason: 'pruned' })
    expect(await owned('version export', ['b.md'], { version: ['1'], to: [join(root, '..', 'b1.md')] })).toMatchObject({ outcome: 'done' })
    expect(readFileSync(join(root, '..', 'b1.md'), 'utf8')).toBe('one')

    await put('four', 'a.md')
    const list = await owned('version list', ['a.md'])
    expect((list as any).data.versions.map((v: any) => [v.n, v.pruned])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ])
    expect(await owned('version prune', ['a.md'], { keep: ['5'] })).toMatchObject({ outcome: 'done', text: 'a.md 留着的只有 2 版，没有要清的。' })
    expect(await owned('version prune', ['a.md'], {})).toMatchObject({ outcome: 'refused', reason: 'usage' })
  })
})

describe('version prune and what a crash left', () => {
  it('removes copies left in pending/ more than an hour old, and says so only when it removed some', async () => {
    const { root, owned, put, declare } = await library()
    await put('one', 'a.md')
    await declare('a.md')
    await put('two', 'a.md')
    await put('three', 'a.md')
    const pending = join(root, '.pneuma-base/version/pending')
    writeTree(pending, { old: 'x', 'tree/index.html': 'y', fresh: 'z' })
    const long = new Date('2026-11-25T00:00:00.000Z')
    for (const name of ['old', 'tree/index.html', 'tree']) utimesSync(join(pending, name), long, long)
    // The operations here are dated 2026-11-25T02:…, so a copy made now is not an hour old for them.
    const pruned = await owned('version prune', ['a.md'], { keep: ['2'] })
    expect(pruned).toMatchObject({ outcome: 'done', data: { pruned: [1], leftovers: 2 } })
    expect((pruned as any).text).toContain('2 份中断时留下的复制')
    expect(Object.keys(readTree(pending))).toEqual(['fresh'])
    const again = await owned('version prune', ['a.md'], { keep: ['1'] })
    expect(again).toMatchObject({ outcome: 'done', data: { pruned: [2], leftovers: 0 } })
    expect((again as any).text).not.toContain('中断')
  })
})

describe('archive purge', () => {
  it('a purged thing is gone from the library: check does not report it missing, and its path is free', async () => {
    const { owned, put, declare, as } = await library()
    await put('v1', 'a.md')
    await declare('a.md')
    await agentFace.archive({ kind: 'archive', path: 'a.md' }, as())
    expect(await owned('archive purge', [])).toMatchObject({ outcome: 'done' })
    const check = await agentFace.check({ since: null, includeArchived: true }, as())
    expect(check.sections.filter((s) => s.plugin === 'version')).toEqual([])
    // Its versions stay in the store and no command reaches them; the refusal says that, not that it was never declared.
    for (const input of ['_archive/a.md', 'a.md']) {
      expect(await owned('version list', [input])).toMatchObject({ outcome: 'refused', reason: 'gone', text: expect.stringContaining('_archive/a.md 随归档区清掉了。它的 1 版内容还在版本存放里') })
    }
  })
})

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind)
const only = <K extends Block['kind']>(blocks: Block[], kind: K) => blocks.find((b): b is Extract<Block, { kind: K }> => b.kind === kind)

describe('the item panel section', () => {
  it('a declared thing: its versions newest first, the current one tagged, export and restore as owner commands', async () => {
    const { put, declare, plugin } = await library()
    await put('v1', 'a.md')
    await declare('a.md')
    await put('v2', 'a.md')
    await put('v3', 'a.md')
    const section = await version.onItemView?.('a.md' as LibraryPath, plugin())
    expect(section?.title).toBe('版本')
    expect(kinds(section?.blocks ?? [])).toEqual(['timeline', 'actions'])
    const timeline = only(section?.blocks ?? [], 'timeline')
    expect(timeline?.entries.map((e) => [e.title.text, e.tag?.text ?? null])).toEqual([
      ['第 3 版', '当前'],
      ['第 2 版', null],
      ['第 1 版', null],
    ])
    const [exported, restored] = only(section?.blocks ?? [], 'actions')?.actions ?? []
    expect(exported).toMatchObject({ label: '导出到库外', call: { face: 'owner', command: 'version export', args: { positional: ['a.md'], flags: { version: ['{version}'], to: ['{to}'] } } } })
    expect(exported?.inputs.map((i) => i.name)).toEqual(['version', 'to'])
    expect(restored).toMatchObject({ label: '放回这一版', call: { face: 'owner', command: 'version restore', args: { positional: ['a.md'], flags: { version: ['{version}'] } } } })
    const choice = restored?.inputs[0]
    expect(choice?.options?.map((o) => o.value)).toEqual(['3', '2', '1'])
    expect(choice?.value).toBe('2')
  })

  it('says when the content changed outside the tool, and tags that version once recorded', async () => {
    const { root, put, declare, plugin, as } = await library()
    await put('v1', 'a.md')
    await declare('a.md')
    writeFileSync(join(root, 'a.md'), 'by hand')
    const before = await version.onItemView?.('a.md' as LibraryPath, plugin())
    expect(only(before?.blocks ?? [], 'text')).toMatchObject({ tone: 'warn' })
    await agentFace.check({ since: null, includeArchived: false }, as())
    const after = await version.onItemView?.('a.md' as LibraryPath, plugin())
    expect(kinds(after?.blocks ?? [])).toEqual(['timeline', 'actions'])
    expect(only(after?.blocks ?? [], 'timeline')?.entries[0]?.lines).toContain('在工具之外改的')
  })

  it('a path inside a bundle shows the bundle; an archived thing offers export and pruning only', async () => {
    const { dir, put, plugin, as } = await library()
    writeTree(join(dir, 'site'), { 'index.html': '1' })
    await agentFace.put({ kind: 'place', from: { kind: 'directory', path: join(dir, 'site') }, to: 'sites/a', origin: { kind: 'made', from: [], outside: [] } }, as())
    await agentFace.say({ kind: 'versioned', about: null, text: 'sites/a', args: {} }, as())
    const inside = await version.onItemView?.('sites/a/index.html' as LibraryPath, plugin())
    expect(only(inside?.blocks ?? [], 'actions')?.actions[0]?.call).toMatchObject({ args: { positional: ['sites/a'] } })
    await put('x', 'b.md')
    await agentFace.archive({ kind: 'archive', path: 'sites/a' }, as())
    const archived = await version.onItemView?.('_archive/sites/a' as LibraryPath, plugin())
    expect(only(archived?.blocks ?? [], 'actions')?.actions.map((a) => a.label)).toEqual(['导出到库外', '只留最近几版'])
  })

  it('an undeclared thing offers the declaration, which works as a say; no thing, no section', async () => {
    const { put, plugin, as } = await library()
    await put('x', 'b.md')
    const section = await version.onItemView?.('b.md' as LibraryPath, plugin())
    const declare = only(section?.blocks ?? [], 'actions')?.actions[0]
    expect(declare?.call).toEqual({ face: 'agent', verb: 'say', request: { kind: 'versioned', about: 'b.md', text: null, args: {} } })
    if (declare?.call.face !== 'agent' || declare.call.verb !== 'say') throw new Error('not a say')
    expect(await agentFace.say(declare.call.request, as(owner))).toMatchObject({ outcome: 'heard', by: 'version' })
    expect(only((await version.onItemView?.('b.md' as LibraryPath, plugin()))?.blocks ?? [], 'timeline')?.entries).toHaveLength(1)
    expect(await version.onItemView?.('nothing.md' as LibraryPath, plugin())).toBeNull()
    expect(await version.onItemView?.('.pneuma-base/config.json' as LibraryPath, plugin())).toBeNull()
  })
})

describe('the page of versioned things', () => {
  it('one row per thing with its state; archived ones only when asked', async () => {
    const { root, put, declare, plugin, as } = await library()
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      await put(name, name)
      await declare(name)
    }
    await put('a2', 'a.md')
    writeFileSync(join(root, 'b.md'), 'by hand')
    await agentFace.archive({ kind: 'archive', path: 'c.md' }, as())
    await import('node:fs/promises').then((fs) => fs.rm(join(root, 'd.md')))
    expect(existsSync(join(root, 'd.md'))).toBe(false)
    expect(version.views?.map((v) => v.id)).toEqual(['version.items'])

    const rows = async (archived: string) => {
      const page = await version.onView?.({ view: 'version.items', params: { archived } }, plugin())
      const table = only(page?.blocks ?? [], 'table')
      // Each state, and whether it is the usual one the page leaves unsaid: every change written down.
      return table?.rows.map((r) => [r.cells.path?.text, r.cells.versions?.text, r.cells.state?.tag?.text ?? r.cells.state?.text, r.cells.state?.normal === true]).sort()
    }
    expect(await rows('hide')).toEqual([
      ['a.md', '2 版', '已记下', true],
      ['b.md', '1 版', '有没记下的改动', false],
      ['d.md', '1 版', '不在', false],
    ])
    expect(await rows('show')).toContainEqual(['_archive/c.md', '1 版', '已归档', false])
  })

  it('lists the versioned things a page at a time, with the way to the next page', async () => {
    const { put, declare, plugin } = await library()
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await put(name, name)
      await declare(name)
    }
    const first = await version.onView?.({ view: 'version.items', params: {}, size: 2 }, plugin())
    const table = only(first?.blocks ?? [], 'table')
    expect(table?.rows).toHaveLength(2)
    expect(table?.page).toMatchObject({ first: 1, shown: 2, total: 3 })
    const rest = await version.onView?.({ view: 'version.items', params: table?.page?.next?.params ?? {}, size: 2 }, plugin())
    expect(only(rest?.blocks ?? [], 'table')?.rows).toHaveLength(1)
  })
})

/** The plugin's context, with every call that reads a thing's content counted: a copy from a place, a fingerprint, a read. */
function counting(ctx: PluginContext): { ctx: PluginContext; reads: string[] } {
  const reads: string[] = []
  const READS = new Set(['write', 'content', 'read'])
  const wrap = <T extends object>(store: T, area: string): T =>
    new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown
        if (key === 'own') return wrap(value as object, 'own')
        if (typeof value !== 'function' || !READS.has(String(key))) return value
        return (...args: unknown[]) => {
          reads.push(`${area}.${String(key)} ${String(args[0])}`)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  return { ctx: { ...ctx, tools: { ...ctx.tools, storage: wrap(ctx.tools.storage, 'content') } }, reads }
}

describe('check over many declared things', () => {
  it('reads content only for the things whose token changed: none when nothing did, one new version for the one changed', async () => {
    const { root, put, declare, plugin, owned } = await library()
    const names = Array.from({ length: 40 }, (_, i) => `notes/n${String(i).padStart(2, '0')}.md`)
    for (const name of names) {
      await put(name, name)
      await declare(name)
    }
    const check = async () => {
      const counted = counting(plugin())
      const sections = (await version.onCheck?.({ since: null, includeArchived: false }, counted.ctx)) ?? []
      return { sections, reads: counted.reads }
    }
    expect(await check()).toEqual({ sections: [], reads: [] })

    writeFileSync(join(root, 'notes/n07.md'), 'by hand')
    const changed = await check()
    expect(changed.sections.map((s) => s.data)).toEqual([{ recorded: [{ path: 'notes/n07.md', version: 2 }], missing: [], count: { recorded: 1, missing: 0 } }])
    expect(changed.reads).toHaveLength(1)
    expect(await check()).toEqual({ sections: [], reads: [] })
    const counts = await Promise.all(names.map(async (name) => ((await owned('version list', [name])) as any).data.versions.length))
    expect(counts.filter((n) => n !== 1)).toEqual([2])
  })
})

