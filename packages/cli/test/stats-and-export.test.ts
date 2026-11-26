// The statistics and the audit export through the real command line: `ledger stats` and the page
// 统计 say the same, an agent may read them, and `ledger export` writes the activity's rows to a file
// outside the library, as JSON Lines or CSV, quoted so commas, quotes and line breaks survive.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Block } from '@pneuma-base/kernel'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let work: string

function ok(r: Run): Run {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}

const owner = (args: string[]) => sb.run(['--library', lib, ...args], { cwd: work })
const as = (grant: string, session: string) => (args: string[], input?: string) => sb.run([`@${grant}`, ...args], { cwd: work, env: { PNEUMA_BASE_SESSION: session }, ...(input === undefined ? {} : { input }) })
const NOTE = '税要另算，主人说 "先按 7%"\n下季度再看'

beforeAll(() => {
  sb = sandbox()
  work = tempDir('pb-work-')
  lib = join(tempDir(), 'lib')
  ok(sb.run(['init', lib]))
  ok(sb.run(['--library', lib, 'grant', 'issue', 'claude', '--agent', 'claude-code']))
  ok(sb.run(['--library', lib, 'grant', 'issue', 'codex', '--agent', 'codex']))
  // claude-code brings a source and makes a comparison from it; codex, in its own session, builds on that.
  const a = as('claude', 'session-a')
  writeFileSync(join(work, 'stripe.html'), '<html>Stripe 2.9%</html>')
  writeFileSync(join(work, 'comparison.md'), '# 比较')
  writeFileSync(join(work, 'integration.md'), '# 接入')
  ok(a(['start', '给小店选支付服务']))
  ok(a(['put', 'stripe.html', '--to', 'pay/stripe.html', '--brought', '--source', 'https://stripe.com/pricing']))
  ok(a(['put', 'comparison.md', '--to', 'pay/comparison.md', '--made', '--from', 'pay/stripe.html']))
  ok(a(['say', 'decided', '用 Paddle']))
  ok(a(['say', 'note', NOTE]))
  ok(a(['ask', '要留住每一版', 'plugin', 'add', 'version']))
  const b = as('codex', 'session-b')
  ok(b(['put', 'integration.md', '--to', 'pay/integration.md', '--made', '--from', 'pay/comparison.md']))
  const id = /r-[0-9a-f]{8}/.exec(ok(owner(['request', 'list'])).stdout)?.[0] as string
  ok(owner(['request', 'decline', id, '先不装']))
})

/** The page's blocks, sections opened. */
const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...flat(b.blocks)] : [b]))

