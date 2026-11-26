// Everything known about each agent product, one row per product: how its sessions are recognised and
// its conversations found, how to tell it is on this machine, where it loads skills from, and how an
// MCP server is registered with it. A fact not verified against the product's documentation or its own
// behaviour is left out, and the product simply lacks that way of connecting. ARCHITECTURE.md section 6.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Transcript } from '@pneuma-base/sdk'

export type Env = Readonly<Record<string, string | undefined>>

/** What a product's rule looks for its conversation by: the home folder, the environment, the directory of the call. */
type Look = { home: string; env: Env; cwd: string }

/** How an agent product is connected: a skill in the folder it loads skills from, or an MCP server in its configuration. */
export type Way = 'skill' | 'mcp'

/** Where an MCP server is registered: a file under HOME, its format, and the key or table its servers sit under. `stdio`: the entry says `"type": "stdio"`. */
export type McpConfig = { readonly file: string; readonly format: 'json' | 'toml'; readonly key: string; readonly stdio?: true }

export type AgentProduct = {
  readonly name: string
  readonly title: string
  /** The variable that carries the product's session id, null when none is known, and variables that only show it is running. */
  readonly session: string | null
  readonly markers: readonly string[]
  /** How to find a session's conversation; null for a product whose layout was never seen. */
  readonly transcript: ((id: string, look: Look) => Transcript | null) | null
  /** How to tell it is on this machine: a program on PATH, a folder under HOME. */
  readonly found?: { readonly program?: string; readonly folder?: string }
  /** The folder under HOME it loads skills from. */
  readonly skills?: string
  readonly mcp?: McpConfig
  /** What the owner does next in the product, by the way it was connected. */
  readonly next?: Readonly<Partial<Record<Way, string>>>
  /** What else the product needs told: Codex's sandbox must be able to write the library. */
  readonly notice?: (root: string) => string
}

/** One sentence the owner says to the agent once it is connected. */
const FIRST_WORDS = '看看我的 Pneuma Base 库里有什么。'

/** What Codex needs before it can write the library from its sandbox. */
export function codexHint(root: string): string {
  return `Codex 在沙箱里运行，这个库要是它能写的目录之一，比如：codex --add-dir ${root}`
}

/** The agent products, in the order a session is recognised. */
export const AGENT_PRODUCTS: readonly AgentProduct[] = [
  {
    name: 'claude-code',
    title: 'Claude Code',
    session: 'CLAUDE_CODE_SESSION_ID',
    markers: ['CLAUDECODE'],
    transcript: claudeCodeTranscript,
    found: { program: 'claude', folder: '.claude' },
    skills: '.claude/skills',
    mcp: { file: '.claude.json', format: 'json', key: 'mcpServers', stdio: true },
    next: {
      skill: `Claude Code 在当前会话里就看得到新技能（看不到就新开一个会话）。对它说一句：「${FIRST_WORDS}」`,
      mcp: `开一个新的 Claude Code 会话：它在会话开始时读 MCP 服务。然后对它说一句：「${FIRST_WORDS}」`,
    },
  },
  {
    name: 'codex',
    title: 'Codex',
    session: 'CODEX_THREAD_ID',
    markers: [],
    transcript: codexTranscript,
    found: { program: 'codex', folder: '.codex' },
    skills: '.agents/skills',
    mcp: { file: '.codex/config.toml', format: 'toml', key: 'mcp_servers' },
    next: {
      skill: `Codex 自己会发现新装的技能，没出现就重启它。然后对它说一句：「${FIRST_WORDS}」`,
      mcp: `重启 Codex，开一个新会话。然后对它说一句：「${FIRST_WORDS}」`,
    },
    notice: codexHint,
  },
  {
    name: 'claude-desktop',
    title: 'Claude Desktop',
    session: null,
    markers: [],
    transcript: null,
    found: { folder: 'Library/Application Support/Claude' },
    mcp: { file: 'Library/Application Support/Claude/claude_desktop_config.json', format: 'json', key: 'mcpServers' },
    next: { mcp: `完全退出 Claude Desktop 再打开：它要重启才读新的配置。然后对它说一句：「${FIRST_WORDS}」` },
  },
  {
    name: 'cursor',
    title: 'Cursor',
    session: null,
    markers: [],
    transcript: null,
    found: { folder: '.cursor' },
    skills: '.cursor/skills',
    mcp: { file: '.cursor/mcp.json', format: 'json', key: 'mcpServers', stdio: true },
    next: {
      skill: `Cursor 在启动时发现技能：完全退出 Cursor 再打开。然后对它说一句：「${FIRST_WORDS}」`,
      mcp: `完全退出 Cursor 再打开。然后对它说一句：「${FIRST_WORDS}」`,
    },
  },
  { name: 'antigravity', title: 'Antigravity', session: 'ANTIGRAVITY_CONVERSATION_ID', markers: ['ANTIGRAVITY_AGENT'], transcript: null },
]

export const productNamed = (name: string): AgentProduct | undefined => AGENT_PRODUCTS.find((p) => p.name === name)

/** The ways a product can be connected, the one used when none is asked for first: a skill before an MCP server. */
export const waysOf = (p: AgentProduct): Way[] => [...(p.skills === undefined ? [] : ['skill' as const]), ...(p.mcp === undefined ? [] : ['mcp' as const])]

/** The products that can be connected: they can be found on a machine and have a way. */
export const CONNECTABLE: readonly AgentProduct[] = AGENT_PRODUCTS.filter((p) => p.found !== undefined && waysOf(p).length > 0)

export const homeOf = (env: Env): string => resolve(env.HOME || homedir())

/** What shows the product is on this machine, in words: the program on PATH, the folder under HOME. Empty when nothing does. */
export function signsOf(p: AgentProduct, env: Env): string[] {
  const signs: string[] = []
  const { program, folder } = p.found ?? {}
  if (program !== undefined && onPath(program, env)) signs.push(`PATH 上有 ${program}`)
  if (folder !== undefined && isDir(join(homeOf(env), folder))) signs.push(`有 ~/${folder}`)
  return signs
}

/** Where the product was looked for, in words. */
export function lookedFor(p: AgentProduct): string {
  const { program, folder } = p.found ?? {}
  return [...(program === undefined ? [] : [`PATH 上的 ${program}`]), ...(folder === undefined ? [] : [`~/${folder}`])].join('、')
}

function onPath(program: string, env: Env): boolean {
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false
    try {
      const s = statSync(join(dir, program))
      return s.isFile() && (s.mode & 0o111) !== 0
    } catch {
      return false
    }
  })
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A path under the home folder written as `~/…`. */
export const tilde = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

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

/** A directory as the shell takes it: the home folder as `~`, a part with a space or a quote quoted. */
function shellPath(dir: string, home: string): string {
  const quote = (part: string) => (/^[A-Za-z0-9_.@%+=:,-]*$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)
  const short = dir === home ? '~' : tilde(dir, home)
  return short.split('/').map((part, i) => (i === 0 && part === '~' ? part : quote(part))).join('/')
}
