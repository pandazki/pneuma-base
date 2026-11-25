import { randomUUID } from 'node:crypto'
import type { Actor, Grant, Session } from './types.js'

export type Env = Readonly<Record<string, string | undefined>>

/** Environment variables that carry a session id, in the order they are tried. */
const SESSION_VARIABLES = ['PNEUMA_BASE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'ANTIGRAVITY_CONVERSATION_ID'] as const

/** Environment variables that mark an agent session even when no session id variable is set. */
const AGENT_VARIABLES = ['CLAUDECODE', 'ANTIGRAVITY_AGENT'] as const

/** Session identity: the flag, then the environment, otherwise one minted for this invocation. */
export function identifySession(input: { flag: string | null; env: Env; cwd: string; machine: string }): Session {
  const base = { cwd: input.cwd, machine: input.machine, transcript: null }
  if (input.flag) return { id: input.flag, source: 'flag', ...base }
  for (const name of SESSION_VARIABLES) {
    const id = input.env[name]
    if (id) return { id, source: 'env', ...base }
  }
  return { id: randomUUID(), source: 'minted', ...base }
}

/** Who acts: the grant's agent, the name given with `--as`, the agent product the environment shows, else the owner. */
export function identifyActor(input: { grant: Grant | null; as: string | null; env: Env }): Actor {
  if (input.grant) return { kind: 'agent', name: input.grant.agent, grant: input.grant.id }
  if (input.as) return { kind: 'agent', name: input.as, grant: null }
  if (input.env.CLAUDE_CODE_SESSION_ID || input.env.CLAUDECODE) return { kind: 'agent', name: 'claude-code', grant: null }
  if (input.env.CODEX_THREAD_ID) return { kind: 'agent', name: 'codex', grant: null }
  if (input.env.ANTIGRAVITY_CONVERSATION_ID || input.env.ANTIGRAVITY_AGENT) return { kind: 'agent', name: 'antigravity', grant: null }
  return { kind: 'owner' }
}

/** The second line of defence for destructive owner commands (K7). */
export function looksLikeAgentSession(env: Env, viaGrant: boolean): boolean {
  return agentSessionSign(env, viaGrant) !== null
}

/** What shows the call comes from an agent session, in words for the refusal; null when nothing does. */
export function agentSessionSign(env: Env, viaGrant: boolean): string | null {
  if (viaGrant) return '调用带着授权'
  const name = [...SESSION_VARIABLES, ...AGENT_VARIABLES].find((n) => Boolean(env[n]))
  return name === undefined ? null : `环境里有 ${name}`
}
