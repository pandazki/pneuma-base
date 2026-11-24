// K7 at the kernel: the confirmed path of a destructive command, through an injected confirmer.
// K5 on failure: an operation that throws still sends exactly one event, marked failed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, ownerFace, type Event, type OwnerCall } from '../src/index.js'
import { fixture, plugin, type Fixture } from './support.js'

function call(f: Fixture, overrides: Partial<OwnerCall> = {}): OwnerCall {
  return { ctx: f.ctx, table: new Map(), home: f.home, env: {}, viaGrant: false, confirm: async () => true, ...overrides }
}

describe('a destructive owner command', () => {
  it('runs once the person confirms', async () => {
    const f = await fixture()
    f.write('_archive/old.md', 'old')
    const questions: string[] = []
    const r = await ownerFace.purgeArchive(call(f, { confirm: async (q) => (questions.push(q), true) }))
    expect(r).toMatchObject({ outcome: 'done', problems: [] })
    expect(questions).toHaveLength(1)
    expect(existsSync(join(f.root, '_archive'))).toBe(false)
  })

  it('is refused in an agent session before anyone is asked', async () => {
    const f = await fixture()
    f.write('_archive/old.md', 'old')
    let asked = false
    const confirm = async () => (asked = true)
    expect(await ownerFace.purgeArchive(call(f, { env: { CODEX_THREAD_ID: 't' }, confirm }))).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(await ownerFace.purgeArchive(call(f, { viaGrant: true, confirm }))).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(asked).toBe(false)
    expect(f.read('_archive/old.md')).toBe('old')
  })

  it('declared by a plugin goes through the same gate', async () => {
    let ran = 0
    const p = plugin('wiper', {
      ownerCommands: [{ name: 'wiper wipe', summary: '', destructive: true, run: async () => (ran++, { outcome: 'done', text: 'wiped' }) }],
    })
    const f = await fixture([p])
    const command = p.ownerCommands[0]!
    const args = { positional: [], flags: {} }
    expect(await ownerFace.run(call(f, { confirm: async () => false }), p, command, args)).toMatchObject({ outcome: 'refused', reason: 'not-confirmed' })
    expect(await ownerFace.run(call(f, { env: { PNEUMA_BASE_SESSION: 's' } }), p, command, args)).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(ran).toBe(0)
    expect(await ownerFace.run(call(f), p, command, args)).toMatchObject({ outcome: 'done', text: 'wiped' })
    expect(ran).toBe(1)
  })
})

describe('the single exit', () => {
  it('sends one failed event when the operation throws, then rethrows', async () => {
    const events: Event[] = []
    const f = await fixture([plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0 // forget the init event
    f.write('a.md', 'a')
    // a.md is a file, so a.md/b.md cannot be created.
    const put = agentFace.put({ kind: 'place', from: { kind: 'stdin', content: new Uint8Array([1]) }, to: 'a.md/b.md', origin: { kind: 'made', from: [], outside: [] } }, f.ctx)
    await expect(put).rejects.toThrow()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ face: 'agent', verb: 'put', result: { outcome: 'failed' } })
  })
})
