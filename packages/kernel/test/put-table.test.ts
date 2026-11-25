// C2, K1: the put totalization table (ARCHITECTURE "放"), one test per cell.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, ownerFace, type AcceptedPut, type GrantId, type PlaceOverExisting, type PutResult, type ReviseOutcome } from '../src/index.js'
import { fixture, outsideFile, plugin, type Fixture } from './support.js'

const brought = { kind: 'brought', source: null, by: null } as const
const sha = { a: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }

function refused(r: PutResult) {
  return r.outcome === 'refused' ? r.reason : `accepted:${r.path}`
}

/** Issues a grant on `area` and reopens the fixture as the agent holding it. */
async function asGrantee(f: Fixture, area: string | null, readOnly = false) {
  const r = await ownerFace.dispatch(
    { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => false },
    'grant issue',
    { positional: ['claude'], flags: { agent: ['claude-code'], ...(area === null ? {} : { area: [area] }), ...(readOnly ? { 'read-only': true as const } : {}) } },
  )
  if (r.outcome !== 'done') throw new Error(r.text)
  const grant = (r.data as { grant: { id: GrantId } }).grant
  await f.reopen({ kind: 'agent', name: 'claude-code', grant: grant.id })
}

describe('an origin from a form', () => {
  it('treats empty fields as not given: no source, no by, no empty basis lines', async () => {
    const seen: AcceptedPut[] = []
    const f = await fixture([plugin('watcher', { onPut: async (req) => (seen.push(req), null) })])
    f.write('src.md', 's')
    f.write('a.md', 'a')
    f.write('b.md', 'b')
    await agentFace.put({ kind: 'register', path: 'a.md', origin: { kind: 'brought', source: '  ', by: '' } }, f.ctx)
    await agentFace.put({ kind: 'register', path: 'b.md', origin: { kind: 'made', from: ['src.md', ''], outside: ['', ' 主人说的 '] } }, f.ctx)
    expect(seen.map((r) => r.kind === 'register' && r.origin)).toEqual([
      { kind: 'brought', source: null, by: null },
      { kind: 'made', from: ['src.md'], outside: ['主人说的'] },
    ])
  })
})

describe('a note on a put', () => {
  it('reaches onPut trimmed; a blank or absent note arrives as null', async () => {
    const seen: AcceptedPut[] = []
    const f = await fixture([plugin('watcher', { onPut: async (req) => (seen.push(req), null) })])
    f.write('a.md', 'a')
    const stdin = (content: string) => ({ kind: 'stdin' as const, content: new TextEncoder().encode(content) })
    await agentFace.put({ kind: 'register', path: 'a.md', origin: brought, note: ' 第一稿 ' }, f.ctx)
    await agentFace.put({ kind: 'place', from: stdin('b'), to: 'b.md', origin: brought, note: '按新成本重算' }, f.ctx)
    await agentFace.put({ kind: 'register', path: 'a.md', origin: brought, note: '  ' }, f.ctx)
    await agentFace.put({ kind: 'place', from: stdin('b'), to: 'b.md', origin: brought }, f.ctx)
    expect(seen.map((r) => r.kind !== 'move' && r.note)).toEqual(['第一稿', '按新成本重算', null, null])
  })
})

describe('register', () => {
  it('outside the library: refused', async () => {
    const f = await fixture()
    expect(refused(await agentFace.put({ kind: 'register', path: outsideFile('a'), origin: brought }, f.ctx))).toBe('outside-library')
    expect(refused(await agentFace.put({ kind: 'register', path: '../x', origin: brought }, f.ctx))).toBe('outside-library')
    expect(refused(await agentFace.put({ kind: 'register', path: '.pneuma-base/config.json', origin: brought }, f.ctx))).toBe('outside-library')
  })

  it('outside the grant area: refused', async () => {
    const f = await fixture()
    f.write('other/a.md', 'a')
    await asGrantee(f, 'work')
    expect(refused(await agentFace.put({ kind: 'register', path: 'other/a.md', origin: brought }, f.ctx))).toBe('outside-grant')
  })

  it('target missing: refused, no such file', async () => {
    const f = await fixture()
    expect(refused(await agentFace.put({ kind: 'register', path: 'a.md', origin: brought }, f.ctx))).toBe('no-such-file')
  })

  it('target present: accepted with its current content', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const r = await agentFace.put({ kind: 'register', path: 'a.md', origin: brought }, f.ctx)
    expect(r).toEqual({ outcome: 'accepted', path: 'a.md', fingerprint: sha.a, copied: false, notes: [], problems: [] })
  })

  it('an absolute path inside the library is a library path', async () => {
    const f = await fixture()
    f.write('d/a.md', 'a')
    const r = await agentFace.put({ kind: 'register', path: join(f.root, 'd/a.md'), origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'accepted', path: 'd/a.md' })
  })
})