describe('ledger stats', () => {
  it('answers the four questions: what was put, what built on earlier work across sessions and agents, who did what, what needs looking at', () => {
    const r = ok(owner(['ledger', 'stats', '--json']))
    expect(r.json().data).toMatchObject({
      period: '30d',
      put: { brought: 1, made: 2 },
      sessions: { total: 2 },
      reuse: { made: 2, fromLibrary: 2, otherSession: 1, otherAgent: 1, top: [{ path: 'pay/comparison.md', uses: 1, by: ['codex'] }, { path: 'pay/stripe.html', uses: 1, by: ['claude-code'] }] },
      agents: [
        { name: 'claude-code', sessions: 1, brought: 1, made: 1, decided: 1, notes: 1, asked: 1, declined: 1, pending: 0 },
        { name: 'codex', sessions: 1, made: 1 },
      ],
      owner: { declined: 1 },
      order: { now: { stale: 0, changed: 0, unknown: 0, archived: 0 } },
    })
    const text = r.json().text as string
    expect(text).toContain('做出来的 2 样里，2 样依据了库里已有的东西；1 样用了别的会话留下的（50%），1 样用了别的 agent 带来或做出的（50%）。')
    expect(text).toContain('- claude-code：1 次会话 · 带进来 1 样 · 做出来 1 样 · 决定 1 条 · 备注 1 条 · 请主人做 1 件：拒绝 1 件')
  })

  it('says what the page 统计 says, for every period: each sentence, each list row', () => {
    for (const period of ['7d', '30d', 'all']) {
      const text = ok(owner(['ledger', 'stats', '--period', period])).stdout
      const page = ok(owner(['show', 'ledger.stats', '--period', period, '--json'])).json()
      const said = flat(page.blocks as Block[]).flatMap((b) =>
        b.kind === 'text' || b.kind === 'chart' ? [b.text] : b.kind === 'list' ? b.items.map((i) => `- ${i.cell.text}：${i.note}`) : b.kind === 'section' ? [b.title] : [],
      )
      expect(said.length, period).toBeGreaterThan(8)
      for (const sentence of said) expect(text, `${period}: ${sentence}`).toContain(sentence)
    }
  })

  it('is shown with each chart as its sentence and its numbers, a row a day', () => {
    const text = ok(owner(['show', 'ledger.stats', '--period', '7d'])).stdout
    expect(text).toContain('## 用起来了吗')
    expect(text).toMatch(/这 7 天放进 3 样东西：带进来 1 样，做出来 2 样。\n +带进来的（样） +做出来的（样）\n/)
    expect(text.split('\n').filter((l) => /^ {2}\d+月\d+日 /.test(l)).length).toBeGreaterThanOrEqual(7)
  })

  it('may be run by an agent, which it changes nothing for', () => {
    const r = as('codex', 'session-c')(['ledger', 'stats', '--period', 'all'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.stdout).toContain('## 谁做了什么')
  })

  it('leaves no record, as the page leaves none when it is looked at: reading the statistics twice says the same', () => {
    const before = ok(owner(['ledger', 'stats', '--json'])).json().data
    ok(owner(['ledger', 'stats']))
    ok(as('claude', 'session-a')(['ledger', 'stats']))
    expect(ok(owner(['ledger', 'stats', '--json'])).json().data).toEqual({ ...before, to: expect.any(String) })
    const rows = ok(owner(['show', 'ledger.activity', '--json'])).json().blocks.find((b: Block) => b.kind === 'feed').groups.flatMap((g: { rows: { text: string }[] }) => g.rows)
    expect(rows.filter((row: { text: string }) => row.text.includes('ledger stats'))).toEqual([])
  })
})

/** The rows of a CSV text: fields split at commas outside quotes, a doubled quote a quote, line breaks inside quotes kept. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quoted && c === '"' && text[i + 1] === '"') {
      cell += '"'
      i++
    } else if (c === '"') quoted = !quoted
    else if (quoted || (c !== ',' && c !== '\r')) cell += c
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    }
  }
  return rows
}

describe('ledger export', () => {
  const activity = () => {
    const page = ok(owner(['show', 'ledger.activity', '--json'])).json()
    const feed = (page.blocks as Block[]).find((b) => b.kind === 'feed') as Extract<Block, { kind: 'feed' }>
    return feed.groups.flatMap((g) => g.rows)
  }

  it('writes one row per fact of the activity, in its order, with its sentence and whose act it was, as JSON Lines', () => {
    const to = join(tempDir('pb-out-'), 'audit.jsonl')
    const shown = activity()
    const r = ok(owner(['ledger', 'export', '--to', to]))
    expect(r.stdout).toContain('导出到')
    const rows = readFileSync(to, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, string>)
    expect(rows.map((x) => [x.id, x.at, x.text, x.whose])).toEqual(shown.map((x) => [x.key, x.at, x.text, x.whose]))
    expect(Object.keys(rows[0] as object)).toEqual(['id', 'at', 'actor', 'actor_kind', 'grant', 'session', 'kind', 'path', 'text', 'whose', 'request'])
    const put = rows.find((x) => x.kind === 'item.enter' && x.path === 'pay/integration.md')
    expect(put).toMatchObject({ actor: 'codex', actor_kind: 'agent', grant: 'codex', session: 'session-b', whose: 'agent', request: '' })
    const decline = rows.find((x) => x.kind === 'owner.op' && x.text?.includes('request decline'))
    const asked = rows.find((x) => x.kind === 'request')
    expect(decline).toMatchObject({ actor: '主人', actor_kind: 'owner', grant: '', whose: 'owner' })
    expect(decline?.request).toMatch(/^r-[0-9a-f]{8}$/)
    expect(asked?.request).toBe(decline?.request)
  })

  it('writes the same rows as CSV, quoting commas, quotes and line breaks, which a spreadsheet reads back whole', () => {
    const dir = tempDir('pb-out-')
    ok(owner(['ledger', 'export', '--to', join(dir, 'audit.jsonl')]))
    ok(owner(['ledger', 'export', '--to', join(dir, 'audit.csv')]))
    ok(owner(['ledger', 'export', '--to', join(dir, 'audit.txt'), '--format', 'csv']))
    const raw = readFileSync(join(dir, 'audit.csv'), 'utf8')
    expect(raw.startsWith('\uFEFFid,at,actor,actor_kind,grant,session,kind,path,text,whose,request\r\n')).toBe(true)
    expect(raw).toContain('"备注：税要另算，主人说 ""先按 7%""\n下季度再看"')
    const [header, ...rows] = parseCsv(raw.slice(1))
    const json = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, string>)
    // Each export is itself a row of the activity, newest first: the CSV has the JSON Lines export's on top.
    const [jsonExport, ...before] = rows.map((r) => Object.fromEntries((header as string[]).map((h, i) => [h, r[i]])))
    expect(jsonExport).toMatchObject({ kind: 'owner.op', text: expect.stringContaining('ledger export') })
    expect(before).toEqual(json)
    expect(parseCsv(readFileSync(join(dir, 'audit.txt'), 'utf8').slice(1)).slice(2)).toEqual(rows)
  })

  it('keeps to the moments asked: a day is local, from its start, or through its end', () => {
    const dir = tempDir('pb-out-')
    const day = (offset: number) => {
      const d = new Date()
      d.setDate(d.getDate() + offset)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const count = (name: string, args: string[]) => {
      ok(owner(['ledger', 'export', '--to', join(dir, name), ...args]))
      return readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l !== '').length
    }
    const all = count('all.jsonl', [])
    // The export just made is the newest row.
    expect(count('today.jsonl', ['--since', day(0), '--until', day(0)])).toBe(all + 1)
    expect(count('later.jsonl', ['--since', day(1)])).toBe(0)
    expect(count('earlier.jsonl', ['--until', day(-1)])).toBe(0)
    expect(count('moment.jsonl', ['--since', new Date(Date.now() + 60_000).toISOString()])).toBe(0)
  })

  it('refuses a file in the library, a file that is there, a moment it cannot read, and an agent', () => {
    const dir = tempDir('pb-out-')
    const inside = owner(['ledger', 'export', '--to', join(lib, 'audit.csv')])
    expect(inside.code).toBe(2)
    expect(inside.stdout).toContain('要放在库外')
    expect(existsSync(join(lib, 'audit.csv'))).toBe(false)
    writeFileSync(join(dir, 'taken.csv'), 'mine')
    const taken = owner(['ledger', 'export', '--to', join(dir, 'taken.csv')])
    expect(taken.code).toBe(2)
    expect(readFileSync(join(dir, 'taken.csv'), 'utf8')).toBe('mine')
    expect(owner(['ledger', 'export', '--to', join(dir, 'x.csv'), '--since', 'last tuesday']).stdout).toContain('--since 要写一天')
    const agent = as('claude', 'session-d')(['ledger', 'export', '--to', join(dir, 'agent.csv')])
    expect(agent.code).toBe(2)
    expect(existsSync(join(dir, 'agent.csv'))).toBe(false)
  })
})
