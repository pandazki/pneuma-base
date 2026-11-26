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
import { defineTarget, deployPlugin, siteName, STATUS, switchAction, type ContentId, type Served, type ServingAsk, type SiteName, type Target, type TargetAdapter, type TargetView } from '@pneuma-base/sdk/kit'
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
            page: (all) => [{ kind: 'custom', entry: 'chart.html', height: 120, text: `${all.length} 个站点`, data: { sites: all.length }, actions: {} }],
            item: () => [{ kind: 'text', tone: 'info', text: '假的目标的说明' }],
          },
        }
      : {}),
  })
  const adapter: TargetAdapter = defineTarget({
    kind: 'fake',
    label: '一个假的目标',
    params: [{ name: 'where', hint: '名字', kind: 'value', required: true }],
    async configure({ where }) {
      return { ok: true, config: { where } }
    },
    open(config) {
      if (typeof config.where !== 'string') throw new Error('no where')
      return open(config.where)
    },
  })
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
  /** The owner sets a secret of the plugin on this machine, through the kernel's command. */
  const secret = (name: string, value: string) =>
    ownerFace.dispatch({ ctx: as(owner), table, env: {}, viaGrant: false, confirm: async () => true, readSecret: async () => value }, 'secret set', { positional: [plugin.name, name], flags: {} })
  const lib0 = {
    root,
    as,
    cmd,
    secret,
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
    expect(plugin.ownerCommands.find((c) => c.name === 'fake target set')).toMatchObject({
      params: { flags: [{ name: 'kind', kind: 'value', options: [{ value: 'fake', label: '一个假的目标' }] }, { name: 'where', hint: '名字', kind: 'value', required: true }] },
      summary: '配部署目标：一个假的目标',
      ownerOnly: true,
      setup: true,
    })
    expect(plugin.views).toEqual([expect.objectContaining({ id: 'fake.sites', title: '假部署' })])
    expect(plugin.statements).toEqual(['deployable'])
    expect(plugin.cognition?.text).toMatch(/^## 上线到假的地方：主人开关\n\n这个库装了\*\*假部署\*\*插件。/)
    expect(plugin.cognition?.text).toContain('pneuma-base @{{授权的名字}} fake sync')
    expect(plugin.cognition?.text).toContain('\n\n网站里的链接要写相对路径。\n')

    const l = await library(plugin, true)
    expect(await l.cmd('fake list')).toMatchObject({ text: expect.stringContaining('还没配部署目标：fake target set --where <名字>') })
    expect(await l.cmd('fake target set', [], { where: ['x'] })).toMatchObject({ outcome: 'done', text: '部署目标已设为 假的 x。' })
    expect(await l.cmd('fake target set', [], {})).toMatchObject({ outcome: 'refused', reason: 'usage', text: '要写 --where <名字>。\n用法：fake target set [--kind fake] --where <名字>' })
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
    expect(setTarget).toMatchObject({ label: '设部署目标', inputs: [{ name: 'where', label: '名字' }], call: { face: 'owner', command: 'fake target set', args: { flags: { kind: ['fake'], where: ['{where}'] } } } })

    const section = await plugin.onItemView?.('sites/shop' as LibraryPath, l.pctx())
    expect(section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields.at(-1)).toEqual({ label: '文件数', value: { text: '2' } })
    expect(section?.blocks.at(-1)).toEqual({ kind: 'text', tone: 'info', text: '假的目标的说明' })
  })

  it('declares the secrets its target reads; one not set refuses, naming the command that sets it, and one set reaches the target', async () => {
    const tokens: string[] = []
    const adapter = defineTarget({
      kind: 'vault',
      label: '一个要令牌的目标',
      params: [],
      secrets: [{ name: 'token', description: '目标的令牌' }],
      configure: async () => ({ ok: true, config: {} }),
      open: (_config, env) => ({
        key: 'vault',
        label: '要令牌的目标',
        async publish(site) {
          tokens.push(await env.secret('token'))
          return { url: url(site) }
        },
        async remove() {
          await env.secret('token')
        },
      }),
    })
    const plugin = deployPlugin('vault', adapter)
    expect(plugin.secrets).toEqual([{ name: 'token', description: '目标的令牌' }])
    expect(plugin.ownerCommands.find((c) => c.name === 'vault target set')?.params.flags?.map((f) => f.name)).toEqual(['kind'])
    const l = await library(plugin, true)
    expect(await l.cmd('vault target set')).toMatchObject({ outcome: 'done', text: expect.stringContaining('还没设：pneuma-base secret set vault token') })
    await l.put(P, 'v1')
    await l.say(P)
    const on = await l.cmd('vault on', [P])
    expect(on).toMatchObject({ outcome: 'refused', reason: 'publish-failed', text: expect.stringContaining('还没设密钥 token：用 pneuma-base secret set vault token 设') })
    expect(tokens).toEqual([])
    expect(await l.secret('token', 'tok-1')).toMatchObject({ outcome: 'done' })
    expect(await l.cmd('vault sync')).toMatchObject({ outcome: 'done' })
    expect(tokens).toEqual(['tok-1'])
    expect(await l.list()).toMatchObject([{ path: P, status: 'online' }])
  })
})

