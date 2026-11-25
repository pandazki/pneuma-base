// Keeping the index up to date with the library, and answering find from it.
import { open } from 'node:fs/promises'
import { join, posix } from 'node:path'
import {
  abs,
  bundleFiles,
  libraryFiles,
  searchTerms,
  SENTENCE_HITS,
  thingAt,
  type FindRequest,
  type LibraryPath,
  type PluginContext,
  type PluginFindAnswer,
  type PluginHit,
} from '@pneuma-base/kernel'
import { currentEmbedder } from './config.js'
import { embedderFor, type Embedder } from './embed.js'
import { freshness, type Stamp } from './fresh.js'
import { SearchIndex, type ChunkRow, type Doc, type Ranked } from './store.js'
import { chunksOf, decodeHead, firstLine, indexTerms, snippet, TEXT_LIMIT, visibleText } from './text.js'

/** How many things find gives at most; start, which matches a sentence's words, gives the kernel's SENTENCE_HITS. */
const FIND_HITS = 20
const EMBED_BATCH = 32
/** Reciprocal rank fusion's constant: how much the first few places count over the rest. */
const FUSION_K = 60

/** Every file of the library the index keys: each file outside bundles, and each file inside a bundle under the bundle's path. */
export async function diskStamps(root: string): Promise<Stamp[]> {
  const out: Stamp[] = []
  for (const path of await libraryFiles(root)) {
    const thing = await thingAt(abs(root, path))
    if (thing?.kind === 'file') out.push({ path, inner: '', size: thing.size, modifiedAt: thing.modifiedAt })
    if (thing?.kind === 'bundle') for (const f of await bundleFiles(abs(root, path))) out.push({ path, inner: f.path, size: f.size, modifiedAt: f.modifiedAt })
  }
  return out
}

/** The file's first TEXT_LIMIT bytes and its size; null when it is gone. */
async function readHead(file: string): Promise<{ head: Uint8Array; size: number } | null> {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return null
  try {
    const { size } = await handle.stat()
    const head = new Uint8Array(Math.min(size, TEXT_LIMIT))
    let filled = 0
    while (filled < head.length) {
      const { bytesRead } = await handle.read(head, filled, head.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    // Ending before the buffer filled means the file is now that long.
    return { head: head.subarray(0, filled), size: filled < head.length ? filled : size }
  } finally {
    await handle.close()
  }
}

async function readDoc(root: string, stamp: Stamp): Promise<Doc | null> {
  const read = await readHead(stamp.inner === '' ? abs(root, stamp.path) : join(abs(root, stamp.path), stamp.inner))
  if (read === null) return null
  const decoded = decodeHead(read.head, read.size)
  if (decoded === null) return { stamp, text: false, truncated: false, chunks: [] }
  const chunks = chunksOf(visibleText(stamp.inner || stamp.path, decoded.text)).map((body) => ({ body, terms: indexTerms(body) }))
  return { stamp, text: true, truncated: decoded.truncated, chunks }
}

/** Brings the index up to the library: reads only the files whose size or time changed, forgets the ones gone. */
export async function refresh(index: SearchIndex, root: string): Promise<void> {
  const plan = freshness(await diskStamps(root), index.stamps())
  const docs: Doc[] = []
  for (const stamp of plan.read) {
    const doc = await readDoc(root, stamp)
    if (doc) docs.push(doc)
  }
  if (plan.drop.length > 0 || docs.length > 0) index.apply(plan.drop, docs)
}

/** Gives every piece a vector of this embedder, in batches; what one batch stored stays when a later one fails. */
export async function embedMissing(index: SearchIndex, embedder: Embedder): Promise<void> {
  index.keepVectorsOf(embedder.id)
  const missing = index.unembedded(embedder.id)
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH)
    const vectors = await embedder.embed(batch.map((m) => m.body))
    index.addVectors(
      embedder.id,
      batch.map((m, j) => ({ hash: m.hash, vector: vectors[j] as Float32Array })),
    )
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
  const cut = row.truncated ? '（只索引了前 1 MB）' : ''
  const detail =
    found.how === 'words'
      ? `${row.inner || '正文'}：${snippet(row.body, terms)}${cut}`
      : `按意思：${row.inner ? `${row.inner} · ` : ''}${firstLine(row.body)}${cut}`
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
 * Brings the index up to date, then finds by the text's words (bm25) and, with an embedder set, by
 * its meaning. An embedder that fails costs only the hits by meaning; its failure is a problem.
 * A request with filters gets nothing: they belong to another plugin's vocabulary.
 */
export async function findHits(req: FindRequest, ctx: PluginContext): Promise<PluginFindAnswer> {
  const text = req.text?.trim() ?? ''
  if (text === '' || Object.keys(req.filters).length > 0) return []
  const config = await currentEmbedder(ctx)
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  try {
    await refresh(index, ctx.library.root)
    const problems: string[] = []
    let query: { embedder: string; vector: Float32Array } | null = null
    if (config === null) index.keepVectorsOf(null)
    else {
      const embedder = embedderFor(config, process.env)
      try {
        const vector = await queryVector(index, embedder, text)
        if (vector) query = { embedder: embedder.id, vector }
      } catch (error) {
        problems.push(`按意思找没做成，只按文字找了：${messageOf(error)}`)
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
      hits.push({ path: null, title: `还有 ${fused.length - limit} 样东西的正文也相关，没有列出；换更具体的词缩小范围`, group: null, detail: null })
    }
    return problems.length === 0 ? hits : { hits, problems }
  } finally {
    index.close()
  }
}
