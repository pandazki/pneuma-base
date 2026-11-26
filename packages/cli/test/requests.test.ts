// Requests: an agent asks for what only the owner may do, with its reason and the exact command; the
// owner approves or declines with one act; the agent sees the outcome at its next check; the audit
// names who asked and who decided. ARCHITECTURE.md section 4, 「请」.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const WHY = '要给方案留住每一版'

let sb: Sandbox
let lib: string

function ok(r: Run): Run {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}

const owner = (args: string[], input?: string) => sb.run(['--library', lib, ...args], input === undefined ? {} : { input })
const as = (grant: string) => (args: string[]) => sb.run([`@${grant}`, ...args], { env: { PNEUMA_BASE_SESSION: `session-of-${grant}` } })
const claude = as('claude')

/** A library with the ledger, a grant for claude, one for codex, a read-only one and one limited to an area. */
function library(flags: string[] = []): string {
  const dir = join(tempDir(), 'lib')
  ok(sb.run(['init', dir, ...flags]))
  ok(sb.run(['--library', dir, 'grant', 'issue', 'claude', '--agent', 'claude']))
  ok(sb.run(['--library', dir, 'grant', 'issue', 'codex', '--agent', 'codex']))
  ok(sb.run(['--library', dir, 'grant', 'issue', 'reader', '--agent', 'reader', '--read-only']))
  mkdirSync(join(dir, 'notes'), { recursive: true })
  ok(sb.run(['--library', dir, 'grant', 'issue', 'notes', '--agent', 'notetaker', '--area', 'notes']))
  return dir
}

const askVersion = (who = claude) => who(['ask', WHY, 'plugin', 'add', 'version', '--json'])
const installed = () => JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins as string[]

beforeEach(() => {
  sb = sandbox()
  lib = library()
})

describe('an agent refused an owner command', () => {
  it('is told the exact ask line that would request it, and that line works', () => {
    const r = claude(['plugin', 'add', 'version'])
    expect(r.code).toBe(2)
    const line = r.stdout.trimEnd().split('\n').at(-1) as string
    expect(line).toBe('pneuma-base @claude ask "<为什么>" plugin add version')
    const asked = sb.run(['@claude', 'ask', WHY, 'plugin', 'add', 'version', '--json'])
    expect(asked.code).toBe(0)
    expect(asked.json()).toMatchObject({ outcome: 'asked', again: false, request: { command: 'plugin add', line: 'plugin add version', status: { kind: 'pending' } } })
  })

  it('carries the flags of the command into the ask line, quoted for the shell', () => {
    const r = claude(['grant', 'issue', 'helper', '--agent', 'my helper', '--read-only'])
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`pneuma-base @claude ask "<为什么>" grant issue helper --agent 'my helper' --read-only`)
  })
})

