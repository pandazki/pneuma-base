// The kernel's find: matching the words of a sentence for `start`, and plugin filters.
import { describe, expect, it } from 'vitest'
import { agentFace, searchTerms, type FindRequest } from '../src/index.js'
import { fixture } from './support.js'

const request = (text: string, match: FindRequest['match'], filters: Record<string, string> = {}): FindRequest => ({ text, match, filters, includeArchived: false, skipOwnSession: false })
const paths = (r: { hits: { path: string | null }[] }) => r.hits.map((h) => h.path)

describe('searchTerms', () => {
  it('keeps the words of a sentence that are two characters or longer, or Latin', () => {
    expect(searchTerms('给电子书小店选支付服务', 'words')).toEqual(['电子', '小店', '支付', '服务'])
    expect(searchTerms('对比 Stripe 和 Paddle', 'words')).toEqual(['对比', 'stripe', 'paddle'])
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

  it('matches nothing when the sentence has no word to match', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(paths(await agentFace.find(request('做', 'words'), f.ctx))).toEqual([])
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
