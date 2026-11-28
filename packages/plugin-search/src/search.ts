// Keeping the index up to date with the registered things, and answering find from it.
import { posix } from 'node:path'
import { searchTerms, SENTENCE_HITS, type FindRequest, type LibraryPath, type PluginContext, type PluginFindAnswer, type PluginHit } from '@pneuma-base/kernel'
import { currentEmbedder } from './config.js'
import { embedderFor, KEY_SECRET, movedKey, type Embedder } from './embed.js'
import { READS, readPending, type Budget } from './reader.js'
import { fold, noticeChanges } from './registry.js'
import { SearchIndex, type ChunkRow, type Ranked } from './store.js'
import { firstLine, snippet } from './text.js'

/** How many things find gives at most; start, which matches a sentence's words, gives the kernel's SENTENCE_HITS. */
const FIND_HITS = 20
const EMBED_BATCH = 32
/** Reciprocal rank fusion's constant: how much the first few places count over the rest. */
const FUSION_K = 60

/**
 * Brings the index up to the registered things: the facts folded, what changed since the kept mark
 * made pending, and the pending things read while `budget` lasts.
 */
export async function refresh(index: SearchIndex, ctx: PluginContext, budget: Budget = { files: READS }): Promise<void> {
  await fold(ctx, index)
  await noticeChanges(ctx)
  await readPending(ctx, index, budget)
}

/**
 * Gives every piece a vector of this embedder, in batches; what one batch stored stays when a later one
 * fails. `afterBatch` hears how many of how many have one after each batch, and stops it by answering true.
 */
export async function embedMissing(index: SearchIndex, embedder: Embedder, afterBatch?: (done: number, total: number) => boolean): Promise<void> {
  index.keepVectorsOf(embedder.id)
  const missing = index.unembedded(embedder.id)
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH)
    const vectors = await embedder.embed(batch.map((m) => m.body))
    index.addVectors(
      embedder.id,
      batch.map((m, j) => ({ hash: m.hash, vector: vectors[j] as Float32Array })),
    )
    if (afterBatch?.(i + batch.length, missing.length) === true) return
  }
}

type Fused = Ranked & { how: 'words' | 'meaning' }

/**
 * One ranking from the ranking by words and the ranking by meaning: reciprocal rank fusion, so a
 * thing high in both comes first. A thing found by words is shown by its words. Ties: words first,
 * then by path.
 */
function fuse(words: readonly Ranked[], meaning: readonly Ranked[]): Fused[] {
  const scored = new Map<LibraryPath, Fused & { score: number }>()
  words.forEach((r, i) => scored.set(r.path, { ...r, how: 'words', score: 1 / (FUSION_K + i + 1) }))
  meaning.forEach((r, i) => {
    const known = scored.get(r.path)
    if (known) known.score += 1 / (FUSION_K + i + 1)
    else scored.set(r.path, { ...r, how: 'meaning', score: 1 / (FUSION_K + i + 1) })
  })
  const order = (a: Fused & { score: number }, b: Fused & { score: number }) =>
    b.score - a.score || (a.how === b.how ? 0 : a.how === 'words' ? -1 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return [...scored.values()].sort(order).map(({ path, chunk, how }) => ({ path, chunk, how }))
}

function hitOf(found: Fused, row: ChunkRow, terms: readonly string[]): PluginHit {
  const cut = row.truncated ? '（仅索引前 1 MB）' : ''
  const detail =
    found.how === 'words'
      ? `${row.inner || '全文'}：${snippet(row.body, terms)}${cut}`
      : `语义：${row.inner ? `${row.inner} · ` : ''}${firstLine(row.body)}${cut}`
  return { path: row.path, title: posix.basename(row.path), group: null, detail }
}

/** The text's vector, once every piece has one of the same embedder; throws when the embedder fails. */
async function queryVector(index: SearchIndex, embedder: Embedder, text: string): Promise<Float32Array | null> {
  const [vector] = await embedder.embed([text])
  await embedMissing(index, embedder)
  return vector ?? null
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Brings the index up to date, then finds by the text's words (bm25) and, with an embedding set, by
 * its meaning. An embedder that fails costs only the hits by meaning; its failure is a problem.
 * A request with filters gets nothing: they belong to another plugin's vocabulary.
 */
export async function findHits(req: FindRequest, ctx: PluginContext): Promise<PluginFindAnswer> {
  const text = req.text?.trim() ?? ''
  if (text === '' || Object.keys(req.filters).length > 0) return []
  const config = await currentEmbedder(ctx)
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  try {
    await refresh(index, ctx)
    const problems: string[] = []
    let query: { embedder: string; vector: Float32Array } | null = null
    if (config === null) index.keepVectorsOf(null)
    else {
      const key = await ctx.secrets.get(KEY_SECRET)
      const embedder = embedderFor(config, key)
      try {
        const vector = await queryVector(index, embedder, text)
        if (vector) query = { embedder: embedder.id, vector }
      } catch (error) {
        const moved = movedKey(config, key !== null)
        problems.push(`语义检索失败，仅进行了全文检索：${messageOf(error)}${moved ? `。${moved}` : ''}`)
      }
    }
    const terms = searchTerms(text, 'words')
    const limit = req.match === 'words' ? SENTENCE_HITS : FIND_HITS
    // One snapshot, so a find writing the index at the same time cannot take the pieces away between the ranking and the reading.
    const { fused, rows } = index.snapshot(() => {
      const meaning = query ? index.nearest(query.embedder, query.vector, req.includeArchived, SENTENCE_HITS) : []
      const fused = fuse(index.matchWords(terms, req.includeArchived), meaning)
      return { fused, rows: index.chunkRows(fused.slice(0, limit).map((f) => f.chunk)) }
    })
    const hits = fused.slice(0, limit).flatMap((f) => {
      const row = rows.get(f.chunk)
      return row ? [hitOf(f, row, terms)] : []
    })
    if (req.match === 'terms' && fused.length > limit) {
      hits.push({ path: null, title: `另有 ${fused.length - limit} 个条目的全文相关，未列出；请使用更具体的关键词缩小范围`, group: null, detail: null })
    }
    return problems.length === 0 ? hits : { hits, problems }
  } finally {
    index.close()
  }
}
