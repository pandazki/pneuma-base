// C10, K8: a plugin that throws in every hook fails no verb; results list its problem; exit 3.
// K5: every operation of either face sends exactly one event to every installed plugin.
// K7: destructive owner commands are refused in an agent session and without confirmation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  expect(sb.runWithTestPlugins(['init', lib, '--bare']).code).toBe(0)
})

const agent = (args: string[], input?: string) =>
  sb.runWithTestPlugins(['--library', lib, '--as', 'claude-code', ...args, '--json'], { cwd: outside, ...(input === undefined ? {} : { input }) })

describe('a plugin that throws in every hook (C10)', () => {
  beforeEach(() => {
    expect(sb.runWithTestPlugins(['plugin', 'add', 'thrower', '--library', lib]).code).toBe(3)
  })

  const thrown = (problems: { plugin: string; message: string }[]) => problems.filter((p) => p.plugin === 'thrower').map((p) => p.message)

  it('put still places the file; the problems name the hook; exit 3', () => {
    const r = agent(['put', '-', '--to', 'a.md', '--made'], 'a')
    expect(r.code).toBe(3)
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'a.md', copied: true })
    expect(thrown(r.json().problems)).toEqual(['thrower failed in onPut', 'thrower failed in observe'])
    expect(readFileSync(join(lib, 'a.md'), 'utf8')).toBe('a')
  })

  it('find, inspect, check, say, archive, unarchive and start all answer and exit 3', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'a')
    const cases: [string[], string[]][] = [
      [['find', 'a'], ['thrower failed in onFind', 'thrower failed in observe']],
      [['inspect', 'a.md'], ['thrower failed in onInspect', 'thrower failed in observe']],
      [['check'], ['thrower failed in onCheck', 'thrower failed in observe']],
      [['say', 'boom', 'x'], ['thrower failed in onSay', 'thrower failed in observe']],
      [['say', 'note', 'x'], ['thrower failed in observe']],
      [['archive', 'a.md'], ['thrower failed in onArchive', 'thrower failed in observe']],
      [['unarchive', 'a.md'], ['thrower failed in onArchive', 'thrower failed in observe']],
    ]
    for (const [args, expected] of cases) {
      const r = agent(args)
      expect(r.code, args.join(' ')).toBe(3)
      expect(thrown(r.json().problems), args.join(' ')).toEqual(expected)
    }
    // Hits come only from plugins' indexes (ARCHITECTURE.md「找、看、说、查、归档」); this library's one plugin threw, so there are none.
    expect(agent(['find', 'a']).json().hits).toEqual([])
    expect(agent(['say', 'boom', 'x']).json()).toMatchObject({ outcome: 'not-heard', reason: 'plugin-failed' })
    const start = agent(['start', 'a'])
    expect(start.code).toBe(3)
    expect(start.json().find.hits).toEqual([])
  })

  it('a throwing reviser leaves the target as it was: refused, exit 2, problem listed', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], 'old')
    const r = agent(['put', '-', '--to', 'a.md', '--made'], 'new')
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'would-overwrite' })
    expect(thrown(r.json().problems)).toEqual(['thrower failed in revise', 'thrower failed in observe'])
    expect(readFileSync(join(lib, 'a.md'), 'utf8')).toBe('old')
  })

  it('prints the problem in the readable output too', () => {
    const r = sb.runWithTestPlugins(['--library', lib, 'check'], { cwd: outside })
    expect(r.code).toBe(3)
    expect(r.stdout).toContain('插件 thrower 出错：thrower failed in onCheck')
  })
})

describe('a plugin installed in the library but unknown to this command line', () => {
  it('is reported as a problem in every answer; the verbs still work and its directory stays', () => {
    sb.runWithTestPlugins(['plugin', 'add', 'recorder', '--library', lib])
    const r = sb.run(['--library', lib, 'find', '--json'], { cwd: outside })
    expect(r.code).toBe(3)
    expect(r.json().problems).toEqual([{ plugin: 'recorder', message: 'installed in this library but not known to this pneuma-base' }])
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).not.toContain('没有装任何插件')
    expect(sb.run(['plugin', 'remove', 'recorder', '--library', lib]).code).toBe(0)
    expect(existsSync(join(lib, '.pneuma-base/recorder'))).toBe(true)
  })
})

