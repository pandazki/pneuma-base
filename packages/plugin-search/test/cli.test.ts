// C7 and C8 through the real command line. With the search plugin, find matches the content of
// registered things, ranked by relevance, each hit with its context; two-character Chinese words
// match; the index is a cache whose deletion changes no answer; with an embedder, a sentence finds
// things by meaning, and an embedder that fails costs only the hits by meaning. The cognition section
// comes and goes with the plugin and promises meaning only on the condition that an embedder is set.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeEmbedder, libraryId, ok, sandbox, tempDir, type FakeEmbedder, type Run, type RunOptions, type Sandbox } from './cli-support.js'

let sb: Sandbox
let lib: string
let outside: string

const agent = (args: string[], opts: RunOptions = {}) => sb.run(['--library', lib, '--as', 'claude-code', ...args], { cwd: outside, ...opts })
const owner = (args: string[], opts: RunOptions = {}) => sb.run([...args, '--library', lib], opts)
const put = async (path: string, content: string) => ok(await agent(['put', '-', '--to', path, '--made'], { input: content }))
/** Registers what is already at `path` in the library. */
const register = async (path: string) => ok(await agent(['put', join(lib, path), '--made']))
const hits = async (...args: string[]) => ok(await agent(['find', ...args, '--json'])).json().hits as { path: string | null; by: string; detail: string | null }[]
const searchHits = async (...args: string[]) => (await hits(...args)).filter((h) => h.by === 'search')
const cacheDir = () => join(sb.home, '.pneuma-base', 'cache', libraryId(lib), 'search')

const COFFEE = '# 豆子与烘焙\n\n本店供应手冲咖啡豆，深烘和浅烘都有。每周二烘焙一次。拿铁用的咖啡豆是意式拼配，挂耳包里的咖啡豆是单品。\n'
const PETS = '# 宠物医院\n\n猫狗疫苗接种、绝育手术和日常体检，周末也开门，需要提前预约挂号。\n'
const BOOKS = '# 旧书交换\n\n把看完的小说带来，换一本别人读过的书。每月第一个周六在社区图书角。\n'

async function newLibrary(plugins: 'bare' | 'search' | 'ledger+search'): Promise<void> {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-s-outside-')
  ok(await sb.run(plugins === 'ledger+search' ? ['init', lib] : ['init', lib, '--bare']))
  if (plugins !== 'bare') ok(await owner(['plugin', 'add', 'search']))
}

