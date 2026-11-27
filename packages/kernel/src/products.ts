// Everything known about each agent product, one row per product: how its sessions are recognised and
// its conversations found, how to tell it is on this machine, where it loads skills from, and how an
// MCP server is registered with it. A fact not verified against the product's documentation or its own
// behaviour is left out, and the product simply lacks that way of connecting. ARCHITECTURE.md「接上一个 agent」.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Transcript } from '@pneuma-base/sdk'

export type Env = Readonly<Record<string, string | undefined>>

/** What a product's rule looks for its conversation by: the home folder, the environment, the directory of the call. */
type Look = { home: string; env: Env; cwd: string }

/**
 * How an agent product is connected: a skill in the folder it loads skills from, an MCP server it
 * starts by a command, or an MCP server it reaches by the local endpoint's address.
 */
export type Way = 'skill' | 'mcp' | 'mcp-http'

/** Where an MCP server is registered: a file under HOME, its format, and the key or table its servers sit under. `type`: what the entry's `"type"` says, when it says one. */
export type McpConfig = { readonly file: string; readonly format: 'json' | 'toml'; readonly key: string; readonly type?: 'stdio' | 'http' }

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
  /** Where an MCP server started by a command is registered. */
  readonly mcp?: McpConfig
  /** Where an MCP server given by its address is registered. */
  readonly mcpUrl?: McpConfig
  /** What the owner does next in the product, by the way it was connected. */
  readonly next?: Readonly<Partial<Record<Way, string>>>
  /** What else the product needs told: Codex's sandbox must be able to write the library. */
  readonly notice?: (root: string) => string
  /** What an agent of this product should know when it connects itself, for its guide (guide.ts). */
  readonly guide?: readonly string[]
}

/** One sentence the owner says to the agent once it is connected. */
export const FIRST_WORDS = '看看我的 Pneuma Base 库里有什么。'

/** What Codex needs before it can write the library from its sandbox. */
export function codexHint(root: string): string {
  return `Codex 在沙箱里运行，这个库要是它能写的目录之一，比如：codex --add-dir ${root}`
}

/**
 * The agent products, in the order a session is recognised. Where an MCP server given by its address
 * goes, as each product wrote it itself in a temporary HOME: `claude mcp add --scope user --transport
 * http <name> <url>` writes `{"type": "http", "url"}` under `mcpServers` in `~/.claude.json`; `codex mcp
 * add <name> --url <url>` writes a table with one line `url = "<url>"`, which `codex mcp get` reads as
 * streamable HTTP; Cursor's MCP documentation gives `{"url"}` under `mcpServers` in `~/.cursor/mcp.json`.
 * Claude Desktop's configuration file takes no address.
 */
export const AGENT_PRODUCTS: readonly AgentProduct[] = [
  {
    name: 'claude-code',
    title: 'Claude Code',
    session: 'CLAUDE_CODE_SESSION_ID',
    markers: ['CLAUDECODE'],
    transcript: claudeCodeTranscript,
    found: { program: 'claude', folder: '.claude' },
    skills: '.claude/skills',
    mcp: { file: '.claude.json', format: 'json', key: 'mcpServers', type: 'stdio' },
    mcpUrl: { file: '.claude.json', format: 'json', key: 'mcpServers', type: 'http' },
    next: {
      skill: `Claude Code 在当前会话里就看得到新技能（看不到就新开一个会话）。对它说一句：「${FIRST_WORDS}」`,
      mcp: `开一个新的 Claude Code 会话：它在会话开始时读 MCP 服务。然后对它说一句：「${FIRST_WORDS}」`,
      'mcp-http': `开一个新的 Claude Code 会话：它在会话开始时读 MCP 服务。然后对它说一句：「${FIRST_WORDS}」`,
    },
    guide: [
      'Claude Code 的 WebFetch 取不了 127.0.0.1 上的地址：在 Bash 里用 curl。',
      '库按 CLAUDE_CODE_SESSION_ID 认出会话，所以这次对话就是一个场景；子代理带着主会话的会话号，算在同一个场景里。',
      '接上之后技能在当前会话里就出现；没出现就开一个新会话。',
    ],
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
    mcpUrl: { file: '.codex/config.toml', format: 'toml', key: 'mcp_servers' },
    next: {
      skill: `Codex 自己会发现新装的技能，没出现就重启它。然后对它说一句：「${FIRST_WORDS}」`,
      mcp: `重启 Codex，开一个新会话。然后对它说一句：「${FIRST_WORDS}」`,
      'mcp-http': `重启 Codex，开一个新会话。然后对它说一句：「${FIRST_WORDS}」`,
    },
    notice: codexHint,
    guide: [
      'Codex 的沙箱可能拦下 curl 访问 127.0.0.1（网络），也可能拦下命令行的那种（它要写 $PNEUMA_BASE_HOME）。被拦了，就请你的用户批准在沙箱外运行那一条命令。',
    ],
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
    guide: ['Claude Desktop 不能运行命令，也连不上 127.0.0.1：请主人在 Pneuma Base 应用里把它接上（首页或 Agent 页的「接上」），然后完全退出 Claude Desktop 再打开。'],
  },
  {
    name: 'cursor',
    title: 'Cursor',
    session: null,
    markers: [],
    transcript: null,
    found: { folder: '.cursor' },
    skills: '.cursor/skills',
    mcp: { file: '.cursor/mcp.json', format: 'json', key: 'mcpServers', type: 'stdio' },
    mcpUrl: { file: '.cursor/mcp.json', format: 'json', key: 'mcpServers' },
    next: {
      skill: `Cursor 在启动时发现技能：完全退出 Cursor 再打开。然后对它说一句：「${FIRST_WORDS}」`,
      mcp: `完全退出 Cursor 再打开。然后对它说一句：「${FIRST_WORDS}」`,
      'mcp-http': `完全退出 Cursor 再打开。然后对它说一句：「${FIRST_WORDS}」`,
    },
    guide: [
      'Cursor 在启动时发现技能：接上之后完全退出 Cursor 再打开。',
      '它的 MCP 配置认地址：主人也可以用 agent connect cursor --via mcp-http 让它经本机的地址接上。',
    ],
  },
  { name: 'antigravity', title: 'Antigravity', session: 'ANTIGRAVITY_CONVERSATION_ID', markers: ['ANTIGRAVITY_AGENT'], transcript: null },
]

export const productNamed = (name: string): AgentProduct | undefined => AGENT_PRODUCTS.find((p) => p.name === name)

/** The ways a product can be connected, the one used when none is asked for first: a skill, then an MCP server by command, then by address. */
export const waysOf = (p: AgentProduct): Way[] => [
  ...(p.skills === undefined ? [] : ['skill' as const]),
  ...(p.mcp === undefined ? [] : ['mcp' as const]),
  ...(p.mcpUrl === undefined ? [] : ['mcp-http' as const]),
]

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
