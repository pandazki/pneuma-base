// The plugin's page and its section of the item panel, called directly: blocks of the kernel's
// kinds that say what the index holds, which embedder is set, and owner commands as actions.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, BUNDLE_MARKER, initLibrary, makeContext, openLibrary, pluginContext, ownerFace, type Action, type Block, type LibraryPath, type PluginContext, type Session } from '@pneuma-base/kernel'
import { search } from '../src/index.js'

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
const session: Session = { id: 'views-test', source: 'flag', cwd: '/', machine: 'test', transcript: null }

async function library() {
  const root = join(tempDir('pb-sv-'), 'lib')
  const home = tempDir('pb-sv-home-')
  const table = new Map([[search.name as string, search]])
  await initLibrary(root, { plugins: ['search'], table, actor: { kind: 'owner' }, session, home })
  const open = async () => {
    const lib = await openLibrary(root, table)
    if (!lib) throw new Error('no library')
    const ctx = makeContext(lib, { kind: 'owner' }, session, home)
    const pctx: PluginContext = pluginContext(ctx, search.name)
    return { ctx, pctx, table }
  }
  return {
    write: (path: string, content: string | Buffer) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    },
    register: async (path: string) => {
      const r = await agentFace.put({ kind: 'register', path, origin: { kind: 'made', from: [], outside: [] } }, (await open()).ctx)
      if (r.outcome !== 'accepted') throw new Error(`not registered: ${r.reason}`)
    },
    dropCache: async () => rmSync((await open()).pctx.cacheDir, { recursive: true, force: true }),
    find: async (text: string) => agentFace.find({ text, match: 'terms', filters: {}, includeArchived: false, skipOwnSession: false }, (await open()).ctx),
    owner: async (name: string, flags: Record<string, string[]> = {}) => {
      const { ctx } = await open()
      return ownerFace.dispatch({ ctx, table, env: {}, viaGrant: false, confirm: async () => false }, name, { positional: [], flags })
    },
    status: async () => (await search.onView?.({ view: 'search.status', params: {} }, (await open()).pctx)) ?? null,
    item: async (path: string) => (await search.onItemView?.(path as LibraryPath, (await open()).pctx)) ?? null,
  }
}

/** Each fields block's label and text, sections opened. */
function fields(blocks: Block[]): Record<string, string> {
  return Object.fromEntries(
    blocks.flatMap((b): [string, string][] => (b.kind === 'fields' ? b.fields.map((f) => [f.label, f.value.text]) : b.kind === 'section' ? Object.entries(fields(b.blocks)) : [])),
  )
}

function actions(blocks: Block[]): Action[] {
  return blocks.flatMap((b) => (b.kind === 'actions' ? b.actions : b.kind === 'section' ? [...b.actions, ...actions(b.blocks)] : []))
}

describe('the search.status view', () => {
  it('is declared for the navigation', () => {
    expect(search.views).toEqual([{ id: 'search.status', title: '查找', icon: 'search', nav: true, filters: [] }])
  })

  it('says there is no index yet, and offers the owner commands as actions', async () => {
    const lib = await library()
    const view = await lib.status()
    expect(fields(view?.blocks ?? [])).toMatchObject({ 文件: '还没有索引', 嵌入器: '没配嵌入器，find 只按文字找' })
    const calls = actions(view?.blocks ?? []).map((a) => a.call)
    expect(calls).toEqual([
      { face: 'owner', command: 'search rebuild', args: { positional: [], flags: {} } },
      { face: 'owner', command: 'search embedder set', args: { positional: [], flags: { kind: ['{kind}'], url: ['{url}'], model: ['{model}'] } } },
    ])
    const set = actions(view?.blocks ?? [])[1]
    expect(set?.inputs.find((i) => i.name === 'kind')?.options?.map((o) => o.value)).toEqual(['hash', 'http'])

    expect((await lib.owner('search embedder set', { kind: ['hash'] })).outcome).toBe('done')
    expect(actions((await lib.status())?.blocks ?? []).map((a) => a.call)).toContainEqual({ face: 'owner', command: 'search embedder clear', args: { positional: [], flags: {} } })
  })

  it('counts what is indexed, what is left to read, and the vectors of the embedder that is set', async () => {
    const lib = await library()
    lib.write('a.md', '退款在七天内处理。\n')
    lib.write('logo.png', Buffer.from([0x89, 0x00, 0xff]))
    await lib.register('a.md')
    await lib.register('logo.png')
    expect(fields((await lib.status())?.blocks ?? [])).toMatchObject({ 文件: '2 个，其中文本 1 个', 块: '1', 待读: '没有' })

    expect((await lib.owner('search embedder set', { kind: ['hash'] })).outcome).toBe('done')
    await lib.find('退款')
    expect(fields((await lib.status())?.blocks ?? [])).toMatchObject({ 嵌入器: 'hash：特征哈希，不用模型', 向量: '1 / 1 块' })
  })
})

describe('the item section', () => {
  it('says whether a thing is indexed, in how many pieces, and how many have vectors', async () => {
    const lib = await library()
    lib.write('a.md', '退款在七天内处理。\n')
    lib.write('logo.png', Buffer.from([0x89, 0x00, 0xff]))
    lib.write('sites/a/index.html', '<p>冷制皂</p>')
    lib.write('sites/a/about.html', '<p>工作室</p>')
    lib.write(`sites/a/${BUNDLE_MARKER}`, '{"format":1}\n')
    for (const path of ['a.md', 'logo.png', 'sites/a']) await lib.register(path)
    lib.write('new.md', '新来的\n')

    expect(await lib.item('a.md')).toEqual({ title: '查找', blocks: [{ kind: 'fields', fields: [{ label: '正文', value: { text: '已索引，1 块' } }, { label: '按意思', value: { text: '没配嵌入器' } }] }] })
    expect(fields((await lib.item('logo.png'))?.blocks ?? [])).toMatchObject({ 正文: '不是文本，不索引正文' })
    expect(fields((await lib.item('new.md'))?.blocks ?? [])).toMatchObject({ 正文: '没有索引：查找插件的记录里没有它' })
    expect(fields((await lib.item('sites/a'))?.blocks ?? [])).toMatchObject({ 正文: '已索引 2 个文件，2 块' })

    await lib.owner('search embedder set', { kind: ['hash'] })
    await lib.find('退款')
    expect(fields((await lib.item('a.md'))?.blocks ?? [])).toMatchObject({ 按意思: '1 / 1 块有向量' })

    await lib.dropCache()
    expect(fields((await lib.item('a.md'))?.blocks ?? [])).toMatchObject({ 正文: '还没读，下次 find 时读' })
    await lib.find('退款')
    expect(fields((await lib.item('a.md'))?.blocks ?? [])).toMatchObject({ 正文: '已索引，1 块' })
  })

  it('gives nothing for a path where there is no thing', async () => {
    const lib = await library()
    expect(await lib.item('nothing.md')).toBeNull()
  })
})
