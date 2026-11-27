// What a plugin author gets from requests: an owner-only command of the plugin can be asked for with
// no work, the approved run reaches observe as the command's own event carrying the request, and a
// command marked `askable: false` is refused. ARCHITECTURE.md「请主人做」.
import { describe, expect, it } from 'vitest'
import { agentFace, ownerFace, type Event, type GrantId, type OwnerCall } from '../src/index.js'
import { fixture, plugin } from './support.js'

const agent = { kind: 'agent' as const, name: 'claude', grant: 'g-1' as GrantId }

describe("a plugin's owner commands", () => {
  it('can be asked for; approving runs it as the owner, and its event carries the request and who asked', async () => {
    const heard: Event[] = []
    let ranAs: string | null = null
    const p = plugin('lamp', {
      ownerCommands: [{ name: 'lamp on', summary: '开灯', params: { positional: [{ name: 'room', hint: '房间', required: true }] }, destructive: false, ownerOnly: true, run: async (args, ctx) => ((ranAs = ctx.actor.kind), { outcome: 'done', text: `${String(args.values.room)} 的灯开了` }) }],
      observe: async (event) => void heard.push(event),
    })
    const f = await fixture([p])
    const asked = await agentFace.ask({ kind: 'ask', why: '天黑了', command: 'lamp on', args: { positional: ['书房'], flags: {} } }, { ...f.ctx, actor: agent })
    if (asked.outcome !== 'asked') throw new Error(JSON.stringify(asked))
    expect(asked.request).toMatchObject({ by: { name: 'claude', grant: 'g-1' }, line: 'lamp on 书房', status: { kind: 'pending' } })
    expect(heard.at(-1)).toMatchObject({ face: 'agent', verb: 'ask', result: { outcome: 'asked' } })

    const call: OwnerCall = { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => false }
    expect(await ownerFace.dispatch(call, 'request approve', { positional: [asked.request.id], flags: {} })).toMatchObject({ outcome: 'done', text: '书房 的灯开了' })
    expect(ranAs).toBe('owner')
    const run = heard.find((e) => e.face === 'owner' && e.command === 'lamp on')
    expect(run).toMatchObject({ args: { positional: ['书房'] }, request: { id: asked.request.id, by: { name: 'claude', grant: 'g-1' } }, result: { outcome: 'done' } })
    expect(heard.filter((e) => e.face === 'owner' && e.command === 'request approve')).toHaveLength(1)
  })

  it('turned destructive after the ask, is not run on approval: the refusal is the outcome', async () => {
    let ran = 0
    const wipe = { name: 'lamp wipe', summary: '', params: {}, destructive: false, ownerOnly: true, run: async () => (ran++, { outcome: 'done' as const, text: 'wiped' }) }
    const f = await fixture([plugin('lamp', { ownerCommands: [wipe] })])
    const asked = await agentFace.ask({ kind: 'ask', why: '清掉', command: 'lamp wipe', args: { positional: [], flags: {} } }, { ...f.ctx, actor: agent })
    if (asked.outcome !== 'asked') throw new Error(JSON.stringify(asked))
    Object.assign(wipe, { destructive: true, ownerOnly: false })
    const call: OwnerCall = { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => true }
    expect(await ownerFace.dispatch(call, 'request approve', { positional: [asked.request.id], flags: {} })).toMatchObject({ outcome: 'refused', reason: 'no-longer-askable' })
    expect(ran).toBe(0)
    const later = await agentFace.inspect({ target: asked.request.id }, { ...f.ctx, actor: agent })
    expect(later.request?.status).toMatchObject({ kind: 'approved', outcome: { outcome: 'refused', reason: 'no-longer-askable' } })
  })

  it('marked askable: false, is refused when asked for, and its refusal in an agent session gives no ask line', async () => {
    const p = plugin('vault', {
      ownerCommands: [{ name: 'vault open', summary: '', params: {}, destructive: false, ownerOnly: true, askable: false, run: async () => ({ outcome: 'done', text: 'open' }) }],
    })
    const f = await fixture([p])
    const asked = await agentFace.ask({ kind: 'ask', why: '要用', command: 'vault open', args: { positional: [], flags: {} } }, { ...f.ctx, actor: agent })
    expect(asked).toMatchObject({ outcome: 'refused', reason: 'not-askable' })
    expect(ownerFace.commands(f.library.plugins).find((c) => c.name === 'vault open')).toMatchObject({ askable: false })
    const refused = await ownerFace.dispatch({ ctx: { ...f.ctx, actor: agent }, table: new Map(), env: {}, viaGrant: true, confirm: async () => false }, 'vault open', { positional: [], flags: {} })
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(refused.outcome === 'refused' && refused.text).not.toContain(' ask ')
  })
})
