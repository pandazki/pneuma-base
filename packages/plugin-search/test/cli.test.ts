// C7 and C8 through the real command line. With the search plugin, find matches the content of
// things, ranked by relevance, each hit with its context; two-character Chinese words match; the
// index is a cache whose deletion changes no answer; with an embedder, a sentence finds things by
// meaning, and an embedder that fails costs only the hits by meaning. The cognition section comes
// and goes with the plugin and promises meaning only on the condition that an embedder is set.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeEmbedder, libraryId, ok, sandbox, tempDir, type FakeEmbedder, type Run, type RunOptions, type Sandbox } from './cli-support.js'

let sb: Sandbox
let lib: string
let outside: string

const agent = (args: string[], opts: RunOptions = {}) => sb.run(['--library', lib, '--as', 'claude-code', ...args], { cwd: outside, ...opts })
const owner = (args: string[], opts: RunOptions = {}) => sb.run([...args, '--library', lib], opts)
const put = async (path: string, content: string) => ok(await agent(['put', '-', '--to', path, '--made'], { input: content }))
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
    expect(hit?.detail).toMatch(/^index\.html：.*冷制皂.*橄榄油&椰子油/)
    expect(hit?.detail).not.toContain('<')
    expect((await searchHits('工作室')).map((h) => h.path)).toEqual(['sites/soap'])
  })

  it('reads a large file up to its first 1 MB and says so', async () => {
    const filler = Array.from({ length: 40_000 }, (_, i) => `filler line ${i} of the log`).join('\n')
    writeFileSync(join(lib, 'big.log'), `alphaword starts the log\n${filler}\nomegaword ends it\n`)
    expect(statSync(join(lib, 'big.log')).size).toBeGreaterThan(1024 * 1024)
    const [hit] = await searchHits('alphaword')
    expect(hit?.path).toBe('big.log')
    expect(hit?.detail).toContain('只索引了前 1 MB')
    expect(await searchHits('omegaword')).toEqual([])
  })

  it('does not index a file that is not UTF-8 text', async () => {
    writeFileSync(join(lib, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7a, 0x65, 0x62, 0x72, 0x61]))
    expect(await searchHits('zebra')).toEqual([])
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
  const KEY_ENV = 'PB_TEST_EMBED_KEY'
  const withKey = { env: { [KEY_ENV]: 'test-key-123' } }

  beforeEach(async () => {
    server = await fakeEmbedder()
    await newLibrary('search')
    await put('shops/coffee.md', COFFEE)
    await put('shops/pets.md', PETS)
    await put('shops/books.md', BOOKS)
  })
  afterEach(() => server.close())

  it('finds by meaning through an OpenAI-compatible server; the key stays in the environment', async () => {
    const set = ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', `${server.url}/v1`, '--model', 'concepts-1', '--key-env', KEY_ENV], withKey))
    expect(set.stdout).toContain('concepts-1')
    const r = ok(await agent(['find', '想喝点提神的饮料', '--json'], withKey))
    expect(r.json().hits[0]).toMatchObject({ path: 'shops/coffee.md', by: 'search', detail: '按意思：# 豆子与烘焙' })
    expect(server.requests.length).toBeGreaterThan(0)
    expect(server.requests.every((q) => q.authorization === 'Bearer test-key-123' && q.model === 'concepts-1')).toBe(true)
    const sent = server.requests.flatMap((q) => q.input)
    expect(sent).toContain('想喝点提神的饮料')
    expect(sent.some((text) => text.includes('拿铁'))).toBe(true)

    const written = readdirSync(lib, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
    expect(written.some((text) => text.includes('test-key-123'))).toBe(false)
    expect(written.some((text) => text.includes(KEY_ENV))).toBe(true)
  })

  it('embeds each piece once, and again when the embedder changes', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'hash']))
    await hits('咖啡')
    ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', server.url, '--model', 'concepts-1', '--key-env', KEY_ENV], withKey))
    const afterProbe = server.requests.length
    ok(await agent(['find', '咖啡'], withKey))
    const pieces = server.requests.slice(afterProbe).flatMap((q) => q.input)
    expect(pieces.filter((text) => text.startsWith('# '))).toHaveLength(3)

    const before = server.requests.length
    ok(await agent(['find', '猫'], withKey))
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

  it('a key variable that is not set is a problem, not a failed find', async () => {
    ok(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', server.url, '--model', 'concepts-1', '--key-env', KEY_ENV]))
    const r = await agent(['find', '拿铁', '--json'])
    expect(r.code).toBe(3)
    expect(r.json().hits.map((h: any) => h.path)).toEqual(['shops/coffee.md'])
    expect(r.json().problems[0].message).toContain(KEY_ENV)
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
    const empty = ok(await owner(['search', 'status']))
    expect(empty.stdout).toContain('还没有索引')
    ok(await agent(['find', '退款']))
    const status = ok(await owner(['search', 'status', '--json'])).json()
    expect(status.data).toMatchObject({ files: 1, textFiles: 1, chunks: 1, stale: 0, embedder: null })
    expect(ok(await owner(['search', 'status'])).stdout).toContain('没配嵌入器')
  })

  it('rebuild builds the index again from the files', async () => {
    const r = ok(await owner(['search', 'rebuild', '--json'])).json()
    expect(r.data).toMatchObject({ files: 1, textFiles: 1, chunks: 1 })
    expect((await searchHits('退款')).map((h) => h.path)).toEqual(['a.md'])
  })

  it('refuses an http embedder without an address or a model, and a key written in the open', async () => {
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--model', 'm']), '--url')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', 'http://127.0.0.1:9']), '--model')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'http', '--url', 'http://127.0.0.1:9', '--model', 'm', '--key', 'sk-secret']), '--key-env')
    refusedAsUsage(await owner(['search', 'embedder', 'set', '--kind', 'magic']), 'hash')
    expect(existsSync(join(lib, '.pneuma-base', 'search', 'embedder'))).toBe(false)
  })

  it('none is destructive: an agent with a grant runs them', async () => {
    ok(await owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    for (const args of [['search', 'status'], ['search', 'rebuild'], ['search', 'embedder', 'set', '--kind', 'hash'], ['search', 'embedder', 'clear']]) {
      ok(await sb.run(['@claude', ...args], { cwd: outside, env: { CLAUDE_CODE_SESSION_ID: 's-1' } }))
    }
  })
})

