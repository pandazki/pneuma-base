// A put in progress is visible: its paths are marked from before it touches anything until every
// plugin's hook is done, and a mark its put stopped refreshing goes stale. ARCHITECTURE "放".
import { chmodSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, pluginContext, type Context, type LibraryPath, type PluginName } from '../src/index.js'
import { fixture, outsideFile, plugin } from './support.js'

const brought = { kind: 'brought', source: null, by: null } as const
const stdin = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })
const puttingIn = (ctx: Context) => pluginContext(ctx, 'any' as PluginName).tools.putting()

describe('tools.putting', () => {
  it('names the paths a put places, registers or moves while its plugins run, and nothing once it is done', async () => {
    const seen: LibraryPath[][] = []
    const f = await fixture([plugin('watcher', { onPut: async (_req, ctx) => (seen.push(await ctx.tools.putting()), null) })])
    await agentFace.put({ kind: 'place', from: stdin('a'), to: 'notes/a.md', origin: brought }, f.ctx)
    f.write('b.md', 'b')
    await agentFace.put({ kind: 'register', path: 'b.md', origin: brought }, f.ctx)
    await agentFace.put({ kind: 'move', from: 'notes/a.md', to: 'kept/a.md' }, f.ctx)
    expect(seen).toEqual([['notes/a.md'], ['b.md'], ['kept/a.md', 'notes/a.md']])
    expect(await puttingIn(f.ctx)).toEqual([])
  })

  it('is cleared after a refused put and after one that failed', async () => {
    const f = await fixture()
    expect(await agentFace.put({ kind: 'register', path: 'absent.md', origin: brought }, f.ctx)).toMatchObject({ outcome: 'refused' })
    const unreadable = outsideFile('x')
    chmodSync(unreadable, 0o000)
    await expect(agentFace.put({ kind: 'place', from: { kind: 'file', path: unreadable }, to: 'y.md', origin: brought }, f.ctx)).rejects.toThrow()
    expect(await puttingIn(f.ctx)).toEqual([])
  })

  it('keeps the mark of a long put fresh: it is refreshed every two seconds while the put runs', async () => {
    const marks = (root: string) => join(root, '.pneuma-base/tmp/putting')
    const ages: number[] = []
    const slow = plugin('slow', {
      onPut: async (_req, ctx) => {
        const [name] = readdirSync(marks(ctx.library.root))
        const born = Date.now()
        await new Promise((done) => setTimeout(done, 2_500))
        ages.push(statSync(join(marks(ctx.library.root), name as string)).mtimeMs - born)
        return null
      },
    })
    const f = await fixture([slow])
    await agentFace.put({ kind: 'place', from: stdin('s'), to: 's.md', origin: brought }, f.ctx)
    expect(ages[0]).toBeGreaterThan(1_000)
  })

  it('leaves out a mark not refreshed for ten seconds, as one a killed put left; the next put clears it', async () => {
    const f = await fixture()
    const marks = join(f.root, '.pneuma-base/tmp/putting')
    mkdirSync(marks, { recursive: true })
    const mark = (name: string, path: string, age: number) => {
      writeFileSync(join(marks, name), JSON.stringify({ paths: [path] }))
      const at = new Date(Date.now() - age)
      utimesSync(join(marks, name), at, at)
    }
    mark('fresh.json', 'fresh.md', 9_000)
    mark('stale.json', 'stale.md', 11_000)
    expect(await puttingIn(f.ctx)).toEqual(['fresh.md'])
    await agentFace.put({ kind: 'place', from: stdin('c'), to: 'c.md', origin: brought }, f.ctx)
    expect(readdirSync(marks)).toEqual(['fresh.json'])
  })
})
