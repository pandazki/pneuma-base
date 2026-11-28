// What the owner and the UI see of the index: its status, and what it has of one thing, from the index
// and the rows. These only read; nothing here builds or changes the index or the rows.
import { formOf, type Action, type Block, type Instant, type ItemSection, type LibraryPath, type OwnerArgs, type PluginContext, type ViewAnswer } from '@pneuma-base/kernel'
import { SET_EMBEDDER } from './commands.js'
import { currentEmbedder } from './config.js'
import { embedderFor, embedderLabel, KEY_SECRET, type EmbedderConfig } from './embed.js'
import { counts, PENDING, rowsDescribe, THINGS, TOKENS, type Observed, type Outcome, type Thing } from './registry.js'
import { SearchIndex } from './store.js'

export const STATUS_VIEW = 'search.status'

/** `pending`: registered things the next find reads; `tooMany`: directory things with more files than one thing takes, not indexed. */
export type Status = {
  indexed: boolean
  files: number
  textFiles: number
  chunks: number
  pending: number
  tooMany: number
  vectors: number
  builtAt: Instant | null
  embedding: EmbedderConfig | null
  /** Whether the embedder's secret key is set on this machine. */
  key: boolean
  cacheDir: string
}

const embedderId = (config: EmbedderConfig | null) => (config === null ? null : embedderFor(config, null).id)

export async function statusOf(ctx: PluginContext): Promise<Status> {
  const embedder = await currentEmbedder(ctx)
  const key = (await ctx.secrets.get(KEY_SECRET)) !== null
  const none: Status = { indexed: false, files: 0, textFiles: 0, chunks: 0, ...(await counts(ctx)), vectors: 0, builtAt: null, embedding: embedder, key, cacheDir: ctx.cacheDir }
  const index = SearchIndex.peek(ctx.cacheDir)
  if (index === null) return none
  try {
    return { ...none, indexed: true, ...index.stats(embedderId(embedder)) }
  } finally {
    index.close()
  }
}

const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
const filesText = (s: Status) => `${s.files} 个，其中文本 ${s.textFiles} 个`
const pendingText = (s: Status) => (s.pending === 0 ? '无' : `${s.pending} 个条目，下次 find 时读取`)
const tooManyText = (s: Status) => `${s.tooMany} 个，超过 5000 个文件，不索引`
const vectorsText = (s: Status) => `${s.vectors} / ${s.chunks} 个分块`

export function statusText(s: Status): string {
  const embedder = `embedding 服务：${embedderLabel(s.embedding, s.key)}${s.embedding && s.indexed ? `；${vectorsText(s)}已有向量` : ''}`
  if (!s.indexed) return ['暂无索引；下次执行 find 或 search rebuild 时建立。', embedder].join('\n')
  const tooMany = s.tooMany > 0 ? `；过大的目录：${tooManyText(s)}` : ''
  return [`索引：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 个分块；待索引：${pendingText(s)}${tooMany}`, embedder, `创建时间 ${when(s.builtAt ?? '')} · 缓存位置 ${s.cacheDir}（删除后可重建）`].join('\n')
}

const owner = (command: string, flags: OwnerArgs['flags'] = {}) => ({ face: 'owner' as const, command, args: { positional: [], flags } })
const action = (label: string, call: Action['call'], inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })
const field = (label: string, text: string, mono = false) => ({ label, value: mono ? { text, mono } : { text } })

/** The form of `search embedding set`, made from its params, filled with the embedder in force. */
function setAction(current: EmbedderConfig | null): Action {
  const http = current?.kind === 'http' ? current : null
  const values = { kind: current?.kind ?? 'hash', ...(http ? { url: http.url, model: http.model } : {}) }
  const { inputs, call } = formOf(SET_EMBEDDER, { values })
  return action('配置 embedding', call, inputs)
}