describe('place', () => {
  it('outside the library or the grant: refused', async () => {
    const f = await fixture()
    const src = { kind: 'file', path: outsideFile('a') } as const
    expect(refused(await agentFace.put({ kind: 'place', from: src, to: '../a.md', origin: brought }, f.ctx))).toBe('outside-library')
    expect(refused(await agentFace.put({ kind: 'place', from: src, to: '_archive/a.md', origin: brought }, f.ctx))).toBe('outside-library')
    await asGrantee(f, 'work')
    expect(refused(await agentFace.put({ kind: 'place', from: src, to: 'elsewhere/a.md', origin: brought }, f.ctx))).toBe('outside-grant')
    expect(refused(await agentFace.put({ kind: 'place', from: src, to: 'work/a.md', origin: brought }, f.ctx))).toBe('accepted:work/a.md')
  })

  it('a read-only grant: refused as outside the grant', async () => {
    const f = await fixture()
    await asGrantee(f, null, true)
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(refused(r)).toBe('outside-grant')
  })

  it('source missing: refused, no such file', async () => {
    const f = await fixture()
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: '/nonexistent/zzz' }, to: 'a.md', origin: brought }, f.ctx)
    expect(refused(r)).toBe('no-such-file')
  })

  it('a made origin naming a file that is not there: refused, no such file, nothing written', async () => {
    const f = await fixture()
    f.write('src.md', 's')
    f.write('_archive/old.md', 'o')
    const made = (from: string[]) => ({ kind: 'made' as const, from, outside: [] })
    const src = { kind: 'file', path: outsideFile('a') } as const
    const r = await agentFace.put({ kind: 'place', from: src, to: 'a.md', origin: made(['src.md', 'gone.md']) }, f.ctx)
    expect(r).toMatchObject({ outcome: 'refused', reason: 'no-such-file', subject: 'gone.md' })
    expect(() => f.read('a.md')).toThrow(/ENOENT/)
    expect(refused(await agentFace.put({ kind: 'place', from: src, to: 'a.md', origin: made(['src.md', 'old.md']) }, f.ctx))).toBe('accepted:a.md')
  })

  it('target missing: copied, accepted', async () => {
    const f = await fixture()
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('a') }, to: 'deep/dir/a.md', origin: brought }, f.ctx)
    expect(r).toEqual({ outcome: 'accepted', path: 'deep/dir/a.md', fingerprint: sha.a, copied: true, notes: [], problems: [] })
    expect(f.read('deep/dir/a.md')).toBe('a')
  })

  it('target holds the same content: not copied, accepted', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const r = await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: new TextEncoder().encode('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'accepted', copied: false, fingerprint: sha.a })
  })

  it('target holds different content and no plugin revises: refused, target bytes unchanged', async () => {
    const f = await fixture()
    f.write('a.md', 'old')
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('new') }, to: 'a.md', origin: brought }, f.ctx)
    expect(refused(r)).toBe('would-overwrite')
    expect(f.read('a.md')).toBe('old')
  })

  it('target holds different content and a plugin holds the old one: replaced, accepted', async () => {
    const seen: { revise?: PlaceOverExisting; held?: string; put?: AcceptedPut } = {}
    const keeper = plugin('keeper', {
      revise: async (req) => {
        seen.revise = req
        seen.held = f.read(req.path)
        return { outcome: 'held', note: null }
      },
      onPut: async (req) => {
        seen.put = req
        return null
      },
    })
    const f = await fixture([keeper])
    f.write('a.md', 'old')
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'accepted', copied: true, fingerprint: sha.a, problems: [] })
    expect(f.read('a.md')).toBe('a')
    expect(seen.held).toBe('old')
    expect(seen.revise).toMatchObject({ path: 'a.md', incoming: sha.a })
    expect(seen.put).toMatchObject({ kind: 'place', path: 'a.md', previous: seen.revise?.current, copied: true })
  })

  it('target holds different content and the reviser declines or throws: refused, target unchanged', async () => {
    for (const revise of [
      async (): Promise<ReviseOutcome> => ({ outcome: 'declined', reason: 'no' }),
      async (): Promise<ReviseOutcome> => { throw new Error('disk full') },
    ]) {
      const f = await fixture([plugin('keeper', { revise })])
      f.write('a.md', 'old')
      const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('new') }, to: 'a.md', origin: brought }, f.ctx)
      expect(refused(r)).toBe('would-overwrite')
      expect(f.read('a.md')).toBe('old')
    }
  })

  it('a reviser that throws is listed in problems', async () => {
    const f = await fixture([plugin('keeper', { revise: async () => { throw new Error('disk full') } })])
    f.write('a.md', 'old')
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('new') }, to: 'a.md', origin: brought }, f.ctx)
    expect(r.problems).toEqual([{ plugin: 'keeper', message: 'disk full' }])
  })
})

