import { posix } from 'node:path'
import { archive } from './archive.js'
import { ARCHIVE_DIR, DESCRIPTION_FILE, KERNEL_DIR, abs, archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { eachPlugin, messageOf, performVerb, pluginContext, type Collected } from './pipeline.js'
import { put } from './put.js'
import { fingerprintOf, listThings, thingAt } from './things.js'
import type {
  AgentFace,
  CheckRequest,
  CheckResult,
  Context,
  FileFacts,
  FindRequest,
  FindResult,
  Hit,
  InspectRequest,
  InspectResult,
  LibraryPath,
  PluginHit,
  PluginProblem,
  PluginSection,
  SayRequest,
  SayResult,
  Section,
} from '@pneuma-base/sdk'

export const NO_HEARER = '这个库没配能记下这句话的插件'

/** The six verbs. Each ends at the pipeline's single exit, which sends its event (K5). */
export const agentFace: AgentFace = {
  put: (req, ctx) => performVerb('put', req, ctx, () => put(req, ctx)),
  find: (req, ctx) => performVerb('find', req, ctx, () => find(req, ctx)),
  inspect: (req, ctx) => performVerb('inspect', req, ctx, () => inspect(req, ctx)),
  say: (req, ctx) => performVerb('say', req, ctx, () => say(req, ctx)),
  check: (req, ctx) => performVerb('check', req, ctx, () => check(req, ctx)),
  archive: (req, ctx) => performVerb('archive', req, ctx, () => archive(req, ctx)),
}

/** How many hits each answerer gives at most when a find matches the words of a sentence. */
export const SENTENCE_HITS = 5

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

const singleHan = (s: Intl.SegmentData) => s.isWordLike === true && /^\p{Script=Han}$/u.test(s.segment)

/**
 * The terms a find request matches, lower-cased. `terms`: the text split on white space and common
 * punctuation. `words`: the sentence's words by Intl.Segmenter, kept when two characters or longer, or
 * Latin. The segmenter cuts some two-character words such as 下单 into single characters, so two
 * adjacent single Chinese characters also give their join.
 */
export function searchTerms(text: string | null, match: FindRequest['match']): string[] {
  if (text === null) return []
  const lower = text.toLowerCase()
  if (match === 'terms') return lower.split(/[\s,.;:!?，。、；：！？"'“”‘’「」『』()（）]+/u).filter((t) => t !== '')
  const segments = [...segmenter.segment(lower)]
  const words = segments.flatMap((s, i) => {
    const before = segments[i - 1]
    if (singleHan(s)) return before && singleHan(before) ? [before.segment + s.segment] : []
    return s.isWordLike && ([...s.segment].length >= 2 || /\p{Script=Latin}/u.test(s.segment)) ? [s.segment] : []
  })
  return [...new Set(words)]
}

/**
 * The hits to give, from candidates scored by how many distinct terms they matched. With no terms,
 * `terms` gives every candidate and `words` none. Otherwise at least one term must match; best
 * first; `words` keeps the best `SENTENCE_HITS`.
 */
export function rankHits<T>(candidates: { hit: T; haystack: string }[], terms: string[], match: FindRequest['match']): T[] {
  if (terms.length === 0) return match === 'terms' ? candidates.map((c) => c.hit) : []
  const scored = candidates
    .map((c) => ({ hit: c.hit, score: terms.filter((t) => c.haystack.includes(t)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
  return (match === 'words' ? scored.slice(0, SENTENCE_HITS) : scored).map((c) => c.hit)
}

async function find(req: FindRequest, ctx: Context): Promise<FindResult> {
  const named = Object.keys(req.filters).length === 0 ? await nameHits(req, ctx.library.root) : []
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onFind?.(req, pctx))
  const answers = heard.values.map(({ plugin, value }) => ({ plugin, ...(Array.isArray(value) ? { hits: value, problems: [] } : value) }))
  const found = [named, ...answers.map(({ plugin, hits }) => hits.map((h) => ({ ...h, by: plugin })))]
  const known = await annotate(req, ctx, found.flat())
  return {
    hits: mergeHits(['kernel', ...ctx.library.plugins.map((p) => p.name)], found, known.hits),
    problems: [...heard.problems, ...answers.flatMap(({ plugin, problems }) => problems.map((message) => ({ plugin, message }))), ...known.problems],
  }
}

type Annotation = Hit & { path: LibraryPath }

/**
 * What each plugin with `onFound` knows about the found paths it gave no hit for, in configuration
 * order. A plugin with no such path is not asked. A hit on a path it was not asked about is left out
 * and listed as a problem (K8).
 */
async function annotate(req: FindRequest, ctx: Context, found: Hit[]): Promise<{ hits: Annotation[]; problems: PluginProblem[] }> {
  const paths = [...new Set(found.flatMap((h) => (h.path === null ? [] : [h.path])))]
  const heard = await eachPlugin(ctx, async (plugin, pctx) => {
    const own = new Set(found.filter((h) => h.by === plugin.name).map((h) => h.path))
    const asked = new Set(paths.filter((path) => !own.has(path)))
    if (!plugin.onFound || asked.size === 0) return undefined
    const answered = await plugin.onFound([...asked], req, pctx)
    const fits = (h: PluginHit): h is PluginHit & { path: LibraryPath } => h.path !== null && asked.has(h.path)
    return {
      hits: answered.filter(fits).map((h): Annotation => ({ ...h, by: plugin.name })),
      problems: answered.filter((h) => !fits(h)).map((h) => ({ plugin: plugin.name, message: `onFound 答了${h.path === null ? '一条没有路径的命中' : `没问它的路径 ${h.path}`}，没有采用` })),
    }
  })
  return { hits: heard.values.flatMap(({ value }) => value.hits), problems: [...heard.problems, ...heard.values.flatMap(({ value }) => value.problems)] }
}

/**
 * The kernel's hits by name and each plugin's ranked hits as one list. The hits on one path stay
 * together, at the best rank any finder gave that path; on equal ranks the kernel comes first,
 * then the plugins in configuration order. Annotations join their path's entry and leave its rank
 * alone. A path is given by the plugins that found or annotated it, in `answerers` order, the
 * kernel's mark (目录, 已归档) in front of the first one's detail; each plugin's hit stays its own,
 * since each says what its plugin knows. A hit without a path is its own entry at its rank.
 */
function mergeHits(answerers: readonly Hit['by'][], found: Hit[][], annotations: Annotation[]): Hit[] {
  type Entry = { rank: number; answerer: number; order: number; hits: Hit[] }
  const entries = new Map<string, Entry>()
  let order = 0
  found.forEach((hits, answerer) =>
    hits.forEach((hit, rank) => {
      const key = hit.path === null ? `\0${order}` : hit.path
      const entry = entries.get(key) ?? { rank, answerer, order: order++, hits: [] }
      entries.set(key, entry)
      entry.hits.push(hit)
      if (rank < entry.rank) Object.assign(entry, { rank, answerer })
    }),
  )
  for (const hit of annotations) entries.get(hit.path)?.hits.push(hit)
  const place = (hit: Hit) => answerers.indexOf(hit.by)
  const ranked = [...entries.values()].sort((a, b) => a.rank - b.rank || a.answerer - b.answerer || a.order - b.order)
  return ranked.flatMap(({ hits }) => {
    const [named, first, ...others] = hits.sort((a, b) => place(a) - place(b)) as [Hit, ...Hit[]]
    if (named.by !== 'kernel' || first === undefined) return hits
    const mark = named.detail
    return [mark === null ? first : { ...first, detail: first.detail === null ? mark : `${mark}，${first.detail}` }, ...others]
  })
}

/** A bundle is one hit, marked 目录; the files inside it are none. */
async function nameHits(req: FindRequest, root: string): Promise<Hit[]> {
  const skip = new Set([KERNEL_DIR, DESCRIPTION_FILE, ...(req.includeArchived ? [] : [ARCHIVE_DIR])])
  const candidates = (await listThings(root, skip)).map((thing) => {
    const path = thing.path as LibraryPath
    const archived = regionOf(path) === 'archive'
    const marks = [...(thing.kind === 'bundle' ? ['目录'] : []), ...(archived ? ['已归档'] : [])]
    const hit: Hit = { path, title: posix.basename(path), by: 'kernel', group: null, detail: marks.length > 0 ? marks.join('，') : null }
    return { hit, haystack: (archived ? originalPath(path) ?? path : path).toLowerCase() }
  })
  return rankHits(candidates, searchTerms(req.text, req.match), req.match)
}

/** Every thing of the library outside the kernel's own, in the content and the archive: its files outside bundles, and its bundles. */
export async function libraryFiles(root: string): Promise<LibraryPath[]> {
  return (await listThings(root, new Set([KERNEL_DIR, DESCRIPTION_FILE]))).map((thing) => thing.path as LibraryPath)
}

async function inspect(req: InspectRequest, ctx: Context): Promise<InspectResult> {
  const file = await fileFacts(ctx.library.root, req.target)
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onInspect?.(req, pctx))
  return { file, sections: stamp(heard), problems: heard.problems }
}

/** The thing a target names: the main one, else its archived copy. `_archive/…` names the archived copy. */
export async function fileFacts(root: string, target: string): Promise<FileFacts | null> {
  const path = parseLibraryPath(root, target)
  if (path === null || regionOf(path) === 'kernel') return null
  const candidates = regionOf(path) === 'archive' ? [path] : [path, archivedPath(path)]
  for (const candidate of candidates) {
    const thing = await thingAt(abs(root, candidate))
    if (thing) return { path: candidate, ...thing, fingerprint: await fingerprintOf(abs(root, candidate)), archived: regionOf(candidate) === 'archive' }
  }
  return null
}

async function say(req: SayRequest, ctx: Context): Promise<SayResult> {
  const hearer = ctx.library.plugins.find((p) => p.onSay && p.statements.includes(req.kind))
  if (!hearer?.onSay) return { outcome: 'not-heard', reason: 'no-plugin-for-kind', note: NO_HEARER, problems: [] }
  try {
    const answer = await hearer.onSay(req, pluginContext(ctx, hearer.name))
    if (answer.outcome === 'heard') return { outcome: 'heard', by: hearer.name, note: answer.note, problems: [] }
    return { ...answer, problems: [] }
  } catch (error) {
    return {
      outcome: 'not-heard',
      reason: 'plugin-failed',
      note: `插件 ${hearer.name} 没能记下这句话`,
      problems: [{ plugin: hearer.name, message: messageOf(error) }],
    }
  }
}

async function check(req: CheckRequest, ctx: Context): Promise<CheckResult> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onCheck?.(req, pctx))
  return { sections: stamp(heard), problems: heard.problems }
}

function stamp(heard: Collected<PluginSection[]>): Section[] {
  return heard.values.flatMap(({ plugin, value }) => value.map((s) => ({ ...s, plugin })))
}
