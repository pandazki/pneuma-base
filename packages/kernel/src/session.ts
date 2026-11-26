import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Actor, Grant, Session, Transcript } from '@pneuma-base/sdk'

export type Env = Readonly<Record<string, string | undefined>>

/** What a product's rule looks for its conversation by: the home folder, the environment, the directory of the call. */
type Look = { home: string; env: Env; cwd: string }

/**
 * The agent products recognised from the environment, in the order they are tried: the variable
 * that carries the product's session id, variables that only show it is running, and how to find
 * the session's conversation, null for a product whose layout was never seen.
 */
const AGENT_PRODUCTS = [
  { name: 'claude-code', session: 'CLAUDE_CODE_SESSION_ID', markers: ['CLAUDECODE'], transcript: claudeCodeTranscript },
  { name: 'codex', session: 'CODEX_THREAD_ID', markers: [], transcript: codexTranscript },
  { name: 'antigravity', session: 'ANTIGRAVITY_CONVERSATION_ID', markers: ['ANTIGRAVITY_AGENT'], transcript: null },
] as const

/** A session id that can name a file and nothing else: no separator, no dots. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/

/** Environment variables that carry a session id, in the order they are tried. */
const SESSION_VARIABLES = ['PNEUMA_BASE_SESSION', ...AGENT_PRODUCTS.map((p) => p.session)]

const signsOf = (product: (typeof AGENT_PRODUCTS)[number]): readonly string[] => [product.session, ...product.markers]

/**
 * Session identity: the flag, then the environment, otherwise one minted for this invocation. An id
 * from an agent product's variable also points to the product's conversation file, when it is there.
 */
export function identifySession(input: { flag: string | null; env: Env; cwd: string; machine: string }): Session {
  const base = { cwd: input.cwd, machine: input.machine, transcript: null }
  if (input.flag) return { id: input.flag, source: 'flag', ...base }
  const given = input.env.PNEUMA_BASE_SESSION
  if (given) return { id: given, source: 'env', ...base }
  for (const product of AGENT_PRODUCTS) {
    const id = input.env[product.session]
    if (!id) continue
    const look = { home: resolve(input.env.HOME || homedir()), env: input.env, cwd: input.cwd }
    return { id, source: 'env', ...base, transcript: product.transcript && PLAIN_ID.test(id) ? product.transcript(id, look) : null }
  }
  return { id: randomUUID(), source: 'minted', ...base }
}

/**
 * Claude Code keeps a conversation at `projects/<folder>/<session id>.jsonl` in its config folder,
 * the folder being the directory the session started in with each character but a letter or digit
 * made `-`. A call may run below that directory, so the directories above it are tried too. A folder
 * name over 200 characters ends in a hash the kernel does not know: no pointer then.
 */
function claudeCodeTranscript(id: string, look: Look): Transcript | null {
  const projects = join(look.env.CLAUDE_CONFIG_DIR ?? join(look.home, '.claude'), 'projects')
  for (let dir = look.cwd; ; dir = dirname(dir)) {
    const folder = dir.replace(/[^a-zA-Z0-9]/g, '-')
    const file = join(projects, folder, `${id}.jsonl`)
    if (folder.length <= 200 && isFile(file)) return { path: tilde(file, look.home), resume: `cd ${shellPath(dir, look.home)} && claude --resume ${id}` }
    if (dirname(dir) === dir) return null
  }
}

/**
 * Codex keeps a conversation at `sessions/<year>/<month>/<day>/rollout-<time>-<thread id>.jsonl` in
 * its home, dated by when it started: the days are searched newest first.
 */
function codexTranscript(id: string, look: Look): Transcript | null {
  const sessions = join(look.env.CODEX_HOME ?? join(look.home, '.codex'), 'sessions')
  for (const year of datedFolders(sessions)) {
    for (const month of datedFolders(join(sessions, year))) {
      for (const day of datedFolders(join(sessions, year, month))) {
        const name = names(join(sessions, year, month, day)).find((n) => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`))
        if (name) return { path: tilde(join(sessions, year, month, day, name), look.home), resume: `codex resume ${id}` }
      }
    }
  }
  return null
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const datedFolders = (dir: string): string[] => names(dir).filter((n) => /^\d+$/.test(n)).sort().reverse()

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const tilde = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** A directory as the shell takes it: the home folder as `~`, a part with a space or a quote quoted. */
function shellPath(dir: string, home: string): string {
  const quote = (part: string) => (/^[A-Za-z0-9_.@%+=:,-]*$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)
  const short = dir === home ? '~' : tilde(dir, home)
  return short.split('/').map((part, i) => (i === 0 && part === '~' ? part : quote(part))).join('/')
}

/** Who acts: the grant's agent, the name given with `--as`, the agent product the environment shows, else the owner. */
export function identifyActor(input: { grant: Grant | null; as: string | null; env: Env }): Actor {
  if (input.grant) return { kind: 'agent', name: input.grant.agent, grant: input.grant.id }
  if (input.as) return { kind: 'agent', name: input.as, grant: null }
  const product = AGENT_PRODUCTS.find((p) => signsOf(p).some((n) => Boolean(input.env[n])))
  return product ? { kind: 'agent', name: product.name, grant: null } : { kind: 'owner' }
}

/** The second line of defence for destructive owner commands (K7). */
export function looksLikeAgentSession(env: Env, viaGrant: boolean): boolean {
  return agentSessionSign(env, viaGrant) !== null
}

/** What shows the call comes from an agent session, in words for the refusal; null when nothing does. */
export function agentSessionSign(env: Env, viaGrant: boolean): string | null {
  if (viaGrant) return '调用带着授权'
  const name = [...SESSION_VARIABLES, ...AGENT_PRODUCTS.flatMap((p) => p.markers)].find((n) => Boolean(env[n]))
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

/** The refusal, in an agent's session, of what only the owner does: an owner command, or a page of management, in the same words. */
export function ownerOnlyRefusal(name: string, why: string, sign: string): string {
  return `「${name}」${why}，只有主人能做，不能在 agent 的会话里做（${sign}）。需要的话告诉主人；主人在自己的终端里做，或在自己的终端里运行 pneuma-base view 用界面做。`
}
