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
  if (viaGrant) return '调用带有授权'
  const name = [...SESSION_VARIABLES, ...RECOGNISED.flatMap((p) => p.markers)].find((n) => Boolean(env[n]))
  return name === undefined ? null : `环境中有 ${name}`
}

/**
 * What shows the call comes from an agent: a grant or an agent session variable (the second line of
 * defence, K7), or an actor named an agent with `--as`. Null when nothing does.
 */
export function agentSign(env: Env, viaGrant: boolean, actor: Actor): string | null {
  return agentSessionSign(env, viaGrant) ?? (actor.kind === 'agent' ? `调用者为 Agent ${actor.name}` : null)
}

/**
 * The refusal, in an agent's session, of what only the owner does: an owner command, or a page of
 * management, in the same words. `why`: what makes it the owner's beyond being the owner's to decide,
 * such as losing data; `ask`: the line that asks the owner for it, when it may be asked for.
 */
export function ownerOnlyRefusal(name: string, why: string | null, sign: string, ask: string | null = null): string {
  const head = `「${name}」${why === null ? '' : `${why}，`}仅所有者可执行，不能在 Agent 会话中执行（${sign}）。`
  if (ask !== null) return `${head}可提交请求，写明原因，由所有者批准：\n${ask}`
  return `${head}请所有者在自己的终端中执行，或运行 pneuma-base view 在管理界面中操作。`
}
