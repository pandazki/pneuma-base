import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  endpointOf,
  ensureLauncher,
  GRANT_NAME,
  guideText,
  guideUrl,
  identifyActor,
  identifySession,
  initLibrary,
  instant,
  loadPlugins,
  makeContext,
  openLibrary,
  ownerFace,
  pairingAnswer,
  PNEUMA_BASE_VERSION,
  requestPairing,
  resolveGrant,
  sentenceFor,
  typedAddress,
  useMachineHome,
  type Env,
  type Grant,
  type Instant,
  type Library,
  type MachineContext,
  type OwnerCall,
  type OwnerCommandInfo,
  type OwnerResult,
  type Pass,
  type PluginTable,
} from '@pneuma-base/kernel'
import { UsageError, argsOf, flagList, flagValue, hasFlag, leadingWords, matchCommand, ownFlags, parseCommand, splitLine, type FlagKind, type Line, type Parsed } from './args.js'
import { ownerText } from './format.js'
import { serve } from './mcp/server.js'
import { libraryFace } from './mcp/tools.js'
import { KINDS, scaffold, type Kind } from './scaffold.js'
import { answer, refusal, VERBS, type Answer, type Bound, type Verb, type VerbInput } from './verbs.js'
import { view } from './view.js'

export type Io = {
  env: Env
  cwd: string
  out(text: string): void
  err(text: string): void
  readStdin(): Promise<Uint8Array>
  /** Standard input line by line, as it arrives, until it ends: a long-running command's channel, such as mcp's. */
  readLines(): AsyncIterable<string>
  /** A value given besides the arguments: standard input, less one final newline; in a terminal, typed without echo. Null when none was given. */
  readSecret(question: string): Promise<string | null>
  confirm(question: string): Promise<boolean>
  /** Resolves when the person stops a long-running command, such as view, with Ctrl+C. */
  untilStopped(): Promise<void>
  openBrowser(url: string): void
  /** The channel of a named whole pass the command may run: its reports on standard error; the first Ctrl+C stops it after the step under way. */
  pass?(): Pass
}

/** Each report on its own line of standard error, the first with how to stop; Ctrl+C is heard only once a pass has reported. */
function terminalPass(): Pass {
  let stop = false
  let heard = false
  return {
    report(p) {
      const first = !heard
      if (first) {
        heard = true
        process.once('SIGINT', () => {
          stop = true
        })
      }
      process.stderr.write(`${p.text}${first ? '（按 Ctrl-C 停止）' : ''}\n`)
    },
    stopped: () => stop,
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** What the person types in the terminal after `question`, shown as nothing; null when they stop with Ctrl+C or Ctrl+D. */
function hiddenAnswer(question: string): Promise<string | null> {
  const stdin = process.stdin
  return new Promise((resolve) => {
    let typed: string[] = []
    const finish = (answer: string | null) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      resolve(answer)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(typed.join(''))
        if (ch === '\u0003' || ch === '\u0004') return finish(null)
        typed = ch === '\u007f' || ch === '\b' ? typed.slice(0, -1) : [...typed, ch]
      }
    }
    process.stderr.write(question)
    stdin.setEncoding('utf8')
    stdin.setRawMode(true)
    stdin.on('data', onData)
    stdin.resume()
  })
}

export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    readStdin,
    // Iterated from the start: readline's iterator, made later, would miss the lines and the end that came before.
    readLines: () => {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => lines }
    },
    readSecret: async (question) => (process.stdin.isTTY ? hiddenAnswer(question) : Buffer.from(await readStdin()).toString('utf8').replace(/\r?\n$/, '')),
    // Input that ends before an answer (Ctrl+D) is no confirmation, as any answer but yes is.
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl.question(`${question} 输入 yes 确认：`).catch(() => {
        process.stderr.write('\n')
        return null
      })
      rl.close()
      return answer?.trim() === 'yes'
    },
    untilStopped: () =>
      new Promise((resolve) => {
        process.once('SIGINT', () => resolve())
        process.once('SIGTERM', () => resolve())
      }),
    openBrowser: (url) => {
      const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
      spawn(command as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
    },
    pass: terminalPass,
  }
}

