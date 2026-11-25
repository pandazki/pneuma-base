// The deploy kit through the real kernel, with a fake target kept in memory: the README's state ×
// operation table cell by cell, a target that reports what it serves (a site removed behind the
// plugin's back, a publish that crashed halfway, a target that cannot be read), a target's own
// content id and site names, its additions to the page, and removing the plugin while sites are online.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentFace,
  initLibrary,
  makeContext,
  openLibrary,
  ownerFace,
  pluginContext,
  type Actor,
  type Block,
  type Instant,
  type LibraryPath,
  type OwnerResult,
  type Plugin,
  type Session,
} from '@pneuma-base/kernel'
import { deployPlugin, siteName, type ContentId, type SiteName, type Target, type TargetAdapter } from '@pneuma-base/sdk/kit'
import { describe, expect, it } from 'vitest'

const owner: Actor = { kind: 'owner' }
const claude: Actor = { kind: 'agent', name: 'claude-code', grant: null }
const session: Session = { id: 'kit-test', source: 'flag', cwd: '/work', machine: 'test', transcript: null }
const temp = () => realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-kit-')))
const url = (site: string) => `https://${site}.fake.test/`

type Options = { reports?: boolean; identify?: boolean; names?: boolean; view?: boolean }

/** A target in memory. `fail`: every step throws; `crash`: a publish lands, then throws; `down`: asking what it serves throws. */
function fakeTarget(opts: Options = {}) {
  const fake = { served: new Map<string, { content: string; files: string[] }>(), calls: [] as string[], fail: false, crash: false, down: false, asked: 0 }
  const open = (where: string): Target => ({
    key: `fake:${where}`,
    label: `假的 ${where}`,
    async publish(site, _dir, meta) {
      fake.calls.push(`publish ${site}`)
      if (fake.fail) throw new Error('目标坏了')
      fake.served.set(site, { content: meta.content, files: meta.files.map((f) => f.path) })
      if (fake.crash) throw new Error('传到一半断了')
      return { url: url(site) }
    },
    async remove(site) {
      fake.calls.push(`remove ${site}`)
      if (fake.fail) throw new Error('目标坏了')
      fake.served.delete(site)
    },
    ...(opts.reports
      ? {
          async serving(sites: readonly SiteName[]) {
            fake.asked++
            if (fake.down) throw new Error('连不上')
            return new Map(sites.flatMap((s) => (fake.served.has(s) ? [[s, { content: fake.served.get(s)?.content as ContentId, url: url(s) }] as const] : [])))
          },
        }
      : {}),
    ...(opts.identify
      ? { identify: async (files) => `id-${createHash('sha256').update(files.map((f) => `${f.path}:${readFileSync(f.abs, 'utf8')}`).join('\n')).digest('hex')}` as ContentId }
      : {}),
    ...(opts.names ? { siteName: (path: LibraryPath) => `f-${siteName(path)}` as SiteName } : {}),
    ...(opts.view
      ? {
          view: {
            columns: [{ key: 'files', label: '文件数' }],
            cells: (l) => ({ files: { text: String(fake.served.get(l.site ?? '')?.files.length ?? 0) } }),
            fields: (l) => [{ label: '文件数', value: { text: String(fake.served.get(l.site ?? '')?.files.length ?? 0) } }],
            page: (all) => [{ kind: 'custom', entry: 'chart.html', height: 120, data: { sites: all.length }, actions: {} }],
            item: () => [{ kind: 'text', tone: 'info', text: '假的目标的说明' }],
          },
        }
      : {}),
  })
  const adapter: TargetAdapter = {
    kind: 'fake',
    label: '一个假的目标',
    usage: '--where <名字>',
    flags: ['where'],
    form: { label: '设假的目标', inputs: [{ name: 'where', label: '名字', placeholder: null, value: null, options: null }] },
    secrets: [{ name: 'fake-token', label: '假的令牌' }],
    async configure(flags) {
      const where = flags.value('where')
      return where === null ? { ok: false, reason: 'usage', text: '要写 --where <名字>。' } : { ok: true, config: { where } }
    },
    open(config) {
      if (typeof config.where !== 'string') throw new Error('no where')
      return open(config.where)
    },
  }
  return { fake, adapter }
}

