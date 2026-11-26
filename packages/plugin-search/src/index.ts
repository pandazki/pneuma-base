import { readFileSync } from 'node:fs'
import { CONTRACT, PNEUMA_BASE_VERSION, pluginName, type AcceptedArchive, type AcceptedPut, type LibraryPath, type Plugin, type PluginContext } from '@pneuma-base/kernel'
import { searchCommands } from './commands.js'
import { KEY_SECRET } from './embed.js'
import { READS, readPending } from './reader.js'
import { append, factOfPut, fold, rowsOf, THINGS, type Fact } from './registry.js'
import { findHits } from './search.js'
import { SearchIndex } from './store.js'
import { itemSection, STATUS_VIEW, statusView } from './views.js'

/** Records `facts` and brings the rows and the index up to them; then reads the things `read` names, as one hook call may. */
async function heard(ctx: PluginContext, facts: (index: SearchIndex) => Promise<Fact[]>, read: (facts: Fact[]) => LibraryPath[] = () => []): Promise<null> {
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  try {
    await fold(ctx, index)
    const written = await facts(index)
    if (written.length === 0) return null
    await append(ctx, written)
    await fold(ctx, index)
    const paths = read(written)
    if (paths.length > 0) await readPending(ctx, index, { files: READS }, paths)
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
 * 查找: find matches the content of the registered things' text files, ranked by bm25, and by meaning
 * when the owner sets an embedder. What it heard registered is facts in its record place; the index
 * lives in the cache directory outside the library.
 */
export const search: Plugin = {
  contract: CONTRACT,
  name: pluginName('search'),
  version: PNEUMA_BASE_VERSION,
  summary: '在登记过的文本文件的正文里找，按相关度排；主人配了嵌入器时也按意思找。',
  cognition: { title: '查找', text: readFileSync(new URL('../cognition/search-section.md', import.meta.url), 'utf8') },
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'embedder', kind: 'body' },
  ],
  statements: [],
  ownerCommands: searchCommands,
  secrets: [{ name: KEY_SECRET, description: 'http 嵌入服务的密钥，作 Bearer 令牌发给它；服务不要密钥就不用设' }],
  views: [{ id: STATUS_VIEW, title: '查找', icon: 'search', nav: true, filters: [] }],

  onPut,
  onArchive,
  async onPurged(paths, ctx) {
    await heard(ctx, async () => [{ kind: 'gone', paths: [...paths] }])
  },
  onFind: findHits,

  async onView(req, ctx) {
    if (req.view !== STATUS_VIEW) throw new Error(`查找插件没有这个视图：${req.view}`)
    return statusView(ctx)
  },

  onItemView: itemSection,
}
