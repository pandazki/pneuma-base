// The kernel's find: matching the words of a sentence for `start`, and plugin filters.
import { describe, expect, it } from 'vitest'
import { agentFace, BUNDLE_MARKER, rankHits, searchTerms, type FindRequest, type LibraryPath, type PluginHit } from '../src/index.js'
import { fixture, plugin } from './support.js'

const request = (text: string, match: FindRequest['match'], filters: Record<string, string> = {}): FindRequest => ({ text, match, filters, includeArchived: false, skipOwnSession: false })
const paths = (r: { hits: { path: string | null }[] }) => r.hits.map((h) => h.path)

describe('searchTerms', () => {
  it('keeps the words of a sentence that are two characters or longer, or Latin', () => {
    expect(searchTerms('给电子书小店选支付服务', 'words')).toEqual(['电子', '小店', '支付', '服务'])
    expect(searchTerms('对比 Stripe 和 Paddle', 'words')).toEqual(['对比', 'stripe', 'paddle'])
  })

  it('joins adjacent single Chinese characters into two-character terms, since the segmenter cuts some words apart', () => {
    expect(searchTerms('看看下单进展', 'words')).toEqual(['看看', '下单', '进展'])
    expect(searchTerms('我们下单了吗', 'words')).toEqual(['我们', '下单', '单了', '了吗'])
    expect(searchTerms('下 单', 'words')).toEqual([])
  })

  it('keeps the text as written in terms mode', () => {
    expect(searchTerms('支付服务 Stripe', 'terms')).toEqual(['支付服务', 'stripe'])
  })
})

describe('ranking for find in words mode', () => {
  // The kernel finds nothing by name itself (that would walk the library); a plugin's index ranks with
  // the kernel's rankHits, handed to it as tools.rankHits.
  const rank = (names: string[], sentence: string) => rankHits(names.map((n) => ({ hit: n, haystack: n.toLowerCase() })), searchTerms(sentence, 'words'), 'words')

  it('ranks names by how many distinct words they match and gives the best five', () => {
    const r = rank(['支付-小店.md', '支付-1.md', '支付-2.md', '支付-3.md', '支付-4.md', '支付-5.md', '其他.md'], '给小店接上支付')
    expect(r).toHaveLength(5)
    expect(r[0]).toBe('支付-小店.md')
    expect(r).not.toContain('其他.md')
  })

  it('finds an earlier 下单 from the sentence 看看下单进展', () => {
    expect(rank(['下单流程.md'], '看看下单进展')).toEqual(['下单流程.md'])
  })

  it('matches nothing when the sentence has no word to match', () => {
    expect(rank(['a.md'], '做')).toEqual([])
  })
})

describe('find without a plugin that finds', () => {
  it('finds nothing: the kernel walks no folder to match names', async () => {
    const f = await fixture()
    f.write('下单流程.md', 'x')
    expect(paths(await agentFace.find(request('看看下单进展', 'words'), f.ctx))).toEqual([])
  })
})

describe('find with plugins that read content', () => {
  const contentHit = (path: string, detail: string | null): PluginHit => ({ path: path as LibraryPath, title: path.split('/').at(-1) as string, group: null, detail })

  it('gives what the plugin found, and nothing the kernel matched by name', async () => {
    const reader = plugin('reader', { onFind: async () => [contentHit('notes/zebra.md', '正文：…zebra…')] })
    const f = await fixture([reader])
    f.write('notes/zebra.md', 'zebra')
    f.write('notes/zebra-2.md', 'other')
    const r = await agentFace.find(request('zebra', 'terms'), f.ctx)
    expect(r.hits).toEqual([{ path: 'notes/zebra.md', title: 'zebra.md', by: 'reader', group: null, detail: '正文：…zebra…' }])
  })

  it('keeps the kernel’s mark of a bundle in front of the plugin’s detail', async () => {
    const reader = plugin('reader', { onFind: async () => [contentHit('sites/zebra', 'index.html：…zebra…')] })
    const f = await fixture([reader])
    f.write('sites/zebra/index.html', 'zebra')
    f.write(`sites/zebra/${BUNDLE_MARKER}`, '{"format":1}\n')
    expect((await agentFace.find(request('zebra', 'terms'), f.ctx)).hits).toEqual([
      { path: 'sites/zebra', title: 'zebra', by: 'reader', group: null, detail: '目录，index.html：…zebra…' },
    ])
  })

  it('places each path at the best rank any answerer gave it, so a later plugin’s relevance order holds', async () => {
    const names = plugin('names', { onFind: async () => ['y.md', 'z.md', 'x.md'].map((p) => contentHit(p, `名字：${p}`)) })
    const relevance = plugin('relevance', { onFind: async () => ['x.md', 'z.md'].map((p) => contentHit(p, `正文：${p}`)) })
    const f = await fixture([names, relevance])
    const r = await agentFace.find(request('q', 'terms'), f.ctx)
    // y and x are each someone's first: y first, since its answerer comes first; z is second for both.
    expect(r.hits.map((h) => [h.path, h.by])).toEqual([
      ['y.md', 'names'],
      ['x.md', 'names'],
      ['x.md', 'relevance'],
      ['z.md', 'names'],
      ['z.md', 'relevance'],
    ])
  })

  it('lists what a plugin could not do next to the hits it still gave', async () => {
    const partial = plugin('partial', { onFind: async () => ({ hits: [contentHit('a.md', '正文：…a…')], problems: ['嵌入服务连不上'] }) })
    const f = await fixture([partial])
    f.write('a.md', 'a')
    const r = await agentFace.find(request('nothing-by-name', 'terms'), f.ctx)
    expect(r.hits.map((h) => [h.path, h.by])).toEqual([['a.md', 'partial']])
    expect(r.problems).toEqual([{ plugin: 'partial', message: '嵌入服务连不上' }])
  })
})

