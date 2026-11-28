// The deploy kit through the real kernel, with a fake target kept in memory: a cell of the README's
// state × operation table for each operation (the sdk's kit-model test walks every cell), a target
// that reports what it serves (a site removed behind the plugin's back, a publish that crashed
// halfway, a target that cannot be read), a target's own content id and site names, its additions to
// the page, and removing the plugin while sites are online.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentFace,
  initLibrary,
  makeContext,
  openLibrary,
  ownerFace,
  pluginContext,
  type Action,
  type Actor,
  type Block,
  type Instant,
  type LibraryPath,
  type OwnerResult,
  type Plugin,
  type Session,
} from '@pneuma-base/kernel'
import { defineTarget, deployPlugin, siteName, STATUS, switchAction, type ContentId, type Served, type ServingAsk, type SiteName, type Target, type TargetAdapter, type TargetConfig, type TargetView } from '@pneuma-base/sdk/kit'
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
            mark: (l) => (fake.served.get(l.site ?? '')?.files.length === 1 ? { text: '只有一个文件', tone: 'warn', tip: '假的目标的说明' } : null),
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
  /** An owner command; `typed`: what it reads hidden, as a terminal or the page gives it. */
  const cmd = async (name: string, positional: string[] = [], flags: Record<string, string[] | true> = {}, typed: string | null = null): Promise<OwnerResult> => {
    const r = await ownerFace.dispatch({ ctx: as(owner), table, env: {}, viaGrant: false, confirm: async () => true, readSecret: async () => typed }, `${name}`, { positional, flags })
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
    return agentFace.put({ kind: 'register', path, origin: { kind: 'generated', from: [], outside: [] } }, as(actor))
  }
  const site = async (path: string, files: Record<string, string>) => {
    const src = join(dir, 'src', path)
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(src, p)), { recursive: true })
      writeFileSync(join(src, p), c)
    }
    return agentFace.put({ kind: 'place', from: { kind: 'directory', path: src }, to: path, origin: { kind: 'generated', from: [], outside: [] } }, as(claude))
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
    /** The fingerprint storage gives of the content at a path. */
    fingerprint: async (path: string) => {
      const answer = await pluginContext(as(owner), plugin.name).tools.storage.content(path)
      return 'fingerprint' in answer ? answer.fingerprint : null
    },
    pctx: () => pluginContext(as(owner), plugin.name),
  }
  if (!noTarget) expect(await cmd(`${plugin.name} target set`, [], { where: ['w'] })).toMatchObject({ outcome: 'done' })
  return lib0
}

// ---- the README's table: each operation reaches the model ----

const P = 'c/a.html' as LibraryPath
const Q = 'c/b.html' as LibraryPath
type Lib = Awaited<ReturnType<typeof library>>
type Fake = ReturnType<typeof fakeTarget>['fake']