export async function statusView(ctx: PluginContext): Promise<ViewAnswer> {
  const s = await statusOf(ctx)
  const index: Block = {
    kind: 'section',
    title: '索引',
    note: null,
    about: `已登记的条目进入索引；索引位于资料库之外的缓存目录（${s.cacheDir}），删除后可重建。`,
    count: null,
    blocks: [
      {
        kind: 'fields',
        // Nothing waiting to be read is the usual state; how many pieces the text was cut into is the index's business.
        fields: s.indexed
          ? [
              field('文件', filesText(s)),
              ...(s.pending === 0 ? [] : [field('待索引', pendingText(s))]),
              ...(s.tooMany > 0 ? [field('过大的目录', tooManyText(s))] : []),
              field('创建时间', when(s.builtAt ?? '')),
              { label: '分块', value: { text: String(s.chunks), normal: true as const } },
              { label: '缓存', value: { text: s.cacheDir, mono: true, normal: true as const } },
            ]
          : [field('文件', '暂无索引')],
      },
    ],
    actions: [{ ...action('重建索引', owner('search rebuild')), as: 'icon', icon: 'refresh-cw' }],
  }
  const meaning: Block = {
    kind: 'section',
    title: '语义检索',
    note: null,
    about: '配置 embedding 后，find 才进行语义检索。',
    count: null,
    blocks: [{ kind: 'fields', fields: [field('embedding 服务', embedderLabel(s.embedding, s.key)), ...(s.embedding && s.indexed ? [field('向量', vectorsText(s))] : [])] }],
    actions: [{ ...setAction(s.embedding), icon: 'pencil', ...(s.embedding ? { as: 'icon' as const } : {}) }, ...(s.embedding ? [{ ...action('清除 embedding 配置', owner('search embedding clear')), as: 'menu' as const }] : [])],
  }
  return { title: '搜索', subtitle: null, blocks: [index, meaning] }
}

const WHY: Record<string, string> = { elsewhere: '内容未下载', not_a_file: '该位置不是文件', not_a_dir: '该位置不是目录', unreadable: '存储无法读取', noise: '已被忽略' }

/** What a read that did not index the thing found. */
function unindexed(outcome: Exclude<Outcome, { state: 'read' }>): string {
  if (outcome.state === 'gone') return '已缺失，不索引'
  if (outcome.state === 'too_many') return `目录内至少 ${outcome.atLeast} 个文件，超过 5000 个，不索引`
  return `无法读取（${WHY[outcome.reason] ?? outcome.reason}），不索引`
}

/** What the index has of the thing at `path`: whether its text is indexed, in how many pieces, and how many have vectors. */
export async function itemSection(path: LibraryPath, ctx: PluginContext): Promise<ItemSection | null> {
  const { records } = ctx.tools.storage
  const thing = (await records.get<Thing>(THINGS, [path])).rows[0]?.value
  const fields = (text: string, meaning: string | null) => ({ title: '搜索', blocks: [{ kind: 'fields' as const, fields: [field('全文', text), ...(meaning === null ? [] : [field('语义', meaning)])] }] })
  if (thing === undefined) {
    const [at] = await ctx.tools.what([path])
    return at?.kind === 'file' || at?.kind === 'bundle' ? fields('未索引：搜索插件中无此条目的记录', null) : null
  }
  const embedder = await currentEmbedder(ctx)
  const index = SearchIndex.peek(ctx.cacheDir)
  try {
    const pending = (await records.get(PENDING, [path])).rows.length > 0
    const outcome = (await records.get<Observed>(TOKENS, [path])).rows[0]?.value.outcome
    if (index === null || pending || outcome === undefined || !(await rowsDescribe(ctx, index))) return fields('未读取，下次 find 时读取', null)
    if (outcome.state !== 'read') return fields(unindexed(outcome), null)
    const texts = index.docsAt(path, embedderId(embedder)).filter((d) => d.text)
    const chunks = texts.reduce((n, d) => n + d.chunks, 0)
    const vectors = texts.reduce((n, d) => n + d.vectors, 0)
    const cut = texts.some((d) => d.truncated) ? '，仅索引前 1 MB' : ''
    const text = thing.bundle ? `已索引 ${texts.length} 个文件，${chunks} 个分块${cut}` : texts.length === 0 ? '非文本文件，不索引全文' : `已索引，${chunks} 个分块${cut}`
    return fields(text, embedder === null ? '未配置 embedding' : `${vectors} / ${chunks} 个分块已有向量`)
  } finally {
    index?.close()
  }
}
