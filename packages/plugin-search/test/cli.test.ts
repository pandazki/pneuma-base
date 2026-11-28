// C7 through the real command line. With the search plugin, find matches the content of registered
// things, ranked by relevance, each hit with its context; the index is a cache whose deletion changes
// no answer, read when a thing is put or when storage says it changed, within its limits; with an
// embedder, a sentence finds things by meaning, and an embedder that fails costs only the hits by
// meaning. C8: the description promises meaning only on the condition that an embedder is set.
// What text.test.ts and embed.test.ts state as pure functions is not asked again here; ranking and
// merging across plugins are packages/kernel/test/find.test.ts's.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fakeEmbedder, libraryId, ok, sandbox, tempDir, type FakeEmbedder, type Run, type RunOptions, type Sandbox } from './cli-support.js'

type Hit = { path: string | null; by: string; detail: string | null }

type Library = {
  sb: Sandbox
  dir: string
  outside: string
  agent(args: string[], opts?: RunOptions): Promise<Run>
  owner(args: string[], opts?: RunOptions): Promise<Run>
  put(path: string, content: string): Promise<Run>
  /** Registers what is already at `path` in the library. */
  register(path: string): Promise<Run>
  hits(...args: string[]): Promise<Hit[]>
  /** The paths of the search plugin's hits. */
  paths(...args: string[]): Promise<(string | null)[]>
  cacheDir(): string
}

/** A library with the search plugin, bare or with the ledger, in a home of its own. */
async function newLibrary(plugins: 'search' | 'ledger+search' = 'search'): Promise<Library> {
  const sb = sandbox()
  const dir = join(tempDir(), 'lib')
  const outside = tempDir('pb-s-outside-')
  const agent = (args: string[], opts: RunOptions = {}) => sb.run(['--library', dir, '--as', 'claude-code', ...args], { cwd: outside, ...opts })
  const owner = (args: string[], opts: RunOptions = {}) => sb.run([...args, '--library', dir], opts)
  ok(await sb.run(plugins === 'search' ? ['init', dir, '--bare'] : ['init', dir]))
  ok(await owner(['plugin', 'enable', 'search']))
  const hits = async (...args: string[]) => ok(await agent(['find', ...args, '--json'])).json().hits as Hit[]
  return {
    sb,
    dir,
    outside,
    agent,
    owner,
    put: async (path, content) => ok(await agent(['put', '-', '--to', path, '--generated'], { input: content })),
    register: async (path) => ok(await agent(['put', join(dir, path), '--generated'])),
    hits,
    paths: async (...args) => (await hits(...args)).filter((h) => h.by === 'search').map((h) => h.path),
    cacheDir: () => join(sb.home, '.pneuma-base', 'cache', libraryId(dir), 'search'),
  }
}

/** The files the search plugin read from the library while `run` ran, from the log of what plugins ask storage. */
async function readsBy(run: (opts: RunOptions) => Promise<Run>): Promise<string[]> {
  const log = join(tempDir('pb-s-log-'), 'tools.jsonl')
  ok(await run({ env: { PNEUMA_BASE_TOOL_LOG: log } }))
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { plugin: string; area: string; tool: string; place?: string; reason?: string }) : []
  return calls.filter((c) => c.plugin === 'search' && c.area === 'content' && c.tool === 'read' && c.reason === undefined).map((c) => c.place ?? '')
}

const COFFEE = '# 豆子与烘焙\n\n本店供应手冲咖啡豆，深烘和浅烘都有。每周二烘焙一次。拿铁用的咖啡豆是意式拼配，挂耳包里的咖啡豆是单品。\n'
const PETS = '# 宠物医院\n\n猫狗疫苗接种、绝育手术和日常体检，周末也开门，需要提前预约挂号。\n'
const BOOKS = '# 旧书交换\n\n把看完的小说带来，换一本别人读过的书。每月第一个周六在社区图书角。\n'