const USAGE = `用法：
  pneuma-base @<授权名称> <命令> …
  pneuma-base --library <资料库目录> [--as <Agent 名称>] <命令> …
基本命令：start "<任务描述>" | find <关键词> [--include-archived] [--scene <场景编号>] [--origin imported|generated] | inspect <库内路径|条目编号|场景编号>
      put <文件|目录|-|库内路径> [--to <库内路径>] (--imported [--source <原始来源>] [--by owner] | --generated [--from <库内路径…>] [--from-external <说明…>]) [--note "<说明>"]
      say <类型> [<对象>] [<内容>] | check [--since <时间>|last] [--include-archived]
      archive <库内路径> | unarchive <库内路径>
查看管理界面的页面：show [<页面 ID> [--<参数> <值>…]]（不写页面 ID 时列出此资料库的页面；条目面板为 show item --path <库内路径>）
供仅支持 MCP 的 Agent 应用使用：pneuma-base @<授权名称> mcp（在标准输入输出上运行 MCP 服务，基本命令和可用的所有者命令均为工具）
Agent 自行连接：guide [<产品>] [--library <资料库目录>] [--url]（供 Agent 读取的连接指南，与本机地址 /guide 的内容相同；--url 输出该地址）
      pair request <产品> "<原因>" [--library <资料库目录>]（请求所有者批准接入，答复中含配对码）| pair status <配对编号>
所有者：view [<目录>] [--port <端口>] [--no-open]（在浏览器中打开管理界面；pneuma-base <目录> 与之等同）
      init <地址> [--bare] [--provider <存储提供者>]（地址为文件夹，或其他存储提供者支持的地址写法）
插件作者：plugin new <目录> [--kind blank|deploy] [--name <插件名称>] [--packages <包文件目录>]（生成插件项目）
加 --json 输出结果对象。`

/** `plugin new --help`: the scaffold's own usage. */
const PLUGIN_NEW_USAGE = `用法：pneuma-base plugin new <目录> [--kind blank|deploy] [--name <插件名称>] [--packages <包文件目录>]
在空目录或不存在的目录中生成插件项目，无需修改即可构建、通过自带的测试并安装到本机。不涉及任何资料库。
  --kind      blank（默认）：一种记录类型、一条带参数表的所有者命令、一个视图和一个自绘块；deploy：开发包中的部署库加一个发布到本地目录的目标
  --name      插件名称：以小写字母开头，仅含小写字母、数字和连字符；默认为目录名
  --packages  pneuma-base 和 @pneuma-base/sdk 两个包文件（pneuma-base-${PNEUMA_BASE_VERSION}.tgz、pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz）所在的目录。项目按绝对路径依赖这两个包，移动项目后仍可安装；包文件需保留在原位置。不指定时按包名依赖，而这两个包未发布到 npm，npm install 将失败
生成后：cd <目录>，npm install，npm test，npm run install-local；README.md 说明每个文件的用途。`

/**
 * The owner commands of the library at hand, from the owner face, or the kernel's when there is
 * none: each with its arguments, what it does, and how it is gated.
 */
function ownerHelp(commands: OwnerCommandInfo[], library: Library | null): string {
  const lines = commands.map((c) => {
    const gate = c.destructive ? '；将丢失数据，仅所有者可执行，需当面确认' : c.ownerOnly ? '；仅所有者可执行' : ''
    const machine = c.machine ? '；无需指定资料库' : ''
    return `  ${[c.name, ...(c.usage === null ? [] : [c.usage])].join(' ')}\n      ${c.summary}${gate}${machine}${c.by === 'kernel' ? '' : `（${c.by}）`}`
  })
  const head = `所有者命令${library === null ? '' : `（${library.root} 可用）`}，除 skill install 和无需指定资料库的命令外均需加 --library <资料库目录>：`
  const more = library === null ? ['资料库中启用的插件各自提供命令，pneuma-base --help --library <资料库目录> 列出该资料库的全部可用命令。'] : []
  return [head, ...lines, ...more].join('\n')
}