// ---- what a target shows ----

/** What the target tells of a site beside content and address, for its views. */
type Note = { note: string }

/**
 * A target that reports what it serves and tells a note of every site it knows: one it serves, and one
 * taken down whose name it keeps (as a service keeps a removed app's releases). `asks`: each call to
 * `serving`. `view` adds to its views; `reports: false` drops `serving`.
 */
function notingTarget(opts: { view?: (env: { plugin: string }) => TargetView<Note>; views?: TargetAdapter['views']; reports?: boolean } = {}) {
  const served = new Map<string, ContentId>()
  const kept = new Set<string>()
  const asks: { sites: string[]; detail: boolean }[] = []
  const adapter = defineTarget({
    kind: 'noting',
    label: '一个会说明的目标',
    params: [{ name: 'where', hint: '名字', kind: 'value', required: true }],
    ...(opts.views ? { views: opts.views } : {}),
    configure: async ({ where }) => ({ ok: true, config: { where } }),
    open(_config, env): Target<Note> {
      return {
        key: 'noting',
        label: '会说明的目标',
        async publish(site, _dir, meta) {
          served.set(site, meta.content)
          kept.delete(site)
          return { url: url(site) }
        },
        async remove(site) {
          if (served.delete(site)) kept.add(site)
        },
        ...(opts.reports === false
          ? {}
          : {
              async serving(sites: readonly SiteName[], ask: ServingAsk) {
                asks.push({ sites: [...sites], detail: ask.detail })
                return new Map(
                  sites.flatMap((s): [SiteName, Served<Note>][] => {
                    const content = served.get(s)
                    if (content !== undefined) return [[s, { content, url: url(s), detail: { note: `在服务 ${s}` } }]]
                    return kept.has(s) ? [[s, { content: null, url: null, detail: { note: `撤下了 ${s}` } }]] : []
                  }),
                )
              },
            }),
        view: {
          columns: [{ key: 'note', label: '说明' }],
          cells: (l) => ({ note: { text: l.detail?.note ?? '—' } }),
          fields: (l) => [{ label: '说明', value: { text: l.detail?.note ?? '—' } }],
          ...opts.view?.(env),
        },
      }
    },
  })
  return { adapter, asks, served }
}

const tableOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === 'section' ? b.blocks : [])).find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table')