/** A library with only the plugin, made in this process; the target is set unless `noTarget`. */
async function library(plugin: Plugin, noTarget = false) {
  const dir = temp()
  const root = join(dir, 'lib')
  const home = join(dir, 'home')
  const table = new Map([[plugin.name as string, plugin]])
  await initLibrary(root, { plugins: [plugin.name], table, actor: owner, session, home })
  let lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const as = (actor: Actor) => makeContext(lib as NonNullable<typeof lib>, actor, session, home, new Date().toISOString() as Instant)
  const cmd = async (name: string, positional: string[] = [], flags: Record<string, string[] | true> = {}): Promise<OwnerResult> => {
    const r = await ownerFace.dispatch({ ctx: as(owner), table, env: {}, viaGrant: false, confirm: async () => true }, `${name}`, { positional, flags })
    lib = (await openLibrary(root, table)) ?? lib
    return r
  }
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  /** The agent puts a file in, or registers new content written at its path. */
  const put = async (path: string, text: string, actor: Actor = claude) => {
    write(path, text)
    return agentFace.put({ kind: 'register', path, origin: { kind: 'made', from: [], outside: [] } }, as(actor))
  }
  const site = async (path: string, files: Record<string, string>) => {
    const src = join(dir, 'src', path)
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(src, p)), { recursive: true })
      writeFileSync(join(src, p), c)
    }
    return agentFace.put({ kind: 'place', from: { kind: 'directory', path: src }, to: path, origin: { kind: 'made', from: [], outside: [] } }, as(claude))
  }
  const lib0 = {
    root,
    as,
    cmd,
    put,
    site,
    write,
    say: (about: string) => agentFace.say({ kind: 'deployable', about, text: null, args: {} }, as(claude)),
    move: (from: string, to: string) => agentFace.put({ kind: 'move', from, to }, as(claude)),
    archive: (path: string, kind: 'archive' | 'unarchive' = 'archive') => agentFace.archive({ kind, path }, as(claude)),
    check: () => agentFace.check({ since: null, includeArchived: false }, as(claude)),
    /** What `<name> list` says of each declared thing. */
    list: async () => ((await cmd(`${plugin.name} list`)) as { data: { path: string; status: string; site: string | null; url: string | null }[] }).data,
    fingerprint: async (path: string) => pluginContext(as(owner), plugin.name).tools.fingerprint(path as LibraryPath),
    pctx: () => pluginContext(as(owner), plugin.name),
  }
  if (!noTarget) expect(await cmd(`${plugin.name} target set`, [], { where: ['w'] })).toMatchObject({ outcome: 'done' })
  return lib0
}

// ---- the README's table, cell by cell ----

const P = 'c/a.html' as LibraryPath
const Q = 'c/b.html' as LibraryPath
type Lib = Awaited<ReturnType<typeof library>>
type Fake = ReturnType<typeof fakeTarget>['fake']

/** Each starting state of the table, reached through the plugin's own operations. */
const STATES: Record<string, (l: Lib, f: Fake) => Promise<unknown>> = {
  离线: async () => {},
  在线: (l) => l.cmd('fake on', [P]),
  待发布: async (l, f) => {
    await l.cmd('fake on', [P])
    f.fail = true
    await l.put(P, 'v2')
  },
  '已归档（开关关）': (l) => l.archive(P),
  '已归档（开关开）': async (l) => {
    await l.cmd('fake on', [P])
    await l.archive(P)
  },
  '待下线（开关关）': async (l, f) => {
    await l.cmd('fake on', [P])
    f.fail = true
    await l.put(P, 'v2')
    await l.cmd('fake off', [P])
  },
  '待下线（已归档）': async (l, f) => {
    await l.cmd('fake on', [P])
    f.fail = true
    await l.archive(P)
  },
  '待下线（不在）': async (l) => {
    await l.cmd('fake on', [P])
    rmSync(join(l.root, P))
  },
  不在: async (l) => {
    rmSync(join(l.root, P))
    await l.cmd('fake on', [P])
  },
}