/** Help, with the owner commands of the library `--library` or `@<grant>` names, if any. */
async function help(argv: readonly string[], io: Io, table: PluginTable, home: string): Promise<string> {
  const line = splitLine(argv.filter((a) => a !== '--help' && a !== 'help'))
  if (line.rest[0] === 'plugin' && line.rest[1] === 'new') return PLUGIN_NEW_USAGE
  const dir = flagValue({ flags: line.global }, 'library')
  const library =
    line.grant !== null
      ? await resolveGrant(home, line.grant, table).then((r) => (r.ok ? r.library : null))
      : dir === null ? null : await openLibrary(typedAddress(dir, io.cwd), table)
  return `${USAGE}\n${ownerHelp(ownerFace.commands(library?.plugins ?? []), library)}`
}

/** `table`: every plugin this machine has; `builtins`: the command line's own, which the UI's server joins with the machine's on each request. */
type Invocation = { parsed: Parsed; args: string[]; io: Io; table: PluginTable; builtins: PluginTable; home: string }

/**
 * `flags`: how each of its own flags takes values; `any` for say, whose flags are the plugins'; `params` for show, whose flags are a page's parameters, each with one value.
 * `rawAfter`: after this many positionals, the rest of the line is taken as written, as ask takes the command it asks for.
 */
type Spec = { words: string[]; flags: Readonly<Record<string, FlagKind>> | 'any' | 'params'; arity: [min: number, max: number]; rawAfter?: number } & (
  | { library: true; run: (inv: Invocation, bound: Bound) => Promise<Answer> }
  | { library: false; run: (inv: Invocation) => Promise<Answer> }
)

const owner = (r: OwnerResult): Answer => answer(r, ownerText(r))

function ownerCall(inv: Invocation, bound: Bound): OwnerCall {
  return { ctx: bound.ctx, table: inv.table, env: inv.io.env, viaGrant: bound.viaGrant, confirm: (q) => inv.io.confirm(q), readSecret: (q) => inv.io.readSecret(q) }
}

/**
 * A verb's values from its words, by the verb's table: positionals in order (the optional ones from
 * the last under `fromEnd`), a `words` one as the rest joined with spaces, each declared flag by its
 * kind, and the flags it does not declare under `more`.
 */
function verbValues({ params }: Verb, parsed: Parsed): VerbInput {
  const args = parsed.positional
  const positional = params.positional ?? []
  const firstOptional = positional.findIndex((p) => !p.required)
  const skipped = params.fromEnd ? Math.max(0, positional.length - args.length) : 0
  const values: Record<string, VerbInput[string]> = {}
  let next = 0
  for (const [i, p] of positional.entries()) {
    if (i >= firstOptional && i < firstOptional + skipped) values[p.name] = null
    else if (p.words || p.many) {
      const rest = args.slice(next)
      next = args.length
      values[p.name] = p.many ? rest : rest.length === 0 ? null : rest.join(' ')
    } else values[p.name] = args[next++] ?? null
  }
  const declared = params.flags ?? []
  for (const f of declared) values[f.name] = f.kind === 'boolean' ? hasFlag(parsed, f.name) : f.kind === 'list' ? flagList(parsed, f.name) : flagValue(parsed, f.name)
  const { more } = params
  if (more) {
    const undeclared = ownFlags(parsed).filter(([name]) => !declared.some((f) => f.name === name))
    values[more.name] = Object.fromEntries(undeclared.map(([name, v]) => [name, more.each === 'list' ? (v === true ? [] : v) : v === true ? '' : (v[0] as string)]))
  }
  return values
}

