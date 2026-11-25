// Embedders turn pieces of text into vectors for finding by meaning. Two kinds: `hash`, feature
// hashing with no model, and `http`, an OpenAI-compatible /v1/embeddings the owner configures.
import { createHash } from 'node:crypto'
import { searchTerms } from '@pneuma-base/kernel'

/**
 * What the owner sets. An http embedder's key is the plugin's secret `key`, on this machine and never
 * in the library. `keyEnv`: the environment variable a record written before named for the key; it is
 * read only to tell the owner the key now lives in the secret.
 */
export type EmbedderConfig = { kind: 'hash' } | { kind: 'http'; url: string; model: string; keyEnv?: string | null }

/** The secret an http embedder sends as its bearer token, when the owner set it. */
export const KEY_SECRET = 'key'
export const SET_KEY = `pneuma-base secret set search ${KEY_SECRET}`

export interface Embedder {
  /** Vectors from embedders with different ids are not compared; changing the embedder makes all vectors anew. */
  readonly id: string
  /** One unit vector per text, in order. Rejects with a message that names what went wrong. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

export const HASH_DIMENSIONS = 256
const HTTP_TIMEOUT_MS = 30_000

function unit(v: Float32Array): Float32Array {
  const norm = Math.hypot(...v)
  return norm === 0 ? v : v.map((x) => x / norm)
}

/** FNV-1a over UTF-16 code units: the same feature always lands in the same dimension. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/**
 * The bag of the text's terms (the kernel's, per line) and of its character pairs within runs of
 * letters, hashed into 256 dimensions, at unit length. Similarity is shared words and character
 * pairs, not meaning; it lets the whole path work without a model. No sign bit: in so few
 * dimensions a colliding feature of the other sign would cancel a shared one.
 */
function hashVector(text: string): Float32Array {
  const v = new Float32Array(HASH_DIMENSIONS)
  const lower = text.toLowerCase()
  const terms = lower.split('\n').flatMap((line) => searchTerms(line, 'words')).map((t) => `w:${t}`)
  const pairs = lower.split(/[\s\p{P}\p{S}]+/u).flatMap((run) => {
    const chars = [...run]
    return chars.slice(1).map((c, i) => `c:${chars[i]}${c}`)
  })
  for (const feature of [...terms, ...pairs]) {
    const at = fnv1a(feature) % HASH_DIMENSIONS
    v[at] = (v[at] as number) + 1
  }
  return unit(v)
}

const hashEmbedder: Embedder = { id: `hash-${HASH_DIMENSIONS}-1`, embed: async (texts) => texts.map(hashVector) }

/** The base address without a trailing slash or /v1, so both `http://host:11434` and `…/v1` work. */
function baseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '')
}

const errorCode = (error: unknown) => {
  const cause = (error as { cause?: { code?: unknown } }).cause
  return typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.message : String(error)
}

/** Parses the server's answer at the boundary: one numeric vector per text, all of one length. */
function vectorsOf(body: unknown, count: number): Float32Array[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length !== count) throw new Error(`嵌入服务的答复不对：要 ${count} 个向量`)
  const out: Float32Array[] = new Array(count)
  for (const [position, row] of data.entries()) {
    const { index, embedding } = row as { index?: unknown; embedding?: unknown }
    const at = typeof index === 'number' ? index : position
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((x) => typeof x === 'number') || at < 0 || at >= count) {
      throw new Error('嵌入服务的答复不对：有一项不是向量')
    }
    out[at] = unit(Float32Array.from(embedding as number[]))
  }
  if (out.some((v) => v === undefined || v.length !== out[0]?.length)) throw new Error('嵌入服务的答复不对：向量缺了或长短不一')
  return out
}

/** `key`: the secret sent as the bearer token; null sends none. */
export function httpEmbedder(config: Extract<EmbedderConfig, { kind: 'http' }>, key: string | null, timeoutMs = HTTP_TIMEOUT_MS): Embedder {
  const base = baseUrl(config.url)
  return {
    id: `http-${createHash('sha256').update(`${base}\n${config.model}`).digest('hex').slice(0, 16)}`,
    async embed(texts) {
      if (texts.length === 0) return []
      let response: Response
      try {
        response = await fetch(`${base}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if ((error as Error).name === 'TimeoutError') throw new Error(`嵌入服务 ${base} ${timeoutMs / 1000} 秒没有答复`, { cause: error })
        throw new Error(`嵌入服务连不上：${base}（${errorCode(error)}）`, { cause: error })
      }
      if (!response.ok) throw new Error(`嵌入服务答复 ${response.status}：${(await response.text().catch(() => '')).slice(0, 200)}`)
      return vectorsOf(await response.json().catch(() => null), texts.length)
    },
  }
}

export function embedderFor(config: EmbedderConfig, key: string | null): Embedder {
  return config.kind === 'hash' ? hashEmbedder : httpEmbedder(config, key)
}

/** For a record that named an environment variable for the key while the secret is not set: where the key lives now. */
export function movedKey(config: EmbedderConfig | null, key: boolean): string | null {
  if (key || config?.kind !== 'http' || !config.keyEnv) return null
  return `密钥原来取自环境变量 ${config.keyEnv}，现在放在这个插件的密钥里，不再读环境变量：用 ${SET_KEY} 设，值从标准输入读`
}

/** How the owner reads the embedder; `key`: whether its secret is set on this machine. */
export function embedderLabel(config: EmbedderConfig | null, key: boolean): string {
  if (config === null) return '没配嵌入器，find 只按文字找'
  if (config.kind === 'hash') return 'hash：特征哈希，不用模型'
  const moved = movedKey(config, key)
  return `http：${config.model} @ ${baseUrl(config.url)}${key ? '，密钥已设' : moved ? `。${moved}` : ''}`
}