describe('find matches content (C7)', () => {
  beforeEach(async () => {
    await newLibrary('search')
    await put('refunds/policy.md', '# 退款\n\n退款在七天内处理。退款需要订单号。\n\n退款原路返回，不收手续费。\n')
    await put('refunds/faq.md', '# 常见问题\n\n运费怎么算？满一百包邮。\n\n能退款吗？可以，见政策。\n')
    await put('misc/hours.md', '营业时间：每天九点到六点。\n')
  })

  it('ranks things by relevance and gives each hit the context of the match', async () => {
    const found = await searchHits('退款')
    expect(found.map((h) => h.path)).toEqual(['refunds/policy.md', 'refunds/faq.md'])
    expect(found[1]?.detail).toMatch(/^正文：.*能退款吗？可以/)

    const text = ok(await agent(['find', '退款'])).stdout.split('\n')
    expect(text[0]).toBe('refunds/policy.md')
    expect(text[1]).toMatch(/^ {2}正文：.*退款/)
  })

  it('finds a two-character Chinese word inside a sentence', async () => {
    await put('print/note.md', '我们昨天下单了一批画册，周五到货。\n')
    expect((await searchHits('下单')).map((h) => h.path)).toEqual(['print/note.md'])
  })

  it('sees a file changed outside the tool and forgets its old words', async () => {
    expect((await searchHits('每天')).map((h) => h.path)).toEqual(['misc/hours.md'])
    writeFileSync(join(lib, 'misc/hours.md'), '营业时间：周末休息，平日照常。\n')
    expect((await searchHits('周末')).map((h) => h.path)).toEqual(['misc/hours.md'])
    expect(await searchHits('每天')).toEqual([])
  })

  it('gives the same hits after the cache directory is deleted', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'hash']))
    const queries = [['退款'], ['下单'], ['哪里', '退钱'], ['退款', '--include-archived']]
    const before = []
    for (const q of queries) before.push(await hits(...q))
    const details = before.flat().map((h) => h.detail ?? '')
    expect(details.filter((d) => d.startsWith('正文：')).length).toBeGreaterThan(2)
    expect(details.filter((d) => d.startsWith('按意思：')).length).toBeGreaterThan(0)
    expect(existsSync(cacheDir())).toBe(true)
    rmSync(cacheDir(), { recursive: true })
    for (const [i, q] of queries.entries()) expect(await hits(...q)).toEqual(before[i])
    expect(existsSync(cacheDir())).toBe(true)
  })

  it('makes the index anew when the cache holds something that is no index', async () => {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(join(cacheDir(), 'index.sqlite'), 'not a database, only text long enough to look like a header')
    expect((await searchHits('退款')).map((h) => h.path)).toEqual(['refunds/policy.md', 'refunds/faq.md'])
  })

  it('answers the same when several finds build the index at once', async () => {
    const answers = await Promise.all([1, 2, 3, 4].map(() => agent(['find', '退款', '--json'])))
    for (const r of answers) expect(ok(r).json().hits.map((h: any) => h.path)).toEqual(['refunds/policy.md', 'refunds/faq.md'])
  })

  it('gives a path found by name and by content once, from the search plugin', async () => {
    await put('notes/zebra.md', 'zebra crossings near the shop\n')
    expect(await hits('zebra')).toEqual([{ path: 'notes/zebra.md', title: 'zebra.md', by: 'search', group: null, detail: '正文：zebra crossings near the shop' }])
  })

  it('leaves archived things out unless asked', async () => {
    ok(await agent(['archive', 'refunds/faq.md']))
    expect((await searchHits('运费')).map((h) => h.path)).toEqual([])
    expect((await searchHits('运费', '--include-archived')).map((h) => h.path)).toEqual(['_archive/refunds/faq.md'])
  })

  it('finds a file inside a bundle as the bundle, naming the inner file, in the words a reader sees', async () => {
    const site = join(outside, 'soap-site')
    mkdirSync(join(site, 'about'), { recursive: true })
    writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><title>手工皂工作室</title><style>.x{color:red}</style></head><body><h1>冷制皂</h1><p>橄榄油&amp;椰子油，熟成六周。</p></body></html>')
    writeFileSync(join(site, 'about', 'team.html'), '<p>两个人的小工作室。</p>')
    ok(await agent(['put', site, '--to', 'sites/soap', '--made']))
    const [hit, ...rest] = await searchHits('冷制皂')
    expect(rest).toEqual([])
    expect(hit?.path).toBe('sites/soap')
    expect(hit?.detail).toMatch(/^目录，index\.html：.*冷制皂.*橄榄油&椰子油/)
    expect(hit?.detail).not.toContain('<')
    expect((await searchHits('工作室')).map((h) => h.path)).toEqual(['sites/soap'])
  })

  it('reads a large file up to its first 1 MB and says so', async () => {
    const filler = Array.from({ length: 40_000 }, (_, i) => `filler line ${i} of the log`).join('\n')
    writeFileSync(join(lib, 'big.log'), `alphaword starts the log\n${filler}\nomegaword ends it\n`)
    expect(statSync(join(lib, 'big.log')).size).toBeGreaterThan(1024 * 1024)
    await register('big.log')
    const [hit] = await searchHits('alphaword')
    expect(hit?.path).toBe('big.log')
    expect(hit?.detail).toContain('只索引了前 1 MB')
    expect(await searchHits('omegaword')).toEqual([])
  })

  it('does not index a file that is not UTF-8 text', async () => {
    writeFileSync(join(lib, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7a, 0x65, 0x62, 0x72, 0x61]))
    await register('image.bin')
    expect(await searchHits('zebra')).toEqual([])
  })
})