/** A verb of the table as the command line's own command: its flags and how many words it takes, read from its `params`. */
function specOf(verb: Verb): Spec {
  const { positional = [], flags = [], more, raw } = verb.params
  const takesRest = positional.some((p) => p.words || p.many)
  return {
    words: [verb.name],
    flags: more ? (more.each === 'list' ? 'any' : 'params') : Object.fromEntries(flags.map((f) => [f.name, f.kind])),
    arity: [positional.filter((p) => p.required).length, takesRest ? Infinity : positional.length],
    ...(raw === undefined ? {} : { rawAfter: positional.findIndex((p) => p.name === raw) }),
    library: true,
    run: (inv, bound) => verb.run(verbValues(verb, inv.parsed), { bound, table: inv.table, env: inv.io.env, cwd: inv.io.cwd, stdin: () => inv.io.readStdin() }),
  }
}

const NO_ENDPOINT = '当前没有可用的 Pneuma Base 本机地址：Pneuma Base 应用运行时提供该地址，也可运行 pneuma-base view <资料库目录>。'

/** The library of a command for an agent not connected yet: `--library`, else the one the running endpoint serves. */
async function servedLibrary({ parsed, io, table, home }: Invocation): Promise<Library | Answer> {
  const dir = flagValue(parsed, 'library')
  const root = dir === null ? ((await endpointOf(home, null))?.library ?? null) : typedAddress(dir, io.cwd)
  if (root === null) throw new UsageError('当前没有可用的 Pneuma Base 本机地址，需用 --library <资料库目录> 指定资料库。')
  return (await openLibrary(root, table)) ?? refusal('not-a-library', `${dir ?? root} 不是资料库。`)
}

const productArg = (name: string): string => {
  if (!GRANT_NAME.test(name)) throw new UsageError(`产品名称无效：${name}（需以小写字母或数字开头，仅含小写字母、数字和连字符）`)
  return name
}

