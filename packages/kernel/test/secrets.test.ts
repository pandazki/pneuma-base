// C9 at the kernel: a plugin's credential is set by the owner, kept per machine under
// $PNEUMA_BASE_HOME in a file only the user can read, outside every library, never in an answer
// or an event, and read by the plugin with ctx.secrets.get.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerFace, viewerFace, type Event, type MachineContext, type OwnerCall, type OwnerResult } from '../src/index.js'
import { fixture, owner, plugin, session, tempDir } from './support.js'

const TOKEN = 'tok-5c1e7-only-here'

const events: Event[] = []
const vault = plugin('vault', {
  secrets: [{ name: 'token', description: '外面服务的令牌' }],
  ownerCommands: [{ name: 'vault show', summary: '', params: {}, destructive: false, ownerOnly: false, run: async (_args, ctx) => ({ outcome: 'done', text: 'shown', data: { token: await ctx.secrets.get('token') } }) }],
  observe: async (e) => void events.push(e),
})

const table = new Map([['vault', vault]])

/** Every file under `dir`, with its content. */
function contents(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
}

function machine(home: string, overrides: Partial<OwnerCall> = {}): OwnerCall {
  const ctx: MachineContext = { library: null, actor: owner, session, now: new Date().toISOString() as MachineContext['now'], home }
  return { ctx, table, env: {}, viaGrant: false, confirm: async () => true, readSecret: async () => TOKEN, ...overrides }
}

const set = (call: OwnerCall, name = 'token') => ownerFace.dispatch(call, 'secret set', { positional: ['vault', name], flags: {} })

describe('secret set', () => {
  it('needs no library, keeps the value in a file only the user can read under the machine’s home, and the plugin reads it', async () => {
    const f = await fixture([vault])
    const r = await set(machine(f.home))
    expect(r).toMatchObject({ outcome: 'done', data: { plugin: 'vault', name: 'token', replaced: false } })
    const file = join(f.home, 'secrets', 'vault', 'token')
    expect(readFileSync(file, 'utf8')).toBe(TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(f.home, 'secrets', 'vault')).mode & 0o777).toBe(0o700)
    expect(statSync(join(f.home, 'secrets')).mode & 0o777).toBe(0o700)
    const shown = await ownerFace.dispatch({ ...machine(f.home), ctx: f.ctx }, 'vault show', { positional: [], flags: {} })
    expect(shown).toMatchObject({ outcome: 'done', data: { token: TOKEN } })
  })

  it('from the page, with a library: the library hears it, and neither the answer, the event nor any file of the library holds the value', async () => {
    const f = await fixture([vault])
    events.length = 0
    const r = await set({ ...machine(f.home), ctx: f.ctx })
    expect(r.outcome).toBe('done')
    expect(events).toMatchObject([{ face: 'owner', command: 'secret set', args: { positional: ['vault', 'token'], flags: {} }, setup: true }])
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(contents(f.root).some((text) => text.includes(TOKEN))).toBe(false)
  })

  it('is refused in an agent session before the value is asked for', async () => {
    const home = tempDir('pb-k-home-')
    let asked = false
    const r = await set(machine(home, { env: { CLAUDE_CODE_SESSION_ID: 's' }, readSecret: async () => ((asked = true), TOKEN) }))
    expect(r).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(asked).toBe(false)
  })

  it('refuses a name the plugin does not declare, a plugin this machine does not have, and no value, writing nothing', async () => {
    const home = tempDir('pb-k-home-')
    const refusals: OwnerResult[] = [
      await set(machine(home), 'tokn'),
      await ownerFace.dispatch(machine(home), 'secret set', { positional: ['nobody', 'token'], flags: {} }),
      await set(machine(home, { readSecret: async () => null })),
      await set(machine(home, { readSecret: async () => '' })),
      await set(machine(home, { readSecret: undefined })),
    ]
    expect(refusals.map((r) => (r.outcome === 'refused' ? r.reason : r.outcome))).toEqual(['undeclared-secret', 'unknown-plugin', 'no-value', 'no-value', 'no-value'])
    expect(refusals[0]?.text).toContain('它用的：token')
    expect(contents(home)).toEqual([])
  })
})

describe('secret list and secret remove', () => {
  it('list names what is set and what is declared but not, never a value; remove takes it away, and again says it was not there', async () => {
    const home = tempDir('pb-k-home-')
    const none = await ownerFace.dispatch(machine(home), 'secret list', { positional: ['vault'], flags: {} })
    expect(none).toMatchObject({ outcome: 'done', data: { set: [], declared: [{ name: 'token', description: '外面服务的令牌', set: false }] } })
    await set(machine(home))
    const listed = await ownerFace.dispatch(machine(home), 'secret list', { positional: ['vault'], flags: {} })
    expect(listed).toMatchObject({ outcome: 'done', data: { set: ['token'], declared: [{ name: 'token', set: true }] } })
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(await ownerFace.dispatch(machine(home), 'secret remove', { positional: ['vault', 'token'], flags: {} })).toMatchObject({ outcome: 'done', data: { removed: true } })
    expect(await ownerFace.dispatch(machine(home), 'secret remove', { positional: ['vault', 'token'], flags: {} })).toMatchObject({ outcome: 'done', data: { removed: false } })
    expect(contents(home)).toEqual([])
  })
})

describe('an optional secret', () => {
  const meter = plugin('meter', { secrets: [{ name: 'token', description: '服务要求登录时的令牌', optional: true }] })

  it('is listed, and shown on the configuration page, as optional while it is not set', async () => {
    const f = await fixture([meter])
    const call = { ...machine(f.home), table: new Map([['meter', meter]]) }
    const listed = await ownerFace.dispatch(call, 'secret list', { positional: ['meter'], flags: {} })
    expect(listed).toMatchObject({ outcome: 'done', text: '插件 meter 在这台机器上没设密钥。\n可以不设、还没设的：token' })
    const config = await viewerFace.show({ view: 'config', params: {} }, { ctx: f.ctx, table: call.table })
    const secrets = config.outcome === 'shown' ? config.blocks.find((b) => b.kind === 'section' && b.title === '密钥') : undefined
    const rows = secrets?.kind === 'section' && secrets.blocks[0]?.kind === 'table' ? secrets.blocks[0].rows : []
    expect(rows.map((r) => r.cells.state?.tag)).toEqual([{ text: '没设（可选）', tone: 'neutral' }])
  })
})
