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
  const thrown = (problems: { plugin: string; message: string }[]) => problems.filter((p) => p.plugin === 'thrower').map((p) => p.message)

  it('fails no verb: each answers, names the hook that threw among its problems, exits 3, and says so in the readable output too', () => {
    expect(sb.runWithTestPlugins(['plugin', 'add', 'thrower', '--library', lib]).code).toBe(3)
    const put = agent(['put', '-', '--to', 'a.md', '--made'], 'a')
    expect(put.code).toBe(3)
    expect(put.json()).toMatchObject({ outcome: 'accepted', path: 'a.md', copied: true })
    expect(thrown(put.json().problems)).toEqual(['thrower failed in onPut', 'thrower failed in observe'])
    expect(readFileSync(join(lib, 'a.md'), 'utf8')).toBe('a')
    const cases: [string[], string[]][] = [
      [['find', 'a'], ['thrower failed in onFind', 'thrower failed in observe']],
      [['inspect', 'a.md'], ['thrower failed in onInspect', 'thrower failed in observe']],
      [['check'], ['thrower failed in onCheck', 'thrower failed in observe']],
      [['say', 'boom', 'x'], ['thrower failed in onSay', 'thrower failed in observe']],
      [['say', 'note', 'x'], ['thrower failed in observe']],
      [['archive', 'a.md'], ['thrower failed in onArchive', 'thrower failed in observe']],
      [['unarchive', 'a.md'], ['thrower failed in onArchive', 'thrower failed in observe']],
      [['start', 'a'], []],
    ]
    const answers = new Map<string, any>()
    for (const [args, expected] of cases) {
      const r = agent(args)
      expect(r.code, args.join(' ')).toBe(3)
      if (args[0] !== 'start') expect(thrown(r.json().problems), args.join(' ')).toEqual(expected)
      answers.set(args.join(' '), r.json())
    }
    // Hits come only from plugins' indexes (ARCHITECTURE.md「找、看、说、查、归档」); this library's one plugin threw, so there are none.
    expect(answers.get('find a').hits).toEqual([])
    expect(answers.get('start a').find.hits).toEqual([])
    expect(answers.get('say boom x')).toMatchObject({ outcome: 'not-heard', reason: 'plugin-failed' })
    const text = sb.runWithTestPlugins(['--library', lib, 'check'], { cwd: outside })
    expect(text.code).toBe(3)
    expect(text.stdout).toContain('插件 thrower 出错：thrower failed in onCheck')
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
  it('archive purge is refused in an agent session, whichever variable shows it, through a grant, and without an in-person confirmation', () => {
    agent(['put', '-', '--to', 'old.md', '--made'], 'old')
    agent(['archive', 'old.md'])
    for (const variable of ['PNEUMA_BASE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
      const r = sb.runWithTestPlugins(['archive', 'purge', '--library', lib], { env: { [variable]: 'session-1' } })
      expect(r.code, variable).toBe(2)
      expect(r.stdout, variable).toContain('agent-session')
    }
    sb.runWithTestPlugins(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code'])
    const viaGrant = sb.runWithTestPlugins(['@claude', 'archive', 'purge'])
    expect(viaGrant.code).toBe(2)
    expect(viaGrant.stdout).toContain('agent-session')
    const unconfirmed = sb.runWithTestPlugins(['archive', 'purge', '--library', lib], { input: 'yes\n' })
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.stdout).toContain('not-confirmed')
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
