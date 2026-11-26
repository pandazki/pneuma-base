// Run 2 C5 and C6 over HTTP: every owner operation the page offers, sent to the server's /api/call as
// the page sends it, leaves a fact in the ledger; an agent's check from the command line reports those
// that changed content or capabilities. A destructive one runs only with the page's confirmation and
// never when the server runs in an agent session.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Call, Plugin } from '@pneuma-base/kernel'
import { startServer, type RunningServer } from '@pneuma-base/viewer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

/** A plugin the library can install and remove from the page. */
const pager: Plugin = { contract: 2, name: 'pager' as Plugin['name'], cognition: { title: '测试插件', text: '## 测试' }, storage: [], statements: [], ownerCommands: [] }
const table = new Map([...builtinPlugins, [pager.name as string, pager]])

let sb: Sandbox
let lib: string
let work: string
const running: RunningServer[] = []

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  work = tempDir('pb-work-')
  expect(sb.run(['init', lib]).code).toBe(0)
  expect(sb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code']).code).toBe(0)
})

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()))
})

const agent = (args: string[], input?: string) => {
  const r = sb.run(['@claude', ...args], { cwd: work, env: { PNEUMA_BASE_SESSION: 'agent-later' }, ...(input === undefined ? {} : { input }) })
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

async function serve(env: Record<string, string> = {}): Promise<RunningServer> {
  const server = await startServer({ dir: lib, builtins: table, home: join(sb.home, '.pneuma-base'), env, port: 0 })
  running.push(server)
  return server
}

/** What the page posts: a call and whether the person confirmed it. */
async function post(server: RunningServer, call: Call, confirmed = false): Promise<{ tone: string; text: string; result: any }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/call`, { method: 'POST', headers: { 'x-pneuma-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ call, confirmed }) })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ tone: string; text: string; result: any }>
}

const owner = (command: string, positional: string[], flags: Record<string, string[] | true> = {}): Call => ({ face: 'owner', command, args: { positional, flags } })

/** Every owner operation the ledger recorded, by command. */
function ownerFacts(): string[] {
  const dir = join(lib, '.pneuma-base/ledger/facts')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .filter((f) => f.kind === 'owner.op')
    .map((f) => f.command)
}

describe('the owner’s operations from the page (C5)', () => {
  it('each leaves a fact; an agent’s check reports the ones that change content or capabilities', async () => {
    // An agent's work before: a file with an old version held, a file it will change by hand later.
    agent(['put', '-', '--to', 'doc.md', '--made'], 'first version\n')
    agent(['put', '-', '--to', 'doc.md', '--made'], 'second version\n')
    agent(['put', '-', '--to', 'notes.md', '--brought'], 'notes\n')
    agent(['put', '-', '--to', 'old.md', '--brought'], 'old\n')
    agent(['archive', 'old.md'])
    agent(['check'])
    writeFileSync(join(lib, 'dropped.md'), 'dropped in by hand\n')
    writeFileSync(join(lib, 'notes.md'), 'notes, edited by hand\n')
    const skills = tempDir('pb-skills-')

    const server = await serve()
    const fingerprint = (agent(['inspect', 'doc.md', '--json']).json().sections[0].data.versions[0].fingerprint as string)
    const done = [
      await post(server, owner('ledger held restore', ['doc.md'], { fingerprint: [fingerprint], to: ['doc.first.md'] })),
      await post(server, { face: 'agent', verb: 'put', request: { kind: 'register', path: 'dropped.md', origin: { kind: 'brought', source: '', by: 'owner' } } }),
      await post(server, { face: 'agent', verb: 'say', request: { kind: 'revised', about: 'notes.md', text: null, args: {} } }),
      await post(server, owner('plugin add', ['pager'])),
      await post(server, owner('plugin remove', ['pager'])),
      await post(server, owner('grant issue', ['codex'], { agent: ['codex'], area: [''], 'read-only': ['no'] })),
      await post(server, owner('grant revoke', ['codex'])),
      await post(server, owner('skill install', ['claude'], { agent: ['claude'], dir: [skills] })),
      await post(server, owner('archive purge', []), true),
    ]
    expect(done.map((r) => r.tone)).toEqual(Array(done.length).fill('good'))

    // On disk: each did what it says.
    expect(readFileSync(join(lib, 'doc.first.md'), 'utf8')).toBe('first version\n')
    expect(existsSync(join(skills, 'pneuma-base-claude', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(lib, '_archive'))).toBe(false)

    // In the ledger: a fact for every owner command, the quiet ones included.
    expect(ownerFacts()).toEqual(expect.arrayContaining(['ledger held restore', 'plugin add', 'plugin remove', 'grant issue', 'grant revoke', 'skill install', 'archive purge']))

    // An agent's check: what changed content or capabilities, not the grants or the skill.
    const news = agent(['check']).stdout
    for (const line of ['主人面的操作 ledger held restore', '放入 doc.first.md', '放入 dropped.md（带进来的，主人给的）', '认了 notes.md 的直接改动', '主人面的操作 plugin add', '主人面的操作 plugin remove', '主人面的操作 archive purge', 'old.md 随归档区一起清掉了']) {
      expect(news).toContain(line)
    }
    for (const quiet of ['grant issue', 'grant revoke', 'skill install']) expect(news).not.toContain(quiet)
  })

  it('a refused operation says why and leaves no fact', async () => {
    const server = await serve()
    const r = await post(server, owner('ledger held restore', ['nothing.md'], { to: ['x.md'] }))
    expect(r).toMatchObject({ tone: 'bad', result: { outcome: 'refused', reason: 'no-such-item' } })
    expect(ownerFacts()).not.toContain('ledger held restore')
  })
})

describe('a destructive operation from the page (C6)', () => {
  beforeEach(() => {
    agent(['put', '-', '--to', 'old.md', '--brought'], 'old\n')
    agent(['archive', 'old.md'])
  })

  it('without the confirmation, nothing changes and no fact is left; confirmed, the archive is emptied and recorded', async () => {
    const server = await serve()
    expect(await post(server, owner('archive purge', []), false)).toMatchObject({ tone: 'bad', result: { reason: 'not-confirmed' } })
    expect(readFileSync(join(lib, '_archive/old.md'), 'utf8')).toBe('old\n')
    expect(ownerFacts()).not.toContain('archive purge')
    expect(await post(server, owner('archive purge', []), true)).toMatchObject({ tone: 'good', result: { outcome: 'done' } })
    expect(existsSync(join(lib, '_archive'))).toBe(false)
    expect(ownerFacts()).toContain('archive purge')
  })

  it('a server started in an agent session refuses it, confirmed or not, and says why', async () => {
    const server = await serve({ CLAUDE_CODE_SESSION_ID: 'session-of-an-agent' })
    const r = await post(server, owner('archive purge', []), true)
    expect(r).toMatchObject({ tone: 'bad', result: { outcome: 'refused', reason: 'agent-session' } })
    expect(r.text).toContain('CLAUDE_CODE_SESSION_ID')
    expect(readFileSync(join(lib, '_archive/old.md'), 'utf8')).toBe('old\n')
  })
})
