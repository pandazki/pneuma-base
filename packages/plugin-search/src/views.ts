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
  embedder: EmbedderConfig | null
  /** Whether the embedder's secret key is set on this machine. */
  key: boolean
  cacheDir: string
}

const embedderId = (config: EmbedderConfig | null) => (config === null ? null : embedderFor(config, null).id)

export async function statusOf(ctx: PluginContext): Promise<Status> {
  const embedder = await currentEmbedder(ctx)
  const key = (await ctx.secrets.get(KEY_SECRET)) !== null
  const none: Status = { indexed: false, files: 0, textFiles: 0, chunks: 0, ...(await counts(ctx)), vectors: 0, builtAt: null, embedder, key, cacheDir: ctx.cacheDir }
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
const pendingText = (s: Status) => (s.pending === 0 ? '没有' : `${s.pending} 样东西，下次 find 时读`)
const tooManyText = (s: Status) => `${s.tooMany} 个，超过 5000 个文件，不索引`
const vectorsText = (s: Status) => `${s.vectors} / ${s.chunks} 块`

export function statusText(s: Status): string {
  const embedder = `嵌入器：${embedderLabel(s.embedder, s.key)}${s.embedder && s.indexed ? `；${vectorsText(s)}有向量` : ''}`
  if (!s.indexed) return ['还没有索引；下次 find 或 search rebuild 时建。', embedder].join('\n')
  const tooMany = s.tooMany > 0 ? `；太大的目录：${tooManyText(s)}` : ''
  return [`索引：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 块；待读：${pendingText(s)}${tooMany}`, embedder, `建于 ${when(s.builtAt ?? '')} · 缓存在 ${s.cacheDir}（删了能重建）`].join('\n')
}

const owner = (command: string, flags: OwnerArgs['flags'] = {}) => ({ face: 'owner' as const, command, args: { positional: [], flags } })
const action = (label: string, call: Action['call'], inputs: Action['inputs'] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })
const field = (label: string, text: string, mono = false) => ({ label, value: mono ? { text, mono } : { text } })

/** The form of `search embedder set`, made from its params, filled with the embedder in force. */
function setAction(current: EmbedderConfig | null): Action {
  const http = current?.kind === 'http' ? current : null
  const values = { kind: current?.kind ?? 'hash', ...(http ? { url: http.url, model: http.model } : {}) }
  const { inputs, call } = formOf(SET_EMBEDDER, { values })
  return action('设嵌入器', call, inputs)
}

export async function statusView(ctx: PluginContext): Promise<ViewAnswer> {
  const s = await statusOf(ctx)
  const index: Block = {
    kind: 'section',
    title: '索引',
    note: null,
    about: `登记过的东西进索引；索引在库外的缓存目录里（${s.cacheDir}），删了能重建。`,
    count: null,
    blocks: [
      {
        kind: 'fields',
        // Nothing waiting to be read is the usual state; how many pieces the text was cut into is the index's business.
        fields: s.indexed
          ? [
              field('文件', filesText(s)),
              ...(s.pending === 0 ? [] : [field('待读', pendingText(s))]),
              ...(s.tooMany > 0 ? [field('太大的目录', tooManyText(s))] : []),
              field('建于', when(s.builtAt ?? '')),
              { label: '块', value: { text: String(s.chunks), normal: true as const } },
              { label: '缓存', value: { text: s.cacheDir, mono: true, normal: true as const } },
            ]
          : [field('文件', '还没有索引')],
      },
    ],
    actions: [{ ...action('重建索引', owner('search rebuild')), as: 'icon', icon: 'refresh-cw' }],
  }
  const meaning: Block = {
    kind: 'section',
    title: '按意思找',
    note: null,
    about: '配了嵌入器，find 才按意思找。',
    count: null,
    blocks: [{ kind: 'fields', fields: [field('嵌入器', embedderLabel(s.embedder, s.key)), ...(s.embedder && s.indexed ? [field('向量', vectorsText(s))] : [])] }],
    actions: [{ ...setAction(s.embedder), icon: 'pencil', ...(s.embedder ? { as: 'icon' as const } : {}) }, ...(s.embedder ? [{ ...action('清除嵌入器', owner('search embedder clear')), as: 'menu' as const }] : [])],
  }
  return { title: '查找', subtitle: null, blocks: [index, meaning] }
}

const WHY: Record<string, string> = { elsewhere: '内容不在本机', not_a_file: '那里现在不是文件', not_a_dir: '那里现在不是目录', unreadable: '存储读不了它', noise: '那里是噪音' }

/** What a read that did not index the thing found. */
function unindexed(outcome: Exclude<Outcome, { state: 'read' }>): string {
  if (outcome.state === 'gone') return '不在了，不索引'
  if (outcome.state === 'too_many') return `目录里至少 ${outcome.atLeast} 个文件，超过 5000 个，不索引`
  return `读不了（${WHY[outcome.reason] ?? outcome.reason}），不索引`
}

/** What the index has of the thing at `path`: whether its text is indexed, in how many pieces, and how many have vectors. */
export async function itemSection(path: LibraryPath, ctx: PluginContext): Promise<ItemSection | null> {
  const { records } = ctx.tools.storage
  const thing = (await records.get<Thing>(THINGS, [path])).rows[0]?.value
  const fields = (text: string, meaning: string | null) => ({ title: '查找', blocks: [{ kind: 'fields' as const, fields: [field('正文', text), ...(meaning === null ? [] : [field('按意思', meaning)])] }] })
  if (thing === undefined) {
    const [at] = await ctx.tools.what([path])
    return at?.kind === 'file' || at?.kind === 'bundle' ? fields('没有索引：查找插件的记录里没有它', null) : null
  }
  const embedder = await currentEmbedder(ctx)
  const index = SearchIndex.peek(ctx.cacheDir)
  try {
    const pending = (await records.get(PENDING, [path])).rows.length > 0
    const outcome = (await records.get<Observed>(TOKENS, [path])).rows[0]?.value.outcome
    if (index === null || pending || outcome === undefined || !(await rowsDescribe(ctx, index))) return fields('还没读，下次 find 时读', null)
    if (outcome.state !== 'read') return fields(unindexed(outcome), null)
    const texts = index.docsAt(path, embedderId(embedder)).filter((d) => d.text)
    const chunks = texts.reduce((n, d) => n + d.chunks, 0)
    const vectors = texts.reduce((n, d) => n + d.vectors, 0)
    const cut = texts.some((d) => d.truncated) ? '，只索引了前 1 MB' : ''
    const text = thing.bundle ? `已索引 ${texts.length} 个文件，${chunks} 块${cut}` : texts.length === 0 ? '不是文本，不索引正文' : `已索引，${chunks} 块${cut}`
    return fields(text, embedder === null ? '没配嵌入器' : `${vectors} / ${chunks} 块有向量`)
  } finally {
    index?.close()
  }
}
