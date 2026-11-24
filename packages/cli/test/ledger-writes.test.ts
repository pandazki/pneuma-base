// C12: processes writing facts to one session at the same time lose none, and no file is written
// by two of them. The ledger rows of the invariants and failure semantics: a fact file never
// changes once written; a writer killed midway leaves no half fact; a minted session says so.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const FACTS = () => join(lib, '.pneuma-base/ledger/facts')

/** Every file under facts/, by its path relative to facts/. */
function factFiles(): Map<string, string> {
  const out = new Map<string, string>()
  for (const scene of readdirSync(FACTS())) {
    for (const name of readdirSync(join(FACTS(), scene))) out.set(`${scene}/${name}`, readFileSync(join(FACTS(), scene, name), 'utf8'))
  }
  return out
}

const parse = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line))

async function runAll(argsList: string[][]): Promise<(number | null)[]> {
  return Promise.all(
    argsList.map((args) => {
      const child = sb.start(['--library', lib, ...args])
      child.stdin.end()
      return new Promise<number | null>((done) => child.on('exit', done))
    }),
  )
}

describe('concurrent writers (C12)', () => {
  it('twelve processes saying something in one session at once: every fact kept, one file each, from one process', async () => {
    const notes = Array.from({ length: 12 }, (_, i) => `note ${i}`)
    const codes = await runAll(notes.map((note) => ['--as', 'claude-code', '--session', 'same', 'say', 'note', note]))
    expect(codes).toEqual(notes.map(() => 0))

    const files = [...factFiles()].filter(([path]) => path.startsWith('same/'))
    expect(files.filter(([path]) => path.includes('.tmp-'))).toEqual([])
    expect(files).toHaveLength(notes.length)
    const facts = files.flatMap(([, text]) => parse(text))
    expect(facts.map((f) => f.text).sort()).toEqual([...notes].sort())
    expect(new Set(facts.map((f) => f.id)).size).toBe(notes.length)
  })

  it('two processes adopting the same unregistered file at once end with one item that both build on', async () => {
    writeFileSync(join(lib, 'shared.md'), 'shared')
    for (const name of ['a', 'b']) writeFileSync(join(outside, `${name}.md`), name)
    const codes = await runAll(
      ['a', 'b'].map((name) => ['--as', 'claude-code', '--session', `s-${name}`, 'put', join(outside, `${name}.md`), '--to', `${name}.md`, '--made', '--from', 'shared.md']),
    )
    expect(codes).toEqual([0, 0])
    const inspect = (path: string) => sb.run(['--library', lib, 'inspect', path, '--json'], { cwd: outside }).json().sections[0].data
    const shared = inspect('shared.md')
    expect(shared.origin).toEqual({ kind: 'adopted' })
    expect(shared.dependents.map((d: any) => d.path).sort()).toEqual(['a.md', 'b.md'])
    expect(inspect('a.md').basis[0].item).toBe(shared.item)
    expect(inspect('b.md').basis[0].item).toBe(shared.item)
  })
})

describe('fact files', () => {
  const agent = (args: string[], input?: string) =>
    sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })

  it('never change once written', () => {
    agent(['start', '整理资料'])
    agent(['put', '-', '--to', 'a.md', '--made'], 'a')
    const before = factFiles()
    agent(['put', '-', '--to', 'b.md', '--made', '--from', 'a.md'], 'b')
    agent(['say', 'note', 'a.md', '一条备注'])
    agent(['check'])
    const after = factFiles()
    for (const [path, text] of before) expect(after.get(path), path).toBe(text)
    expect(after.size).toBeGreaterThan(before.size)
  })

  it('a writer killed midway leaves no half fact, and a leftover temporary file is ignored', async () => {
    for (const delay of [0, 5, 10, 20, 30, 40, 50, 60, 80, 120]) {
      const child = sb.start(['--library', lib, '--as', 'claude-code', '--session', 'killed', 'say', 'note', `n${delay}`])
      child.stdin.end()
      const exited = new Promise((done) => child.on('exit', done))
      await new Promise((done) => setTimeout(done, delay))
      child.kill('SIGKILL')
      await exited
    }
    mkdirSync(join(FACTS(), 'killed'), { recursive: true })
    writeFileSync(join(FACTS(), 'killed', '.tmp-20261125000000000-deadbeef.jsonl'), '{"id":"f_half","at":"2026')
    for (const [path, text] of factFiles()) if (!path.split('/')[1]?.startsWith('.tmp-')) expect(() => parse(text), path).not.toThrow()
    const r = agent(['check', '--json'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json().problems).toEqual([])
  })

  it('a call with no session id gets one minted, grouped by agent and day, and the facts say it was minted', () => {
    const r = sb.run(['--library', lib, '--as', 'claude-code', 'say', 'note', '没有会话标识'], { cwd: outside })
    expect(r.code, r.stderr).toBe(0)
    const day = new Date().toISOString().slice(0, 10)
    const facts = [...factFiles()].filter(([path]) => path.startsWith(`adhoc-claude-code-${day}/`)).flatMap(([, text]) => parse(text))
    expect(facts).toMatchObject([{ kind: 'said', text: '没有会话标识', where: { sessionSource: 'minted' } }])
  })
})