describe('what a target shows', () => {
  const R = 'c/r.html' as LibraryPath

  it('hands every view the detail its serving told, an archived thing’s too, asking once for a page and for details only when drawn', async () => {
    const { adapter, asks } = notingTarget()
    const plugin = deployPlugin('fake', adapter)
    const l = await library(plugin)
    for (const path of [P, R]) {
      await l.put(path, path)
      await l.say(path)
      await l.cmd('fake on', [path])
    }
    await l.archive(R)
    const [a, r] = [siteName(P), siteName(R)]

    asks.length = 0
    const page = await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx())
    expect(asks).toEqual([{ sites: expect.arrayContaining([a, r]), detail: true }])
    const notes = Object.fromEntries(tableOf(page?.blocks ?? [])?.rows.map((row) => [row.cells.path?.text, row.cells.note?.text]) ?? [])
    expect(notes).toEqual({ [P]: `在服务 ${a}`, [`_archive/${R}`]: `撤下了 ${r}` })

    const section = await plugin.onItemView?.(`_archive/${R}` as LibraryPath, l.pctx())
    const fields = section?.blocks.find((b): b is Extract<Block, { kind: 'fields' }> => b.kind === 'fields')?.fields ?? []
    expect(fields.find((f) => f.label === '说明')?.value.text).toBe(`撤下了 ${r}`)

    asks.length = 0
    await l.list()
    await l.put(P, 'v2')
    expect(asks.length).toBeGreaterThan(0)
    expect(asks.every((ask) => !ask.detail)).toBe(true)
  })

  it('adds pages of its own to the navigation, drawn from the same looks with the kit’s states and switch, and blocks before the kit’s sections', async () => {
    const { adapter } = notingTarget({
      views: [{ name: 'board', title: '看板', icon: 'layout-grid' }],
      view: (env) => ({
        before: () => [{ kind: 'text', tone: 'info', text: '在最前面' }],
        pages: {
          board: (all) => [
            {
              kind: 'custom',
              entry: 'board.html',
              height: 100,
              text: all.map((l) => `${l.thing.path}：${STATUS[l.status].text}`).join('\n'),
              data: all.map((l) => ({ path: l.thing.path, state: STATUS[l.status], note: l.detail?.note ?? null })),
              actions: Object.fromEntries(
                all.flatMap((l) => {
                  const a = switchAction(env.plugin, l)
                  return a === null ? [] : [[l.thing.id, a]]
                }),
              ),
            },
          ],
        },
      }),
    })
    const plugin = deployPlugin('fake', adapter, { ui: '/plugins/fake/ui' })
    expect(plugin.views).toEqual([expect.objectContaining({ id: 'fake.sites', nav: true }), { id: 'fake.board', title: '看板', icon: 'layout-grid', nav: true, filters: [] }])

    const l = await library(plugin, true)
    const unset = await plugin.onView?.({ view: 'fake.board', params: {} }, l.pctx())
    expect(unset?.blocks).toEqual([{ kind: 'text', tone: 'warn', text: expect.stringContaining('还没配部署目标') }])

    expect(await l.cmd('fake target set', [], { where: ['w'] })).toMatchObject({ outcome: 'done' })
    for (const path of [P, Q]) {
      await l.put(path, path)
      await l.say(path)
    }
    await l.cmd('fake on', [P])
    const board = await plugin.onView?.({ view: 'fake.board', params: {} }, l.pctx())
    expect(board).toMatchObject({ title: '看板', subtitle: '1 样在线，共 2 样' })
    const custom = board?.blocks[0]
    expect(custom?.kind).toBe('custom')
    if (custom?.kind !== 'custom') return
    expect(custom.data).toEqual([
      { path: P, state: { text: '在线', tone: 'good' }, note: `在服务 ${siteName(P)}` },
      { path: Q, state: { text: '离线', tone: 'neutral' }, note: null },
    ])

    const page = await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx())
    expect(page?.blocks[0]).toEqual({ kind: 'text', tone: 'info', text: '在最前面' })
    const rows = tableOf(page?.blocks ?? [])?.rows ?? []
    expect(Object.values(custom.actions)).toEqual(rows.map((row) => row.actions[0]))
    expect(rows.map((row) => row.cells.state?.tag)).toEqual([STATUS.online, STATUS.offline])
  })

  it('makes its pages ask again every 30 seconds when it reports what it serves, or as often as it says', async () => {
    const pages = [{ name: 'board', title: '看板', icon: 'layout-grid' as const }]
    const cases: [reports: boolean, refresh: number | null | undefined, expected: number | undefined][] = [
      [true, undefined, 30],
      [true, 10, 10],
      [true, null, undefined],
      [false, undefined, undefined],
    ]
    for (const [reports, refresh, expected] of cases) {
      const { adapter } = notingTarget({ reports, views: pages, view: () => ({ pages: { board: () => [] }, ...(refresh === undefined ? {} : { refresh }) }) })
      const plugin = deployPlugin('fake', adapter)
      const l = await library(plugin)
      for (const view of ['fake.sites', 'fake.board']) expect((await plugin.onView?.({ view, params: {} }, l.pctx()))?.refresh, `${view} ${reports} ${refresh}`).toBe(expected)
    }
  })

  it('declares an optional secret as optional: target set mentions it without asking, and the target reads null until it is set', async () => {
    const tokens: (string | null)[] = []
    const adapter = defineTarget({
      kind: 'open',
      label: '令牌可有可无的目标',
      params: [],
      secrets: [{ name: 'token', description: '服务要求登录时的令牌', optional: true }],
      configure: async () => ({ ok: true, config: {} }),
      open: (_config, env) => ({
        key: 'open',
        label: '令牌可有可无的目标',
        async publish(site) {
          tokens.push(await env.secret('token'))
          return { url: url(site) }
        },
        async remove() {},
      }),
    })
    const plugin = deployPlugin('open', adapter)
    expect(plugin.secrets).toEqual([{ name: 'token', description: '服务要求登录时的令牌', optional: true }])
    const l = await library(plugin, true)
    const set = await l.cmd('open target set')
    expect(set).toMatchObject({ outcome: 'done', text: '部署目标已设为 令牌可有可无的目标。可选的密钥 token 没设（服务要求登录时的令牌）；要用时：pneuma-base secret set open token。' })
    await l.put(P, 'v1')
    await l.say(P)
    expect(await l.cmd('open on', [P])).toMatchObject({ outcome: 'done' })
    expect(await l.secret('token', 'tok-1')).toMatchObject({ outcome: 'done' })
    await l.put(P, 'v2')
    expect(tokens).toEqual([null, 'tok-1'])
  })

  it('lets configure say where the credentials come from, in place of the reminder of unset secrets', async () => {
    const adapter = defineTarget({
      kind: 'keyed',
      label: '要钥匙的目标',
      params: [],
      secrets: [{ name: 'key', description: '账户的钥匙', optional: true }],
      configure: async () => ({ ok: true, config: {}, note: '钥匙从凭据文件读。' }),
      open: () => ({ key: 'keyed', label: '要钥匙的目标', publish: async (site) => ({ url: url(site) }), remove: async () => {} }),
    })
    const l = await library(deployPlugin('keyed', adapter), true)
    expect(await l.cmd('keyed target set')).toMatchObject({ outcome: 'done', text: '部署目标已设为 要钥匙的目标。钥匙从凭据文件读。' })
  })
})

