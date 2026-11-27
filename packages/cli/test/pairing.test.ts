// Pairing: an agent not connected asks to be, the owner allows it with one act on the home page or
// with `pair allow`, and `agent connect` connects it under its own name. Every run has a temporary
// HOME with the product folders the test makes, and a PATH with no agent program on it.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Ask, Block } from '@pneuma-base/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let bin: string

const WHY = '要把这次读的论文放进库里'
const pbHome = () => join(sb.home, '.pneuma-base')
const launcher = () => join(pbHome(), 'bin', 'pneuma-base')
const run = (args: string[], env: Record<string, string> = {}): Run => sb.run(args, { env: { PATH: bin, ...env } })
const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
  return r
}
const owner = (args: string[]) => run(['--library', lib, ...args])
const request = (product: string, why = WHY, library = lib) => run(['pair', 'request', product, why, '--library', library, '--json'])
const requested = (product: string, why = WHY, library = lib) => ok(request(product, why, library)).json().pairing as { id: string; code: string }
const status = (id: string) => ok(run(['pair', 'status', id, '--json'])).json()
const grants = () => (JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')) as { grants: { name: string; agent: string }[] }).grants

/** Lets a pairing's ten minutes run out. */
function age(id: string): void {
  const file = join(pbHome(), 'pairings', `${id}.json`)
  const p = JSON.parse(readFileSync(file, 'utf8')) as { expires: string }
  writeFileSync(file, JSON.stringify({ ...p, expires: new Date(Date.now() - 60_000).toISOString() }))
}

const home = () => ok(owner(['show', 'home', '--json'])).json() as { blocks: Block[] }
const asksOf = (blocks: Block[]): Ask[] => {
  const decide = blocks.find((b) => b.kind === 'section' && b.title === '等你决定')
  const asks = decide?.kind === 'section' ? decide.blocks[0] : undefined
  return asks?.kind === 'asks' ? asks.asks : []
}

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  bin = tempDir('pb-bin-')
  mkdirSync(join(sb.home, '.claude'), { recursive: true })
  ok(run(['init', lib]))
})

describe('pair request and pair status', () => {
  it('records a request with an id and a code to show, answers the same one again, and says it waits', () => {
    const first = ok(request('claude-code')).json()
    expect(first).toMatchObject({ outcome: 'requested', again: false, pairing: { product: 'claude-code', why: WHY, library: lib, via: 'command-line', decision: null } })
    expect(first.pairing.id).toMatch(/^p-[0-9a-f]{8}$/)
    expect(first.pairing.code).toMatch(/^\d{3}-\d{3}$/)
    const text = ok(run(['pair', 'request', 'claude-code', WHY, '--library', lib])).stdout
    expect(text).toContain(first.pairing.code)
    expect(text).toContain(`pair status ${first.pairing.id}`)
    expect(ok(request('claude-code', '换一句话也一样')).json()).toMatchObject({ again: true, pairing: { id: first.pairing.id, code: first.pairing.code } })
    expect(status(first.pairing.id)).toMatchObject({ id: first.pairing.id, state: 'waiting', product: 'claude-code', code: first.pairing.code, connected: null, declined: null })
    expect(ok(run(['pair', 'status', first.pairing.id])).stdout).toContain(first.pairing.code)
  })

  it('refuses a name that is no product, a reason empty or too long, a folder that is no library, and an id it does not have', () => {
    expect(request('My Agent').code).toBe(1)
    expect(request('codex', '   ').code).toBe(1)
    expect(request('codex', '长'.repeat(201)).code).toBe(1)
    const notLibrary = request('codex', WHY, tempDir())
    expect(notLibrary.code).toBe(2)
    expect(notLibrary.json()).toMatchObject({ outcome: 'refused', reason: 'not-a-library' })
    expect(ok(request('codex', '第一行\n第二行\t完')).json().pairing.why).toBe('第一行 第二行 完')
    const unknown = run(['pair', 'status', 'p-00000000', '--json'])
    expect(unknown.code).toBe(2)
    expect(unknown.json()).toMatchObject({ outcome: 'refused', reason: 'no-such-pairing' })
  })
})

