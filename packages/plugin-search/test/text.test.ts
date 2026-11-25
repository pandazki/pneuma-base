// What the index reads from a file: UTF-8 text up to 1 MB, the words a reader sees in a page,
// pieces of about 800 characters on paragraph boundaries, and a snippet around a match.
import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE, chunksOf, decodeHead, firstLine, indexTerms, snippet, TEXT_LIMIT, visibleText } from '../src/text.js'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('decodeHead', () => {
  it('gives the text of a file that is valid UTF-8', () => {
    const b = bytes('支付 ok\n')
    expect(decodeHead(b, b.length)).toEqual({ text: '支付 ok\n', truncated: false })
  })

  it('gives nothing for bytes that are not UTF-8, or text holding a NUL', () => {
    const invalid = new Uint8Array([0x61, 0xff, 0xfe, 0x62])
    expect(decodeHead(invalid, invalid.length)).toBeNull()
    const nul = bytes('a\u0000b')
    expect(decodeHead(nul, nul.length)).toBeNull()
  })

  it('reads a larger file by its first 1 MB without splitting a character', () => {
    const whole = bytes('支'.repeat(400_000)) // three bytes each, 1.2 MB
    const decoded = decodeHead(whole.subarray(0, TEXT_LIMIT), whole.length)
    expect(decoded).toEqual({ text: '支'.repeat(Math.floor(TEXT_LIMIT / 3)), truncated: true })
  })
})

describe('visibleText', () => {
  it('keeps the words of a page and drops its markup, scripts and styles', () => {
    const page = '<!doctype html><html><head><title>手工皂</title><style>p{color:red}</style><script>var x = "zebra"</script></head><body><h1>冷制皂</h1><p>橄榄油&amp;椰子油&nbsp;熟成</p><!-- note --></body></html>'
    const text = visibleText('site/index.html', page)
    for (const word of ['手工皂', '冷制皂', '橄榄油&椰子油 熟成']) expect(text).toContain(word)
    for (const gone of ['<', 'zebra', 'color', 'note']) expect(text).not.toContain(gone)
  })

  it('leaves other files as they are', () => {
    expect(visibleText('notes.md', '<b>bold</b> text')).toBe('<b>bold</b> text')
  })
})

describe('chunksOf', () => {
  const paragraph = (n: number, length: number) => `${n}`.padEnd(length, '字')

  it('packs whole paragraphs into pieces of at most about 800 characters', () => {
    const paragraphs = [1, 2, 3, 4, 5].map((n) => paragraph(n, 300))
    const chunks = chunksOf(paragraphs.join('\n\n'))
    expect(chunks).toEqual([`${paragraphs[0]}\n\n${paragraphs[1]}`, `${paragraphs[2]}\n\n${paragraphs[3]}`, paragraphs[4]])
  })

  it('cuts a paragraph longer than a piece at its lines, and a line longer than a piece anywhere, losing nothing', () => {
    const lines = [paragraph(1, 500), paragraph(2, 500), paragraph(3, 2000)]
    const chunks = chunksOf(lines.join('\n'))
    expect(chunks.every((c) => c.length <= CHUNK_SIZE)).toBe(true)
    expect(chunks.join('').replaceAll('\n', '')).toBe(lines.join(''))
    expect(chunks[0]).toBe(lines[0])
  })

  it('gives no piece for empty text', () => {
    expect(chunksOf(' \n\n \n')).toEqual([])
  })
})

describe('indexTerms', () => {
  it('gives a two-character word inside a sentence as a term of its own', () => {
    expect(indexTerms('我们昨天下单了一批画册').split(/\s+/)).toContain('下单')
  })

  it('counts a word once per sentence it appears in', () => {
    const terms = indexTerms('退款很快。退款原路返回。\n退款').split(/\s+/)
    expect(terms.filter((t) => t === '退款')).toHaveLength(3)
  })
})

describe('snippet and firstLine', () => {
  it('shows the text around the first match on one line', () => {
    const body = `${'前面的话。'.repeat(20)}\n首选恒雅彩印，因为便宜。\n${'后面的话。'.repeat(20)}`
    const s = snippet(body, ['恒雅'])
    expect(s).toContain('首选恒雅彩印，因为便宜。')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).not.toContain('\n')
    expect(s.length).toBeLessThanOrEqual(82)
  })

  it('shows a short text whole, and the first line when no term is in it', () => {
    expect(snippet('zebra crossings\n', ['zebra'])).toBe('zebra crossings')
    expect(snippet('\n# 标题\n正文', ['不在'])).toBe('# 标题')
    expect(firstLine('\n\n  # 豆子与烘焙  \n正文')).toBe('# 豆子与烘焙')
  })
})
