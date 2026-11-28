// Facts keep the words they were written with. A command fact or a request written before the commands
// were renamed reads under the name the command has now, on the pages, in `show` and in the export.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { factsOf, feedRowsIn, sandbox, tempDir } from './helpers.js'

describe('a fact written under an old command name', () => {
  it('reads under the new name, its renamed flags too, in the activity, the scene and the export', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    const [init] = factsOf(lib)
    const old = (n: number, body: Record<string, unknown>) => ({ ...init, id: `f_20260101000000000_aaaaaa_000${n}`, at: `2026-01-01T00:00:0${n}.000Z`, ...body })
    const facts = [
      old(1, { command: 'plugin add', summary: '已装上插件 version', line: 'plugin add version', act: 'on', object: 'version' }),
      old(2, { command: 'ledger register', summary: '已登记', line: 'ledger register notes --inside', act: 'brought', object: 'notes' }),
      old(3, { command: 'grant issue', summary: '已发授权', line: undefined, act: undefined, object: undefined }),
      old(4, { kind: 'request', act: 'asked', request: 'r-1', line: 'plugin remove deploy --anyway', why: '不用了', command: undefined, summary: undefined, destructive: undefined }),
    ]
    const day = join(lib, '.pneuma-base', 'ledger', 'facts', '2026-01-01')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, '20260101000000000-aaaaaaaaaaaa-000000.jsonl'), facts.map((f) => `${JSON.stringify(f)}\n`).join(''))

    const activity = sb.run(['--library', lib, 'show', 'ledger.activity']).stdout
    for (const now of ['pneuma-base plugin enable version', 'pneuma-base ledger register notes --recursive', 'pneuma-base grant create', 'plugin disable deploy --force']) expect(activity).toContain(now)
    for (const before of ['plugin add', '--inside', 'grant issue', 'plugin remove', '--anyway']) expect(activity).not.toContain(before)
    const rows = feedRowsIn(sb.run(['--library', lib, 'show', 'ledger.activity', '--json']).json().blocks.find((b: any) => b.kind === 'feed').groups)
    expect(rows.find((r: any) => r.path === 'notes')).toMatchObject({ act: 'imported' })

    const scene = sb.run(['--library', lib, 'show', 'ledger.scene', '--scene', init.scene]).stdout
    expect(scene).toContain('plugin enable')
    expect(scene).not.toContain('plugin add')

    const out = join(tempDir(), 'audit.jsonl')
    expect(sb.run(['--library', lib, 'ledger', 'export', '--to', out]).code).toBe(0)
    const exported = readFileSync(out, 'utf8')
    for (const now of ['plugin enable', 'grant create', 'plugin disable deploy --force']) expect(exported).toContain(now)
    for (const before of ['plugin add', 'grant issue', 'plugin remove']) expect(exported).not.toContain(before)
  })
})

describe('a request pending under an old command name', () => {
  it('lists and runs under the new name and its renamed flags', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    expect(sb.run(['--library', lib, 'plugin', 'enable', 'version']).code).toBe(0)
    // Asked before the rename, arriving by sync: the command and its flag under the names they had then.
    const asked = { request: 'r-0ed0ed01', kind: 'asked', at: new Date().toISOString(), by: { name: 'claude', grant: null }, session: 's1', why: '不用了', command: 'plugin remove', args: { positional: ['version'], flags: { anyway: true } } }
    const day = join(lib, '.pneuma-base/requests/facts', asked.at.slice(0, 10))
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `${asked.at.replace(/[^0-9]/g, '').slice(0, 17)}-othermachine-000001.jsonl`), `${JSON.stringify(asked)}\n`)
    expect(sb.run(['--library', lib, 'request', 'list']).stdout).toContain('plugin disable version --force')
    const approved = sb.run(['--library', lib, 'request', 'approve', asked.request])
    expect(approved.code, approved.stdout + approved.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).not.toContain('version')
  })
})