describe('events (K5)', () => {
  it('each operation of either face reaches the installed plugins exactly once', () => {
    const run = (args: string[], opts?: { input?: string; env?: Record<string, string> }) =>
      sb.runWithTestPlugins(['--library', lib, ...args], { cwd: outside, ...opts })
    run(['plugin', 'add', 'recorder'])
    run(['put', '-', '--to', 'a.md', '--made'], { input: 'a' })
    run(['put', '-', '--to', 'a.md', '--made'], { input: 'b' }) // refused
    run(['find', 'a'])
    run(['inspect', 'a.md'])
    run(['say', 'note', 'x'])
    run(['check'])
    run(['archive', 'a.md'])
    run(['unarchive', 'a.md'])
    run(['start', 'a']) // say, check, find
    run(['grant', 'issue', 'g', '--agent', 'x'])
    run(['archive', 'purge'], { env: { CLAUDE_CODE_SESSION_ID: 's' } }) // refused
    expect(run(['put', '-', '--to', 'b.md'], { input: 'b' }).code).toBe(1) // usage error: no operation
    run(['plugin', 'remove', 'recorder'])
    run(['find', 'a']) // the recorder is no longer installed

    const events = readFileSync(join(lib, '.pneuma-base/recorder/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.map((e) => `${e.face}:${e.what}:${e.outcome}`)).toEqual([
      'owner:plugin add:done',
      'agent:put:accepted',
      'agent:put:refused',
      'agent:find:undefined',
      'agent:inspect:undefined',
      'agent:say:not-heard',
      'agent:check:undefined',
      'agent:archive:accepted',
      'agent:archive:accepted',
      'agent:say:not-heard',
      'agent:check:undefined',
      'agent:find:undefined',
      'owner:grant issue:done',
      'owner:archive purge:refused',
    ])
  })
})

describe('destructive owner commands (K7)', () => {
  beforeEach(() => {
    agent(['put', '-', '--to', 'old.md', '--made'], 'old')
    agent(['archive', 'old.md'])
  })

  for (const variable of ['PNEUMA_BASE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
    it(`archive purge is refused when ${variable} is set`, () => {
      const r = sb.runWithTestPlugins(['archive', 'purge', '--library', lib], { env: { [variable]: 'session-1' } })
      expect(r.code).toBe(2)
      expect(r.stdout).toContain('agent-session')
      expect(existsSync(join(lib, '_archive/old.md'))).toBe(true)
    })
  }

  it('archive purge is refused through a grant', () => {
    sb.runWithTestPlugins(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code'])
    const r = sb.runWithTestPlugins(['@claude', 'archive', 'purge'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('agent-session')
    expect(existsSync(join(lib, '_archive/old.md'))).toBe(true)
  })

  it('archive purge is refused without an in-person confirmation', () => {
    const r = sb.runWithTestPlugins(['archive', 'purge', '--library', lib], { input: 'yes\n' })
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('not-confirmed')
    expect(existsSync(join(lib, '_archive/old.md'))).toBe(true)
  })

  it('a plugin-declared destructive command passes the same gate', () => {
    sb.runWithTestPlugins(['plugin', 'add', 'recorder', '--library', lib])
    const events = join(lib, '.pneuma-base/recorder/events.jsonl')
    writeFileSync(events, 'kept\n')
    const inSession = sb.runWithTestPlugins(['recorder', 'clear', '--library', lib], { env: { CODEX_THREAD_ID: 't' } })
    expect(inSession.code).toBe(2)
    expect(inSession.stdout).toContain('agent-session')
    const unconfirmed = sb.runWithTestPlugins(['recorder', 'clear', '--library', lib])
    expect(unconfirmed.code).toBe(2)
    expect(readFileSync(events, 'utf8').startsWith('kept\n')).toBe(true)
  })
})
