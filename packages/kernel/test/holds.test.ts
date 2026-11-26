// A put holds the places it changes from before the write until every plugin's onPut is done, so
// whoever looks meanwhile sees them held, not as things nobody registered or things gone; once the put
// is over, nothing is held. (This replaces the kernel's own marks of puts in progress.)
import { describe, expect, it } from 'vitest'
import { agentFace, isDescribed, type Looked } from '../src/index.js'
import { fixture, plugin } from './support.js'

const brought = { kind: 'brought', source: null, by: null } as const

describe('a put holds what it changes while its plugins run', () => {
  it('marks the place held during onPut, and not after', async () => {
    let during: Looked | null = null
    const f = await fixture([
      plugin('watcher', {
        contract: 2,
        onPut: async (req, ctx) => {
          during = await ctx.tools.storage.look([{ place: req.path, token: 'v0;stale' }])
          return null
        },
      }),
    ])
    await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(during).not.toBeNull()
    expect((during as unknown as Looked).held).toEqual(['a.md'])
    const [after] = await (await import('../src/storage.js')).storageOf(f.root).glance(['a.md'])
    expect(after && isDescribed(after) && after.held).toBeFalsy()
  })

  it('releases what it held when a plugin fails', async () => {
    const f = await fixture([plugin('broken', { contract: 2, onPut: async () => Promise.reject(new Error('no')) })])
    await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('a') }, to: 'a.md', origin: brought }, f.ctx)
    const { storageOf } = await import('../src/storage.js')
    const held = await storageOf(f.root).hold(['a.md'], 1000)
    expect('hold' in held).toBe(true)
  })
})
