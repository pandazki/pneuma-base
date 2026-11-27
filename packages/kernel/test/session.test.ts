// Session identity order (spec failure semantics, "未知"): flag, PNEUMA_BASE_SESSION,
// CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, otherwise minted and marked so. Which variables show an agent
// session is the gate's: owner.test.ts here, plugin-mechanism.test.ts on the command line.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { identifyActor, identifySession, type GrantId } from '../src/index.js'

const base = { cwd: '/w', machine: 'm' }
const all = { PNEUMA_BASE_SESSION: 'p', CLAUDE_CODE_SESSION_ID: 'c', CODEX_THREAD_ID: 'x', ANTIGRAVITY_CONVERSATION_ID: 'a' }

describe('identifySession', () => {
  it('takes the first source present, in order, and mints a fresh one per invocation when nothing gives it', () => {
    expect(identifySession({ ...base, flag: 'f', env: all })).toMatchObject({ id: 'f', source: 'flag' })
    expect(identifySession({ ...base, flag: null, env: all })).toMatchObject({ id: 'p', source: 'env' })
    expect(identifySession({ ...base, flag: null, env: { CLAUDE_CODE_SESSION_ID: 'c', CODEX_THREAD_ID: 'x', ANTIGRAVITY_CONVERSATION_ID: 'a' } })).toMatchObject({ id: 'c', source: 'env' })
    expect(identifySession({ ...base, flag: null, env: { CODEX_THREAD_ID: 'x', ANTIGRAVITY_CONVERSATION_ID: 'a' } })).toMatchObject({ id: 'x', source: 'env' })
    expect(identifySession({ ...base, flag: null, env: { ANTIGRAVITY_CONVERSATION_ID: 'a' } })).toMatchObject({ id: 'a', source: 'env' })
    const a = identifySession({ ...base, flag: null, env: {} })
    const b = identifySession({ ...base, flag: null, env: {} })
    expect(a.source).toBe('minted')
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ cwd: '/w', machine: 'm', transcript: null })
  })
})

// The products' folders are faked under a temp HOME, with empty files: only names are looked at.
describe('the conversation a session points back to', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  let home: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pb-home-')))
  })
  const touch = (path: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  const folderOf = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-')
  const transcript = (env: Record<string, string>, cwd: string, flag: string | null = null) => identifySession({ flag, env: { HOME: home, ...env }, cwd, machine: 'm' }).transcript

  it('finds a Claude Code conversation in the folder named after the directory it started in, from below that directory too, and under CLAUDE_CONFIG_DIR when it is set', () => {
    const project = join(home, 'work', 'my.site v2')
    mkdirSync(join(project, 'src'), { recursive: true })
    touch(join(home, '.claude/projects', folderOf(project), `${id}.jsonl`))
    const expected = { path: `~/.claude/projects/${folderOf(project)}/${id}.jsonl`, resume: `cd ~/work/'my.site v2' && claude --resume ${id}` }
    expect(transcript({ CLAUDE_CODE_SESSION_ID: id }, project)).toEqual(expected)
    expect(transcript({ CLAUDE_CODE_SESSION_ID: id }, join(project, 'src'))).toEqual(expected)
    const other = join(home, 'w')
    touch(join(home, 'cfg/projects', folderOf(other), `${id}.jsonl`))
    expect(transcript({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: join(home, 'cfg') }, other)?.path).toBe(`~/cfg/projects/${folderOf(other)}/${id}.jsonl`)
  })

  it('finds a Codex conversation by its thread id in the dated folders, and under CODEX_HOME when it is set', () => {
    touch(join(home, '.codex/sessions/2026/11/26', 'rollout-2026-11-26T01-00-00-01a2106d-fcb1-72c3-9aef-583c6bd555a2.jsonl'))
    touch(join(home, '.codex/sessions/2026/10/31', `rollout-2026-10-31T23-59-01-${id}.jsonl`))
    expect(transcript({ CODEX_THREAD_ID: id }, '/w')).toEqual({ path: `~/.codex/sessions/2026/10/31/rollout-2026-10-31T23-59-01-${id}.jsonl`, resume: `codex resume ${id}` })
    touch(join(home, 'cx/sessions/2026/11/25', `rollout-2026-11-25T04-42-24-${id}.jsonl`))
    expect(transcript({ CODEX_THREAD_ID: id, CODEX_HOME: join(home, 'cx') }, '/w')?.path).toBe(`~/cx/sessions/2026/11/25/rollout-2026-11-25T04-42-24-${id}.jsonl`)
  })

  it('points nowhere without the file, for a product with no rule, for an id that is no plain name, or for an id not from a product', () => {
    const project = join(home, 'w')
    expect(transcript({ CLAUDE_CODE_SESSION_ID: id }, project)).toBeNull()
    expect(transcript({ CODEX_THREAD_ID: id }, project)).toBeNull()
    touch(join(home, '.claude/projects', folderOf(project), `${id}.jsonl`))
    expect(transcript({ ANTIGRAVITY_CONVERSATION_ID: id }, project)).toBeNull()
    expect(transcript({ PNEUMA_BASE_SESSION: id }, project)).toBeNull()
    expect(transcript({ CLAUDE_CODE_SESSION_ID: id }, project, id)).toBeNull()
    touch(join(home, '.claude/projects', `${id}.jsonl`))
    expect(transcript({ CLAUDE_CODE_SESSION_ID: `../${id}` }, project)).toBeNull()
  })
})

describe('identifyActor', () => {
  it('prefers the grant, then --as, then the agent product in the environment, else the owner', () => {
    const grant = { id: 'g' as GrantId, name: 'n', agent: 'codex', area: null, readOnly: false }
    expect(identifyActor({ grant, as: 'x', env: all })).toEqual({ kind: 'agent', name: 'codex', grant: 'g' })
    expect(identifyActor({ grant: null, as: 'x', env: all })).toEqual({ kind: 'agent', name: 'x', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { CLAUDE_CODE_SESSION_ID: 'c' } })).toEqual({ kind: 'agent', name: 'claude-code', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { CLAUDECODE: '1' } })).toEqual({ kind: 'agent', name: 'claude-code', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { CODEX_THREAD_ID: 'x' } })).toEqual({ kind: 'agent', name: 'codex', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { ANTIGRAVITY_CONVERSATION_ID: 'a' } })).toEqual({ kind: 'agent', name: 'antigravity', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { ANTIGRAVITY_AGENT: '1' } })).toEqual({ kind: 'agent', name: 'antigravity', grant: null })
    expect(identifyActor({ grant: null, as: null, env: {} })).toEqual({ kind: 'owner' })
  })
})
