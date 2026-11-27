// The whole story of the local endpoint, on the real built command line: `pneuma-base view` serves a
// library; an agent that is not connected reads its guide, asks to be connected, and polls; the owner
// allows it through the page's own call path; the agent runs the command the answer names, or
// connects by MCP over HTTP to the address it names, and what it does is filed under its own name.
// The command line is the reference: its guide and its pairing say what the endpoint says.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

type Served = { child: ChildProcessWithoutNullStreams; origin: string; token: string }

/** `view` started on a free port, once it printed its address. */
function serve(sb: Sandbox, lib: string): Promise<Served> {
  const child = sb.start(['view', lib, '--no-open', '--port', '0'])
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/.exec(out)
      if (match) resolve({ child, origin: match[1] as string, token: match[2] as string })
    })
    child.once('exit', (code) => reject(new Error(`view exited with ${code}: ${out}`)))
  })
}

const running: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGINT')
})

/** A library with the ledger, in a sandbox whose HOME has a Claude Code folder, so Claude Code is found on this machine. */
function setUp(): { sb: Sandbox; lib: string } {
  const sb = sandbox()
  mkdirSync(join(sb.home, '.claude'))
  const lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
  return { sb, lib }
}

async function started(sb: Sandbox, lib: string): Promise<Served> {
  const s = await serve(sb, lib)
  running.push(s.child)
  return s
}

const postJson = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Every `{input}` in a button's call replaced by the value given, or by nothing, as the page does with an input left empty. */
function filled(call: unknown, values: Record<string, string> = {}): unknown {
  if (typeof call === 'string') return call.replace(/\{([^{}]+)\}/g, (_, name: string) => values[name] ?? '')
  if (Array.isArray(call)) return call.map((c) => filled(c, values))
  if (typeof call === 'object' && call !== null) return Object.fromEntries(Object.entries(call).map(([k, v]) => [k, filled(v, values)]))
  return call
}

type AskShape = { key: string; text: string; command?: string; actions: { label: string; call: unknown }[] }

/** The asks of the home page, as the page gets them. */
async function homeAsks({ origin, token }: Served): Promise<AskShape[]> {
  const view = (await (await fetch(`${origin}/api/view?view=home`, { headers: { 'x-pneuma-token': token } })).json()) as { blocks: unknown[] }
  const asks: AskShape[] = []
  const walk = (b: any) => {
    if (b?.kind === 'asks') asks.push(...b.asks)
    for (const inner of b?.blocks ?? []) walk(inner)
  }
  view.blocks.forEach(walk)
  return asks
}