describe('revise asks every plugin that has the hook', () => {
  type Answer = ReviseOutcome | 'throw'
  /** Three plugins: two revisers answering as given, and one without the hook. Records who was asked. */
  async function overwrite(first: Answer, second: Answer) {
    const asked: string[] = []
    const reviser = (name: string, answer: Answer) =>
      plugin(name, {
        revise: async () => {
          asked.push(name)
          if (answer === 'throw') throw new Error(`${name} broke`)
          return answer
        },
      })
    const f = await fixture([reviser('one', first), plugin('quiet'), reviser('two', second)])
    f.write('a.md', 'old')
    const r = await agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('new') }, to: 'a.md', origin: brought }, f.ctx)
    return { r, asked, content: f.read('a.md') }
  }
  const held = (note: string | null): ReviseOutcome => ({ outcome: 'held', note })
  const declined: ReviseOutcome = { outcome: 'declined', reason: 'not mine' }

  it('accepts when one holds and another declines, and asks both', async () => {
    const { r, asked, content } = await overwrite(declined, held('kept by two'))
    expect(asked).toEqual(['one', 'two'])
    expect(r).toMatchObject({ outcome: 'accepted', copied: true, notes: [{ plugin: 'two', text: 'kept by two' }], problems: [] })
    expect(content).toBe('new')
  })

  it('keeps the note of each plugin that held, and still asks the second after the first held', async () => {
    const { r, asked } = await overwrite(held('kept by one'), held('kept by two'))
    expect(asked).toEqual(['one', 'two'])
    expect(r).toMatchObject({ outcome: 'accepted', notes: [{ plugin: 'one', text: 'kept by one' }, { plugin: 'two', text: 'kept by two' }] })
  })

  it('counts a plugin that throws as not held and lists it; another holding is enough', async () => {
    const { r, content } = await overwrite('throw', held(null))
    expect(r).toMatchObject({ outcome: 'accepted', notes: [], problems: [{ plugin: 'one', message: 'one broke' }] })
    expect(content).toBe('new')
  })

  it('refuses when none holds, the target unchanged, the thrower listed', async () => {
    const { r, asked, content } = await overwrite('throw', declined)
    expect(asked).toEqual(['one', 'two'])
    expect(r).toMatchObject({ outcome: 'refused', reason: 'would-overwrite', problems: [{ plugin: 'one', message: 'one broke' }] })
    expect(content).toBe('old')
  })
})

describe('move', () => {
  it('outside the library or the grant: refused', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    expect(refused(await agentFace.put({ kind: 'move', from: 'a.md', to: '../b.md' }, f.ctx))).toBe('outside-library')
    expect(refused(await agentFace.put({ kind: 'move', from: outsideFile('a'), to: 'b.md' }, f.ctx))).toBe('outside-library')
    await asGrantee(f, 'work')
    expect(refused(await agentFace.put({ kind: 'move', from: 'a.md', to: 'work/a.md' }, f.ctx))).toBe('outside-grant')
  })

  it('source missing: refused, no such file', async () => {
    const f = await fixture()
    expect(refused(await agentFace.put({ kind: 'move', from: 'a.md', to: 'b.md' }, f.ctx))).toBe('no-such-file')
  })

  it('target missing: moved, accepted', async () => {
    const f = await fixture()
    f.write('a.md', 'a')
    const r = await agentFace.put({ kind: 'move', from: 'a.md', to: 'x/b.md' }, f.ctx)
    expect(r).toEqual({ outcome: 'accepted', path: 'x/b.md', fingerprint: sha.a, copied: false, notes: [], problems: [] })
    expect(f.read('x/b.md')).toBe('a')
    expect(() => f.read('a.md')).toThrow()
  })

  it('target present with the same or different content: refused, both untouched', async () => {
    for (const target of ['a', 'other']) {
      const f = await fixture()
      f.write('a.md', 'a')
      f.write('b.md', target)
      expect(refused(await agentFace.put({ kind: 'move', from: 'a.md', to: 'b.md' }, f.ctx))).toBe('would-overwrite')
      expect(f.read('a.md')).toBe('a')
      expect(f.read('b.md')).toBe(target)
    }
  })
})

