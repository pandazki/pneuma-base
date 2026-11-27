// Looking is no act: a read-only owner command leaves no fact, and the facts of looking an older
// ledger wrote are on no page and in no `show`, only in the export, which is the raw record. An
// owner command is recorded as given, with what it did to what; never what it printed.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownerFace } from '@pneuma-base/kernel'
import { describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir } from './helpers.js'

const FACTS = '.pneuma-base/ledger/facts'

function factsOf(lib: string): Record<string, unknown>[] {
  const dir = join(lib, FACTS)
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('looking is no act', () => {
  it('every command that lists or tells a status is read-only; an export, which takes data out, is not', () => {
    const commands = ownerFace.commands([...builtinPlugins.values()])
    const looking = commands.filter((c) => / (list|status)$/.test(c.name))
    expect(looking.length).toBeGreaterThan(8)
    expect(looking.filter((c) => !c.readOnly).map((c) => c.name)).toEqual([])
    const exports = commands.filter((c) => c.name.endsWith(' export'))
    expect(exports.map((c) => c.name).sort()).toEqual(['ledger export', 'version export'])
    expect(exports.filter((c) => c.readOnly).map((c) => c.name)).toEqual([])
  })

  it('a read-only command leaves no fact; one that changes something is recorded as given, with what it did and to what', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    for (const look of [['storage', 'list'], ['plugin', 'list'], ['request', 'list'], ['agent', 'list'], ['ledger', 'held', 'list'], ['show', 'ledger.activity']]) {
      expect(sb.run(['--library', lib, ...look]).code).toBe(0)
    }
    expect(sb.run(['--library', lib, 'plugin', 'add', 'version']).code).toBe(0)
    const ops = factsOf(lib).filter((f) => f.kind === 'owner.op')
    expect(ops.map((f) => f.command)).toEqual(['init', 'plugin add'])
    expect(ops[0]).toMatchObject({ line: `init ${lib}`, act: 'created', object: 'lib' })
    expect(ops[1]).toMatchObject({ line: 'plugin add version', act: 'on', object: 'version' })
    // The row says the command as given, not what it printed.
    const activity = sb.run(['--library', lib, 'show', 'ledger.activity']).stdout
    expect(activity).toContain('pneuma-base plugin add version')
    expect(activity).not.toContain('已装上插件')
  })

  it('the looking an older ledger recorded is on no page and in no show, and is not counted; the export keeps it', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    const [init] = factsOf(lib)
    const older = { ...init, id: 'f_20260101000000000_aaaaaa_0000', at: '2026-01-01T00:00:00.000Z', command: 'storage list', summary: 'local-folder 0.1.0 · 自带', readOnly: true, line: undefined, act: undefined, object: undefined }
    const day = join(lib, FACTS, '2026-01-01')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, '20260101000000000-aaaaaaaaaaaa-000000.jsonl'), `${JSON.stringify(older)}\n`)

    const activity = sb.run(['--library', lib, 'show', 'ledger.activity']).stdout
    expect(activity).toContain('pneuma-base init')
    expect(activity).not.toContain('storage list')
    expect(activity).toContain('全部 1')
    const out = join(tempDir(), 'audit.jsonl')
    expect(sb.run(['--library', lib, 'ledger', 'export', '--to', out]).code).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('storage list')
  })
})
