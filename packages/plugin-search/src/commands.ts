// The owner commands the search plugin adds. None can make content unrecoverable: the embedder
// record is a new file each time, and the index and its rows are a cache.
import { defineCommand, type OwnerAnswer, type OwnerCommand, type PluginContext } from '@pneuma-base/kernel'
import { currentEmbedder, recordEmbedder } from './config.js'
import { embedderFor, embedderLabel, KEY_SECRET, SET_KEY, type EmbedderConfig } from './embed.js'
import { readPending } from './reader.js'
import { counts } from './registry.js'
import { embedMissing, messageOf, refresh } from './search.js'
import { SearchIndex } from './store.js'
import { statusOf, statusText } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })
const usage = (text: string) => refused('usage', text)

/** The embedder an owner command chose: `--kind` is one of the options; what http needs besides is checked here. */
function embedderOf(kind: string, url: string | null, model: string | null): EmbedderConfig | string {
  // A form sends every field; for hash the http ones mean nothing.
  if (kind === 'hash') return { kind }
  if (url === null) return `--kind http 需指定 --url <URL>，例如 http://127.0.0.1:11434。`
  if (model === null) return '--kind http 需指定 --model <模型名称>。'
  return { kind: 'http', url, model }
}

/**
 * The named whole pass: a new index, and every registered thing read into it, each file up to its
 * first 1 MB, then a vector for every piece. Says how many things first and how far after each page
 * and batch; stops after the one under way when asked, and what is left is read by the next find.
 */
async function rebuild(ctx: PluginContext): Promise<OwnerAnswer> {
  const config = await currentEmbedder(ctx)
  const key = await ctx.secrets.get(KEY_SECRET)
  const index = SearchIndex.fresh(ctx.cacheDir, ctx.now)
  const stopped = () => ctx.pass?.stopped() ?? false
  let failure: string | null = null
  let stop: string | null = null
  try {
    await refresh(index, ctx, { files: 0 })
    const { pending } = await counts(ctx)
    ctx.pass?.report({ done: 0, total: pending, text: `将重建搜索索引：读取 ${pending} 个已登记条目。` })
    await readPending(ctx, index, { files: Infinity }, undefined, (read) => {
      ctx.pass?.report({ done: read, total: pending, text: `已读取 ${read} / ${pending} 个` })
      if (stopped()) stop = `已停止：已读取 ${read} / ${pending} 个，其余的在下次 find 时继续读取。`
      return stop !== null
    })
    if (config !== null && stop === null) {
      try {
        await embedMissing(index, embedderFor(config, key), (n, total) => {
          ctx.pass?.report({ done: n, total, text: `语义：已建立 ${n} / ${total} 个分块的向量` })
          if (stopped()) stop = `已停止：${n} / ${total} 个分块已有向量，其余的在下次 find 时继续建立。`
          return stop !== null
        })
      } catch (error) {
        failure = messageOf(error)
      }
    }
  } finally {
    index.close()
  }
  const s = await statusOf(ctx)
  const built = `${stop === null ? '已重建索引' : '索引已部分重建'}：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 个分块。`
  if (failure !== null) return refused('embedding-failed', `${built}语义检索的向量未建立完成（${s.vectors} / ${s.chunks} 个分块）：${failure}`)
  return done(`${stop ?? ''}${built}${config ? `语义：${s.vectors} / ${s.chunks} 个分块已有向量。` : ''}`, { ...s, stopped: stop !== null })
}

export const SET_EMBEDDER = defineCommand({
  name: 'search embedding set',
  act: { kind: 'set', object: 'model', name: 'embedding 配置' },
  summary: '配置语义检索使用的 embedding 服务：hash，或兼容 OpenAI 的 HTTP 服务',
  params: {
    flags: [
      {
        name: 'kind',
        hint: '类型',
        kind: 'value',
        required: true,
        options: [
          { value: 'hash', label: 'hash：特征哈希，无需模型' },
          { value: 'http', label: 'http：兼容 OpenAI 的 /v1/embeddings' },
        ],
      },
      { name: 'url', hint: 'URL（HTTP）', kind: 'value', pattern: 'https?://[^\\s/]+\\S*' },
      { name: 'model', hint: '模型（HTTP）', kind: 'value' },
    ],
  },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ kind, url, model }, ctx) {
    const config = embedderOf(kind, url, model)
    if (typeof config === 'string') return usage(config)
    await recordEmbedder(ctx, config)
    // The key never goes into the library: it is this machine's secret, read when set.
    const key = await ctx.secrets.get(KEY_SECRET)
    const probe = await embedderFor(config, key)
      .embed(['测试连接'])
      .then(() => null)
      .catch((error: unknown) => messageOf(error))
    const tried = probe === null ? '测试连接成功。下次执行 find 时为资料库中的文本补充向量。' : `但测试连接失败：${probe}。find 照常进行全文检索，并报告此问题。`
    const secret = config.kind === 'http' && key === null ? `服务需要密钥时，用 ${SET_KEY} 设置，值从标准输入读取；密钥仅保存在本机，不写入资料库。` : ''
    return done(`已配置 embedding：${embedderLabel(config, key !== null)}。${tried}${secret}`, { embedding: config, probe: probe ?? 'ok', key: key !== null })
  },
})

export const searchCommands: OwnerCommand[] = [
  SET_EMBEDDER,
  defineCommand({
    name: 'search embedding clear',
    act: { kind: 'removed', name: 'embedding 配置' },
    summary: '清除 embedding 配置，find 仅进行全文检索',
    params: {},
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run(_values, ctx) {
      if ((await currentEmbedder(ctx)) === null) return done('未配置 embedding。')
      await recordEmbedder(ctx, null)
      return done('已清除 embedding 配置，find 仅进行全文检索。缓存中的向量在下次 find 时删除。')
    },
  }),
  defineCommand({
    name: 'search rebuild',
    summary: '删除搜索索引，重新读取全部已登记条目',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    run: async (_values, ctx) => rebuild(ctx),
  }),
  defineCommand({
    name: 'search status',
    summary: '查看搜索索引的规模、待索引数量和 embedding 配置',
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