describe('the cognition section comes and goes with the plugin (C8)', () => {
  it('appears on plugin add with the condition for meaning, and goes on plugin remove; without the plugin find reads no content', async () => {
    await newLibrary('bare')
    await put('a.md', 'zebra crossings\n')
    const description = () => readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')
    expect(description()).not.toContain('查找插件')
    expect(await hits('zebra')).toEqual([])
    const unknown = await owner(['search', 'status'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('不认识的命令')

    ok(await owner(['plugin', 'add', 'search']))
    expect(description()).toContain('查找插件')
    expect(description()).toMatch(/主人配了嵌入器时[^\n]*按意思/)
    expect(description()).toMatch(/没配[^\n]*只按文字/)
    expect((await hits('zebra')).map((h) => h.path)).toEqual(['a.md'])

    ok(await owner(['plugin', 'remove', 'search']))
    expect(description()).not.toContain('查找插件')
    expect(await hits('zebra')).toEqual([])
  })

  it('sits beside the ledger: one entry per path in the text, the ledger’s detail and the snippet on its line', async () => {
    await newLibrary('ledger+search')
    await put('notes/zebra.md', 'zebra crossings near the shop\n')
    const r = ok(await agent(['find', 'crossings', '--json'])).json()
    expect(r.hits.filter((h: any) => h.path === 'notes/zebra.md').map((h: any) => h.by).sort()).toEqual(['ledger', 'search'])
    const text = ok(await agent(['find', 'crossings'])).stdout
    expect(text).toMatch(/notes\/zebra\.md {2}做出来的 {2}正文：zebra crossings near the shop/)
  })

  it('its commands run as written for an agent with a grant, and the example finds what it promises', async () => {
    await newLibrary('search')
    await put('support/refunds.md', '# 退款流程\n\n客户申请退款后，三天内原路退回。\n')
    ok(await owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    const section = readFileSync(new URL('../cognition/search-section.md', import.meta.url), 'utf8')
    const commands = [...section.matchAll(/```sh\n([\s\S]*?)```/g), ...section.matchAll(/`(pneuma-base [^`]+)`/g)].map((m) => (m[1] as string).trim())
    expect(commands).toEqual(['pneuma-base @{{授权的名字}} find 退款 流程', 'pneuma-base @{{授权的名字}} search status'])
    for (const command of commands) {
      const r = ok(await sb.run(command.replace('{{授权的名字}}', 'claude').split(' ').slice(1), { cwd: outside, env: { CLAUDE_CODE_SESSION_ID: 's-2' } }))
      if (command.includes(' find ')) expect(r.stdout.split('\n')[0]).toBe('support/refunds.md')
    }
  })
})