/** The owner presses a button of the home page: the page's own call path, with the token. */
async function press({ origin, token }: Served, call: unknown): Promise<any> {
  const res = await fetch(`${origin}/api/call`, { method: 'POST', headers: { 'x-pneuma-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ call, confirmed: false }) })
  return res.json()
}

async function pollUntilSettled(origin: string, id: string): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const answer = (await (await fetch(`${origin}/pair/${id}`)).json()) as { state: string }
    if (answer.state !== 'waiting') return answer
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`pairing ${id} still waiting`)
}

/** A command line as an agent product runs one: through sh, with system tools only and its own session. */
function asAgent(sb: Sandbox, line: string, session: string, input = ''): { code: number; out: string } {
  const r = spawnSync('/bin/sh', ['-c', line], { env: { HOME: sb.home, PATH: '/usr/bin:/bin', CLAUDE_CODE_SESSION_ID: session }, input, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout + r.stderr }
}

describe('an agent connects itself through the endpoint', () => {
  it('Claude Code: guide, pairing, the owner allows on the home page, the named command files its scene under claude-code', async () => {
    const { sb, lib } = setUp()
    const s = await started(sb, lib)

    const guide = await fetch(`${s.origin}/guide/claude-code`)
    expect(guide.status).toBe(200)
    expect(guide.headers.get('content-type')).toMatch(/^text\/markdown/)
    const text = await guide.text()
    const launcher = join(sb.home, '.pneuma-base', 'bin', 'pneuma-base')
    expect(text).toContain(`${s.origin}/pair`)
    expect(text).toContain(lib)
    expect(text, 'the command line prints the same guide').toBe(sb.run(['guide', 'claude-code', '--library', lib]).stdout)

    const asked = await postJson(`${s.origin}/pair`, { product: 'claude-code', why: '整理这次的调研' })
    expect(asked.status).toBe(201)
    const { id, code, poll } = (await asked.json()) as { id: string; code: string; poll: string }
    expect(code).toMatch(/^\d{3}-\d{3}$/)
    expect(poll).toBe(`${s.origin}/pair/${id}`)
    expect(((await (await fetch(`${s.origin}/pair/${id}`)).json()) as { state: string }).state).toBe('waiting')

    const ask = (await homeAsks(s)).find((a) => a.text.includes(code))
    expect(ask?.text).toContain('Claude Code 想接入这个库')
    expect(ask?.text).toContain('整理这次的调研')
    const allow = ask?.actions.find((a) => a.label === '允许')
    expect(allow).toBeDefined()
    const pressed = await press(s, filled(allow?.call))
    expect(pressed.result?.outcome, JSON.stringify(pressed)).toBe('done')

    const answer = await pollUntilSettled(s.origin, id)
    expect(answer.state).toBe('connected')
    expect(answer.connected.grant).toBe('claude-code')
    expect(answer.connected.command).toContain(launcher)
    expect(existsSync(join(sb.home, '.claude', 'skills', 'pneuma-base-claude-code', 'SKILL.md'))).toBe(true)

    const started_ = asAgent(sb, `${answer.connected.command} start "整理这次的调研"`, 'story-session')
    expect(started_.code, started_.out).toBe(0)
    const put = asAgent(sb, `${answer.connected.command} put - --to notes/research.md --made`, 'story-session', '# 调研\n')
    expect(put.code, put.out).toBe(0)
    const facts = sb.run(['--library', lib, 'inspect', 'notes/research.md']).stdout
    expect(facts).toContain('做出来的 · claude-code')
    expect(facts).toContain('整理这次的调研')
  })

  it('an application not in the products table: generic guide, pairing, then MCP over HTTP at the address the answer names', async () => {
    const { sb, lib } = setUp()
    const s = await started(sb, lib)

    const guide = await (await fetch(`${s.origin}/guide?for=my-app`)).text()
    expect(guide).toContain('my-app')
    expect(guide).toContain(`${s.origin}/mcp/`)

    const { id } = (await (await postJson(`${s.origin}/pair`, { product: 'my-app', why: '把会议纪要放进库' })).json()) as { id: string }
    expect(sb.run(['pair', 'allow', id, '--library', lib]).code).toBe(0)
    const answer = await pollUntilSettled(s.origin, id)
    expect(answer.state).toBe('connected')
    expect(answer.connected.mcp.url).toBe(`${s.origin}/mcp/${answer.connected.grant}`)

    const client = new Client({ name: 'story', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${answer.connected.mcp.url}?session=minutes`)))
    try {
      const r = (await client.callTool({ name: 'put', arguments: { to: 'notes/minutes.md', made: true, text: '# 纪要\n' } })) as { isError?: boolean; content: { text?: string }[] }
      expect(r.isError, r.content.map((c) => c.text).join('\n')).toBeFalsy()
    } finally {
      await client.close()
    }
    const facts = sb.run(['--library', lib, 'inspect', 'notes/minutes.md']).stdout
    expect(facts).toContain(`做出来的 · my-app`)
  })

  it('pairing through HTTP and through the command line end in the same state', async () => {
    const { sb, lib } = setUp()
    const s = await started(sb, lib)
    const byHttp = (await (await postJson(`${s.origin}/pair`, { product: 'tool-a', why: '同一件事' })).json()) as { id: string }
    const byLine = sb.run(['pair', 'request', 'tool-b', '同一件事', '--library', lib, '--json'])
    expect(byLine.code, byLine.stderr).toBe(0)
    const lineId = byLine.json().pairing?.id ?? byLine.json().id
    for (const pid of [byHttp.id, lineId]) expect(sb.run(['pair', 'allow', pid, '--library', lib]).code).toBe(0)
    const overHttp = await pollUntilSettled(s.origin, byHttp.id)
    const overLine = sb.run(['pair', 'status', lineId, '--json']).json()
    const shape = (a: any) => ({ state: a.state, way: a.connected?.way, grant: a.connected?.grant.replace(/^tool-[ab]/, 'tool'), command: a.connected?.command.replace(/tool-[ab]/, 'tool'), mcp: a.connected?.mcp.url?.replace(/tool-[ab]/, 'tool') })
    expect(shape(overLine)).toEqual(shape(overHttp))
    expect(await (await fetch(`${s.origin}/pair/${lineId}`)).json(), 'the endpoint answers the same object for a pairing asked by the command line').toEqual(overLine)
  })
})
