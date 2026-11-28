import { readFileSync } from 'node:fs'
import { CONTRACT, PNEUMA_BASE_VERSION, pluginName, type AcceptedArchive, type AcceptedPut, type LibraryPath, type Plugin, type PluginContext } from '@pneuma-base/kernel'
import { searchCommands } from './commands.js'
import { KEY_SECRET } from './embed.js'
import { READS, readPending } from './reader.js'
import { append, factOfPut, fold, rowsOf, THINGS, type Fact } from './registry.js'
import { findHits } from './search.js'
import { SearchIndex } from './store.js'
import { itemSection, STATUS_VIEW, statusView } from './views.js'

/** Records `facts` and brings the rows and the index up to them; then reads the things `read` names, at most `files` files (as many as one hook call may). */
async function heard(ctx: PluginContext, facts: (index: SearchIndex) => Promise<Fact[]>, read: (facts: Fact[]) => LibraryPath[] = () => [], files = READS): Promise<null> {
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  try {
    await fold(ctx, index)
    const written = await facts(index)
    if (written.length === 0) return null
    await append(ctx, written)
    await fold(ctx, index)
    const paths = read(written)
    if (paths.length > 0) await readPending(ctx, index, { files }, paths)
    return null
  } finally {
    index.close()
  }
}

/** The things a put registered, placed or moved: the ones its hook reads. */
const putPaths = (facts: Fact[]): LibraryPath[] => facts.flatMap((f) => (f.kind === 'seen' ? f.things.map((t) => t.path) : f.kind === 'moved' ? [f.to] : []))

async function onPut(req: AcceptedPut, ctx: PluginContext): Promise<null> {
  return heard(
    ctx,
    async () => {
      const known = req.kind === 'register-files' ? new Set((await rowsOf(ctx.tools.storage.records, THINGS, req.files.map((f) => f.path))).keys()) : undefined
      const fact = factOfPut(req, known)
      return fact === null ? [] : [fact]
    },
    putPaths,
  )
}

/** An archive or unarchive moves a thing; what is at its new place says whether it is a file or a directory thing. */
async function onArchive(req: AcceptedArchive, ctx: PluginContext): Promise<null> {
  if (!req.moved) return null
  return heard(ctx, async () => {
    const [at] = await ctx.tools.what([req.to])
    return at?.kind === 'file' || at?.kind === 'bundle' ? [{ kind: 'moved', from: req.from, to: req.to, bundle: at.kind === 'bundle' }] : [{ kind: 'gone', paths: [req.from] }]
  })
}

/**
 * 搜索: find matches the content of the registered things' text files, ranked by bm25, and by meaning
 * when the owner sets an embedder. What it heard registered is facts in its record place; the index
 * lives in the cache directory outside the library.
 */
export const search: Plugin = {
  contract: CONTRACT,
  name: pluginName('search'),
  version: PNEUMA_BASE_VERSION,
  title: '搜索',
  summary: '全文检索，可启用语义检索',
  about: '在已登记的文本文件中进行全文检索，按相关度排序；配置 embedding 后可进行语义检索。',
  cognition: { title: '搜索', text: readFileSync(new URL('../cognition/search-section.md', import.meta.url), 'utf8') },
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'embedder', kind: 'body' },
  ],
  statements: [],
  ownerCommands: searchCommands,
  secrets: [{ name: KEY_SECRET, title: 'API 密钥', description: 'HTTP embedding 服务的密钥，作为 Bearer token 发送；服务无需密钥时不必设置' }],
  views: [{ id: STATUS_VIEW, title: '搜索', icon: 'search', nav: true, filters: [], with: 'settings' }],

  onPut,
  onArchive,
  async onPurged(paths, ctx) {
    await heard(ctx, async () => [{ kind: 'gone', paths: [...paths] }])
  },
  onFind: findHits,

  /** A page of what was registered before it was added: the things it did not know are recorded as heard, and read, every one of them. */
  async catchUp(things, ctx) {
    await heard(
      ctx,
      async () => {
        const known = await rowsOf(ctx.tools.storage.records, THINGS, things.map((t) => t.place))
        const fresh = things.filter((t) => !known.has(t.place)).map((t) => ({ path: t.place, bundle: t.kind === 'bundle' }))
        return fresh.length === 0 ? [] : [{ kind: 'seen', things: fresh }]
      },
      putPaths,
      Infinity,
    )
  },

  async onView(req, ctx) {
    if (req.view !== STATUS_VIEW) throw new Error(`搜索插件不存在此视图：${req.view}`)
    return statusView(ctx)
  },

  onItemView: itemSection,
}