describe('find with plugins that know about paths others found', () => {
  const hit = (path: string | null, detail: string): PluginHit => ({ path: path as LibraryPath | null, title: path ?? '场景', group: null, detail })
  const finder = (found: () => string[]) => plugin('finder', { onFind: async () => found().map((p) => hit(p, `正文：${p}`)) })

  it('joins what a plugin knows to the entry of its path, in configuration order, at the rank the finders gave', async () => {
    const annotator = plugin('annotator', { onFound: async (paths) => [...paths].reverse().map((p) => hit(p, `来历：${p}`)) })
    const f = await fixture([annotator, finder(() => ['b.md', 'a.md'])])
    const r = await agentFace.find(request('q', 'terms'), f.ctx)
    expect(r.hits.map((h) => [h.path, h.by, h.detail])).toEqual([
      ['b.md', 'annotator', '来历：b.md'],
      ['b.md', 'finder', '正文：b.md'],
      ['a.md', 'annotator', '来历：a.md'],
      ['a.md', 'finder', '正文：a.md'],
    ])
    expect(r.problems).toEqual([])
  })

  it('keeps the kernel’s mark in front of the first plugin hit when that hit is what a plugin knows', async () => {
    const annotator = plugin('annotator', { onFound: async (paths) => paths.map((p) => hit(p, '做出来的')) })
    const f = await fixture([annotator, finder(() => ['sites/zebra'])])
    f.write('sites/zebra/index.html', 'zebra')
    f.write(`sites/zebra/${BUNDLE_MARKER}`, '{"format":1}\n')
    expect((await agentFace.find(request('zebra', 'terms'), f.ctx)).hits.map((h) => [h.path, h.by, h.detail])).toEqual([
      ['sites/zebra', 'annotator', '目录，做出来的'],
      ['sites/zebra', 'finder', '正文：sites/zebra'],
    ])
  })

  it('asks a plugin only about the found paths it gave no hit for, and not at all when none is left', async () => {
    const asked: string[][] = []
    const both = plugin('both', {
      onFind: async () => [hit('a.md', '正文：a.md'), hit(null, '一个场景')],
      onFound: async (paths) => {
        asked.push([...paths].sort())
        return []
      },
    })
    let found = ['a.md', 'b.md']
    const f = await fixture([both, finder(() => found)])
    await agentFace.find(request('q', 'terms'), f.ctx)
    expect(asked).toEqual([['b.md']])

    found = ['a.md']
    await agentFace.find(request('nothing-by-name', 'terms'), f.ctx)
    expect(asked).toHaveLength(1)
  })

  it('lists a plugin whose onFound throws as a problem, and the hits stand', async () => {
    const thrower = plugin('thrower', {
      onFound: async () => {
        throw new Error('记录读不了')
      },
    })
    const f = await fixture([thrower, finder(() => ['a.md'])])
    const r = await agentFace.find(request('q', 'terms'), f.ctx)
    expect(r.hits.map((h) => [h.path, h.by])).toEqual([['a.md', 'finder']])
    expect(r.problems).toEqual([{ plugin: 'thrower', message: '记录读不了' }])
  })

  it('leaves out a hit on a path the plugin was not asked about, a hit without a path too, and lists each as its problem', async () => {
    const stray = plugin('stray', { onFound: async () => [hit('a.md', '来历：a.md'), hit('elsewhere.md', '来历'), hit(null, '场景')] })
    const f = await fixture([stray, finder(() => ['a.md'])])
    const r = await agentFace.find(request('q', 'terms'), f.ctx)
    expect(r.hits.map((h) => [h.path, h.by])).toEqual([
      ['a.md', 'stray'],
      ['a.md', 'finder'],
    ])
    expect(r.problems.map((p) => p.plugin)).toEqual(['stray', 'stray'])
  })
})

describe('find with filters', () => {
  it('passes the filters to the plugins and finds nothing by name itself', async () => {
    const seen: Record<string, string>[] = []
    const f = await fixture([plugin('reader', { onFind: async (req) => (seen.push(req.filters), []) })])
    f.write('a.md', 'a')
    expect(paths(await agentFace.find(request('a', 'terms', { origin: 'made' }), f.ctx))).toEqual([])
    expect(seen).toEqual([{ origin: 'made' }])
  })
})