/** The files the search plugin read from the library while `args` ran, from the log of what plugins ask storage. */
async function readsBy(run: (opts: RunOptions) => Promise<Run>): Promise<string[]> {
  const log = join(tempDir('pb-s-log-'), 'tools.jsonl')
  ok(await run({ env: { PNEUMA_BASE_TOOL_LOG: log } }))
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { plugin: string; area: string; tool: string; place?: string; reason?: string }) : []
  return calls.filter((c) => c.plugin === 'search' && c.area === 'content' && c.tool === 'read' && c.reason === undefined).map((c) => c.place ?? '')
}
const status = async () => ok(await owner(['search', 'status', '--json'])).json().data as { files: number; pending: number; tooMany: number }
const itemText = async (path: string) => ok(await owner(['show', 'item', '--path', path])).stdout

describe('what find indexes: the registered things, read when put or when storage says they changed', () => {
  beforeEach(async () => {
    await newLibrary('search')
  })

  it('finds a file written into the library by its body only once it is put', async () => {
    writeFileSync(join(lib, 'loose.md'), 'quokka sightings on the island\n')
    expect(await searchHits('quokka')).toEqual([])
    await register('loose.md')
    expect((await searchHits('quokka')).map((h) => h.path)).toEqual(['loose.md'])
  })

  it('reads a thing when it is put, and a find after that reads nothing', async () => {
    expect(await readsBy((opts) => agent(['put', '-', '--to', 'notes/a.md', '--made'], { ...opts, input: '袋鼠和考拉\n' }))).toEqual(['notes/a.md'])
    expect(await readsBy((opts) => agent(['find', '考拉'], opts))).toEqual([])
    expect((await searchHits('考拉')).map((h) => h.path)).toEqual(['notes/a.md'])
  })

  it('finds a moved and an archived thing at its new path, a directory thing without reading its files again', async () => {
    await put('notes/a.md', 'platypus notes\n')
    const site = join(outside, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'index.html'), '<p>wombat burrows</p>')
    writeFileSync(join(site, 'about.html'), '<p>about the wombat</p>')
    ok(await agent(['put', site, '--to', 'sites/w', '--made']))

    ok(await agent(['put', 'notes/a.md', '--to', 'notes/b.md']))
    expect((await searchHits('platypus')).map((h) => h.path)).toEqual(['notes/b.md'])
    ok(await agent(['archive', 'notes/b.md']))
    expect(await searchHits('platypus')).toEqual([])
    expect((await searchHits('platypus', '--include-archived')).map((h) => h.path)).toEqual(['_archive/notes/b.md'])

    ok(await agent(['archive', 'sites/w']))
    expect(await readsBy((opts) => agent(['find', 'wombat', '--include-archived'], opts))).toEqual([])
    expect((await searchHits('wombat', '--include-archived')).map((h) => h.path)).toEqual(['_archive/sites/w'])
    ok(await agent(['unarchive', 'sites/w']))
    expect((await searchHits('wombat')).map((h) => h.path)).toEqual(['sites/w'])
  })

  it('reads at most 200 files in one call, leaves the rest for the next, and reads none when nothing changed', async () => {
    mkdirSync(join(lib, 'many'))
    for (let i = 0; i < 250; i++) writeFileSync(join(lib, 'many', `f${String(i).padStart(3, '0')}.md`), `numbat ${i}\n`)
    expect(await readsBy((opts) => agent(['put', join(lib, 'many'), '--made'], opts))).toHaveLength(200)
    expect(await status()).toMatchObject({ files: 200, pending: 1 })
    expect(await readsBy((opts) => agent(['find', 'numbat'], opts))).toHaveLength(50)
    expect(await status()).toMatchObject({ files: 250, pending: 0 })
    expect(await readsBy((opts) => agent(['find', 'numbat'], opts))).toEqual([])
    writeFileSync(join(lib, 'many', 'f007.md'), 'echidna instead\n')
    expect(await readsBy((opts) => agent(['find', 'echidna'], opts))).toEqual(['many/f007.md'])
    expect((await searchHits('echidna')).map((h) => h.path)).toEqual(['many'])
  })

  it('does not read a directory thing of more than 5000 files, and says so on the item panel and the status', async () => {
    mkdirSync(join(lib, 'huge', 'sub'), { recursive: true })
    for (let i = 0; i < 5001; i++) writeFileSync(join(lib, 'huge', 'sub', `f${i}.md`), `dingo ${i}\n`)
    expect(await readsBy((opts) => agent(['put', join(lib, 'huge'), '--made'], opts))).toEqual([])
    expect(await readsBy((opts) => agent(['find', 'dingo'], opts))).toEqual([])
    expect(await searchHits('dingo')).toEqual([])
    expect(await status()).toMatchObject({ files: 0, pending: 0, tooMany: 1 })
    expect(await itemText('huge')).toContain('正文：目录里至少 5001 个文件，超过 5000 个，不索引')
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
    sb = sandbox()
    outside = tempDir('pb-s-outside-')
    const as = (l: string, args: string[], opts: RunOptions = {}) => sb.run(['--library', l, '--as', 'claude-code', ...args], { cwd: outside, ...opts })
    const site = join(outside, 'site')
    mkdirSync(site)
    writeFileSync(join(site, 'index.html'), '<p>kookaburra calls</p>')
    const make = async () => {
      const l = join(tempDir(), 'lib')
      ok(await sb.run(['init', l, '--bare']))
      ok(await sb.run(['plugin', 'add', 'search', '--library', l]))
      for (const name of ['kept', 'edited', 'gone']) ok(await as(l, ['put', '-', '--to', `${name}.md`, '--made'], { input: `${name} lyrebird\n` }))
      ok(await as(l, ['put', site, '--to', 'sites/k', '--made']))
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

describe('a file changed through put (C7)', () => {
  it('is found by its new words and not its old', async () => {
    await newLibrary('ledger+search')
    await put('notes/plan.md', '第一版：先做袋熊的页面\n')
    expect((await searchHits('袋熊')).map((h) => h.path)).toEqual(['notes/plan.md'])
    expect(await readsBy((opts) => agent(['put', '-', '--to', 'notes/plan.md', '--made'], { ...opts, input: '第二版：改做鸭嘴兽的页面\n' }))).toEqual(['notes/plan.md'])
    expect((await searchHits('鸭嘴兽')).map((h) => h.path)).toEqual(['notes/plan.md'])
    expect(await searchHits('袋熊')).toEqual([])
  })
})

describe('a folder of files on record, registered as one thing', () => {
  it('is found as the one thing, not also as the files it absorbed, and stays so when the index is rebuilt', async () => {
    await newLibrary('ledger+search')
    await put('notes/a.md', 'bilby burrows\n')
    await put('notes/deep/b.md', 'bilby diet\n')
    writeFileSync(join(lib, 'notes', '.pneuma-item'), '{"format":1}\n')
    ok(await agent(['put', join(lib, 'notes'), '--brought']))
    expect((await searchHits('bilby')).map((h) => h.path)).toEqual(['notes'])
    ok(await owner(['search', 'rebuild']))
    expect((await searchHits('bilby')).map((h) => h.path)).toEqual(['notes'])
  })
})

describe('find by meaning (C7)', () => {
  beforeEach(async () => {
    await newLibrary('search')
    await put('shops/coffee.md', COFFEE)
    await put('shops/pets.md', PETS)
    await put('shops/books.md', BOOKS)
  })

  it('with no embedder there is no hit by meaning; with the hash embedder a sentence finds the closest thing', async () => {
    const sentence = '我想喝杯现磨咖啡' // no word of it is a word of the shops; 咖啡 is half of 咖啡豆
    expect(await hits(sentence)).toEqual([])
    ok(await owner(['search', 'embedder', 'set', '--kind', 'hash']))
    // The other shops share a character pair or two by chance: far less near, so left out.
    expect(await hits(sentence)).toEqual([{ path: 'shops/coffee.md', title: 'coffee.md', by: 'search', group: null, detail: '按意思：# 豆子与烘焙' }])

    ok(await owner(['search', 'embedder', 'clear']))
    expect(await hits(sentence)).toEqual([])
  })

  it('keeps the embedder configuration in the library and its vectors in the cache', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'hash']))
    const records = readdirSync(join(lib, '.pneuma-base', 'search', 'embedder'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base', 'search', 'embedder', records[0] as string), 'utf8'))).toMatchObject({ embedder: { kind: 'hash' } })
    await hits('咖啡')
    expect(readdirSync(cacheDir()).some((name) => name.endsWith('.sqlite'))).toBe(true)
  })
})

describe('the http embedder (C7)', () => {
  let server: FakeEmbedder
  const setKey = async (key: string) => ok(await sb.run(['secret', 'set', 'search', 'key'], { input: key }))

  beforeEach(async () => {
    server = await fakeEmbedder()
    await newLibrary('search')
    await put('shops/coffee.md', COFFEE)
    await put('shops/pets.md', PETS)
    await put('shops/books.md', BOOKS)
  })
  afterEach(() => server.close())

  it('finds by meaning through an OpenAI-compatible server; the key is a secret of this machine, never in the library', async () => {
    const unset = ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', `${server.url}/v1`, '--model', 'concepts-1']))
    expect(unset.stdout).toContain('pneuma-base secret set search key')
    await setKey('test-key-123')
    const set = ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', `${server.url}/v1`, '--model', 'concepts-1']))
    expect(set.stdout).toContain('concepts-1')
    expect(set.stdout).toContain('密钥已设')
    expect(set.stdout).not.toContain('test-key-123')
    const r = ok(await agent(['find', '想喝点提神的饮料', '--json']))
    expect(r.json().hits[0]).toMatchObject({ path: 'shops/coffee.md', by: 'search', detail: '按意思：# 豆子与烘焙' })
    expect(server.requests.length).toBeGreaterThan(0)
    expect(server.requests.slice(1).every((q) => q.authorization === 'Bearer test-key-123' && q.model === 'concepts-1')).toBe(true)
    const sent = server.requests.flatMap((q) => q.input)
    expect(sent).toContain('想喝点提神的饮料')
    expect(sent.some((text) => text.includes('拿铁'))).toBe(true)

    const written = readdirSync(lib, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
    expect(written.some((text) => text.includes('test-key-123'))).toBe(false)
  })

  it('embeds each piece once, and again when the embedder changes', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'hash']))
    await hits('咖啡')
    ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', server.url, '--model', 'concepts-1']))
    const afterProbe = server.requests.length
    ok(await agent(['find', '咖啡']))
    const pieces = server.requests.slice(afterProbe).flatMap((q) => q.input)
    expect(pieces.filter((text) => text.startsWith('# '))).toHaveLength(3)

    const before = server.requests.length
    ok(await agent(['find', '猫']))
    expect(server.requests.slice(before).flatMap((q) => q.input)).toEqual(['猫'])
  })

  it('a server that is down costs only the hits by meaning: the words still match and the failure is listed', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', server.url, '--model', 'concepts-1']))
    await server.close()
    const r = await agent(['find', '拿铁', '--json'])
    expect(r.code).toBe(3)
    expect(r.json().hits.map((h: any) => [h.path, h.by])).toEqual([['shops/coffee.md', 'search']])
    expect(r.json().problems).toMatchObject([{ plugin: 'search', message: expect.stringContaining('嵌入') }])
    server = await fakeEmbedder() // afterEach closes it
  })

  it('rebuild with the server down rebuilds the words and says the vectors are missing', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', server.url, '--model', 'concepts-1']))
    await server.close()
    const r = await owner(['search', 'rebuild'])
    expect(r.code).toBe(2)
    expect(r.stdout).toMatch(/^拒绝（embedder-failed）：已重建索引：3 个文件，其中文本 3 个，3 块。按意思的向量没建完（0 \/ 3 块）：嵌入服务连不上/)
    server = await fakeEmbedder() // afterEach closes it
  })

  it('an embedder recorded with a key variable still loads; the variable is not read, and status says the key is a secret now and how to set it', async () => {
    const KEY_ENV = 'PB_TEST_EMBED_KEY'
    const record = { format: 1, at: '2026-11-01T00:00:00.000Z', embedder: { kind: 'http', url: server.url, model: 'concepts-1', keyEnv: KEY_ENV } }
    mkdirSync(join(lib, '.pneuma-base', 'search', 'embedder'), { recursive: true })
    writeFileSync(join(lib, '.pneuma-base', 'search', 'embedder', '20261101000000000-aaaaaaaa.json'), `${JSON.stringify(record)}\n`)
    const env = { env: { [KEY_ENV]: 'from-the-environment' } }
    const before = ok(await owner(['search', 'status'], env)).stdout
    expect(before).toContain(`密钥原来取自环境变量 ${KEY_ENV}`)
    expect(before).toContain('pneuma-base secret set search key')
    ok(await agent(['find', '想喝点提神的饮料'], env))
    expect(server.requests.length).toBeGreaterThan(0)
    expect(server.requests.every((q) => q.authorization === undefined)).toBe(true)
    await setKey('test-key-123')
    expect(ok(await owner(['search', 'status'])).stdout).toContain('密钥已设')
    const sent = server.requests.length
    ok(await agent(['find', '猫']))
    expect(server.requests.slice(sent).map((q) => q.authorization)).toEqual(['Bearer test-key-123'])
  })
})