describe('asking, and the owner deciding', () => {
  it('answers with the request id and says the owner will see it; the owner sees it in request list and on the home page, in the same lines', () => {
    const asked = askVersion()
    expect(asked.code).toBe(0)
    const id = asked.json().request.id as string
    expect(id).toMatch(/^r-[0-9a-f]{8}$/)
    expect(claude(['ask', WHY, 'plugin', 'add', 'version']).stdout).toContain(id)

    const list = ok(owner(['request', 'list'])).stdout
    expect(list).toContain(WHY)
    expect(list).toContain('plugin add version')
    expect(list).toContain(`$ request approve ${id}  # 批准`)
    expect(list).toContain(`$ request decline ${id} [<理由>]  # 拒绝`)
    const home = ok(owner(['show', 'home'])).stdout
    const entry = list.split('\n').slice(1).filter((l) => l.trim() !== '')
    for (const line of entry) expect(home, line).toContain(line)

    const ask = (ok(owner(['show', 'home', '--json'])).json().blocks as any[]).flatMap((b) => b.blocks ?? []).find((b: any) => b.kind === 'asks').asks[0]
    expect(ask).toMatchObject({ by: { kind: 'agent', name: 'claude', grant: 'claude' }, text: WHY, command: 'plugin add version', suggested: 0 })
    expect(ask.actions.map((a: any) => a.label)).toEqual(['批准', '拒绝'])
  })

  it('approve runs the command as the owner; the agent sees the outcome at its next check, once; inspect shows it in full', () => {
    const id = askVersion().json().request.id as string
    const approved = ok(owner(['request', 'approve', id]))
    expect(approved.stdout).toContain('已装上插件 version')
    expect(installed()).toContain('version')
    expect(ok(owner(['request', 'list'])).stdout).toContain('没有等你决定的请求')
    expect(ok(owner(['request', 'list', '--all'])).stdout).toMatch(new RegExp(`${id}.*plugin add version.*已批准`))

    const check = ok(claude(['check']))
    expect(check.stdout).toContain('## 你提的请求')
    expect(check.stdout).toContain(`${id} plugin add version：已批准`)
    expect(check.stdout).toContain('已装上插件 version')
    expect(ok(claude(['check', '--json'])).json().requests).toEqual({ ended: [], pending: 0 })
    expect(ok(claude(['check'])).stdout).not.toContain('你提的请求')

    const inspect = ok(claude(['inspect', id])).stdout
    for (const words of ['claude', WHY, 'plugin add version', '已批准', '已装上插件 version']) expect(inspect).toContain(words)
    expect(inspect).not.toContain('库里没有这个文件')
    expect(ok(claude(['inspect', id, '--json'])).json().request).toMatchObject({ id, status: { kind: 'approved', outcome: { outcome: 'done' } }, seen: true })
  })

  it('decline with a reason: nothing runs, and the agent reads the reason at its next check', () => {
    const id = askVersion().json().request.id as string
    expect(ok(owner(['request', 'decline', id, '先不装，下周再说'])).stdout).toContain(id)
    expect(installed()).not.toContain('version')
    const check = ok(claude(['check'])).stdout
    expect(check).toContain(`${id} plugin add version：已拒绝`)
    expect(check).toContain('先不装，下周再说')
    expect(owner(['request', 'approve', id]).code).toBe(2)
  })

  it('the agent that asked withdraws a pending one; another agent may not; a decided one stays as it was', () => {
    const id = askVersion().json().request.id as string
    expect(as('codex')(['ask', '--withdraw', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-yours' })
    expect(ok(claude(['ask', '--withdraw', id, '--json'])).json()).toMatchObject({ outcome: 'withdrawn', request: { id, status: { kind: 'withdrawn' } } })
    expect(ok(owner(['request', 'list'])).stdout).toContain('没有等你决定的请求')
    expect(owner(['request', 'approve', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-pending' })
    expect(claude(['ask', '--withdraw', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-pending' })
    expect(claude(['ask', '--withdraw', 'r-00000000', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'no-such-request' })
    // A withdrawn request is no longer the same pending one: asking again makes a new one.
    expect(askVersion().json().request.id).not.toBe(id)
  })

  it('the same pending request from the same agent is one; another agent’s is its own; at most 20 pending per agent', () => {
    const first = askVersion().json()
    const again = askVersion().json()
    expect(again).toMatchObject({ outcome: 'asked', again: true, request: { id: first.request.id, why: WHY } })
    expect(askVersion(as('codex')).json().request.id).not.toBe(first.request.id)
    for (let i = 1; i < 20; i++) ok(claude(['ask', '第几个', 'grant', 'revoke', `g${i}`]))
    const over = claude(['ask', '再一个', 'grant', 'revoke', 'g20', '--json'])
    expect(over.code).toBe(2)
    expect(over.json()).toMatchObject({ outcome: 'refused', reason: 'too-many' })
    expect(askVersion().json()).toMatchObject({ outcome: 'asked', again: true })
  })

  it('approving a command that is now refused records the refusal as the outcome', () => {
    const id = claude(['ask', '帮手要一份授权', 'grant', 'issue', 'helper', '--agent', 'helper', '--json']).json().request.id as string
    ok(owner(['grant', 'issue', 'helper', '--agent', 'someone-else']))
    const approved = owner(['request', 'approve', id, '--json'])
    expect(approved.code).toBe(2)
    expect(approved.json()).toMatchObject({ outcome: 'refused', reason: 'grant-exists' })
    expect(ok(claude(['inspect', id, '--json'])).json().request.status).toMatchObject({ kind: 'approved', outcome: { outcome: 'refused', reason: 'grant-exists' } })
    expect(ok(claude(['check'])).stdout).toContain('grant-exists')
  })
})

describe('what cannot be asked for', () => {
  const refusal = (args: string[]) => {
    const r = claude(['ask', '想要', ...args, '--json'])
    return { code: r.code, ...(r.code === 0 || r.code === 2 ? r.json() : { stderr: r.stderr }) }
  }

  it('each is refused with its own reason, and nothing is recorded', () => {
    expect(refusal(['archive', 'purge'])).toMatchObject({ code: 2, reason: 'red-line', text: expect.stringContaining('当面') })
    expect(refusal(['secret', 'set', 'search', 'key'])).toMatchObject({ code: 2, reason: 'not-askable' })
    expect(refusal(['request', 'approve', 'r-00000000'])).toMatchObject({ code: 2, reason: 'not-askable' })
    expect(refusal(['plugin', 'list'])).toMatchObject({ code: 2, reason: 'run-it-yourself', text: expect.stringContaining('pneuma-base @claude plugin list') })
    expect(refusal(['nothing', 'here'])).toMatchObject({ code: 2, reason: 'unknown-command', text: expect.stringContaining('nothing here') })
    expect(refusal(['grant', 'issue', 'helper'])).toMatchObject({ code: 1, stderr: expect.stringContaining('要写 --agent <给谁>') })
    expect(refusal(['grant', 'issue', 'helper', '--agent', 'x', '--color', 'red'])).toMatchObject({ code: 1, stderr: expect.stringContaining('grant issue 不认识 --color') })
    expect(claude(['ask', '想要']).code).toBe(1)
    expect(claude(['ask']).code).toBe(1)
    expect(readdirSync(join(lib, '.pneuma-base')).includes('requests') ? readdirSync(join(lib, '.pneuma-base/requests')) : []).toEqual([])
  })

  it('the owner has nobody to ask', () => {
    expect(owner(['ask', WHY, 'plugin', 'add', 'version', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-an-agent' })
  })

  it('a read-only grant and a grant limited to an area may ask', () => {
    expect(askVersion(as('reader')).json()).toMatchObject({ outcome: 'asked', request: { by: { name: 'reader' } } })
    expect(askVersion(as('notes')).json()).toMatchObject({ outcome: 'asked', request: { by: { name: 'notetaker' } } })
  })
})

describe('the store', () => {
  it('two processes asking at once lose nothing: different asks are two requests, the same ask is one', async () => {
    const run = (args: string[]) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [BIN, ...args], { cwd: sb.home, env: { PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') } })
        child.on('exit', (code) => resolve(code ?? -1))
      })
    const codes = await Promise.all([
      run(['@claude', 'ask', '一', 'grant', 'revoke', 'a']),
      run(['@claude', 'ask', '二', 'grant', 'revoke', 'b']),
      run(['@claude', 'ask', '三', 'grant', 'revoke', 'c']),
      run(['@claude', 'ask', '同一个', 'grant', 'revoke', 'd']),
      run(['@claude', 'ask', '同一个', 'grant', 'revoke', 'd']),
    ])
    expect(codes).toEqual([0, 0, 0, 0, 0])
    const list = ok(owner(['request', 'list'])).stdout
    for (const line of ['grant revoke a', 'grant revoke b', 'grant revoke c', 'grant revoke d']) expect(list).toContain(line)
    expect(list.match(/grant revoke d/g)).toHaveLength(1)
    expect(readdirSync(join(lib, '.pneuma-base/requests'))).toHaveLength(4)
  })

  it('is one file per request of appended lines, and a sync conflict copy of it reads as the same request', () => {
    const id = askVersion().json().request.id as string
    const file = join(lib, '.pneuma-base/requests', `${id}.jsonl`)
    const asked = readFileSync(file, 'utf8')
    expect(asked.trimEnd().split('\n').map((l) => JSON.parse(l).kind)).toEqual(['asked'])
    // The other machine declined it; the sync put its copy beside this one.
    const declined = `${asked}${JSON.stringify({ kind: 'decided', at: new Date().toISOString(), decision: 'declined', reason: '另一台机器上拒绝的' })}\n`
    writeFileSync(join(lib, '.pneuma-base/requests', `${id}.conflict-other-20261126T080000Z.jsonl`), declined)
    expect(ok(owner(['request', 'list', '--all'])).stdout).toContain('另一台机器上拒绝的')
    expect(ok(claude(['inspect', id, '--json'])).json().request.status).toMatchObject({ kind: 'declined', reason: '另一台机器上拒绝的' })
  })

  it('works in a library with no plugin', () => {
    sb = sandbox()
    lib = library(['--bare'])
    const refused = claude(['grant', 'issue', 'helper', '--agent', 'helper'])
    const line = refused.stdout.trimEnd().split('\n').at(-1) as string
    expect(line).toBe('pneuma-base @claude ask "<为什么>" grant issue helper --agent helper')
    const id = claude(['ask', '帮手要一份授权', 'grant', 'issue', 'helper', '--agent', 'helper', '--json']).json().request.id as string
    expect(ok(owner(['show', 'home'])).stdout).toContain('帮手要一份授权')
    ok(owner(['request', 'approve', id]))
    expect(ok(claude(['check'])).stdout).toContain(`${id} grant issue helper --agent helper：已批准`)
  })
})

describe('the audit', () => {
  it('the activity has a row for asking, one for the approved command with both names and 主人批准的, and rows for withdrawing and declining', () => {
    const approvedId = askVersion().json().request.id as string
    ok(owner(['request', 'approve', approvedId]))
    const declinedId = claude(['ask', '帮手要一份授权', 'grant', 'issue', 'helper', '--agent', 'helper', '--json']).json().request.id as string
    ok(owner(['request', 'decline', declinedId, '不需要']))
    const withdrawnId = claude(['ask', '清掉', 'grant', 'revoke', 'reader', '--json']).json().request.id as string
    ok(claude(['ask', '--withdraw', withdrawnId]))

    const rows = (ok(owner(['show', 'ledger.activity', '--json'])).json().blocks as any[]).find((b) => b.kind === 'feed').groups.flatMap((g: any) => g.rows) as any[]
    const approved = rows.find((r) => r.whose === 'approved')
    expect(approved).toMatchObject({ actor: { kind: 'owner' }, text: expect.stringContaining('plugin add') })
    expect(approved.meta).toEqual(expect.arrayContaining([expect.objectContaining({ actor: { kind: 'agent', name: 'claude', grant: 'claude' }, text: expect.stringContaining(approvedId) })]))
    expect(rows.filter((r) => r.text.includes('request approve'))).toEqual([])
    expect(rows.find((r) => r.text.includes(WHY))).toMatchObject({ actor: { name: 'claude' }, whose: 'agent', text: expect.stringContaining('plugin add version') })
    expect(rows.find((r) => r.text.includes(declinedId) && r.text.includes('拒绝'))).toMatchObject({ actor: { kind: 'owner' }, whose: 'owner' })
    expect(rows.find((r) => r.text.includes('撤回') && r.text.includes(withdrawnId))).toMatchObject({ actor: { name: 'claude' } })

    const text = ok(owner(['show', 'ledger.activity'])).stdout
    expect(text).toContain('[主人批准的]')
  })
})