describe('a target opened for a run', () => {
  /** A target that counts how often it is opened and closed; `fail`: publishing throws; `badClose`: closing throws. */
  function countingTarget() {
    const n = { opened: 0, closed: 0, fail: false, badClose: false }
    const adapter = defineTarget({
      kind: 'counted',
      label: '数开关的目标',
      params: [],
      configure: async () => ({ ok: true, config: {} }),
      open: () => {
        n.opened++
        return {
          key: 'counted',
          label: '数开关的目标',
          async publish(site) {
            if (n.fail) throw new Error('目标坏了')
            return { url: url(site) }
          },
          async remove() {},
          async close() {
            n.closed++
            if (n.badClose) throw new Error('退出登录失败')
          },
        }
      },
    })
    return { n, adapter }
  }

  it('is closed once when its hook, command or view ends, also when publishing failed or closing throws', async () => {
    const { n, adapter } = countingTarget()
    const plugin = deployPlugin('counted', adapter)
    const l = await library(plugin, true)
    const balanced = (step: string) => expect([n.opened, n.closed], step).toEqual([n.opened, n.opened])
    expect(await l.cmd('counted target set')).toMatchObject({ outcome: 'done' })
    balanced('target set')
    await l.put(P, 'v1')
    await l.say(P)
    balanced('put, say')
    expect(await l.cmd('counted on', [P])).toMatchObject({ outcome: 'done' })
    balanced('on')
    n.fail = true
    expect(await l.put(P, 'v2')).toMatchObject({ outcome: 'accepted' })
    balanced('a put whose publish failed')
    n.fail = false
    n.badClose = true
    expect(await l.cmd('counted sync')).toMatchObject({ outcome: 'done' })
    balanced('a sync whose close threw')
    await plugin.onView?.({ view: 'counted.sites', params: {} }, l.pctx())
    await plugin.onItemView?.(P, l.pctx())
    balanced('the page and the item panel')
    expect(n.opened).toBeGreaterThan(5)
  })
})
