// K7 at the kernel: the confirmed path of a destructive command, through an injected confirmer.
// K5 on failure: an operation that throws still sends exactly one event, marked failed.
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFace, ownerFace, type Event, type OwnerCall } from '../src/index.js'
import { fixture, outsideFile, plugin, type Fixture } from './support.js'

const NO_ARGS = { positional: [], flags: {} }

function call(f: Fixture, overrides: Partial<OwnerCall> = {}): OwnerCall {
  return { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => true, ...overrides }
}

describe('a destructive owner command', () => {
  it('runs once the person confirms', async () => {
    const f = await fixture()
    f.write('_archive/old.md', 'old')
    const questions: string[] = []
    const r = await ownerFace.dispatch(call(f, { confirm: async (q) => (questions.push(q), true) }), 'archive purge', NO_ARGS)
    expect(r).toMatchObject({ outcome: 'done', problems: [] })
    expect(questions).toHaveLength(1)
    expect(existsSync(join(f.root, '_archive'))).toBe(false)
  })

  it('is refused in an agent session before anyone is asked', async () => {
    const f = await fixture()
    f.write('_archive/old.md', 'old')
    let asked = false
    const confirm = async () => (asked = true)
    // The refusal says why, so a person who started the server inside an agent session knows what to change.
    expect(await ownerFace.dispatch(call(f, { env: { CODEX_THREAD_ID: 't' }, confirm }), 'archive purge', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('CODEX_THREAD_ID') })
    expect(await ownerFace.dispatch(call(f, { viaGrant: true, confirm }), 'archive purge', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining('授权') })
    expect(asked).toBe(false)
    expect(f.read('_archive/old.md')).toBe('old')
  })

  it('declared by a plugin goes through the same gate', async () => {
    let ran = 0
    const p = plugin('wiper', {
      ownerCommands: [{ name: 'wiper wipe', summary: '', params: {}, destructive: true, ownerOnly: true, run: async () => (ran++, { outcome: 'done', text: 'wiped' }) }],
    })
    const f = await fixture([p])
    expect(await ownerFace.dispatch(call(f, { confirm: async () => false }), 'wiper wipe', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'not-confirmed' })
    expect(await ownerFace.dispatch(call(f, { env: { PNEUMA_BASE_SESSION: 's' } }), 'wiper wipe', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(ran).toBe(0)
    expect(await ownerFace.dispatch(call(f), 'wiper wipe', NO_ARGS)).toMatchObject({ outcome: 'done', text: 'wiped' })
    expect(ran).toBe(1)
  })
})

describe('an owner-only command', () => {
  it('runs for the owner without asking, and is refused for an agent, without asking, naming what showed it', async () => {
    let ran = 0
    const p = plugin('switch', {
      ownerCommands: [{ name: 'switch on', summary: '', params: {}, destructive: false, ownerOnly: true, run: async () => (ran++, { outcome: 'done', text: 'on' }) }],
    })
    const f = await fixture([p])
    let asked = false
    const confirm = async () => (asked = true)
    expect(await ownerFace.dispatch(call(f, { confirm }), 'switch on', NO_ARGS)).toMatchObject({ outcome: 'done', text: 'on' })
    expect(asked).toBe(false)
    const agent = { ...f.ctx, actor: { kind: 'agent' as const, name: 'codex', grant: null } }
    for (const [overrides, sign] of [
      [{ env: { CLAUDE_CODE_SESSION_ID: 'c' } }, 'CLAUDE_CODE_SESSION_ID'],
      [{ env: { ANTIGRAVITY_CONVERSATION_ID: 'a' } }, 'ANTIGRAVITY_CONVERSATION_ID'],
      [{ env: { ANTIGRAVITY_AGENT: '1' } }, 'ANTIGRAVITY_AGENT'],
      [{ viaGrant: true }, '授权'],
      [{ ctx: agent }, 'Agent codex'],
    ] as const) {
      expect(await ownerFace.dispatch(call(f, { ...overrides, confirm }), 'switch on', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'agent-session', text: expect.stringContaining(sign) })
    }
    expect(asked).toBe(false)
    expect(ran).toBe(1)
  })

  it('covers the kernel’s grant, plugin, secret, agent, request, pairing and storage commands, but not skill install or plugin list', () => {
    const owners = ownerFace.commands([]).filter((c) => c.ownerOnly).map((c) => c.name)
    expect(owners).toEqual(['grant create', 'grant revoke', 'plugin enable', 'plugin disable', 'archive purge', 'plugin install', 'plugin uninstall', 'secret set', 'secret list', 'secret remove', 'agent detect', 'agent connect', 'agent disconnect', 'agent list', 'launcher install', 'request list', 'request approve', 'request decline', 'pair list', 'pair allow', 'pair decline', 'ignore add', 'ignore remove', 'storage list', 'storage install', 'storage remove', 'storage update'])
  })
})

describe('the owner event', () => {
  it('says whether the command was destructive, and archive purge names the paths it deleted', async () => {
    const events: Event[] = []
    const recorder = plugin('recorder', { observe: async (e) => void events.push(e) })
    const f = await fixture([recorder])
    events.length = 0
    f.write('_archive/a.md', 'a')
    f.write('_archive/d/b.md', 'b')
    await ownerFace.dispatch(call(f, { table: new Map([['recorder', recorder]]) }), 'grant create', { positional: ['g'], flags: { agent: ['x'] } })
    await ownerFace.dispatch(call(f), 'archive purge', NO_ARGS)
    expect(events).toMatchObject([
      { face: 'owner', command: 'grant create', destructive: false },
      { face: 'owner', command: 'archive purge', destructive: true, result: { outcome: 'done', data: { removed: 2, paths: ['_archive/a.md', '_archive/d/b.md'] } } },
    ])
  })
})

describe('an owner command’s act', () => {
  it('names its row by the first given of the arguments it names, an empty one not given, else by its fixed name', async () => {
    const events: Event[] = []
    const flags = ['host', 'origin'].map((name) => ({ name, hint: name, kind: 'value' as const }))
    const connect = { name: 'target set', summary: '', params: { flags }, act: { kind: 'connected' as const, object: ['host', 'origin'], name: '自己的命令' }, destructive: false, ownerOnly: true, run: async () => ({ outcome: 'done' as const, text: '' }) }
    const f = await fixture([plugin('target', { ownerCommands: [connect], observe: async (e) => void events.push(e) })])
    events.length = 0
    const calls: Record<string, string[]>[] = [{ host: ['space.example.com'], origin: ['https://other.example.com'] }, { host: [''], origin: ['https://space.example.com'] }, { host: [' '] }]
    for (const given of calls) {
      await ownerFace.dispatch(call(f), 'target set', { positional: [], flags: given })
    }
    expect(events.map((e) => (e.face === 'owner' ? e.act : null))).toEqual([
      { kind: 'connected', object: 'space.example.com' },
      { kind: 'connected', object: 'https://space.example.com' },
      { kind: 'connected', object: '自己的命令' },
    ])
  })
})

describe('the single exit', () => {
  it('sends one failed event when the operation throws, then rethrows', async () => {
    const events: Event[] = []
    const f = await fixture([plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0 // forget the init event
    // A source nobody can read: storage fails the copy, and the put throws.
    const source = outsideFile('a')
    chmodSync(source, 0o000)
    const put = agentFace.put({ kind: 'place', from: { kind: 'file', path: source }, to: 'a.md', origin: { kind: 'generated', from: [], outside: [] } }, f.ctx)
    await expect(put).rejects.toThrow()
    chmodSync(source, 0o644)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ face: 'agent', verb: 'put', result: { outcome: 'failed' } })
  })
})

describe('the owner face’s one entry', () => {
  it('lists the kernel’s commands, then each installed plugin’s; a plugin cannot take a kernel name', async () => {
    const shadow = plugin('shadow', {
      ownerCommands: [
        { name: 'archive purge', summary: '', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text: 'shadowed' }) },
        { name: 'shadow list', summary: '', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text: 'listed' }) },
      ],
    })
    const f = await fixture([shadow])
    const names = ownerFace.commands(f.library.plugins).map((c) => `${c.by}:${c.name}`)
    const kernel = ['grant create', 'grant revoke', 'plugin enable', 'plugin disable', 'plugin backfill', 'skill install', 'archive purge', 'plugin install', 'plugin uninstall', 'plugin list', 'secret set', 'secret list', 'secret remove', 'agent detect', 'agent connect', 'agent disconnect', 'agent list', 'launcher install', 'request list', 'request approve', 'request decline', 'pair list', 'pair allow', 'pair decline', 'ignore list', 'ignore add', 'ignore remove', 'storage list', 'storage install', 'storage remove', 'storage update']
    expect(names).toEqual([...kernel.map((n) => `kernel:${n}`), 'shadow:shadow list'])
    expect(await ownerFace.dispatch(call(f), 'shadow list', NO_ARGS)).toMatchObject({ outcome: 'done', text: 'listed' })
    expect(await ownerFace.dispatch(call(f, { confirm: async () => false }), 'archive purge', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'not-confirmed' })
  })

  it('refuses an unknown command before any operation, so no event is sent', async () => {
    const events: Event[] = []
    const f = await fixture([plugin('recorder', { observe: async (e) => void events.push(e) })])
    events.length = 0
    expect(await ownerFace.dispatch(call(f), 'delete everything', NO_ARGS)).toMatchObject({ outcome: 'refused', reason: 'unknown-command' })
    expect(events).toEqual([])
  })
})

describe('skill install', () => {
  it('takes ~ in the directory as the home directory, as a shell would', async () => {
    const f = await fixture()
    await ownerFace.dispatch(call(f), 'grant create', { positional: ['claude'], flags: { agent: ['claude-code'] } })
    await f.reopen()
    const home = process.env.HOME
    process.env.HOME = f.home
    try {
      const r = await ownerFace.dispatch(call(f), 'skill install', { positional: ['claude'], flags: { agent: ['claude'], dir: ['~/skills'] } })
      expect(r).toMatchObject({ outcome: 'done', data: { file: join(f.home, 'skills', 'pneuma-base-claude', 'SKILL.md') } })
      expect(existsSync(join(f.home, 'skills', 'pneuma-base-claude', 'SKILL.md'))).toBe(true)
    } finally {
      process.env.HOME = home
    }
  })
})
