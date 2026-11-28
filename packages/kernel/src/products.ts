// Everything known about each agent product, one row per product: how its sessions are recognised and
// its conversations found, how to tell it is on this machine, where it loads skills from, and how an
// MCP server is registered with it. A fact not verified against the product's documentation or its own
// behaviour is left out, and the product simply lacks that way of connecting. ARCHITECTURE.md「连接一个 agent」.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import type { Reopen, Transcript } from '@pneuma-base/sdk'

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
  /** How one of its conversations is opened again, from the file its transcript rule points at. */
  readonly reopen?: Reopening
}

/**
 * How a product's conversation is opened again, each way verified on a machine with the product
 * installed; a way that could not be verified is left out. `id`: the session id a conversation file of
 * this product names, null for another product's file. `url`: a link the product's application
 * handles. `resume`: the command that continues it in a terminal; `anywhere`, it finds the
 * conversation from any directory, so it runs in the home folder when the session's own is gone.
 */
export type Reopening = {
  readonly id: (file: string) => string | null
  readonly url?: (id: string) => string
  readonly resume?: { readonly command: (id: string) => string; readonly anywhere: boolean }
}

/** One sentence the owner says to the agent once it is connected. */
export const FIRST_WORDS = '查看我的 Pneuma Base 资料库中有哪些内容。'

/** What Codex needs before it can write the library from its sandbox. */
export function codexHint(root: string): string {
  return `Codex 在沙箱中运行，此资料库须为其可写目录之一，例如：codex --add-dir ${root}`
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
      skill: `新技能在 Claude Code 的当前会话中即可使用（未出现时新开一个会话）。然后发出第一条指令：「${FIRST_WORDS}」`,
      mcp: `新开一个 Claude Code 会话：Claude Code 在会话开始时读取 MCP 服务。然后发出第一条指令：「${FIRST_WORDS}」`,
      'mcp-http': `新开一个 Claude Code 会话：Claude Code 在会话开始时读取 MCP 服务。然后发出第一条指令：「${FIRST_WORDS}」`,
    },
    guide: [
      'Claude Code 的 WebFetch 无法访问 127.0.0.1 上的地址：在 Bash 中使用 curl。',
      '资料库按 CLAUDE_CODE_SESSION_ID 识别会话，因此本次对话即一个场景；子代理带有主会话的会话 ID，计入同一场景。',
      '连接后技能即出现在当前会话中；未出现时新开一个会话。',
    ],
    // Resume: `claude --help` (2.1.332), "-r, --resume [value]  Resume a conversation by session ID";
    // code.claude.com/docs/en/sessions: "You can run claude --resume <session-id> from any directory",
    // looked for in the current project, then every other project on the machine. No link: Claude.app
    // (7.37095) handles claude://resume?session=<id>, but it imports the session into the app, a copy
    // and a take-over, not an opening.
    reopen: { id: (file) => (basename(dirname(dirname(file))) === 'projects' ? sessionIdIn(basename(file), /^(.+)\.jsonl$/) : null), resume: { command: (id) => `claude --resume ${id}`, anywhere: true } },
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
      skill: `Codex 会自动发现新安装的技能，未出现时重启 Codex。然后发出第一条指令：「${FIRST_WORDS}」`,
      mcp: `重启 Codex 并新开一个会话。然后发出第一条指令：「${FIRST_WORDS}」`,
      'mcp-http': `重启 Codex 并新开一个会话。然后发出第一条指令：「${FIRST_WORDS}」`,
    },
    notice: codexHint,
    guide: [
      'Codex 的沙箱可能拦截 curl 对 127.0.0.1 的访问（网络），也可能拦截命令行（需写入 $PNEUMA_BASE_HOME）。被拦截时，请用户批准在沙箱外运行该命令。',
    ],
    // Link: the Codex app (ChatGPT.app, com.openai.codex, 26.1111) registers the scheme codex in its
    // Info.plist; learn.chatgpt.com/docs/reference/commands: "codex://threads/<thread-id>  A local chat.
    // <thread-id> is its technical thread ID", which is CODEX_THREAD_ID, the id the file's name ends in.
    // Resume: `codex resume --help` (codex-cli 0.167.0), "[SESSION_ID]  Session id (UUID) or session
    // name"; its picker keeps to the current directory, and nothing says an id is found from another.
    reopen: { id: (file) => sessionIdIn(basename(file), /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i), url: (id) => `codex://threads/${id}`, resume: { command: (id) => `codex resume ${id}`, anywhere: false } },
  },
  {
    name: 'claude-desktop',
    title: 'Claude Desktop',
    session: null,
    markers: [],
    transcript: null,
    found: { folder: 'Library/Application Support/Claude' },
    mcp: { file: 'Library/Application Support/Claude/claude_desktop_config.json', format: 'json', key: 'mcpServers' },
    next: { mcp: `完全退出并重新打开 Claude Desktop：重启后才会读取新配置。然后发出第一条指令：「${FIRST_WORDS}」` },
    guide: ['Claude Desktop 无法运行命令，也无法连接 127.0.0.1：请所有者在 Pneuma Base 应用中连接 Claude Desktop（首页或 Agent 页的「连接」），然后完全退出并重新打开 Claude Desktop。'],
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
      skill: `Cursor 在启动时发现技能：完全退出并重新打开 Cursor。然后发出第一条指令：「${FIRST_WORDS}」`,
      mcp: `完全退出并重新打开 Cursor。然后发出第一条指令：「${FIRST_WORDS}」`,
      'mcp-http': `完全退出并重新打开 Cursor。然后发出第一条指令：「${FIRST_WORDS}」`,
    },
    guide: [
      'Cursor 在启动时发现技能：连接后完全退出并重新打开 Cursor。',
      'Cursor 的 MCP 配置支持 URL：所有者也可用 agent connect cursor --via mcp-http 通过本机地址连接。',
    ],
  },
  { name: 'antigravity', title: 'Antigravity', session: 'ANTIGRAVITY_CONVERSATION_ID', markers: ['ANTIGRAVITY_AGENT'], transcript: null },
]

