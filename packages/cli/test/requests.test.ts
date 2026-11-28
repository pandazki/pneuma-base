// Requests: an agent asks for what only the owner may do, with its reason and the exact command; the
// owner approves or declines with one act; the agent sees the outcome at its next check; the audit
// names who asked and who decided. ARCHITECTURE.md「请主人做」. The kernel's tests own a plugin's
// askable commands and an approval the gate now refuses (packages/kernel/test/requests.test.ts).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { feedRowsIn, sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

/** The facts of the kernel's record place for requests, every file storage wrote or a sync brought, in no order. */
function requestFacts(lib: string): Record<string, unknown>[] {
  const dir = join(lib, '.pneuma-base/requests/facts')
  if (!existsSync(dir)) return []
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').trimEnd().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>))
}

/** Writes a facts file into the requests record place as another machine's would arrive by sync: its own file, named by its moment. */
function syncedFacts(lib: string, facts: unknown[], at = new Date(Date.now() + 1000)): void {
  const day = at.toISOString().slice(0, 10)
  const stamp = at.toISOString().replace(/[^0-9]/g, '').slice(0, 17)
  const dir = join(lib, '.pneuma-base/requests/facts', day)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${stamp}-othermachine-000001.jsonl`), facts.map((f) => `${JSON.stringify(f)}\n`).join(''))
}
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
const lastLine = (r: Run) => r.stdout.trimEnd().split('\n').at(-1)

/** `pneuma-base ...args` started without waiting, as another process would at the same moment; resolves to its exit code. */
const running = (args: string[]) =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: sb.home, env: { PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') } })
    child.on('exit', (code) => resolve(code ?? -1))
  })

/** A library with the ledger, a grant for claude, one for codex, a read-only one and one limited to an area. */
function library(): string {
  const dir = join(tempDir(), 'lib')
  ok(sb.run(['init', dir]))
  ok(sb.run(['--library', dir, 'grant', 'create', 'claude', '--agent', 'claude']))
  ok(sb.run(['--library', dir, 'grant', 'create', 'codex', '--agent', 'codex']))
  ok(sb.run(['--library', dir, 'grant', 'create', 'reader', '--agent', 'reader', '--read-only']))
  mkdirSync(join(dir, 'notes'), { recursive: true })
  ok(sb.run(['--library', dir, 'grant', 'create', 'notes', '--agent', 'notetaker', '--area', 'notes']))
  return dir
}

const installed = () => JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins as string[]

// One library for these tests: each adds requests of its own, in the order written; the audit reads
// what the first three decided, before the later ones crowd the activity.
describe('asking, and the owner deciding', () => {
  beforeAll(() => {
    sb = sandbox()
    lib = library()
  })
  const decided = { approved: '', declined: '', withdrawn: '' }

  it('an agent refused an owner command is told the exact ask line, flags quoted for the shell; the line asks, and the owner sees the request in request list and on the home page, in the same lines', () => {
    const refused = claude(['plugin', 'enable', 'version'])
    expect(refused.code).toBe(2)
    expect(lastLine(refused)).toBe('pneuma-base @claude ask "<原因>" plugin enable version')
    expect(lastLine(claude(['grant', 'create', 'helper', '--agent', 'my helper', '--read-only']))).toBe(`pneuma-base @claude ask "<原因>" grant create helper --agent 'my helper' --read-only`)

    const asked = claude(['ask', WHY, 'plugin', 'enable', 'version', '--json'])
    expect(asked.code).toBe(0)
    expect(asked.json()).toMatchObject({ outcome: 'asked', again: false, request: { command: 'plugin enable', line: 'plugin enable version', status: { kind: 'pending' } } })
    const id = asked.json().request.id as string
    expect(id).toMatch(/^r-[0-9a-f]{8}$/)
    expect(claude(['ask', WHY, 'plugin', 'enable', 'version']).stdout).toContain(id)
    decided.approved = id

    const list = ok(owner(['request', 'list'])).stdout
    expect(list).toContain(WHY)
    expect(list).toContain('plugin enable version')
    expect(list).toContain(`$ request approve ${id}  # 批准`)
    expect(list).toContain(`$ request decline ${id} [<原因>]  # 拒绝`)
    const home = ok(owner(['show', 'home'])).stdout
    for (const line of list.split('\n').slice(1).filter((l) => l.trim() !== '')) expect(home, line).toContain(line)
    const ask = (ok(owner(['show', 'home', '--json'])).json().blocks as any[]).flatMap((b) => b.blocks ?? []).find((b: any) => b.kind === 'asks').asks[0]
    expect(ask).toMatchObject({ by: { kind: 'agent', name: 'claude', grant: 'claude' }, text: WHY, command: 'plugin enable version', suggested: 0 })
    expect(ask.actions.map((a: any) => a.label)).toEqual(['批准', '拒绝'])
  })

  it('approve runs the command as the owner; the agent sees the outcome at its next check, once; inspect shows it in full', () => {
    const id = decided.approved
    expect(ok(owner(['request', 'approve', id])).stdout).toContain('已启用插件 version')
    expect(installed()).toContain('version')
    expect(ok(owner(['request', 'list'])).stdout).toContain('暂无待处理的请求')

    const check = ok(claude(['check'])).stdout
    expect(check).toContain('## 已提交的请求')
    expect(check).toContain(`${id} plugin enable version：已批准`)
    expect(check).toContain('已启用插件 version')
    expect(ok(claude(['check'])).stdout).not.toContain('已提交的请求')

    const inspect = ok(claude(['inspect', id])).stdout
    for (const words of ['claude', WHY, 'plugin enable version', '已批准', '已启用插件 version']) expect(inspect).toContain(words)
    expect(inspect).not.toContain('资料库中不存在该文件')
  })

  it('decline with a reason: nothing runs, the agent reads the reason at its next check, and it cannot be approved after', () => {
    const id = claude(['ask', '要按意思找', 'plugin', 'enable', 'search', '--json']).json().request.id as string
    decided.declined = id
    expect(ok(owner(['request', 'decline', id, '先不装，下周再说'])).stdout).toContain(id)
    expect(installed()).not.toContain('search')
    const check = ok(claude(['check'])).stdout
    expect(check).toContain(`${id} plugin enable search：已拒绝`)
    expect(check).toContain('先不装，下周再说')
    expect(owner(['request', 'approve', id]).code).toBe(2)
  })

  it('the agent that asked withdraws a pending one; another agent may not; a decided one stays as it was', () => {
    const ask = () => claude(['ask', '要同步', 'plugin', 'enable', 'sync', '--json']).json().request.id as string
    const id = ask()
    decided.withdrawn = id
    expect(as('codex')(['ask', '--withdraw', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-yours' })
    expect(ok(claude(['ask', '--withdraw', id, '--json'])).json()).toMatchObject({ outcome: 'withdrawn', request: { id, status: { kind: 'withdrawn' } } })
    expect(ok(owner(['request', 'list'])).stdout).toContain('暂无待处理的请求')
    expect(owner(['request', 'approve', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-pending' })
    expect(claude(['ask', '--withdraw', id, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-pending' })
    expect(claude(['ask', '--withdraw', 'r-ffffffff', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'no-such-request' })
    // A withdrawn request is no longer the same pending one: asking again makes a new one.
    expect(ask()).not.toBe(id)
  })

  it('the activity has a row for asking, one for the approved command with both names and 所有者批准, and rows for withdrawing and declining', () => {
    const rows = feedRowsIn((ok(owner(['show', 'ledger.activity', '--json'])).json().blocks as any[]).find((b) => b.kind === 'feed').groups)
    const approved = rows.find((r) => r.whose === 'approved')
    expect(approved).toMatchObject({ actor: { kind: 'owner' }, text: expect.stringContaining('plugin enable') })
    expect(approved.meta).toEqual(expect.arrayContaining([expect.objectContaining({ actor: { kind: 'agent', name: 'claude', grant: 'claude' }, text: expect.stringContaining(decided.approved) })]))
    expect(rows.filter((r) => r.text.startsWith('pneuma-base request approve'))).toEqual([])
    // The owner's request list names the ask too; the row of asking is the agent's.
    expect(rows.find((r) => r.text.includes(WHY) && !r.text.startsWith('pneuma-base '))).toMatchObject({ actor: { name: 'claude' }, whose: 'agent', text: expect.stringContaining('plugin enable version') })
    expect(rows.find((r) => r.act === 'declined' && r.text.includes(decided.declined))).toMatchObject({ actor: { kind: 'owner' }, whose: 'owner', text: expect.stringMatching(/^pneuma-base request decline /) })
    expect(rows.find((r) => r.text.includes('撤回') && r.text.includes(decided.withdrawn))).toMatchObject({ actor: { name: 'claude' } })
    expect(ok(owner(['show', 'ledger.activity'])).stdout).toContain('[所有者批准]')
  })

  it('what cannot be asked for is refused with its own reason, and nothing is recorded', () => {
    const before = requestFacts(lib).length
    const refusal = (args: string[]) => {
      const r = claude(['ask', '想要', ...args, '--json'])
      return { code: r.code, ...(r.code === 0 || r.code === 2 ? r.json() : { stderr: r.stderr }) }
    }
    expect(refusal(['archive', 'purge'])).toMatchObject({ code: 2, reason: 'red-line', text: expect.stringContaining('当面') })
    expect(refusal(['secret', 'set', 'search', 'key'])).toMatchObject({ code: 2, reason: 'not-askable' })
    expect(refusal(['plugin', 'list'])).toMatchObject({ code: 2, reason: 'run-it-yourself', text: expect.stringContaining('pneuma-base @claude plugin list') })
    expect(refusal(['nothing', 'here'])).toMatchObject({ code: 2, reason: 'unknown-command', text: expect.stringContaining('nothing here') })
    expect(refusal(['grant', 'create', 'helper'])).toMatchObject({ code: 1, stderr: expect.stringContaining('--agent') })
    expect(claude(['ask', '想要']).code).toBe(1)
    // The owner has nobody to ask.
    expect(owner(['ask', '我自己要', 'plugin', 'enable', 'deploy', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-an-agent' })
    expect(requestFacts(lib)).toHaveLength(before)
  })

  it('two processes asking at once lose nothing: different asks are two requests, the same ask is one', async () => {
    const codes = await Promise.all([
      running(['@claude', 'ask', '一', 'grant', 'revoke', 'a']),
      running(['@claude', 'ask', '二', 'grant', 'revoke', 'b']),
      running(['@claude', 'ask', '三', 'grant', 'revoke', 'c']),
      running(['@claude', 'ask', '同一个', 'grant', 'revoke', 'd']),
      running(['@claude', 'ask', '同一个', 'grant', 'revoke', 'd']),
    ])
    expect(codes).toEqual([0, 0, 0, 0, 0])
    const list = ok(owner(['request', 'list'])).stdout
    for (const line of ['grant revoke a', 'grant revoke b', 'grant revoke c', 'grant revoke d']) expect(list).toContain(line)
    expect(list.match(/grant revoke d/g)).toHaveLength(1)
    // Every ask is a fact; the same line asked twice at once folds into one request.
    const asked = requestFacts(lib).filter((f) => f.kind === 'asked').map((f) => (f.args as { positional: string[] }).positional[0])
    expect(new Set(asked.filter((p) => ['a', 'b', 'c', 'd'].includes(p as string))).size).toBe(4)
  })

  it('the same pending request from the same agent is one; another agent’s is its own; at most 20 pending per agent; a read-only grant and one limited to an area may ask', async () => {
    const line = ['ask', '要清掉旧授权', 'grant', 'revoke', 'g0', '--json']
    const notes = as('notes')
    const first = notes(line).json()
    expect(first).toMatchObject({ outcome: 'asked', again: false, request: { by: { name: 'notetaker' } } })
    expect(notes(line).json()).toMatchObject({ outcome: 'asked', again: true, request: { id: first.request.id } })
    const reader = as('reader')(line).json()
    expect(reader).toMatchObject({ outcome: 'asked', request: { by: { name: 'reader' } } })
    expect(reader.request.id).not.toBe(first.request.id)
    // Nineteen more, five processes at a time.
    for (let n = 1; n < 20; n += 5) {
      const batch = Array.from({ length: Math.min(5, 20 - n) }, (_, i) => running(['@notes', 'ask', '第几个', 'grant', 'revoke', `g${n + i}`]))
      expect(await Promise.all(batch)).toEqual(Array(batch.length).fill(0))
    }
    const over = notes(['ask', '再一个', 'grant', 'revoke', 'g20', '--json'])
    expect(over.code).toBe(2)
    expect(over.json()).toMatchObject({ outcome: 'refused', reason: 'too-many' })
    expect(notes(line).json()).toMatchObject({ outcome: 'asked', again: true })
  })

  it('is facts appended to the kernel’s record place, and another machine’s decision arriving by sync settles the request', () => {
    const id = claude(['ask', '不再要 codex', 'grant', 'revoke', 'codex', '--json']).json().request.id as string
    expect(requestFacts(lib).filter((f) => f.request === id).map((f) => f.kind)).toEqual(['asked'])
    syncedFacts(lib, [{ request: id, kind: 'decided', at: new Date().toISOString(), decision: 'declined', reason: '另一台机器上拒绝的' }])
    expect(ok(owner(['request', 'list', '--all'])).stdout).toContain('另一台机器上拒绝的')
    expect(ok(claude(['inspect', id, '--json'])).json().request.status).toMatchObject({ kind: 'declined', reason: '另一台机器上拒绝的' })
  })

})

describe('the store', () => {
  it('request list --all lists the 50 latest settled requests and how many older ones it left out; --older lists them all; every fact stays', () => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    ok(sb.run(['init', lib, '--bare']))
    const by = { name: 'claude', grant: null }
    const facts: unknown[] = []
    for (let i = 0; i < 55; i++) {
      const at = new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString()
      const request = `r-${i.toString(16).padStart(8, '0')}`
      facts.push({ request, kind: 'asked', at, by, session: 's', why: `第 ${i} 个`, command: 'grant revoke', args: { positional: [`g${i}`], flags: {} } })
      facts.push({ request, kind: 'decided', at, decision: 'declined', reason: null })
    }
    syncedFacts(lib, facts)
    const all = ok(owner(['request', 'list', '--all'])).stdout
    expect(all).toContain('grant revoke g54')
    expect(all).toContain('grant revoke g5 ')
    expect(all).not.toContain('grant revoke g4 ')
    expect(all).toContain('更早的 5 个未列出')
    expect(all).toContain('--older')
    const data = ok(owner(['request', 'list', '--all', '--json'])).json().data
    expect(data).toMatchObject({ requests: expect.any(Array), older: 5 })
    expect(data.requests).toHaveLength(50)

    const older = ok(owner(['request', 'list', '--all', '--older'])).stdout
    expect(older).toContain('grant revoke g0 ')
    expect(older).not.toContain('更早的')
    expect(requestFacts(lib)).toHaveLength(110)
  })

  it('works in a library with no plugin', () => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    ok(sb.run(['init', lib, '--bare']))
    ok(owner(['grant', 'create', 'claude', '--agent', 'claude']))
    const id = claude(['ask', '帮手要一份授权', 'grant', 'create', 'helper', '--agent', 'helper', '--json']).json().request.id as string
    expect(ok(owner(['show', 'home'])).stdout).toContain('帮手要一份授权')
    ok(owner(['request', 'approve', id]))
    expect(ok(claude(['check'])).stdout).toContain(`${id} grant create helper --agent helper：已批准`)
  })
})

// A library of its own, with the deploy plugin asking about sites/shop: the tests run in order on it.
describe('a request standing in for a plugin’s ask about the same command', () => {
  const homeAsks = () => (ok(owner(['show', 'home', '--json'])).json().blocks as any[]).flatMap((b) => b.blocks ?? []).find((b: any) => b.kind === 'asks').asks as any[]
  const SHOP = '店要上线给客户看'
  /** A site claude puts in and says is deployable, so the deploy plugin asks the owner about it. */
  const deployable = (name: string) => {
    const site = join(tempDir('pb-site-'), name)
    mkdirSync(site)
    writeFileSync(join(site, 'index.html'), `<h1>${name}</h1>`)
    ok(claude(['put', site, '--to', `sites/${name}`, '--generated']))
    ok(claude(['say', 'deployable', `sites/${name}`]))
  }

  beforeAll(() => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    ok(sb.run(['init', lib]))
    ok(owner(['grant', 'create', 'claude', '--agent', 'claude']))
    ok(owner(['grant', 'create', 'codex', '--agent', 'codex']))
    ok(owner(['plugin', 'enable', 'deploy']))
    deployable('shop')
  })

  let waiting = ''

  it('is the one row while it waits: the agent’s reason stands, the plugin’s ask about sites/shop is not raised beside it, on the home page or in check', () => {
    expect(homeAsks().map((a) => a.about)).toEqual(['sites/shop'])
    waiting = claude(['ask', SHOP, 'deploy', 'on', 'sites/shop', '--json']).json().request.id as string
    expect(homeAsks()).toEqual([expect.objectContaining({ key: `request:${waiting}`, text: SHOP, command: 'deploy on sites/shop' })])
    expect(ok(as('codex')(['check', '--json'])).json().asks).toEqual([])
    expect(ok(owner(['show', 'home'])).stdout).not.toContain('可以部署，还没上线')
  })

  it('settles both once decided: declined, or approved', () => {
    ok(owner(['request', 'decline', waiting, '还没好']))
    expect(homeAsks()).toEqual([])

    deployable('shop2')
    ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(tempDir('pb-target-'), 'www')]))
    const id = claude(['ask', SHOP, 'deploy', 'on', 'sites/shop2', '--json']).json().request.id as string
    ok(owner(['request', 'approve', id]))
    expect(homeAsks()).toEqual([])
  })

  it('stands in for nothing when it asks for another command or other arguments', () => {
    deployable('shop3')
    claude(['ask', SHOP, 'deploy', 'on', 'sites/other'])
    expect(homeAsks().map((a) => a.about ?? a.command)).toEqual(['deploy on sites/other', 'sites/shop3'])
  })
})
