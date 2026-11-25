// What the index reads from a file and shows back. Pure functions.
import { searchTerms } from '@pneuma-base/kernel'

/** A file is read up to its first 1 MB; a larger one is indexed by that part. */
export const TEXT_LIMIT = 1024 * 1024

/** About how many characters one piece of text holds, for ranking and for vectors. */
export const CHUNK_SIZE = 800

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * The text of a file from its first bytes: `head` is the whole file when `size` fits the limit.
 * Null when it is not UTF-8 or holds a NUL. A cut file drops the bytes of a character the cut split.
 */
export function decodeHead(head: Uint8Array, size: number): { text: string; truncated: boolean } | null {
  if (head.includes(0)) return null
  const truncated = size > head.length
  for (let drop = 0; drop <= (truncated ? 3 : 0); drop++) {
    try {
      return { text: decoder.decode(head.subarray(0, head.length - drop)), truncated }
    } catch {
      // a cut inside a character; try one byte less
    }
  }
  return null
}

const PAGE = /\.(html?|xhtml)$/i
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** The words a reader sees: a page without its markup, scripts, styles and comments; any other file as it is. */
export function visibleText(name: string, text: string): string {
  if (!PAGE.test(name)) return text
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|title|tr|td|th|table|section|article|header|footer|main|nav|aside|blockquote|pre|figure)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Cuts a line longer than a piece into pieces, by characters. */
function cutLine(line: string): string[] {
  const chars = [...line]
  const out: string[] = []
  for (let i = 0; i < chars.length; i += CHUNK_SIZE) out.push(chars.slice(i, i + CHUNK_SIZE).join(''))
  return out
}

/** Packs parts into pieces of at most CHUNK_SIZE characters, joined by `glue`. */
function pack(parts: string[], glue: string): string[] {
  const out: string[] = []
  let current = ''
  for (const part of parts) {
    if (current !== '' && current.length + glue.length + part.length > CHUNK_SIZE) {
      out.push(current)
      current = part
    } else current = current === '' ? part : `${current}${glue}${part}`
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * The text in pieces of about CHUNK_SIZE characters on paragraph boundaries. A paragraph longer than
 * a piece is cut at its lines, and a line longer than a piece anywhere.
 */
export function chunksOf(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  return pack(
    paragraphs.flatMap((p) => (p.length <= CHUNK_SIZE ? [p] : pack(p.split('\n').flatMap((line) => (line.length <= CHUNK_SIZE ? [line] : cutLine(line))), '\n'))),
    '\n\n',
  )
}

/**
 * The words the full-text index holds for a piece: the kernel's terms of each sentence, so a word
 * counts once per sentence it is in. Lines keep the sentences apart.
 */
export function indexTerms(text: string): string {
  return text
    .split(/[\n。！？!?；;]/)
    .map((sentence) => searchTerms(sentence, 'words').join(' '))
    .filter((terms) => terms !== '')
    .join('\n')
}

/** The first line of a piece that has something on it. */
export function firstLine(body: string): string {
  return (body.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}

const BEFORE = 24
const AFTER = 56

/** The text around the first place a term appears, on one line; the first line when none appears. */
export function snippet(body: string, terms: readonly string[]): string {
  const lower = body.toLowerCase()
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0))
  if (!Number.isFinite(at)) return firstLine(body)
  // Neither end may fall between the two halves of a surrogate pair.
  const widen = (i: number, step: -1 | 1) => (i > 0 && i < body.length && /[\udc00-\udfff]/.test(body[i] as string) ? i + step : i)
  const start = widen(Math.max(0, at - BEFORE), -1)
  const end = widen(Math.min(body.length, at + AFTER), 1)
  const middle = body.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${middle}${end < body.length && body.slice(end).trim() !== '' ? '…' : ''}`
}