/** Each starting state of the table, reached through the plugin's own operations. */
const STATES: Record<string, (l: Lib, f: Fake) => Promise<unknown>> = {
  离线: async () => {},
  在线: (l) => l.cmd('fake on', [P]),
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

// One cell per operation, and one whose starting state only a failing target leaves behind; every
// cell is in test/kit-model.test.ts in the sdk.
const CELLS: Cell[] = [
  ['离线', '开', 'online', 'pending'],
  ['在线', '关', 'offline', 'retiring'],
  ['在线', '内容变了', 'online', 'pending'],
  ['在线', '归档', 'archived', 'retiring'],
  ['已归档（开关开）', '取回', 'online', 'pending'],
  ['在线', '挪', 'online', 'pending'],
  ['待下线（开关关）', '开', 'online', 'pending'],
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

describe('the state × operation table, one cell per operation, through the plugin', () => {
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

// ---- what it copies and what it follows ----

describe('what the kit reads of the library', () => {
  it('publishes a bundle as its content rule counts it, without the marker, what its .gitignore files leave out, or a link, whether or not the target identifies content', async () => {
    for (const identify of [false, true]) {
      const { fake, adapter } = fakeTarget({ identify })
      const l = await library(deployPlugin('fake', adapter))
      await l.site('sites/shop', { 'index.html': '<h1>shop</h1>', '.gitignore': '*.env\nbuild/\n', 'keep/.gitignore': '!local.env\n' })
      // Written in place after it was copied in, as an agent's build would: not its content by the rule.
      l.write('sites/shop/secret.env', 'TOKEN=1')
      l.write('sites/shop/build/out.js', 'built')
      l.write('sites/shop/keep/local.env', 'kept')
      symlinkSync('index.html', join(l.root, 'sites/shop/home.html'))
      await l.say('sites/shop')
      expect(await l.cmd('fake on', ['sites/shop'])).toMatchObject({ outcome: 'done' })
      const held = fake.served.get(siteName('sites/shop' as LibraryPath))
      expect(held?.files, `identify: ${identify}`).toEqual(['.gitignore', 'index.html', 'keep/.gitignore', 'keep/local.env'])
      if (!identify) expect(held?.content).toBe(await l.fingerprint('sites/shop'))
      expect(await l.list()).toEqual([expect.objectContaining({ status: 'online' })])
    }
  })

  it('refuses to publish a bundle with more files than one thing takes, saying so, and takes nothing down, whether or not the target identifies content', async () => {
    for (const identify of [false, true]) {
      const { fake, adapter } = fakeTarget({ identify })
      const l = await library(deployPlugin('fake', adapter))
      await l.site('sites/big', { 'index.html': 'v1' })
      await l.say('sites/big')
      expect(await l.cmd('fake on', ['sites/big'])).toMatchObject({ outcome: 'done' })
      for (let i = 0; i < 5000; i++) l.write(`sites/big/pages/${i}.html`, String(i))
      fake.calls.length = 0
      const synced = await l.cmd('fake sync')
      expect(synced, `identify: ${identify}`).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
      expect(synced.text).toContain('sites/big 至少有 5001 个文件，超过一样东西能有的 5000 个，没有发布')
      expect(fake.calls).toEqual([])
      expect(await l.list()).toEqual([expect.objectContaining({ path: 'sites/big', status: 'pending' })])
    }
  })

  it('follows each declared file among the loose files of an open directory registered as one act', async () => {
    const { fake, adapter } = fakeTarget()
    // The plugin's records make `c` open, as a ledger's would: registering it registers the loose files of its level.
    const l = await library({ ...deployPlugin('fake', adapter), openDirs: async () => ['c' as LibraryPath] })
    for (const path of [P, Q]) {
      await l.put(path, 'v1')
      await l.say(path)
      await l.cmd('fake on', [path])
      l.write(path, 'v2')
    }
    l.write('c/loose.md', 'new')
    const put = await agentFace.put({ kind: 'register', path: 'c', origin: { kind: 'generated', from: [], outside: [] } }, l.as(claude))
    expect(put).toMatchObject({ outcome: 'accepted', notes: [{ plugin: 'fake', text: `${P} 在线，已重新发布：${url(siteName(P))}；${Q} 在线，已重新发布：${url(siteName(Q))}` }] })
    for (const path of [P, Q]) expect(fake.served.get(siteName(path))?.content).toBe(await l.fingerprint(path))
  })
})

// ---- the plugin it makes ----

describe('the plugin the kit makes', () => {
  it('names its commands, its page and its cognition after itself, and with one kind of target needs no --kind', async () => {
    const { adapter } = fakeTarget()
    const plugin = deployPlugin('fake', adapter, { title: '假部署', heading: '上线到假的地方：主人开关', cognition: '网站里的链接要写相对路径。' })
    expect(plugin.ownerCommands.map((c) => c.name)).toEqual(['fake on', 'fake off', 'fake sync', 'fake list', 'fake target set', 'fake target list', 'fake target remove'])
    expect(plugin.ownerCommands.find((c) => c.name === 'fake target set')).toMatchObject({
      params: { flags: [{ name: 'kind', kind: 'value', options: [{ value: 'fake', label: '一个假的目标' }] }, { name: 'where', hint: '名字', kind: 'value', required: true }] },
      summary: '连上部署目标：一个假的目标',
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
    expect(await l.cmd('fake target set', [], { where: ['x'] })).toMatchObject({ outcome: 'done', text: '已连上 假的 x。' })
    expect(await l.cmd('fake target set', [], {})).toMatchObject({ outcome: 'refused', reason: 'usage', text: '要写 --where <名字>。\n用法：fake target set [--kind fake] --where <名字>' })
  })

  it('asks the owner about each declared thing whose switch was never set, 上线 suggested; either answer settles it, and an archived thing is not asked about', async () => {
    const { adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.put(Q, 'v1')
    await l.say(P)
    await l.say(Q)
    expect(await l.say('c/nope.html')).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
    const asks = async () => (await l.check()).asks
    expect(await asks()).toEqual([
      {
        key: expect.stringMatching(/^fake:/),
        by: 'fake',
        text: `claude-code 说 ${P} 可以部署，还没上线。要上线吗？`,
        about: P,
        actions: [
          expect.objectContaining({ label: '上线', call: { face: 'owner', command: 'fake on', args: { positional: [P], flags: {} } } }),
          expect.objectContaining({ label: '不上线', call: { face: 'owner', command: 'fake off', args: { positional: [P], flags: {} } } }),
        ],
        suggested: 0,
      },
      expect.objectContaining({ about: Q }),
    ])
    // Keeping it off is an answer too, though the switch was off already.
    await l.cmd('fake off', [P])
    expect((await asks()).map((a) => a.about)).toEqual([Q])
    await l.archive(Q)
    expect(await asks()).toEqual([])
    await l.archive(`_archive/${Q}`, 'unarchive')
    await l.cmd('fake on', [Q])
    expect(await asks()).toEqual([])
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

  it('refuses to be removed while sites are online, saying how many; removed anyway, the answer lists what stays online; with nothing online, removed without a word', async () => {
    const { adapter } = fakeTarget()
    const quiet = await library(deployPlugin('fake', adapter))
    await quiet.put(P, 'v1')
    await quiet.say(P)
    expect(await quiet.cmd('plugin remove', ['fake'])).toMatchObject({ outcome: 'done' })

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

  it('lists the facts it cannot read in check, one an earlier version wrote and one in its record place, and reads the rest', async () => {
    const { adapter } = fakeTarget()
    const l = await library(deployPlugin('fake', adapter))
    await l.put(P, 'v1')
    await l.say(P)
    // A line that is not JSON is no fact: storage leaves it out.
    appendFileSync(join(l.root, '.pneuma-base/fake/facts/broken.jsonl'), '{"half\n{"id":"f_9","kind":"switch"}\n')
    const [order] = await l.pctx().tools.storage.records.append([{ store: 'facts', id: 'f_10', kind: 'switch' }])
    expect(await l.list()).toEqual([expect.objectContaining({ path: P, status: 'offline' })])
    const section = (await l.check()).sections.find((s) => s.title === '部署记录里读不懂的行')
    expect(section?.body.split('\n')).toEqual([expect.stringMatching(/^fake 的记录 \S*broken\.jsonl#2：缺 id、at、actor 或 session$/), `fake 的记录 ${order}：缺 id、at、actor 或 session`])
  })

  it('once connected: the destination row, each thing a row with its folder, mark, address and switch, the target’s own mark, fields and blocks', async () => {
    const { adapter } = fakeTarget({ view: true })
    const plugin = deployPlugin('fake', adapter, { ui: '/plugins/fake/ui' })
    expect(plugin.ui).toBe('/plugins/fake/ui')
    const l = await library(plugin)
    await l.site('sites/shop', { 'index.html': '<h1>shop</h1>', 'a.css': 'h1{}' })
    await l.site('sites/one', { 'index.html': '<h1>one</h1>' })
    await l.put('top.html', 'top')
    for (const path of ['sites/shop', 'sites/one', 'top.html']) await l.say(path)
    await l.cmd('fake on', ['sites/shop'])
    await l.cmd('fake on', ['sites/one'])
    const page = await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx())
    expect(page?.subtitle).toBe('2 样在线')
    const [head, where, things, own] = page?.blocks ?? []
    expect(head).toMatchObject({ kind: 'actions', head: true, actions: [{ label: '上线一样东西', icon: 'plus', as: 'primary', call: { command: 'fake on' } }] })
    expect(where).toMatchObject({ kind: 'list', items: [{ cell: { text: '假的 w' }, actions: [{ label: '换一个…', as: 'menu' }, { label: '断开', as: 'menu', confirm: '断开 假的 w？线上的东西不撤下，开关都留着。' }] }] })
    const shop = url(siteName('sites/shop' as LibraryPath))
    const items = things?.kind === 'list' ? things.items : []
    expect(items.map((i) => [i.cell.text, i.note, i.cell.tag?.text ?? null, i.aside ?? null, i.toggle?.on, i.toggle?.action.label])).toEqual([
      ['one', 'sites', '只有一个文件', expect.objectContaining({ text: url(siteName('sites/one' as LibraryPath)) }), true, '下线'],
      ['shop', 'sites', null, { text: shop, mono: true, href: shop, copy: true }, true, '下线'],
      ['top.html', null, null, null, false, '上线'],
    ])
    expect(items[0]?.cell.tag?.tip).toBe('假的目标的说明')
    expect(items[1]?.cell.link).toEqual({ view: 'item', params: { path: 'sites/shop' }, target: 'panel' })
    expect(own).toMatchObject({ kind: 'custom', entry: 'chart.html', data: { sites: 3 } })

    // The panel: the address on one line, then the target's fields and blocks.
    const section = await plugin.onItemView?.('sites/shop' as LibraryPath, l.pctx())
    expect(section?.blocks).toEqual([
      { kind: 'fields', line: true, fields: [{ label: '地址', value: { text: shop, mono: true, href: shop, copy: true } }] },
      { kind: 'fields', fields: [{ label: '文件数', value: { text: '2' } }] },
      { kind: 'text', tone: 'info', text: '假的目标的说明' },
    ])
  })

  it('marks a thing not as it should be with why, offers 重试 only while something waits, and says so when nothing is declared', async () => {
    const { fake, adapter } = fakeTarget()
    const plugin = deployPlugin('fake', adapter)
    const l = await library(plugin)
    const page = async () => (await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx()))?.blocks ?? []
    expect((await page()).at(-1)).toEqual({ kind: 'empty', title: '还没有上线的东西', hint: null })
    await l.put(P, 'v1')
    await l.say(P)
    await l.cmd('fake on', [P])
    fake.fail = true
    await l.put(P, 'v2')
    const [head, , things] = await page()
    expect(head?.kind === 'actions' && head.actions.map((a) => [a.label, a.as])).toEqual([
      ['上线一样东西', 'primary'],
      ['重试', 'icon'],
    ])
    expect(things?.kind === 'list' && things.items[0]?.cell.tag).toEqual({ text: '待发布', tone: 'warn', tip: '开关开着，线上不是当前的内容' })
    // The panel says the mark, its reason and the address in one line.
    const panel = await plugin.onItemView?.(P, l.pctx())
    expect(panel?.blocks[0]).toEqual({
      kind: 'fields',
      line: true,
      fields: [
        { label: '状态', value: { text: '', tag: { text: '待发布', tone: 'warn' } } },
        { label: '为什么', value: { text: '开关开着，线上不是当前的内容' } },
        { label: '地址', value: expect.objectContaining({ text: url(siteName(P)) }) },
      ],
    })
    fake.fail = false
    await l.cmd('fake sync')
    const [settled] = await page()
    expect(settled?.kind === 'actions' && settled.actions.map((a) => a.label)).toEqual(['上线一样东西'])
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
    expect(plugin.ownerCommands.find((c) => c.name === 'vault target set')?.params).toEqual({ flags: [expect.objectContaining({ name: 'kind' })] })
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

// ---- connecting a destination ----

/**
 * Three kinds as a page meets them: alpha and beta share the group 假的地方; alpha finds two destinations
 * on this machine, asks for a key typed hidden, takes a prefix that can be changed once connected, and
 * has a paragraph for agents; gamma stands alone and is a folder of this machine.
 */
function threeKinds() {
  const typed: (string | null)[] = []
  const open = (config: TargetConfig): Target => ({
    key: `k:${String(config.where)}`,
    label: String(config.where),
    ...(config.local === true ? { local: true as const } : {}),
    ...(typeof config.prefix === 'string' ? { settings: [{ flag: 'prefix', hint: '前缀', value: config.prefix }] } : {}),
    publish: async (site) => ({ url: url(site) }),
    remove: async () => {},
  })
  const alpha = defineTarget({
    kind: 'alpha',
    label: '甲种',
    icon: 'cloud',
    group: { name: '假的地方', choice: '甲' },
    form: ['at'],
    params: [
      { name: 'host', hint: '主机', kind: 'value' },
      { name: 'at', hint: '地址', kind: 'value' },
      { name: 'prefix', hint: '前缀', kind: 'value' },
    ],
    secrets: [{ name: 'key', description: '甲的钥匙', optional: true }],
    asked: { name: 'key', hint: '钥匙' },
    cognition: '甲要网站顶上有 index.html。',
    found: async () => [
      { label: 'one.example.com', values: { host: 'one.example.com' } },
      { label: 'two.example.com', values: { host: 'two.example.com' } },
    ],
    async configure({ host, at, prefix }, ctx, read) {
      if (host !== null) return { ok: true, config: { where: host, prefix: prefix ?? 'lib' } }
      const key = await read()
      typed.push(key)
      return (key ?? (await ctx.secrets.get('key'))) === KEY ? { ok: true, config: { where: at, prefix: prefix ?? 'lib' } } : { ok: false, reason: 'refused', text: '钥匙不对' }
    },
    open,
  })
  const beta = defineTarget({
    kind: 'beta',
    label: '乙种',
    icon: 'server',
    group: { name: '假的地方', choice: '乙' },
    params: [{ name: 'admin', hint: '地址', kind: 'value', required: true }],
    configure: async ({ admin }) => ({ ok: true, config: { where: admin } }),
    open,
  })
  const gamma = defineTarget({
    kind: 'gamma',
    label: '丙种',
    icon: 'folder',
    params: [{ name: 'to', hint: '目录', kind: 'value', required: true }],
    configure: async ({ to }) => ({ ok: true, config: { where: to, local: true } }),
    open,
  })
  return { plugin: deployPlugin('fake', [alpha, beta, gamma]), typed }
}

const KEY = 'k-typed-3f9a51'

/** Presses a button of a page in this process, as the page sends it: each `{input}` filled from `values`, the secret as what is read hidden. */
async function press(l: Lib, action: Action | undefined, values: Record<string, string> = {}): Promise<OwnerResult> {
  if (action?.call.face !== 'owner') throw new Error(`not an owner command: ${JSON.stringify(action)}`)
  const fill = (w: string) => w.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? action.inputs.find((i) => i.name === name)?.value ?? '')
  const flags: Record<string, string[] | true> = Object.fromEntries(Object.entries(action.call.args.flags).map(([k, v]) => [k, v === true ? (true as const) : v.map(fill)]))
  const stdin = action.call.stdin === undefined ? null : fill(action.call.stdin)
  return l.cmd(action.call.command, action.call.args.positional.map(fill), flags, stdin)
}

const listsOf = (blocks: readonly Block[]): Extract<Block, { kind: 'list' }>[] =>
  blocks.flatMap((b) => (b.kind === 'list' ? [b] : b.kind === 'section' ? listsOf(b.blocks) : []))

describe('connecting a destination', () => {
  it('with nothing connected, the page is where to publish: each destination found, one row per group, the other kinds in the menu; a found one connects in one press', async () => {
    const { plugin } = threeKinds()
    const l = await library(plugin, true)
    const page = async () => (await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx()))?.blocks ?? []
    const [where, ...rest] = await page()
    expect(rest).toEqual([])
    expect(where).toMatchObject({ kind: 'section', title: '发到哪里', note: null, count: null, actions: [{ label: '丙种…', as: 'menu' }] })
    const items = listsOf([where as Block])[0]?.items ?? []
    expect(items.map((i) => [i.cell.text, i.cell.icon ?? null, i.actions.map((a) => [a.label, a.as ?? null])])).toEqual([
      ['one.example.com', 'cloud', [['连上', 'primary']]],
      ['two.example.com', 'cloud', [['连上', 'primary']]],
      ['别的 假的地方', 'cloud', [['连上…', null]]],
    ])
    // The group's dialog: the kind by its choice, then the fields of the kind chosen, the key last, sent as what is read hidden.
    const other = items[2]?.actions[0]
    expect(other?.inputs.map((i) => [i.name, i.options?.map((o) => o.label) ?? null, i.when ?? null, i.secret ?? null])).toEqual([
      ['kind', ['甲', '乙'], null, null],
      ['at', null, [{ input: 'kind', is: ['alpha'] }], null],
      ['admin', null, [{ input: 'kind', is: ['beta'] }], null],
      ['key', null, [{ input: 'kind', is: ['alpha'] }], true],
    ])
    expect(other?.call).toMatchObject({ args: { flags: { kind: ['{kind}'], at: ['{at}'], admin: ['{admin}'] } }, stdin: '{key}' })

    expect(await press(l, items[0]?.actions[0])).toMatchObject({ outcome: 'done', text: '已连上 one.example.com。' })
    const [head, row, empty] = await page()
    expect(head).toMatchObject({ kind: 'actions', head: true })
    expect(row).toMatchObject({ kind: 'list', items: [{ cell: { text: 'one.example.com', icon: 'cloud' }, actions: [{ label: '换一个…' }, { label: '前缀…' }, { label: '断开' }] }] })
    expect(empty).toMatchObject({ kind: 'empty' })
    // Changing kind: all of them by their labels, the one connected chosen; a found one or 别的 and its fields.
    const change = listsOf([row as Block])[0]?.items[0]?.actions[0]
    expect(change?.inputs.map((i) => [i.name, i.value, i.options?.map((o) => o.label) ?? null, i.when ?? null])).toEqual([
      ['kind', 'alpha', ['甲种', '乙种', '丙种'], null],
      ['host', 'one.example.com', ['one.example.com', 'two.example.com', '别的'], [{ input: 'kind', is: ['alpha'] }]],
      ['at', null, null, [{ input: 'kind', is: ['alpha'] }, { input: 'host', is: [''] }]],
      ['admin', null, null, [{ input: 'kind', is: ['beta'] }]],
      ['to', null, null, [{ input: 'kind', is: ['gamma'] }]],
      ['key', null, null, [{ input: 'kind', is: ['alpha'] }, { input: 'host', is: [''] }]],
    ])
    expect(await press(l, change, { kind: 'gamma', host: '', to: '/srv/www' })).toMatchObject({ outcome: 'done', text: '已连上 /srv/www。' })
    expect(listsOf(await page())[0]?.items[0]?.cell).toEqual({ text: '/srv/www', icon: 'folder', local: true })
    // The connected kind's paragraph is the plugin's to add while it is connected.
    expect(await plugin.onDescribe?.(l.pctx())).toBeNull()
    await press(l, items[1]?.actions[0])
    expect(await plugin.onDescribe?.(l.pctx())).toBe('甲要网站顶上有 index.html。')
  })

  it('keeps the flags it was given and never the typed key; a setting changes from the row’s menu; a destination that refuses keeps nothing', async () => {
    const { plugin, typed } = threeKinds()
    const l = await library(plugin, true)
    const configFile = () => readFileSync(join(l.root, '.pneuma-base/fake/config.json'), 'utf8')
    const wrong = await l.cmd('fake target set', [], { kind: ['alpha'], at: ['far.example.com'] }, 'not-the-key')
    expect(wrong).toMatchObject({ outcome: 'refused', reason: 'refused', text: '钥匙不对' })
    expect(await l.pctx().secrets.get('key')).toBeNull()
    expect(() => configFile()).toThrow()

    expect(await l.cmd('fake target set', [], { kind: ['alpha'], at: ['far.example.com'] }, `${KEY}\n`)).toMatchObject({ outcome: 'done', text: '已连上 far.example.com。' })
    expect(typed).toEqual(['not-the-key', KEY])
    expect(await l.pctx().secrets.get('key')).toBe(KEY)
    expect(JSON.parse(configFile())).toEqual({ format: 1, target: { kind: 'alpha', where: 'far.example.com', prefix: 'lib' }, given: { at: 'far.example.com' } })

    const row = listsOf((await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx()))?.blocks ?? [])[0]?.items[0]
    const prefix = row?.actions.find((a) => a.label === '前缀…')
    expect(prefix).toMatchObject({ inputs: [{ name: 'prefix', label: '前缀', value: 'lib' }], call: { args: { flags: { kind: ['alpha'], at: ['far.example.com'], prefix: ['{prefix}'] } } } })
    expect(prefix?.call.face === 'owner' && prefix.call.stdin).toBeUndefined()
    // Nothing typed this time: the kind reads null, and the key it keeps is what it uses.
    expect(await press(l, prefix, { prefix: 'mine' })).toMatchObject({ outcome: 'done' })
    expect(typed.at(-1)).toBeNull()
    expect(JSON.parse(configFile()).given).toEqual({ at: 'far.example.com', prefix: 'mine' })
    expect(configFile()).not.toContain(KEY)
  })

  it('target list says what is connected and what this machine has, each with its command; target remove forgets the destination and takes nothing down', async () => {
    const { plugin } = threeKinds()
    const l = await library(plugin, true)
    expect(await l.cmd('fake target list')).toMatchObject({
      outcome: 'done',
      text: '还没有部署目标。\n这台机器上有 one.example.com：fake target set --kind alpha --host one.example.com\n这台机器上有 two.example.com：fake target set --kind alpha --host two.example.com',
      data: { connected: null, found: [{ kind: 'alpha', label: 'one.example.com', values: { host: 'one.example.com' } }, expect.objectContaining({ label: 'two.example.com' })] },
    })
    await l.cmd('fake target set', [], { kind: ['gamma'], to: ['/srv/my www'] })
    expect(await l.cmd('fake target list')).toMatchObject({ text: expect.stringMatching(/^连着 \/srv\/my www：fake target set --kind gamma --to '\/srv\/my www'\n/), data: { connected: { kind: 'gamma', label: '/srv/my www' } } })
    await l.put(P, 'v1')
    await l.say(P)
    await l.cmd('fake on', [P])
    expect(await l.cmd('fake target remove')).toMatchObject({ outcome: 'done', text: '已断开 /srv/my www。线上的 1 样没有撤下。' })
    expect(await l.list()).toEqual([expect.objectContaining({ path: P, on: true })])
    expect((await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx()))?.blocks[0]).toMatchObject({ kind: 'section', title: '发到哪里' })
    expect(await l.cmd('fake target remove')).toMatchObject({ outcome: 'refused', reason: 'no-target' })
  })
})

describe('the owner putting a thing online', () => {
  it('declares a thing nobody declared and switches it on in one act; an agent’s declaration stays off; the panel offers 上线… for a directory thing while connected', async () => {
    const { fake, adapter } = fakeTarget()
    const plugin = deployPlugin('fake', adapter)
    const l = await library(plugin, true)
    await l.site('sites/shop', { 'index.html': '<h1>shop</h1>' })
    await l.site('sites/blog', { 'index.html': '<h1>blog</h1>' })
    await l.put(P, 'v1')
    expect(await plugin.onItemView?.('sites/shop' as LibraryPath, l.pctx())).toBeNull()
    await l.cmd('fake target set', [], { where: ['w'] })
    const panel = await plugin.onItemView?.('sites/shop' as LibraryPath, l.pctx())
    expect(panel).toEqual({ title: '部署', blocks: [], actions: [expect.objectContaining({ label: '上线…', as: 'menu', confirm: '把 shop 发到 假的 w？', call: expect.objectContaining({ command: 'fake on', args: { positional: ['sites/shop'], flags: {} } }) })] })
    expect(await plugin.onItemView?.(P, l.pctx())).toBeNull()

    expect(await press(l, panel?.actions?.[0])).toMatchObject({ outcome: 'done', text: `已上线 sites/shop → ${url(siteName('sites/shop' as LibraryPath))}` })
    expect(fake.served.has(siteName('sites/shop' as LibraryPath))).toBe(true)
    await l.say('sites/blog')
    expect(await l.list()).toEqual([expect.objectContaining({ path: 'sites/blog', on: false, status: 'offline' }), expect.objectContaining({ path: 'sites/shop', on: true, status: 'online' })])
    expect(await l.cmd('fake on', ['sites/nothing'])).toMatchObject({ outcome: 'refused', reason: 'not-declared' })
    expect(await l.cmd('fake off', [Q])).toMatchObject({ outcome: 'refused', reason: 'not-declared' })
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
          mark: (l) => (l.detail ? { text: l.detail.note, tone: 'neutral' } : null),
          fields: (l) => [{ label: '说明', value: { text: l.detail?.note ?? '—' } }],
          ...opts.view?.(env),
        },
      }
    },
  })
  return { adapter, asks, served }
}

/** The rows of the things on the kit's page: its last list. */
const itemsOf = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'list' }> => b.kind === 'list').at(-1)?.items ?? []

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
    expect(itemsOf(page?.blocks ?? []).map((i) => i.cell.tag?.text)).toEqual([`在服务 ${a}`])

    const section = await plugin.onItemView?.(`_archive/${R}` as LibraryPath, l.pctx())
    const fields = section?.blocks.flatMap((b) => (b.kind === 'fields' ? b.fields : [])) ?? []
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
    expect(plugin.views).toEqual([expect.objectContaining({ id: 'fake.sites', nav: true }), { id: 'fake.board', title: '看板', icon: 'layout-grid', nav: true, filters: [], with: 'fake.sites' }])

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
    expect(board).toMatchObject({ title: '看板', subtitle: '1 样在线' })
    const custom = board?.blocks[0]
    expect(custom?.kind).toBe('custom')
    if (custom?.kind !== 'custom') return
    expect(custom.data).toEqual([
      { path: P, state: { text: '在线', tone: 'good' }, note: `在服务 ${siteName(P)}` },
      { path: Q, state: { text: '离线', tone: 'neutral' }, note: null },
    ])

    const page = await plugin.onView?.({ view: 'fake.sites', params: {} }, l.pctx())
    expect(page?.blocks[1]).toEqual({ kind: 'text', tone: 'info', text: '在最前面' })
    // The same switch as the kit's rows.
    expect(Object.values(custom.actions)).toEqual(itemsOf(page?.blocks ?? []).map((i) => i.toggle?.action))
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

  it('declares an optional secret as optional: target set says nothing of it, or what configure says, and the target reads null until it is set', async () => {
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
    // An optional secret not set goes unsaid.
    expect(await l.cmd('open target set')).toMatchObject({ outcome: 'done', text: '已连上 令牌可有可无的目标。' })
    await l.put(P, 'v1')
    await l.say(P)
    expect(await l.cmd('open on', [P])).toMatchObject({ outcome: 'done' })
    expect(await l.secret('token', 'tok-1')).toMatchObject({ outcome: 'done' })
    await l.put(P, 'v2')
    expect(tokens).toEqual([null, 'tok-1'])

    // A target whose configure says where the credentials come from: that, in place of the reminder.
    const keyed = defineTarget({
      kind: 'keyed',
      label: '要钥匙的目标',
      params: [],
      secrets: [{ name: 'key', description: '账户的钥匙', optional: true }],
      configure: async () => ({ ok: true, config: {}, note: '钥匙从凭据文件读。' }),
      open: () => ({ key: 'keyed', label: '要钥匙的目标', publish: async (site) => ({ url: url(site) }), remove: async () => {} }),
    })
    const k = await library(deployPlugin('keyed', keyed), true)
    expect(await k.cmd('keyed target set')).toMatchObject({ outcome: 'done', text: '已连上 要钥匙的目标。钥匙从凭据文件读。' })
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
