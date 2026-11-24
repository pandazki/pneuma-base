// Session identity order (spec failure semantics, "未知"): flag, PNEUMA_BASE_SESSION,
// CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, otherwise minted and marked so.
import { describe, expect, it } from 'vitest'
import { identifyActor, identifySession, looksLikeAgentSession, type GrantId } from '../src/index.js'

const base = { cwd: '/w', machine: 'm' }
const all = { PNEUMA_BASE_SESSION: 'p', CLAUDE_CODE_SESSION_ID: 'c', CODEX_THREAD_ID: 'x' }

describe('identifySession', () => {
  it('takes the first source present, in order', () => {
    expect(identifySession({ ...base, flag: 'f', env: all })).toMatchObject({ id: 'f', source: 'flag' })
    expect(identifySession({ ...base, flag: null, env: all })).toMatchObject({ id: 'p', source: 'env' })
    expect(identifySession({ ...base, flag: null, env: { CLAUDE_CODE_SESSION_ID: 'c', CODEX_THREAD_ID: 'x' } })).toMatchObject({ id: 'c', source: 'env' })
    expect(identifySession({ ...base, flag: null, env: { CODEX_THREAD_ID: 'x' } })).toMatchObject({ id: 'x', source: 'env' })
  })

  it('mints a fresh one per invocation when nothing gives it', () => {
    const a = identifySession({ ...base, flag: null, env: {} })
    const b = identifySession({ ...base, flag: null, env: {} })
    expect(a.source).toBe('minted')
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ cwd: '/w', machine: 'm', transcript: null })
  })
})

describe('identifyActor', () => {
  it('prefers the grant, then --as, then the agent product in the environment, else the owner', () => {
    const grant = { id: 'g' as GrantId, name: 'n', agent: 'codex', area: null, readOnly: false }
    expect(identifyActor({ grant, as: 'x', env: all })).toEqual({ kind: 'agent', name: 'codex', grant: 'g' })
    expect(identifyActor({ grant: null, as: 'x', env: all })).toEqual({ kind: 'agent', name: 'x', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { CLAUDE_CODE_SESSION_ID: 'c' } })).toEqual({ kind: 'agent', name: 'claude-code', grant: null })
    expect(identifyActor({ grant: null, as: null, env: { CODEX_THREAD_ID: 'x' } })).toEqual({ kind: 'agent', name: 'codex', grant: null })
    expect(identifyActor({ grant: null, as: null, env: {} })).toEqual({ kind: 'owner' })
  })
})

describe('looksLikeAgentSession', () => {
  it('is true for any session variable or a call through a grant', () => {
    for (const name of Object.keys(all)) expect(looksLikeAgentSession({ [name]: 'v' }, false)).toBe(true)
    expect(looksLikeAgentSession({}, true)).toBe(true)
    expect(looksLikeAgentSession({ HOME: '/h' }, false)).toBe(false)
  })
})
