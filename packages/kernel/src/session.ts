import { randomUUID } from 'node:crypto'
import type { Actor, Grant, Session } from '@pneuma-base/sdk'
import { AGENT_PRODUCTS, homeOf, type AgentProduct, type Env } from './products.js'

export type { Env } from './products.js'

/** A session id that can name a file and nothing else: no separator, no dots. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/

/** The products whose sessions are recognised from the environment, in the order they are tried. */
const RECOGNISED = AGENT_PRODUCTS.flatMap((p) => (p.session === null ? [] : [{ ...p, session: p.session }]))

/** Environment variables that carry a session id, in the order they are tried. */
const SESSION_VARIABLES = ['PNEUMA_BASE_SESSION', ...RECOGNISED.map((p) => p.session)]

const variablesOf = (product: AgentProduct): readonly string[] => [...(product.session === null ? [] : [product.session]), ...product.markers]

/**
 * Session identity: the flag, then the environment, otherwise one minted for this invocation. An id
 * from an agent product's variable also points to the product's conversation file, when it is there.
 */
export function identifySession(input: { flag: string | null; env: Env; cwd: string; machine: string }): Session {
  const base = { cwd: input.cwd, machine: input.machine, transcript: null }
  if (input.flag) return { id: input.flag, source: 'flag', ...base }
  const given = input.env.PNEUMA_BASE_SESSION
  if (given) return { id: given, source: 'env', ...base }
  for (const product of RECOGNISED) {
    const id = input.env[product.session]
    if (!id) continue
    const look = { home: homeOf(input.env), env: input.env, cwd: input.cwd }
    return { id, source: 'env', ...base, transcript: product.transcript && PLAIN_ID.test(id) ? product.transcript(id, look) : null }
  }
  return { id: randomUUID(), source: 'minted', ...base }
}

/** Who acts: the grant's agent, the name given with `--as`, the agent product the environment shows, else the owner. */
export function identifyActor(input: { grant: Grant | null; as: string | null; env: Env }): Actor {
  if (input.grant) return { kind: 'agent', name: input.grant.agent, grant: input.grant.id }
  if (input.as) return { kind: 'agent', name: input.as, grant: null }
  const product = AGENT_PRODUCTS.find((p) => variablesOf(p).some((n) => Boolean(input.env[n])))
  return product ? { kind: 'agent', name: product.name, grant: null } : { kind: 'owner' }
}

/** The second line of defence for destructive owner commands (K7). */
export function looksLikeAgentSession(env: Env, viaGrant: boolean): boolean {
  return agentSessionSign(env, viaGrant) !== null
}

/** What shows the call comes from an agent session, in words for the refusal; null when nothing does. */
export function agentSessionSign(env: Env, viaGrant: boolean): string | null {
  if (viaGrant) return '调用带着授权'
  const name = [...SESSION_VARIABLES, ...RECOGNISED.flatMap((p) => p.markers)].find((n) => Boolean(env[n]))
  return name === undefined ? null : `环境里有 ${name}`
}

/**
 * What shows the call comes from an agent: a grant or an agent session variable (the second line of
 * defence, K7), or an actor named an agent with `--as`. Null when nothing does.
 */
export function agentSign(env: Env, viaGrant: boolean, actor: Actor): string | null {
  return agentSessionSign(env, viaGrant) ?? (actor.kind === 'agent' ? `调用者是 agent ${actor.name}` : null)
}

/** Why an owner-only command, or a page of management, is not an agent's to use. */
export const OWNER_DECIDES = '是替主人做的决定'

/**
 * The refusal, in an agent's session, of what only the owner does: an owner command, or a page of
 * management, in the same words. `ask`: the line that asks the owner for it, when it may be asked for.
 */
export function ownerOnlyRefusal(name: string, why: string, sign: string, ask: string | null = null): string {
  const head = `「${name}」${why}，只有主人能做，不能在 agent 的会话里做（${sign}）。`
  if (ask !== null) return `${head}要主人来做，写明为什么，请主人批准：\n${ask}`
  return `${head}需要的话告诉主人；主人在自己的终端里做，或在自己的终端里运行 pneuma-base view 用界面做。`
}