const OPS: Record<string, (l: Lib) => Promise<unknown>> = {
  开: (l) => l.cmd('fake on', [P]),
  关: (l) => l.cmd('fake off', [P]),
  内容变了: (l) => l.put(P, 'v3'),
  归档: (l) => l.archive(P),
  取回: (l) => l.archive(P, 'unarchive'),
  挪: (l) => l.move(P, Q),
}

type Cell = [state: string, op: string, ok: string, failed: string]

// The applicable cells, as in test/kit-model.test.ts in the sdk.
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

/** A fresh library at the starting state, the target answering again, and what the target holds then. */
async function at(state: string) {
  const { fake, adapter } = fakeTarget()
  const l = await library(deployPlugin('fake', adapter))
  await l.put(P, 'v1')
  expect(await l.say(P)).toMatchObject({ outcome: 'heard' })
  await STATES[state]?.(l, fake)
  fake.fail = false
  return { l, fake }
}

const holds = (fake: Fake) => new Map([...fake.served].map(([site, s]) => [site, s.content]))

describe('the state × operation table, through the plugin', () => {
  it.each(CELLS)('%s, %s: %s, or %s when the target fails', async (state, op, ok, failed) => {
    const done = await at(state)
    await OPS[op]?.(done.l)
    const [thing] = await done.l.list()
    expect(thing?.status).toBe(ok)
    expect(holds(done.fake)).toEqual(ok === 'online' ? new Map([[siteName(thing?.path as LibraryPath), await done.l.fingerprint(thing?.path as string)]]) : new Map())

    const stuck = await at(state)
    const before = holds(stuck.fake)
    stuck.fake.fail = true
    await OPS[op]?.(stuck.l)
    expect((await stuck.l.list())[0]?.status).toBe(failed)
    expect(holds(stuck.fake)).toEqual(before)
  })
})

// ---- a target that reports what it serves ----

describe('a target that reports what it serves', () => {
  it('sees a site removed behind the plugin’s back, and sync publishes it again; a target that cannot report goes by its records', async () => {
    for (const reports of [true, false]) {
      const { fake, adapter } = fakeTarget({ reports })
      const l = await library(deployPlugin('fake', adapter))
      await l.put(P, 'v1')
      await l.say(P)
      await l.cmd('fake on', [P])
      fake.served.clear()
      expect((await l.list())[0]?.status).toBe(reports ? 'pending' : 'online')
      const sync = await l.cmd('fake sync')
      expect(sync).toMatchObject({ outcome: 'done', data: { changed: reports ? 1 : 0 } })
      expect(fake.served.has(siteName(P))).toBe(reports)
    }
  })

  it('after a publish that landed and then failed, sync publishes nothing again, and a later move takes the old name down', async () => {
    const { fake, adapter } = fakeTarget({ reports: true })
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    fake.crash = true
    expect(await l.cmd('fake on', [P])).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    fake.crash = false
    const published = fake.calls.length

    expect(await l.cmd('fake sync')).toMatchObject({ outcome: 'done', data: { changed: 0, things: [{ path: P, status: 'online', url: url(siteName(P)) }] } })
    expect(fake.calls).toHaveLength(published)

    await l.move(P, Q)
    expect([...fake.served.keys()]).toEqual([siteName(Q)])
  })

  it('that cannot be read: the state is 不知道, nothing is published or taken down, and sync says why', async () => {
    const { fake, adapter } = fakeTarget({ reports: true })
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    await l.cmd('fake on', [P])
    fake.down = true
    const calls = fake.calls.length
    expect(await l.list()).toEqual([expect.objectContaining({ path: P, status: 'unknown' })])
    const sync = await l.cmd('fake sync')
    expect(sync).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    expect((sync as { text: string }).text).toContain('连不上')
    expect((await l.check()).sections.find((s) => s.plugin === 'fake')?.body).toContain('不知道，读不到目标：连不上')
    await l.put(P, 'v2')
    expect(fake.calls).toHaveLength(calls)
  })

  it('and identifies content its own way: the id it is given is the id it computes, from the files sorted by path, under its own site names', async () => {
    const { fake, adapter } = fakeTarget({ reports: true, identify: true, names: true })
    const l = await library(deployPlugin('fake', adapter))
    await l.site('sites/shop', { 'index.html': '<h1>shop</h1>', 'css/a.css': 'h1{}', 'B.txt': 'b' })
    await l.say('sites/shop')
    await l.cmd('fake on', ['sites/shop'])
    const site = `f-${siteName('sites/shop' as LibraryPath)}`
    const held = fake.served.get(site)
    expect(held?.files).toEqual(['B.txt', 'css/a.css', 'index.html'])
    const expected = `id-${createHash('sha256').update('B.txt:b\ncss/a.css:h1{}\nindex.html:<h1>shop</h1>').digest('hex')}`
    expect(held?.content).toBe(expected)
    expect(await l.list()).toEqual([expect.objectContaining({ status: 'online', site, url: url(site) })])
    expect(await l.cmd('fake sync')).toMatchObject({ data: { changed: 0 } })
  })
})