describe('the owner commands', () => {
  beforeEach(async () => {
    await newLibrary('search')
    await put('a.md', '退款在七天内处理。\n')
  })

  const refusedAsUsage = (r: Run, text: string) => {
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(text)
  }

  it('status says what is indexed and which embedder is set', async () => {
    const status = ok(await owner(['search', 'status', '--json'])).json()
    expect(status.data).toMatchObject({ files: 1, textFiles: 1, chunks: 1, pending: 0, tooMany: 0, embedder: null })
    expect(ok(await owner(['search', 'status'])).stdout).toContain('没配嵌入器')
  })

  it('rebuild builds the index again from the registered things', async () => {
    const r = ok(await owner(['search', 'rebuild', '--json'])).json()
    expect(r.data).toMatchObject({ files: 1, textFiles: 1, chunks: 1 })
    expect((await searchHits('退款')).map((h) => h.path)).toEqual(['a.md'])
  })

  it('refuses an http embedder without an address or a model, and a key or key variable written in a flag', async () => {
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--model', 'm']), '--url')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', 'http://127.0.0.1:9']), '--model')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key', 'sk-secret']), '不认识 --key')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key-env', 'MY_KEY']), '不认识 --key-env')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'magic']), 'hash')
    expect(existsSync(join(lib, '.pneuma-base', 'search', 'embedder'))).toBe(false)
  })

  it('none is destructive: an agent with a grant runs status and rebuild; the embedder is the owner’s to choose', async () => {
    ok(await owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    for (const args of [['search', 'status'], ['search', 'rebuild']]) ok(await sb.run(['@claude', ...args], { cwd: outside, env: { CLAUDE_CODE_SESSION_ID: 's-1' } }))
    for (const args of [['search', 'embedder', 'set', '--kind', 'hash'], ['search', 'embedder', 'clear']]) {
      const r = await sb.run(['@claude', ...args, '--json'], { cwd: outside, env: { CLAUDE_CODE_SESSION_ID: 's-1' } })
      expect(r.code).toBe(2)
      expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    }
  })
})