describe('the owner allows or declines', () => {
  it('pair allow connects the product under its name: the grant, the connection, the skill; the agent is told its command', () => {
    const { id, code } = requested('claude-code')
    const r = ok(owner(['pair', 'allow', id, '--read-only']))
    expect(r.stdout).toContain(code)
    expect(grants()).toEqual([expect.objectContaining({ name: 'claude-code', agent: 'claude-code' })])
    expect(existsSync(join(sb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'))).toBe(true)
    expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections).toEqual([expect.objectContaining({ grant: 'claude-code', product: 'claude-code', way: 'skill', inPlace: true, readOnly: true })])
    const answer = status(id)
    expect(answer).toMatchObject({
      state: 'connected',
      connected: { grant: 'claude-code', way: 'skill', command: `${launcher()} @claude-code`, mcp: { url: null, stdio: `${launcher()} @claude-code mcp` }, read: join(lib, 'PNEUMA-BASE.md') },
    })
    expect(answer.connected.next).toContain(`${launcher()} @claude-code start`)
    expect(answer.text).toContain('claude-code')
    expect(ok(run(['@claude-code', 'start', '读论文'], { PNEUMA_BASE_SESSION: 'paired' })).code).toBe(0)
  })

  it('names the grant after the product, or the product with a number when that name connects something else here', () => {
    const other = join(tempDir(), 'other')
    ok(run(['init', other]))
    ok(run(['agent', 'connect', 'claude-code', '--library', other]))
    const { id } = requested('claude-code')
    expect(asksOf(home().blocks)[0]?.command).toBe('agent connect claude-code --name claude-code-2 --via skill')
    ok(owner(['pair', 'allow', id]))
    expect(status(id)).toMatchObject({ state: 'connected', connected: { grant: 'claude-code-2' } })
  })

  it('keeps a pairing waiting when the connect is refused, and refuses it in an agent session, from another library and once expired', () => {
    const { id } = requested('cursor')
    const inSession = run(['--library', lib, 'pair', 'allow', id], { CLAUDE_CODE_SESSION_ID: 'session-1' })
    expect(inSession.code).toBe(2)
    expect(inSession.stdout).toContain('agent-session')
    const refused = owner(['pair', 'allow', id])
    expect(refused.code).toBe(2)
    expect(refused.stdout).toContain('not-found')
    expect(status(id).state).toBe('waiting')

    const other = join(tempDir(), 'other')
    ok(run(['init', other]))
    expect(run(['--library', other, 'pair', 'allow', id]).stdout).toContain('other-library')

    age(id)
    expect(status(id).state).toBe('expired')
    expect(owner(['pair', 'allow', id]).stdout).toContain('expired')
  })

  it('pair decline tells the agent not to ask again, and a decided pairing takes no second decision', () => {
    const { id } = requested('codex')
    ok(owner(['pair', 'decline', id, '不认识这个']))
    expect(status(id)).toMatchObject({ state: 'declined', declined: { reason: '不认识这个' }, connected: null })
    expect(status(id).text).toContain('不要再请求')
    expect(owner(['pair', 'decline', id]).stdout).toContain('not-pending')
    expect(owner(['pair', 'allow', id]).stdout).toContain('not-pending')
    expect(grants()).toEqual([])
  })

  it('pair list shows the waiting ones with their codes and commands, and with --all the settled ones too', () => {
    const waiting = requested('claude-code')
    const declined = requested('codex')
    ok(owner(['pair', 'decline', declined.id]))
    const text = ok(owner(['pair', 'list'])).stdout
    expect(text).toContain(waiting.code)
    expect(text).toContain(`pair allow ${waiting.id}`)
    expect(text).not.toContain(declined.code)
    expect(ok(owner(['pair', 'list', '--all'])).stdout).toContain(declined.code)
  })
})

describe('on the pages', () => {
  it('a waiting pairing is the first ask on the home page: the product’s mark, the code, the reason, what allowing does, 允许 and 拒绝', () => {
    ok(run(['--library', lib, 'grant', 'issue', 'claude', '--agent', 'claude']))
    ok(run(['@claude', 'ask', '要装版本插件', 'plugin', 'add', 'version'], { PNEUMA_BASE_SESSION: 's' }))
    const { id, code } = requested('claude-code')
    const [ask, second] = asksOf(home().blocks)
    expect(second?.key).toMatch(/^request:/)
    expect(ask).toMatchObject({ key: `pairing:${id}`, by: { kind: 'agent', name: 'claude-code' }, command: 'agent connect claude-code --name claude-code --via skill', about: null })
    expect(ask?.suggested).toBeUndefined()
    expect(ask?.text).toContain('Claude Code 想接入这个库：允许吗？')
    expect(ask?.text).toContain(code)
    expect(ask?.text).toContain(WHY)
    expect(ask?.text).toContain('~/.claude/skills/pneuma-base-claude-code/SKILL.md')
    expect(ask?.actions.map((a) => [a.label, a.call.face === 'owner' ? a.call.command : '', a.inputs.map((i) => i.name)])).toEqual([
      ['允许', 'pair allow', ['area', 'read-only']],
      ['拒绝', 'pair decline', ['reason']],
    ])
  })

  it('a pairing settled or expired leaves the home page, and the agents page lists every pairing with its state', () => {
    const connected = requested('claude-code')
    const declined = requested('codex')
    const expired = requested('my-agent')
    const waiting = requested('other-agent')
    ok(owner(['pair', 'allow', connected.id]))
    ok(owner(['pair', 'decline', declined.id]))
    age(expired.id)
    expect(asksOf(home().blocks).map((a) => a.key)).toEqual([`pairing:${waiting.id}`])
    const page = ok(owner(['show', 'agents', '--json'])).json() as { blocks: { kind: string; title: string; blocks: Block[] }[] }
    const section = page.blocks.find((b) => b.title === '让 agent 自己接上')
    const list = section?.blocks.find((b) => b.kind === 'list')
    const items = list?.kind === 'list' ? list.items : []
    // Only the waiting one is marked; a settled one says how it ended first in its line.
    expect(items.map((i) => [i.cell.actor?.name, i.cell.tag?.text ?? i.note?.split(' · ')[0]])).toEqual([
      ['other-agent', '等你决定'],
      ['my-agent', '已过期'],
      ['codex', '已拒绝'],
      ['claude-code', '已接上'],
    ])
    expect(items.slice(1).map((i) => i.cell.tag)).toEqual([undefined, undefined, undefined])
    expect(items[0]?.note).toContain(waiting.code)
    expect(items[0]?.actions.map((a) => a.label)).toEqual(['允许', '拒绝'])
    expect(items[3]?.actions).toEqual([])
  })
})