// ---- the plugin it makes ----

describe('the plugin the kit makes', () => {
  it('names its commands, its page and its cognition after itself, and with one kind of target needs no --kind', async () => {
    const { adapter } = fakeTarget()
    const plugin = deployPlugin('fake', adapter, { title: '假部署', heading: '上线到假的地方：主人开关', cognition: '网站里的链接要写相对路径。' })
    expect(plugin.ownerCommands.map((c) => c.name)).toEqual(['fake on', 'fake off', 'fake sync', 'fake list', 'fake target set'])
    expect(plugin.ownerCommands.find((c) => c.name === 'fake target set')).toMatchObject({ usage: '--where <名字>', summary: '配部署目标：一个假的目标', ownerOnly: true, setup: true })
    expect(plugin.views).toEqual([expect.objectContaining({ id: 'fake.sites', title: '假部署' })])
    expect(plugin.statements).toEqual(['deployable'])
    expect(plugin.cognition?.text).toMatch(/^## 上线到假的地方：主人开关\n\n这个库装了\*\*假部署\*\*插件。/)
    expect(plugin.cognition?.text).toContain('pneuma-base @{{授权的名字}} fake sync')
    expect(plugin.cognition?.text).toContain('\n\n网站里的链接要写相对路径。\n')

    const l = await library(plugin, true)
    expect(await l.cmd('fake list')).toMatchObject({ text: expect.stringContaining('还没配部署目标：fake target set --where <名字>') })
    expect(await l.cmd('fake target set', [], { where: ['x'] })).toMatchObject({ outcome: 'done', text: '部署目标已设为 假的 x。' })
    expect(await l.cmd('fake target set', [], {})).toMatchObject({ outcome: 'refused', reason: 'usage', text: '要写 --where <名字>。' })
  })

  it('tells an agent whose put the target refused that the put is in and going online waits for the owner, as a problem beside the answer', async () => {
    const { fake, adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    await l.cmd('fake on', [P])
    fake.fail = true
    const put = await l.put(P, 'v2')
    expect(put).toMatchObject({ outcome: 'accepted', path: P })
    expect(put.problems).toEqual([{ plugin: 'fake', message: expect.stringContaining('这不是你的放入出了问题，你不用重做；上线要等主人在自己的终端里运行 fake sync') }])
  })

  it('takes down what the archive purge removed, and forgets its declaration', async () => {
    const { fake, adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    await l.cmd('fake on', [P])
    fake.fail = true
    await l.archive(P)
    expect((await l.list())[0]?.status).toBe('retiring')
    fake.fail = false
    expect(await l.cmd('archive purge')).toMatchObject({ outcome: 'done', problems: [] })
    expect(fake.served.size).toBe(0)
    expect(await l.list()).toEqual([])
  })

  it('refuses to be removed while sites are online, saying how many; removed anyway, the answer lists what stays online', async () => {
    const { adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    for (const path of ['a.html', 'b.html', 'c.html']) {
      await l.put(path, path)
      await l.say(path)
    }
    await l.cmd('fake on', ['a.html'])
    await l.cmd('fake on', ['b.html'])
    const refused = await l.cmd('plugin remove', ['fake'])
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'plugin-refused' })
    expect((refused as { text: string }).text).toContain('还有 2 样在线')
    expect((refused as { text: string }).text).toContain('先用 fake off 关上')

    const anyway = await l.cmd('plugin remove', ['fake'], { anyway: true })
    expect(anyway).toMatchObject({ outcome: 'done' })
    expect((anyway as { text: string }).text).toMatch(/它卸下前提醒过：还有 2 样在线：a\.html（https:\/\/.*）、b\.html（https:\/\/.*）/)
  })

  it('is removed without a word when nothing is online', async () => {
    const { adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    expect(await l.cmd('plugin remove', ['fake'])).toMatchObject({ outcome: 'done' })
  })

  it('lists a records line it cannot read in check, and reads the rest', async () => {
    const { adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    appendFileSync(join(l.root, '.pneuma-base/fake/facts/broken.jsonl'), '{"id":"f_9"\n')
    expect(await l.list()).toEqual([expect.objectContaining({ path: P, status: 'offline' })])
    const section = (await l.check()).sections.find((s) => s.title === '部署记录里读不懂的行')
    expect(section?.body).toContain('.pneuma-base/fake/facts/broken.jsonl 第 1 行')
  })

  it('shows a target’s own columns, fields and blocks, and the address as a link that can be copied', async () => {
    const { adapter } = fakeTarget({ view: true })
    const plugin = deployPlugin('fake', adapter, { ui: '/plugins/fake/ui' })
    expect(plugin.ui).toBe('/plugins/fake/ui')
    const l = await library(plugin)
    await l.site('sites/shop', { 'index.html': '<h1>shop</h1>', 'a.css': 'h1{}' })
    await l.say('sites/shop')
    await l.cmd('fake on', ['sites/shop'])
    const view = await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx())
    const blocks = view?.blocks ?? []
    const table = blocks.flatMap((b) => (b.kind === 'section' ? b.blocks : [])).find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table')
    expect(table?.columns.map((c) => c.key)).toEqual(['path', 'state', 'address', 'files'])
    const address = url(siteName('sites/shop' as LibraryPath))
    expect(table?.rows[0]?.cells).toMatchObject({ files: { text: '2' }, address: { text: address, href: address, copy: true } })
    expect(blocks.at(-1)).toMatchObject({ kind: 'custom', entry: 'chart.html', data: { sites: 1 } })
    const setTarget = blocks.find((b): b is Extract<Block, { kind: 'section' }> => b.kind === 'section' && b.title === '目标')?.actions[0]
    expect(setTarget).toMatchObject({ label: '设假的目标', call: { face: 'owner', command: 'fake target set', args: { flags: { kind: ['fake'], where: ['{where}'] } } } })

    const section = await plugin.onItemView?.('sites/shop' as LibraryPath, l.pctx())
    expect(section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields.at(-1)).toEqual({ label: '文件数', value: { text: '2' } })
    expect(section?.blocks.at(-1)).toEqual({ kind: 'text', tone: 'info', text: '假的目标的说明' })
  })
})