describe('the cognition section comes and goes with the plugin (C8)', () => {
  it('appears on plugin add with the condition for meaning, and goes on plugin remove; without the plugin find reads no content', async () => {
    await newLibrary('bare')
    await put('a.md', 'zebra crossings\n')
    const description = () => readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')
    expect(description()).not.toContain('**查找**插件')
    expect(await hits('zebra')).toEqual([])
    const unknown = await owner(['search', 'status'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('不认识的命令')

    ok(await owner(['plugin', 'add', 'search']))
    expect(description()).toContain('**查找**插件')
    expect(description()).toMatch(/主人配了嵌入器时[^\n]*按意思/)
    // Put before the plugin was added: its body is indexed once it is registered again.
    expect(await hits('zebra')).toEqual([])
    await register('a.md')
    expect((await hits('zebra')).map((h) => h.path)).toEqual(['a.md'])

    ok(await owner(['plugin', 'remove', 'search']))
    expect(description()).not.toContain('**查找**插件')
    expect(await hits('zebra')).toEqual([])
  })

  it('beside the ledger, a path stands at the best rank either gave it, so the most relevant file is not pushed down by the ledger’s order', async () => {
    await newLibrary('ledger+search')
    const filler = '天气、交通、工作安排、读书计划、周末的打算、房租、快递、体检、旅行、搬家。'
    // The ledger matches its records, not content (ARCHITECTURE.md「找和看」): each put's note holds some of the words
    // asked for. alpha and beta are in no file, so search ranks by 咖啡 alone.
    const noted = async (path: string, content: string, note: string) => ok(await agent(['put', '-', '--to', path, '--made', '--note', note], { input: content }))
    await noted('notes/y.md', `一份杂记，提到一次咖啡。${filler}\n`, '咖啡 alpha beta')
    await noted('notes/z.md', `另一份杂记，也提到一次咖啡。${filler}${filler}\n`, '咖啡 alpha')
    await noted('notes/x.md', '咖啡 咖啡 咖啡：手冲咖啡的咖啡豆。\n', '咖啡')
    const asked = '咖啡 alpha beta'
    const order = (all: { path: string | null }[]) => [...new Set(all.flatMap((h) => (h.path === null ? [] : [h.path])))]
    // The ledger alone ranks them by how many of the words their notes hold, x last. Search alone ranks x first (bm25: short, three times).
    ok(await owner(['plugin', 'remove', 'search']))
    expect(order(await hits(asked))).toEqual(['notes/y.md', 'notes/z.md', 'notes/x.md'])
    ok(await owner(['plugin', 'add', 'search']))
    // y and x are each one answerer's first; y comes first as the ledger comes first in the configuration.
    expect(order(await hits(asked))).toEqual(['notes/y.md', 'notes/x.md', 'notes/z.md'])
    expect(ok(await agent(['find', asked])).stdout.split('\n').filter((l) => l.startsWith('  notes/')).map((l) => l.trim().split(' ')[0])).toEqual(['notes/y.md', 'notes/x.md', 'notes/z.md'])
  })

  it('sits beside the ledger: one entry per path in the text, the ledger’s detail and the snippet on its line', async () => {
    await newLibrary('ledger+search')
    await put('notes/zebra.md', 'zebra crossings near the shop\n')
    const r = ok(await agent(['find', 'crossings', '--json'])).json()
    expect(r.hits.filter((h: any) => h.path === 'notes/zebra.md').map((h: any) => h.by).sort()).toEqual(['ledger', 'search'])
    const text = ok(await agent(['find', 'crossings'])).stdout
    expect(text).toMatch(/notes\/zebra\.md {2}做出来的 {2}正文：zebra crossings near the shop/)
  })

  // Only Node versions that still mark node:sqlite experimental (22, early 24 and 25) can fail this.
  it('keeps stderr clean across put and find', async () => {
    await newLibrary('ledger+search')
    const placed = ok(await agent(['put', '-', '--to', 'clean.md', '--made'], { input: '干净的标准错误输出\n' }))
    expect(placed.stderr).toBe('')
    const searched = ok(await agent(['find', '干净']))
    expect(searched.stderr).toBe('')
  })
})
