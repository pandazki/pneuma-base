// The kernel's find: matching the words of a sentence for `start`, and plugin filters.
import { describe, expect, it } from 'vitest'
import { agentFace, BUNDLE_MARKER, searchTerms, type FindRequest, type LibraryPath, type PluginHit } from '../src/index.js'
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

describe('find in words mode', () => {
  it('ranks names by how many distinct words they match and gives the best five', async () => {
    const f = await fixture()
    for (const name of ['支付-小店.md', '支付-1.md', '支付-2.md', '支付-3.md', '支付-4.md', '支付-5.md', '其他.md']) f.write(name, name)
    const r = await agentFace.find(request('给小店接上支付', 'words'), f.ctx)
    expect(paths(r)).toHaveLength(5)
    expect(paths(r)[0]).toBe('支付-小店.md')
    expect(paths(r)).not.toContain('其他.md')
  })

  it('finds an earlier 下单 from the sentence 看看下单进展', async () => {
    const f = await fixture()
    f.write('下单流程.md', 'x')
    expect(paths(await agentFace.find(request('看看下单进展', 'words'), f.ctx))).toEqual(['下单流程.md'])
  })

  it('matches nothing when the sentence has no word to match', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(paths(await agentFace.find(request('做', 'words'), f.ctx))).toEqual([])
  })
})

describe('find with plugins that read content', () => {
  const contentHit = (path: string, detail: string | null): PluginHit => ({ path: path as LibraryPath, title: path.split('/').at(-1) as string, group: null, detail })

  it('gives a path both the kernel and a plugin found once, from the plugin, at the best rank either gave it', async () => {
    const reader = plugin('reader', { onFind: async () => [contentHit('notes/zebra.md', '正文：…zebra…')] })
    const f = await fixture([reader])
    f.write('notes/zebra.md', 'zebra')
    f.write('notes/zebra-2.md', 'other')
    const r = await agentFace.find(request('zebra', 'terms'), f.ctx)
    expect(r.hits).toEqual([
      { path: 'notes/zebra-2.md', title: 'zebra-2.md', by: 'kernel', group: null, detail: null },
      { path: 'notes/zebra.md', title: 'zebra.md', by: 'reader', group: null, detail: '正文：…zebra…' },
    ])
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

describe('find with filters', () => {
  it('lists no file by name, since the kernel cannot apply a plugin filter', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(paths(await agentFace.find(request('a', 'terms'), f.ctx))).toEqual(['a.md'])
    expect(paths(await agentFace.find(request('a', 'terms', { origin: 'made' }), f.ctx))).toEqual([])
  })
})
