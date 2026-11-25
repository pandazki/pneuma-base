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
  PluginSection,
  SayRequest,
  SayResult,
  Section,
} from './types.js'

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
  return {
    hits: mergeHits(named, answers.flatMap(({ plugin, hits }) => hits.map((h) => ({ ...h, by: plugin })))),
    problems: [...heard.problems, ...answers.flatMap(({ plugin, problems }) => problems.map((message) => ({ plugin, message })))],
  }
}

/**
 * The kernel's hits by name and the plugins' hits as one list, one hit per path between the kernel
 * and the plugins: a path a plugin found is given by the first plugin that found it, at its place,
 * with the kernel's mark (目录, 已归档) in front of its detail. Two plugins' hits on one path stay
 * apart, since each says what its plugin knows.
 */
function mergeHits(named: Hit[], heard: Hit[]): Hit[] {
  const byName = new Map(named.map((h) => [h.path, h]))
  const taken = new Set<LibraryPath>()
  const merged = heard.map((h) => {
    if (h.path === null || taken.has(h.path)) return h
    taken.add(h.path)
    const mark = byName.get(h.path)?.detail ?? null
    return mark === null ? h : { ...h, detail: h.detail === null ? mark : `${mark}，${h.detail}` }
  })
  return [...named.filter((h) => h.path === null || !taken.has(h.path)), ...merged]
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