// One library the tests read in order; the last two change only the index and the embedder.
describe('find matches content (C7)', () => {
  let lib: Library
  const putErrors: string[] = []

  beforeAll(async () => {
    lib = await newLibrary()
    putErrors.push((await lib.put('refunds/policy.md', '# 退款\n\n退款在七天内处理。退款需要订单号。\n\n退款原路返回，不收手续费。\n')).stderr)
    putErrors.push((await lib.put('refunds/faq.md', '# 常见问题\n\n运费怎么算？满一百包邮。\n\n能退款吗？可以，见政策。\n')).stderr)
    putErrors.push((await lib.put('notes/zebra.md', 'zebra crossings near the shop\n')).stderr)
    const site = join(lib.outside, 'soap-site')
    mkdirSync(join(site, 'about'), { recursive: true })
    mkdirSync(join(site, 'assets'))
    for (const image of ['a.png', 'b.png', 'c.png']) writeFileSync(join(site, 'assets', image), Buffer.alloc(400 * 1024, 0xff))
    writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><title>手工皂工作室</title><style>.x{color:red}</style></head><body><h1>冷制皂</h1><p>橄榄油&amp;椰子油，熟成六周。</p></body></html>')
    writeFileSync(join(site, 'about', 'team.html'), '<p>两个人的小工作室。</p>')
    ok(await lib.agent(['put', site, '--to', 'sites/soap', '--generated'])) // a directory's put says how far its reading got on stderr
    const filler = Array.from({ length: 40_000 }, (_, i) => `filler line ${i} of the log`).join('\n')
    writeFileSync(join(lib.dir, 'big.log'), `alphaword starts the log\n${filler}\nomegaword ends it\n`)
    putErrors.push((await lib.register('big.log')).stderr)
  })

  it('ranks things by relevance, gives each hit the context of the match and each path once, and keeps stderr clean', async () => {
    const found = (await lib.hits('退款')).filter((h) => h.by === 'search')
    expect(found.map((h) => h.path)).toEqual(['refunds/policy.md', 'refunds/faq.md'])
    expect(found[1]?.detail).toMatch(/^全文：.*能退款吗？可以/)
    const text = ok(await lib.agent(['find', '退款']))
    expect(text.stdout.split('\n')[0]).toBe('refunds/policy.md')
    expect(text.stdout.split('\n')[1]).toMatch(/^ {2}全文：.*退款/)
    // Found by its name and by its content: one hit, from the search plugin.
    expect(await lib.hits('zebra')).toEqual([{ path: 'notes/zebra.md', title: 'zebra.md', by: 'search', group: null, detail: '全文：zebra crossings near the shop' }])
    // Only Node versions that still mark node:sqlite experimental (22, early 24 and 25) can fail this.
    expect([...putErrors, text.stderr].filter((e) => e !== '')).toEqual([])
  })

  it('finds a file inside a bundle as the bundle, naming the inner file, in the words a reader sees, past images that sort before it', async () => {
    const [hit, ...rest] = (await lib.hits('冷制皂')).filter((h) => h.by === 'search')
    expect(rest).toEqual([])
    expect(hit?.path).toBe('sites/soap')
    expect(hit?.detail).toMatch(/^目录，index\.html：.*冷制皂.*橄榄油&椰子油/)
    expect(hit?.detail).not.toContain('<')
    expect(await lib.paths('工作室')).toEqual(['sites/soap'])
  })

  it('reads a large file up to its first 1 MB and says so', async () => {
    expect(statSync(join(lib.dir, 'big.log')).size).toBeGreaterThan(1024 * 1024)
    const [hit] = (await lib.hits('alphaword')).filter((h) => h.by === 'search')
    expect(hit?.path).toBe('big.log')
    expect(hit?.detail).toContain('仅索引前 1 MB')
    expect(await lib.paths('omegaword')).toEqual([])
  })

  it('is promised in the description by meaning only on the condition that the owner set an embedder (C8)', () => {
    expect(readFileSync(join(lib.dir, 'PNEUMA-BASE.md'), 'utf8')).toMatch(/所有者配置 embedding 后[^\n]*语义/)
  })

  it('refuses an http embedder without an address or a model, and a key or key variable written in a flag', async () => {
    for (const [flags, named] of [
      [['--kind', 'http', '--model', 'm'], '--url'],
      [['--kind', 'http', '--url', 'http://127.0.0.1:9'], '--model'],
      [['--kind', 'http', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key', 'sk-secret'], '不支持 --key'],
      [['--kind', 'http', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key-env', 'MY_KEY'], '不支持 --key-env'],
      [['--kind', 'magic'], 'hash'],
    ] as const) {
      const r = await lib.owner(['search', 'embedding', 'set', ...flags])
      expect(r.code, flags.join(' ')).toBe(1)
      expect(r.stderr).toContain(named)
    }
    expect(existsSync(join(lib.dir, '.pneuma-base', 'search', 'embedder'))).toBe(false)
  })

  it('has no destructive command: an agent with a grant runs status and rebuild; the embedder is the owner’s to choose', async () => {
    ok(await lib.owner(['grant', 'create', 'claude', '--agent', 'claude-code']))
    const viaGrant = (args: string[]) => lib.sb.run(['@claude', ...args], { cwd: lib.outside, env: { CLAUDE_CODE_SESSION_ID: 's-1' } })
    for (const args of [['search', 'status'], ['search', 'rebuild']]) ok(await viaGrant(args))
    for (const args of [['search', 'embedding', 'set', '--kind', 'hash'], ['search', 'embedding', 'clear']]) {
      const r = await viaGrant([...args, '--json'])
      expect(r.code).toBe(2)
      expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    }
  })

  it('finds a folder of files on record, registered as one thing, as the one thing and not the files it absorbed, also after search rebuild', async () => {
    await lib.put('journal/a.md', 'bilby burrows\n')
    await lib.put('journal/deep/b.md', 'bilby diet\n')
    writeFileSync(join(lib.dir, 'journal', '.pneuma-item'), '{"format":1}\n')
    ok(await lib.agent(['put', join(lib.dir, 'journal'), '--imported']))
    expect(await lib.paths('bilby')).toEqual(['journal'])
    ok(await lib.owner(['search', 'rebuild']))
    expect(await lib.paths('bilby')).toEqual(['journal'])
  })

  it('gives the same hits when the cache is deleted, holds something that is no index, or answers several finds at once', async () => {
    ok(await lib.owner(['search', 'embedding', 'set', '--kind', 'hash']))
    const queries = [['退款'], ['哪里', '退钱']]
    const before: Hit[][] = []
    for (const q of queries) before.push(await lib.hits(...q))
    const details = before.flat().map((h) => h.detail ?? '')
    expect(details.some((d) => d.startsWith('全文：'))).toBe(true)
    expect(details.some((d) => d.startsWith('语义：'))).toBe(true)
    const same = async () => {
      for (const [i, q] of queries.entries()) expect(await lib.hits(...q)).toEqual(before[i])
    }

    rmSync(lib.cacheDir(), { recursive: true })
    await same()
    expect(existsSync(lib.cacheDir())).toBe(true)

    rmSync(lib.cacheDir(), { recursive: true })
    mkdirSync(lib.cacheDir(), { recursive: true })
    writeFileSync(join(lib.cacheDir(), 'index.sqlite'), 'not a database, only text long enough to look like a header')
    await same()

    const answers = await Promise.all([1, 2, 3, 4].map(() => lib.agent(['find', '退款', '--json'])))
    for (const r of answers) expect(ok(r).json().hits).toEqual(before[0])
  })
})

// With the ledger, a put over a file is accepted and the replaced content held.
describe('what find indexes: the registered things, read when put or when storage says they changed', () => {
  let lib: Library
  beforeAll(async () => {
    lib = await newLibrary('ledger+search')
  })

  it('reads a thing when it is put and when it changes, through put or outside the tool, and forgets its old words', async () => {
    writeFileSync(join(lib.dir, 'loose.md'), 'quokka sightings on the island\n')
    expect(await lib.paths('quokka')).toEqual([])
    await lib.register('loose.md')
    expect(await lib.paths('quokka')).toEqual(['loose.md'])

    const putPlan = (text: string) => readsBy((opts) => lib.agent(['put', '-', '--to', 'notes/plan.md', '--generated'], { ...opts, input: text }))
    expect(await putPlan('第一版：先做袋熊的页面\n')).toEqual(['notes/plan.md'])
    expect(await readsBy((opts) => lib.agent(['find', '袋熊'], opts))).toEqual([])
    expect(await lib.paths('袋熊')).toEqual(['notes/plan.md'])

    expect(await putPlan('第二版：改做鸭嘴兽的页面\n')).toEqual(['notes/plan.md'])
    expect(await lib.paths('鸭嘴兽')).toEqual(['notes/plan.md'])
    expect(await lib.paths('袋熊')).toEqual([])

    writeFileSync(join(lib.dir, 'notes/plan.md'), '第三版：周末休息\n')
    expect(await lib.paths('周末')).toEqual(['notes/plan.md'])
    expect(await lib.paths('鸭嘴兽')).toEqual([])
  })

  it('finds a moved and an archived thing at its new path, a directory thing without reading its files again', async () => {
    await lib.put('notes/a.md', 'platypus notes\n')
    const site = join(lib.outside, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'index.html'), '<p>wombat burrows</p>')
    writeFileSync(join(site, 'about.html'), '<p>about the wombat</p>')
    ok(await lib.agent(['put', site, '--to', 'sites/w', '--generated']))

    ok(await lib.agent(['put', 'notes/a.md', '--to', 'notes/b.md']))
    expect(await lib.paths('platypus')).toEqual(['notes/b.md'])
    ok(await lib.agent(['archive', 'notes/b.md']))
    expect(await lib.paths('platypus')).toEqual([])
    expect(await lib.paths('platypus', '--include-archived')).toEqual(['_archive/notes/b.md'])

    ok(await lib.agent(['archive', 'sites/w']))
    expect(await readsBy((opts) => lib.agent(['find', 'wombat', '--include-archived'], opts))).toEqual([])
    expect(await lib.paths('wombat', '--include-archived')).toEqual(['_archive/sites/w'])
    ok(await lib.agent(['unarchive', 'sites/w']))
    expect(await lib.paths('wombat')).toEqual(['sites/w'])
  })
})

describe('how much find reads', () => {
  let lib: Library
  const status = async () => ok(await lib.owner(['search', 'status', '--json'])).json().data as { files: number; pending: number; tooMany: number }
  beforeAll(async () => {
    lib = await newLibrary()
  })

  it('reads at most 200 files in one call, leaves the rest for the next, and reads none when nothing changed', async () => {
    mkdirSync(join(lib.dir, 'many'))
    for (let i = 0; i < 250; i++) writeFileSync(join(lib.dir, 'many', `f${String(i).padStart(3, '0')}.md`), `numbat ${i}\n`)
    expect(await readsBy((opts) => lib.agent(['put', join(lib.dir, 'many'), '--generated'], opts))).toHaveLength(200)
    expect(await status()).toMatchObject({ files: 200, pending: 1 })
    expect(await readsBy((opts) => lib.agent(['find', 'numbat'], opts))).toHaveLength(50)
    expect(await status()).toMatchObject({ files: 250, pending: 0 })
    expect(await readsBy((opts) => lib.agent(['find', 'numbat'], opts))).toEqual([])
    writeFileSync(join(lib.dir, 'many', 'f007.md'), 'echidna instead\n')
    expect(await readsBy((opts) => lib.agent(['find', 'echidna'], opts))).toEqual(['many/f007.md'])
    expect(await lib.paths('echidna')).toEqual(['many'])
  })

  it('does not read a directory thing of more than 5000 files, and says so on the item panel and the status', async () => {
    mkdirSync(join(lib.dir, 'huge', 'sub'), { recursive: true })
    for (let i = 0; i < 5001; i++) writeFileSync(join(lib.dir, 'huge', 'sub', `f${i}.md`), `dingo ${i}\n`)
    expect(await readsBy((opts) => lib.agent(['put', join(lib.dir, 'huge'), '--generated'], opts))).toEqual([])
    expect(await readsBy((opts) => lib.agent(['find', 'dingo'], opts))).toEqual([])
    expect(await lib.paths('dingo')).toEqual([])
    expect(await status()).toMatchObject({ pending: 0, tooMany: 1 })
    expect(ok(await lib.owner(['show', 'item', '--path', 'huge'])).stdout).toContain('全文：目录内至少 5001 个文件，超过 5000 个，不索引')
  })
})

const CORE = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))

describe('who tells find what changed', () => {
  const listeners: ChildProcessWithoutNullStreams[] = []
  afterEach(() => {
    for (const child of listeners.splice(0)) child.kill('SIGKILL')
  })

  /** The places storage reports since `cursor` without replaying: from a live listener's log, or null. */
  const heard = (l: string, cursor: string): string[] | null => {
    const a = JSON.parse(spawnSync(CORE, ['changed', '--root', l, JSON.stringify({ cursor, budget: 0, limit: 10000 })], { encoding: 'utf8' }).stdout) as { outcome: string; places?: string[] }
    return a.outcome === 'done' ? (a.places ?? []) : null
  }
  const cursorOf = (l: string) => (JSON.parse(spawnSync(CORE, ['changed', '--root', l, '{}'], { encoding: 'utf8' }).stdout) as { cursor: string }).cursor
  async function until<T>(f: () => T | undefined): Promise<T> {
    for (let i = 0; i < 500; i++) {
      const found = f()
      if (found !== undefined) return found
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('not within ten seconds')
  }

  // A listener needs a change journal, which only the macOS provider has.
  it.runIf(process.platform === 'darwin')('a live listener names the places, and find reads the same as when storage compares every row', async () => {
    const sb = sandbox()
    const outside = tempDir('pb-s-outside-')
    const as = (l: string, args: string[], opts: RunOptions = {}) => sb.run(['--library', l, '--as', 'claude-code', ...args], { cwd: outside, ...opts })
    const site = join(outside, 'site')
    mkdirSync(site)
    writeFileSync(join(site, 'index.html'), '<p>kookaburra calls</p>')
    const make = async () => {
      const l = join(tempDir(), 'lib')
      ok(await sb.run(['init', l, '--bare']))
      ok(await sb.run(['plugin', 'enable', 'search', '--library', l]))
      for (const name of ['kept', 'edited', 'gone']) ok(await as(l, ['put', '-', '--to', `${name}.md`, '--generated'], { input: `${name} lyrebird\n` }))
      ok(await as(l, ['put', site, '--to', 'sites/k', '--generated']))
      return l
    }
    const listened = await make()
    const alone = await make()
    const child = spawn(CORE, ['serve', '--root', listened], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.write(`${JSON.stringify({ id: 'sub', op: 'subscribe' })}\n`)
    listeners.push(child)
    await until(() => (heard(listened, cursorOf(listened)) === null ? undefined : true))
    expect(heard(alone, cursorOf(alone))).toBeNull()
    for (const l of [listened, alone]) ok(await as(l, ['find', 'lyrebird']))

    const from = cursorOf(listened)
    for (const l of [listened, alone]) {
      writeFileSync(join(l, 'edited.md'), 'edited cassowary\n')
      unlinkSync(join(l, 'gone.md'))
      writeFileSync(join(l, 'sites/k/new.html'), '<p>new cassowary page</p>')
    }
    await until(() => {
      const p = heard(listened, from)
      return p !== null && ['edited.md', 'gone.md', 'sites/k/new.html'].every((w) => p.includes(w)) ? true : undefined
    })
    const reads = await Promise.all([listened, alone].map((l) => readsBy((opts) => as(l, ['find', 'cassowary'], opts))))
    expect(reads[0]).toEqual(['edited.md', 'sites/k/new.html'])
    expect(reads[1]).toEqual(reads[0])
    for (const q of ['cassowary', 'lyrebird', 'kookaburra']) {
      const [a, b] = await Promise.all([listened, alone].map(async (l) => ok(await as(l, ['find', q, '--json'])).json().hits))
      expect(a).toEqual(b)
    }
    expect(ok(await as(listened, ['find', 'lyrebird', '--json'])).json().hits.map((h: { path: string }) => h.path)).toEqual(['kept.md'])
  })
})

// One library and one embedding server, in order: no embedder, the hash embedder, the http one, the http one down.
describe('find by meaning (C7)', () => {
  let lib: Library
  let server: FakeEmbedder
  let serverUp = false

  beforeAll(async () => {
    server = await fakeEmbedder()
    serverUp = true
    lib = await newLibrary()
    await lib.put('shops/coffee.md', COFFEE)
    await lib.put('shops/pets.md', PETS)
    await lib.put('shops/books.md', BOOKS)
  })
  afterAll(async () => {
    if (serverUp) await server.close()
  })

  it('with no embedder there is no hit by meaning; with the hash embedder a sentence finds the closest thing; its configuration is in the library and its vectors in the cache', async () => {
    const sentence = '我想喝杯现磨咖啡' // no word of it is a word of the shops; 咖啡 is half of 咖啡豆
    expect(await lib.hits(sentence)).toEqual([])
    ok(await lib.owner(['search', 'embedding', 'set', '--kind', 'hash']))
    // The other shops share a character pair or two by chance: far less near, so left out.
    expect(await lib.hits(sentence)).toEqual([{ path: 'shops/coffee.md', title: 'coffee.md', by: 'search', group: null, detail: '语义：# 豆子与烘焙' }])
    const recordDir = join(lib.dir, '.pneuma-base', 'search', 'embedder')
    const records = readdirSync(recordDir)
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(recordDir, records[0] as string), 'utf8'))).toMatchObject({ embedder: { kind: 'hash' } })
    expect(readdirSync(lib.cacheDir()).some((name) => name.endsWith('.sqlite'))).toBe(true)

    ok(await lib.owner(['search', 'embedding', 'clear']))
    expect(await lib.hits(sentence)).toEqual([])
  })

  it('finds by meaning through an OpenAI-compatible server, embedding each piece once per embedder; the key is a secret of this machine, never in the library', async () => {
    const set = () => lib.owner(['search', 'embedding', 'set', '--kind', 'http', '--url', `${server.url}/v1`, '--model', 'concepts-1'])
    expect(ok(await set()).stdout).toContain('pneuma-base secret set search key')
    ok(await lib.sb.run(['secret', 'set', 'search', 'key'], { input: 'test-key-123' }))
    const withKey = ok(await set()).stdout
    expect(withKey).toContain('concepts-1')
    expect(withKey).toContain('密钥已设置')
    expect(withKey).not.toContain('test-key-123')

    const from = server.requests.length
    expect(ok(await lib.agent(['find', '想喝点提神的饮料', '--json'])).json().hits[0]).toMatchObject({ path: 'shops/coffee.md', by: 'search', detail: '语义：# 豆子与烘焙' })
    const sent = server.requests.slice(from)
    expect(sent.every((q) => q.authorization === 'Bearer test-key-123' && q.model === 'concepts-1')).toBe(true)
    // The hash embedder's vectors are another embedder's: each of the three pieces goes to the server.
    expect(sent.flatMap((q) => q.input).filter((text) => text.startsWith('# '))).toHaveLength(3)
    const later = server.requests.length
    ok(await lib.agent(['find', '猫']))
    expect(server.requests.slice(later).flatMap((q) => q.input)).toEqual(['猫'])

    const written = readdirSync(lib.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
    expect(written.some((text) => text.includes('test-key-123'))).toBe(false)
  })

  it('a server that is down costs only the hits by meaning: find matches the words and lists the failure; rebuild rebuilds the words and says the vectors are missing', async () => {
    await server.close()
    serverUp = false
    const r = await lib.agent(['find', '拿铁', '--json'])
    expect(r.code).toBe(3)
    expect(r.json().hits.map((h: Hit) => [h.path, h.by])).toEqual([['shops/coffee.md', 'search']])
    expect(r.json().problems).toMatchObject([{ plugin: 'search', message: expect.stringContaining('embedding') }])

    const rebuilt = await lib.owner(['search', 'rebuild'])
    expect(rebuilt.code).toBe(2)
    expect(rebuilt.stdout).toMatch(/^拒绝（embedding-failed）：已重建索引：3 个文件，其中文本 3 个，3 个分块。语义检索的向量未建立完成（0 \/ 3 个分块）：无法连接 embedding 服务/)
  })
})

describe('an embedder an earlier version recorded with a key variable', () => {
  it('still loads; the variable is not read, and status says the key is a secret now and how to set it', async () => {
    const server = await fakeEmbedder()
    try {
      const lib = await newLibrary()
      await lib.put('shops/coffee.md', COFFEE)
      const KEY_ENV = 'PB_TEST_EMBED_KEY'
      const record = { format: 1, at: '2026-11-01T00:00:00.000Z', embedder: { kind: 'http', url: server.url, model: 'concepts-1', keyEnv: KEY_ENV } }
      mkdirSync(join(lib.dir, '.pneuma-base', 'search', 'embedder'), { recursive: true })
      writeFileSync(join(lib.dir, '.pneuma-base', 'search', 'embedder', '20261101000000000-aaaaaaaa.json'), `${JSON.stringify(record)}\n`)
      const env = { env: { [KEY_ENV]: 'from-the-environment' } }
      const before = ok(await lib.owner(['search', 'status'], env)).stdout
      expect(before).toContain(`密钥之前取自环境变量 ${KEY_ENV}`)
      expect(before).toContain('pneuma-base secret set search key')
      ok(await lib.agent(['find', '想喝点提神的饮料'], env))
      expect(server.requests.length).toBeGreaterThan(0)
      expect(server.requests.every((q) => q.authorization === undefined)).toBe(true)
      ok(await lib.sb.run(['secret', 'set', 'search', 'key'], { input: 'test-key-123' }))
      expect(ok(await lib.owner(['search', 'status'])).stdout).toContain('密钥已设')
      const sent = server.requests.length
      ok(await lib.agent(['find', '猫']))
      expect(server.requests.slice(sent).map((q) => q.authorization)).toEqual(['Bearer test-key-123'])
    } finally {
      await server.close()
    }
  })
})
