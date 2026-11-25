// How find splits a text into terms and ranks what matched. Plugins use the same, through their tools.
import type { FindRequest } from '@pneuma-base/sdk'

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
export function rankHits<T>(candidates: readonly { hit: T; haystack: string }[], terms: readonly string[], match: FindRequest['match']): T[] {
  if (terms.length === 0) return match === 'terms' ? candidates.map((c) => c.hit) : []
  const scored = candidates
    .map((c) => ({ hit: c.hit, score: terms.filter((t) => c.haystack.includes(t)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
  return (match === 'words' ? scored.slice(0, SENTENCE_HITS) : scored).map((c) => c.hit)
}