const SPECS: Spec[] = [
  ...VERBS.map(specOf),
  {
    words: ['guide'],
    flags: { url: 'boolean' },
    arity: [0, 1],
    library: false,
    run: async (inv) => {
      const { args, parsed, io, table, home } = inv
      const product = args[0] === undefined ? null : productArg(args[0])
      if (hasFlag(parsed, 'url')) {
        const dir = flagValue(parsed, 'library')
        const library = dir === null ? null : await openLibrary(typedAddress(dir, io.cwd), table)
        if (dir !== null && library === null) return refusal('not-a-library', `${dir} 不是资料库。`)
        const endpoint = await endpointOf(home, library?.root ?? null)
        if (endpoint === null) return refusal('no-endpoint', NO_ENDPOINT)
        const json = { url: guideUrl(endpoint.url), port: endpoint.port, library: endpoint.library, sentence: sentenceFor(endpoint.url) }
        return { json, lines: [json.url], exit: 0 }
      }
      const library = await servedLibrary(inv)
      if ('exit' in library) return library
      // The guide names this machine's command; it runs only once it is there.
      await ensureLauncher(home, io.env)
      const url = (await endpointOf(home, library.root))?.url ?? null
      const text = guideText({ root: library.root, home, env: io.env, url }, product)
      return { json: { library: library.root, product, url, text }, lines: [text.trimEnd()], exit: 0 }
    },
  },
  {
    words: ['pair', 'request'],
    flags: {},
    arity: [2, Infinity],
    library: false,
    run: async (inv) => {
      const [product, ...why] = inv.args as [string, ...string[]]
      const library = await servedLibrary(inv)
      if ('exit' in library) return library
      const r = await requestPairing({ home: inv.home, library: library.root, product, why: why.join(' '), via: 'command-line', now: instant(Date.now()) })
      if (r.outcome === 'refused' && r.reason === 'usage') throw new UsageError(r.text)
      return { json: r, lines: [r.outcome === 'refused' ? `拒绝（${r.reason}）：${r.text}` : r.text], exit: r.outcome === 'refused' ? 2 : 0 }
    },
  },
  {
    words: ['pair', 'status'],
    flags: {},
    arity: [1, 1],
    library: false,
    run: async ({ args, home }) => {
      const id = args[0] as string
      const a = await pairingAnswer(home, id, instant(Date.now()))
      return a === null ? refusal('no-such-pairing', `配对 ${id} 不存在。`) : { json: a, lines: [a.text], exit: 0 }
    },
  },
  {
    words: ['mcp'],
    flags: {},
    arity: [0, 0],
    library: false,
    run: async ({ parsed, io, table, builtins, home }) => {
      const grant = parsed.grant
      if (grant === null) throw new UsageError('mcp 需指定 @<授权名称>：授权决定资料库和身份。')
      if (['library', 'as'].some((f) => hasFlag(parsed, f))) throw new UsageError('mcp 仅接受 @<授权名称>：资料库和身份由授权决定，不使用 --library 或 --as。')
      // Standard output carries the protocol alone: a refusal before it starts, and whatever a plugin logs, go to standard error.
      const resolved = await resolveGrant(home, grant, table)
      if (!resolved.ok) {
        io.err(`拒绝（${resolved.reason}）：${resolved.text}`)
        return { json: undefined, lines: [], exit: 2 }
      }
      for (const method of ['log', 'info', 'debug'] as const) console[method] = console.error
      // One connection is one session, so one scene: the client's own name for it when it gives one, else a new one.
      // Unnamed, it would join the agent's ad hoc scene of the day.
      const session = identifySession({ flag: flagValue(parsed, 'session') ?? `mcp-${randomUUID()}`, env: {}, cwd: io.cwd, machine: hostname() })
      const face = libraryFace({ grant, home, builtins, env: io.env, cwd: io.cwd, session })
      await serve({ incoming: io.readLines(), send: (message) => io.out(JSON.stringify(message)) }, face)
      return { json: undefined, lines: [], exit: 0 }
    },
  },
  {
    words: ['init'],
    flags: { bare: 'boolean', provider: 'value' },
    arity: [1, 1],
    library: false,
    run: async ({ args, parsed, io, table, home }) => {
      const actor = identifyActor({ grant: null, as: flagValue(parsed, 'as'), env: io.env })
      const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
      const plugins = hasFlag(parsed, 'bare') ? [] : ['ledger']
      const provider = flagValue(parsed, 'provider')
      return owner(await initLibrary(typedAddress(args[0] as string, io.cwd), { plugins, table, actor, session, home, env: io.env, provider }))
    },
  },
  {
    words: ['plugin', 'new'],
    flags: { kind: 'value', name: 'value', packages: 'value' },
    arity: [1, 1],
    library: false,
    run: async ({ args, parsed, io }) => {
      const kind = flagValue(parsed, 'kind') ?? 'blank'
      if (!(KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind 的值只能为 ${KINDS.join(' 或 ')}：${kind}`)
      const packages = flagValue(parsed, 'packages')
      const dir = resolve(io.cwd, args[0] as string)
      const r = scaffold({ dir, kind: kind as Kind, name: flagValue(parsed, 'name'), packages: packages === null ? null : resolve(io.cwd, packages) })
      if (!r.ok) {
        if (r.reason === 'usage') throw new UsageError(r.text)
        return refusal(r.reason, r.text)
      }
      const where = r.packages === null ? ['未指定 --packages：package.json 按包名依赖两个包，而这两个包未发布到 npm，npm install 将失败。请改用空目录，加 --packages <包文件目录> 重新生成。'] : []
      const next = [`cd ${dir}`, 'npm install', 'npm test', 'npm run install-local', `npx -- pneuma-base plugin enable ${r.name} --library <资料库目录>`]
      const standard = `插件规范：${r.standard ?? 'npm install 后位于 node_modules/pneuma-base/PLUGINS.md'}`
      const lines = [`已在 ${dir} 生成插件 ${r.name}（${r.kind}），共 ${r.files.length} 个文件，README.md 说明每个文件的用途。`, standard, ...where, '下一步：', ...next.map((l) => `  ${l}`)]
      return { json: { outcome: 'done', problems: [], ...r }, lines, exit: 0 }
    },
  },
  {
    words: ['view'],
    flags: { port: 'value', 'no-open': 'boolean' },
    arity: [0, 1],
    library: false,
    run: async ({ args, parsed, io, builtins, home }) => {
      const port = flagValue(parsed, 'port')
      if (port !== null && !/^\d{1,5}$/.test(port)) throw new UsageError(`--port 的值应为端口号：${port}`)
      const dir = resolve(io.cwd, args[0] ?? '.')
      const stopped = await view({ dir, builtins, home, io, port: port === null ? undefined : Number(port), open: !hasFlag(parsed, 'no-open') })
      return { json: stopped, lines: ['管理界面已关闭。'], exit: 0 }
    },
  },
]

/** The first word of each of the command line's own commands. */
export const COMMAND_LINE_WORDS: readonly string[] = [...new Set(SPECS.map((s) => s.words[0] as string))]

function matchSpec(typed: readonly string[]): Spec | null {
  let best: Spec | null = null
  for (const spec of SPECS) {
    if (spec.words.every((w, i) => typed[i] === w) && spec.words.length > (best?.words.length ?? 0)) best = spec
  }
  return best
}

/** Which library and who: `@<grant>` fixes both; `--library` with an optional `--as` is for use without a grant file. */
async function bind(inv: Invocation): Promise<Bound | Answer> {
  const { parsed, io, table, home } = inv
  const dir = flagValue(parsed, 'library')
  if (parsed.grant !== null && (dir !== null || hasFlag(parsed, 'as'))) throw new UsageError('@<授权名称> 已决定资料库和身份，不能再使用 --library 或 --as。')
  if (parsed.grant !== null) {
    const r = await resolveGrant(home, parsed.grant, table)
    return r.ok ? contextFor(inv, r.library, r.grant) : refusal(r.reason, r.text)
  }
  if (dir === null) throw new UsageError('需用 @<授权名称> 或 --library <资料库目录> 指定资料库。')
  const library = await openLibrary(typedAddress(dir, io.cwd), table)
  return library ? contextFor(inv, library, null) : refusal('not-a-library', `${dir} 不是资料库。可用 pneuma-base init <地址> 初始化资料库。`)
}

function contextFor({ parsed, io, home }: Invocation, library: Library, grant: Grant | null): Bound {
  const actor = identifyActor({ grant, as: flagValue(parsed, 'as'), env: io.env })
  const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
  const ctx = makeContext(library, actor, session, home)
  return { library, ctx: io.pass === undefined ? ctx : { ...ctx, pass: io.pass() }, viaGrant: grant !== null }
}

/** Owner commands whose library comes from the local grant their first argument names, not from --library. */
const GRANT_BOUND: ReadonlySet<string> = new Set(['skill install'])

const words = (name: string) => name.split(' ')

/** The library of a grant-bound command: the one its grant points at, used by the owner. */
async function bindByGrant(inv: Invocation, grantName: string | undefined, command: string): Promise<Bound | Answer> {
  if (grantName === undefined) throw new UsageError(`${command} 需指定授权名称`)
  const resolved = await resolveGrant(inv.home, grantName, inv.table)
  return resolved.ok ? contextFor(inv, resolved.library, null) : refusal(resolved.reason, resolved.text)
}

/** A command that needs no library, run with none: the owner's, in the session the environment shows. */
function machineCall(inv: Invocation): OwnerCall {
  const { parsed, io, home } = inv
  const actor = identifyActor({ grant: null, as: flagValue(parsed, 'as'), env: io.env })
  const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
  const ctx: MachineContext = { library: null, actor, session, now: new Date().toISOString() as Instant, home }
  return { ctx, table: inv.table, env: io.env, viaGrant: false, confirm: (q) => io.confirm(q), readSecret: (q) => io.readSecret(q) }
}

/** An owner command, the kernel's or an installed plugin's, run through the owner face's one entry. */
async function ownerCommand(inv: Invocation, line: Line): Promise<Answer> {
  const typed = leadingWords(line)
  const unknown = () => new UsageError(`未知命令：${typed.join(' ') || '（空）'}`)
  const answer = (r: OwnerResult): Answer => {
    if (r.outcome === 'refused' && r.reason === 'usage') throw new UsageError(r.text)
    return owner(r)
  }
  let bound: Bound | Answer
  if (line.grant === null && !hasFlag(inv.parsed, 'library')) {
    const kernel = matchCommand(ownerFace.commands([]), typed)
    if (!kernel) throw unknown()
    const args = argsOf(kernel, line)
    if (kernel.machine) return answer(await ownerFace.dispatch(machineCall(inv), kernel.name, args))
    if (!GRANT_BOUND.has(kernel.name)) throw new UsageError('需用 @<授权名称> 或 --library <资料库目录> 指定资料库。')
    bound = await bindByGrant(inv, args.positional[0], kernel.name)
  } else bound = await bind(inv)
  if ('exit' in bound) return bound
  const command = matchCommand(ownerFace.commands(bound.library.plugins), typed)
  if (!command) throw unknown()
  return answer(await ownerFace.dispatch(ownerCall(inv, bound), command.name, argsOf(command, line)))
}

async function runSpec(spec: Spec, inv: Invocation): Promise<Answer> {
  const name = spec.words.join(' ')
  if (inv.args.length < spec.arity[0] || inv.args.length > spec.arity[1]) throw new UsageError(`${name} 的参数个数错误`)
  if (!spec.library) return spec.run(inv)
  const bound = await bind(inv)
  return 'exit' in bound ? bound : spec.run(inv, bound)
}

/** The command line's own command these words name, unless a kernel owner command with more words does, as `archive purge` over `archive`. */
function verbSpec(typed: readonly string[]): Spec | null {
  const spec = matchSpec(typed)
  const command = matchCommand(ownerFace.commands([]), typed)
  return spec && !(command && words(command.name).length > spec.words.length) ? spec : null
}

/** The arguments after a command line's own command, read by how it says its flags take values. */
function parseSpec(line: Line, spec: Spec): Parsed {
  const name = spec.words.join(' ')
  if (spec.flags === 'any') return parseCommand(line, spec.words.length, {}, 'table', name)
  if (spec.flags === 'params') return parseCommand(line, spec.words.length, {}, 'value', name)
  return parseCommand(line, spec.words.length, spec.flags, 'error', name, spec.rawAfter)
}

/** `pneuma-base <directory>`, with nothing else but flags, is `pneuma-base view <directory>`. */
function impliedView(line: Line, cwd: string): Line {
  const typed = leadingWords(line)
  const [first] = typed
  if (line.grant !== null || first === undefined || typed.length > 1 || matchSpec(typed)) return line
  return statSync(resolve(cwd, first), { throwIfNoEntry: false })?.isDirectory() ? { ...line, rest: ['view', ...line.rest] } : line
}

/** `builtins` is the command line's own plugin table; the owner's plugins in `$PNEUMA_BASE_HOME/plugins/` join it. */
export async function main(argv: readonly string[], builtins: PluginTable, io: Io): Promise<number> {
  try {
    const home = io.env.PNEUMA_BASE_HOME ?? join(homedir(), '.pneuma-base')
    useMachineHome(home)
    const table = await loadPlugins(home, builtins)
    if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
      io.out(await help(argv, io, table, home))
      return argv.length === 0 ? 1 : 0
    }
    const line = impliedView(splitLine(argv), io.cwd)
    const spec = verbSpec(leadingWords(line))
    const parsed = spec ? parseSpec(line, spec) : { grant: line.grant, positional: [], flags: new Map(line.global) }
    const inv: Invocation = { parsed, args: parsed.positional, io, table, builtins, home }
    const result = spec ? await runSpec(spec, inv) : await ownerCommand(inv, line)
    // A command that printed as it went, as mcp did on its channel, answers nothing more.
    if (hasFlag(parsed, 'json') ? result.json !== undefined : result.lines.length > 0) io.out(hasFlag(parsed, 'json') ? JSON.stringify(result.json, null, 2) : result.lines.join('\n'))
    return result.exit
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`用法错误：${error.message}`)
      // A command's own usage line, when the message ends with one, says more than the general one.
      io.err(`${error.message.includes('\n用法：') ? '' : `${USAGE}\n`}所有者命令：pneuma-base --help --library <资料库目录> 列出该资料库的全部可用命令。`)
      return 1
    }
    io.err(`出错：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