export const productNamed = (name: string): AgentProduct | undefined => AGENT_PRODUCTS.find((p) => p.name === name)

/**
 * The agents the page draws as their product's own icon, each with the names and short forms an agent
 * or a grant goes by. The page matches a name whole, then by its first word (codex-work is Codex); any
 * other name is drawn as its letters. Products connected or paired go by their product name.
 */
export const AGENT_MARKS: readonly { readonly product: string; readonly title: string; readonly names: readonly string[] }[] = [
  { product: 'claude-code', title: 'Claude Code', names: ['claude-code', 'claude', 'cc'] },
  { product: 'claude-desktop', title: 'Claude Desktop', names: ['claude-desktop'] },
  { product: 'codex', title: 'Codex', names: ['codex'] },
  { product: 'cursor', title: 'Cursor', names: ['cursor'] },
  { product: 'gemini-cli', title: 'Gemini CLI', names: ['gemini-cli', 'gemini'] },
  { product: 'github-copilot', title: 'GitHub Copilot', names: ['github-copilot', 'copilot'] },
  { product: 'grok', title: 'Grok', names: ['grok'] },
  { product: 'kimi', title: 'Kimi', names: ['kimi'] },
  { product: 'qwen-code', title: 'Qwen Code', names: ['qwen-code', 'qwen'] },
  { product: 'deepseek', title: 'DeepSeek', names: ['deepseek'] },
  { product: 'opencode', title: 'OpenCode', names: ['opencode'] },
  { product: 'antigravity', title: 'Antigravity', names: ['antigravity'] },
  { product: 'windsurf', title: 'Windsurf', names: ['windsurf'] },
  { product: 'cline', title: 'Cline', names: ['cline'] },
]

/** The product an agent's name goes by, matched whole, then by its first word, as the page draws its mark; null for any other name. */
export function agentProduct(name: string): { product: string; title: string } | null {
  const lower = name.toLowerCase()
  const first = lower.split(/[^a-z0-9]+/)[0] ?? ''
  return AGENT_MARKS.find((m) => m.names.includes(lower)) ?? AGENT_MARKS.find((m) => m.names.includes(first)) ?? null
}

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
  if (program !== undefined && onPath(program, env)) signs.push(`PATH 中有 ${program}`)
  if (folder !== undefined && isDir(join(homeOf(env), folder))) signs.push(`存在 ~/${folder}`)
  return signs
}

/** Where the product was looked for, in words. */
export function lookedFor(p: AgentProduct): string {
  const { program, folder } = p.found ?? {}
  return [...(program === undefined ? [] : [`PATH 中的 ${program}`]), ...(folder === undefined ? [] : [`~/${folder}`])].join('、')
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

/** The session id a conversation file's name holds, when it is one a session can have. */
function sessionIdIn(name: string, pattern: RegExp): string | null {
  const id = pattern.exec(name)?.[1]
  return id !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) ? id : null
}

/**
 * How the Mac app opens a scene's conversation again on this machine, from the file its facts point
 * at and the directories the scene worked in: null when the file is not here. A product with a rule
 * for it gives its link and its resume command, run in the newest of those directories still here
 * (in the home folder when none is and the product finds it from anywhere, else not at all); any
 * conversation file still here can be shown in Finder.
 */
export function reopenOf(file: string, cwds: readonly string[], home: string): Reopen | null {
  const local = file.startsWith('~/') ? join(home, file.slice(2)) : file
  if (!isFile(local)) return null
  for (const product of AGENT_PRODUCTS) {
    const rule = product.reopen
    const id = rule?.id(local) ?? null
    if (rule === undefined || id === null) continue
    const cwd = [...cwds].reverse().find(isDir) ?? (rule.resume?.anywhere ? home : undefined)
    return { url: rule.url?.(id) ?? null, run: rule.resume !== undefined && cwd !== undefined ? { command: rule.resume.command(id), cwd } : null, reveal: local }
  }
  return { url: null, run: null, reveal: local }
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
