// The owner commands the search plugin adds. None can make content unrecoverable: the embedder
// record is a new file each time, and the index is a cache.
import { rm } from 'node:fs/promises'
import { defineCommand, type OwnerAnswer, type OwnerCommand, type PluginContext } from '@pneuma-base/kernel'
import { currentEmbedder, recordEmbedder } from './config.js'
import { embedderFor, embedderLabel, type EmbedderConfig } from './embed.js'
import { embedMissing, messageOf, refresh } from './search.js'
import { SearchIndex } from './store.js'
import { statusOf, statusText } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })
const usage = (text: string) => refused('usage', text)

/** The embedder an owner command chose: `--kind` is one of the options; what http needs besides is checked here. */
function embedderOf(kind: string, url: string | null, model: string | null, keyEnv: string | null): EmbedderConfig | string {
  // A form sends every field; for hash the http ones mean nothing.
  if (kind === 'hash') return { kind }
  if (url === null) return `--kind http 要写 --url <地址>，比如 http://127.0.0.1:11434。`
  if (model === null) return '--kind http 要写 --model <模型名>。'
  return { kind: 'http', url, model, keyEnv }
}

async function rebuild(ctx: PluginContext): Promise<OwnerAnswer> {
  const config = await currentEmbedder(ctx)
  await rm(ctx.cacheDir, { recursive: true, force: true })
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  let failure: string | null = null
  try {
    await refresh(index, ctx.library.root)
    if (config !== null) {
      try {
        await embedMissing(index, embedderFor(config, process.env))
      } catch (error) {
        failure = messageOf(error)
      }
    }
  } finally {
    index.close()
  }
  const s = await statusOf(ctx)
  const built = `已重建索引：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 块。`
  if (failure !== null) return refused('embedder-failed', `${built}按意思的向量没建完（${s.vectors} / ${s.chunks} 块）：${failure}`)
  return done(`${built}${config ? `按意思：${s.vectors} / ${s.chunks} 块有向量。` : ''}`, s)
}

export const SET_EMBEDDER = defineCommand({
  name: 'search embedder set',
  summary: '设按意思找用的嵌入器：hash，或 OpenAI 兼容的 http 服务',
  params: {
    flags: [
      {
        name: 'kind',
        hint: '种类',
        kind: 'value',
        required: true,
        options: [
          { value: 'hash', label: 'hash：特征哈希，不用模型' },
          { value: 'http', label: 'http：OpenAI 兼容的 /v1/embeddings' },
        ],
      },
      { name: 'url', hint: '地址（http）', kind: 'value', pattern: 'https?://[^\\s/]+\\S*' },
      { name: 'model', hint: '模型（http）', kind: 'value' },
      // The key itself never goes into the library: only the name of the variable that holds it.
      { name: 'key-env', hint: '存密钥的环境变量名（http）', kind: 'value', pattern: '[A-Za-z_][A-Za-z0-9_]*' },
    ],
  },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ kind, url, model, 'key-env': keyEnv }, ctx) {
    const config = embedderOf(kind, url, model, keyEnv)
    if (typeof config === 'string') return usage(config)
    await recordEmbedder(ctx, config)
    const probe = await embedderFor(config, process.env)
      .embed(['试一下能不能用'])
      .then(() => null)
      .catch((error: unknown) => messageOf(error))
    const tried = probe === null ? '试了一次，能用。下次 find 时给库里的文本补上向量。' : `不过试了一次没成：${probe}。find 照常按文字找，并报这个问题。`
    return done(`已设好嵌入器：${embedderLabel(config)}。${tried}`, { embedder: config, probe: probe ?? 'ok' })
  },
})

export const searchCommands: OwnerCommand[] = [
  SET_EMBEDDER,
  defineCommand({
    name: 'search embedder clear',
    summary: '清除嵌入器，find 只按文字找',
    params: {},
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run(_values, ctx) {
      if ((await currentEmbedder(ctx)) === null) return done('本来就没配嵌入器。')
      await recordEmbedder(ctx, null)
      return done('已清除嵌入器，find 只按文字找。缓存里的向量下次 find 时删掉。')
    },
  }),
  defineCommand({
    name: 'search rebuild',
    summary: '删掉查找的索引，从库里的文件重建',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    run: async (_values, ctx) => rebuild(ctx),
  }),
  defineCommand({
    name: 'search status',
    summary: '查找的索引有多少、待更新多少、配了什么嵌入器',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run(_values, ctx) {
      const s = await statusOf(ctx)
      return done(statusText(s), s)
    },
  }),
]
