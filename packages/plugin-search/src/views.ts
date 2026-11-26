// What the owner and the UI see of the index: its status, and what it has of one thing. These only
// read; nothing here builds or changes the index.
import { formOf, type Action, type Block, type Instant, type ItemSection, type LibraryPath, type OwnerArgs, type PluginContext, type ViewAnswer } from '@pneuma-base/kernel'
import { SET_EMBEDDER } from './commands.js'
import { currentEmbedder } from './config.js'
import { embedderFor, embedderLabel, KEY_SECRET, type EmbedderConfig } from './embed.js'
import { freshness, type Stamp } from './fresh.js'
import { diskStamps } from './search.js'
import { SearchIndex } from './store.js'

export const STATUS_VIEW = 'search.status'

/** `stale`: files on disk the index would read again or forget at the next find. */
export type Status = {
  indexed: boolean
  files: number
  textFiles: number
  chunks: number
  stale: number
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
  const none: Status = { indexed: false, files: 0, textFiles: 0, chunks: 0, stale: 0, vectors: 0, builtAt: null, embedder, key, cacheDir: ctx.cacheDir }
  const index = SearchIndex.peek(ctx.cacheDir)
  if (index === null) return none
  try {
    const plan = freshness(await diskStamps(ctx), index.stamps())
    return { ...none, indexed: true, ...index.stats(embedderId(embedder)), stale: plan.read.length + plan.drop.length }
  } finally {
    index.close()
  }
}

const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
const filesText = (s: Status) => `${s.files} 个，其中文本 ${s.textFiles} 个`
const staleText = (s: Status) => (s.stale === 0 ? '没有' : `${s.stale} 个文件，下次 find 时更新`)
const vectorsText = (s: Status) => `${s.vectors} / ${s.chunks} 块`

export function statusText(s: Status): string {
  const embedder = `嵌入器：${embedderLabel(s.embedder, s.key)}${s.embedder && s.indexed ? `；${vectorsText(s)}有向量` : ''}`
  if (!s.indexed) return ['还没有索引；下次 find 或 search rebuild 时建。', embedder].join('\n')
  return [`索引：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 块；待更新：${staleText(s)}`, embedder, `建于 ${when(s.builtAt ?? '')} · 缓存在 ${s.cacheDir}（删了能重建）`].join('\n')
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
    note: '在库外的缓存目录里，删了能重建',
    count: null,
    blocks: [
      {
        kind: 'fields',
        fields: s.indexed
          ? [field('文件', filesText(s)), field('块', String(s.chunks)), field('待更新', staleText(s)), field('建于', when(s.builtAt ?? '')), field('缓存', s.cacheDir, true)]
          : [field('文件', '还没有索引'), field('缓存', s.cacheDir, true)],
      },
    ],
    actions: [action('重建索引', owner('search rebuild'))],
  }
  const meaning: Block = {
    kind: 'section',
    title: '按意思找',
    note: s.embedder === null ? '配了嵌入器，find 才按意思找' : null,
    count: null,
    blocks: [{ kind: 'fields', fields: [field('嵌入器', embedderLabel(s.embedder, s.key)), ...(s.embedder && s.indexed ? [field('向量', vectorsText(s))] : [])] }],
    actions: [setAction(s.embedder), ...(s.embedder ? [action('清除嵌入器', owner('search embedder clear'))] : [])],
  }
  return { title: '查找', subtitle: null, blocks: [index, meaning] }
}

/** What the index has of the thing at `path`: whether its text is indexed, in how many pieces, and how many have vectors. */
export async function itemSection(path: LibraryPath, ctx: PluginContext): Promise<ItemSection | null> {
  const thing = await ctx.tools.thing(path)
  if (thing === null) return null
  const disk: Stamp[] =
    thing.kind === 'file' ? [{ path, inner: '', size: thing.size, modifiedAt: thing.modifiedAt }] : ((await ctx.tools.files(path)) ?? []).map((f) => ({ path, inner: f.path, size: f.size, modifiedAt: f.modifiedAt }))
  const embedder = await currentEmbedder(ctx)
  const index = SearchIndex.peek(ctx.cacheDir)
  const docs = index?.docsAt(path, embedderId(embedder)) ?? []
  index?.close()
  const plan = freshness(disk, docs.map((d) => ({ path, inner: d.inner, size: d.size, modifiedAt: d.modifiedAt })))
  const texts = docs.filter((d) => d.text)
  const chunks = texts.reduce((n, d) => n + d.chunks, 0)
  const vectors = texts.reduce((n, d) => n + d.vectors, 0)
  const cut = texts.some((d) => d.truncated) ? '，只索引了前 1 MB' : ''
  let text: string
  if (docs.length === 0) text = '还没索引，下次 find 时补上'
  else if (thing.kind === 'bundle') text = `已索引 ${texts.length} 个文件，${chunks} 块${cut}${plan.read.length > 0 ? `；${plan.read.length} 个文件下次 find 时更新` : ''}`
  else if (plan.read.length > 0) text = '变了，下次 find 时更新'
  else if (texts.length === 0) text = '不是文本，不索引正文'
  else text = `已索引，${chunks} 块${cut}`
  const meaning = embedder === null ? '没配嵌入器' : `${vectors} / ${chunks} 块有向量`
  return { title: '查找', blocks: [{ kind: 'fields', fields: [field('正文', text), field('按意思', meaning)] }] }
}
