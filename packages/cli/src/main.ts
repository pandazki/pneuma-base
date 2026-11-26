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
  }
}

const USAGE = `用法：
  pneuma-base @<授权名> <动词> …
  pneuma-base --library <库的目录> [--as <agent 名>] <动词> …
动词：start "<一句话>" | find <文字> [--include-archived] [--scene <场景号>] [--origin brought|made] | inspect <库内路径|条目号|场景号>
      put <文件|目录|-|库内路径> [--to <库内路径>] (--brought [--source <出处>] [--by owner] | --made [--from <库内路径…>] [--from-outside <一句话…>]) [--note "<一句话>"]
      say <种类> [<关于>] [<内容>] | check [--since <时间>|last] [--include-archived]
      archive <库内路径> | unarchive <库内路径>
看管理界面的一页：show [<页的编号> [--<参数> <值>…]]（不写编号列出这个库的页；条目面板是 show item --path <库内路径>）
给只能接 MCP 的 agent 应用：pneuma-base @<授权名> mcp（在标准输入输出上跑 MCP 服务，动词和能用的命令都是工具）
让 agent 自己接上：guide [<产品>] [--library <库的目录>] [--url]（给 agent 读的说明，和本机地址 /guide 给的一样；--url 印出那个地址）
      pair request <产品> "<为什么>" [--library <库的目录>]（请主人允许接入，答复里有配对码）| pair status <配对号>
主人：view [<目录>] [--port <端口>] [--no-open]（在浏览器里打开管理界面；pneuma-base <目录> 也一样）
      init <地址> [--bare] [--provider <存储提供者>]（地址是一个文件夹，或别的存储提供者答的写法）
插件作者：plugin new <目录> [--kind blank|deploy] [--name <插件名>] [--packages <两个包文件所在的目录>]（生成一个插件项目）
加 --json 输出结果对象。`

/** `plugin new --help`: the scaffold's own usage. */
const PLUGIN_NEW_USAGE = `用法：pneuma-base plugin new <目录> [--kind blank|deploy] [--name <插件名>] [--packages <两个包文件所在的目录>]
在一个空的或还不存在的目录里生成一个插件项目，不改一行就能构建、通过自己的测试、装进这台机器。不碰任何库。
  --kind      blank（缺省）：一种「说」的种类、一条带参数表的主人命令、一个视图和一个自己画的块；deploy：开发包里的部署库加一个发布到本地目录的目标
  --name      插件名：小写字母开头，只用小写字母、数字和连字符；不写就用目录名
  --packages  pneuma-base 和 @pneuma-base/sdk 两个包文件（pneuma-base-${PNEUMA_BASE_VERSION}.tgz、pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz）所在的目录。项目按绝对路径依赖它们，挪到哪里都装得上；包文件要留在原处。不写时按包名依赖，两个包没有发布到 npm，npm install 装不上
生成之后：cd <目录>，npm install，npm test，npm run install-local；README.md 说每个文件是什么。`

/**
 * The owner commands of the library at hand, from the owner face, or the kernel's when there is
 * none: each with its arguments, what it does, and how it is gated.
 */
function ownerHelp(commands: OwnerCommandInfo[], library: Library | null): string {
  const lines = commands.map((c) => {
    const gate = c.destructive ? '；会丢数据，只有主人能做，要当面确认' : c.ownerOnly ? '；只有主人能做' : ''
    const machine = c.machine ? '；不用指明库' : ''
    return `  ${[c.name, ...(c.usage === null ? [] : [c.usage])].join(' ')}\n      ${c.summary}${gate}${machine}${c.by === 'kernel' ? '' : `（${c.by}）`}`
  })
  const head = `主人命令${library === null ? '' : `（${library.root} 能用的）`}，都带 --library <库的目录>，skill install 和不用指明库的除外：`
  const more = library === null ? ['库里装的插件各带自己的命令，pneuma-base --help --library <库的目录> 列出那个库能用的全部。'] : []
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

const NO_ENDPOINT = '现在没有开着的 Pneuma Base 地址：它在 Pneuma Base 应用开着时有，或者运行 pneuma-base view <库的目录>。'

/** The library of a command for an agent not connected yet: `--library`, else the one the running endpoint serves. */
async function servedLibrary({ parsed, io, table, home }: Invocation): Promise<Library | Answer> {
  const dir = flagValue(parsed, 'library')
  const root = dir === null ? ((await endpointOf(home, null))?.library ?? null) : typedAddress(dir, io.cwd)
  if (root === null) throw new UsageError('没有开着的 Pneuma Base 地址，用 --library <库的目录> 指明是哪个库。')
  return (await openLibrary(root, table)) ?? refusal('not-a-library', `${dir ?? root} 不是一个库。`)
}

const productArg = (name: string): string => {
  if (!GRANT_NAME.test(name)) throw new UsageError(`不是一个产品名：${name}（小写字母或数字开头，只用小写字母、数字和连字符）`)
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
        if (dir !== null && library === null) return refusal('not-a-library', `${dir} 不是一个库。`)
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
      return a === null ? refusal('no-such-pairing', `没有配对 ${id}。`) : { json: a, lines: [a.text], exit: 0 }
    },
  },
  {
    words: ['mcp'],
    flags: {},
    arity: [0, 0],
    library: false,
    run: async ({ parsed, io, table, builtins, home }) => {
      const grant = parsed.grant
      if (grant === null) throw new UsageError('mcp 要写 @<授权名>：授权定了是哪个库、是谁。')
      if (['library', 'as'].some((f) => hasFlag(parsed, f))) throw new UsageError('mcp 只认 @<授权名>：库和身份由授权定，不写 --library 或 --as。')
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
      if (!(KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind 只能是 ${KINDS.join(' 或 ')}：${kind}`)
      const packages = flagValue(parsed, 'packages')
      const dir = resolve(io.cwd, args[0] as string)
      const r = scaffold({ dir, kind: kind as Kind, name: flagValue(parsed, 'name'), packages: packages === null ? null : resolve(io.cwd, packages) })
      if (!r.ok) {
        if (r.reason === 'usage') throw new UsageError(r.text)
        return refusal(r.reason, r.text)
      }
      const where = r.packages === null ? ['没写 --packages，package.json 按包名依赖两个包，它们没有发布到 npm，npm install 装不上。换一个空目录，加 --packages <两个包文件所在的目录> 再生成。'] : []
      const next = [`cd ${dir}`, 'npm install', 'npm test', 'npm run install-local', `npx -- pneuma-base plugin add ${r.name} --library <库的目录>`]
      const standard = `插件规范：${r.standard ?? 'npm install 之后在 node_modules/pneuma-base/PLUGINS.md'}`
      const lines = [`已在 ${dir} 生成插件 ${r.name}（${r.kind}），${r.files.length} 个文件，README.md 说每个是什么。`, standard, ...where, '接着：', ...next.map((l) => `  ${l}`)]
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
      if (port !== null && !/^\d{1,5}$/.test(port)) throw new UsageError(`--port 要写一个端口号：${port}`)
      const dir = resolve(io.cwd, args[0] ?? '.')
      const stopped = await view({ dir, builtins, home, io, port: port === null ? undefined : Number(port), open: !hasFlag(parsed, 'no-open') })
      return { json: stopped, lines: ['界面已关闭。'], exit: 0 }
    },
  },
]

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
  if (parsed.grant !== null && (dir !== null || hasFlag(parsed, 'as'))) throw new UsageError('@<授权名> 已经定了库和身份，不要再写 --library 或 --as。')
  if (parsed.grant !== null) {
    const r = await resolveGrant(home, parsed.grant, table)
    return r.ok ? contextFor(inv, r.library, r.grant) : refusal(r.reason, r.text)
  }
  if (dir === null) throw new UsageError('要用 @<授权名> 或 --library <库的目录> 指明是哪个库。')
  const library = await openLibrary(typedAddress(dir, io.cwd), table)
  return library ? contextFor(inv, library, null) : refusal('not-a-library', `${dir} 不是一个库。先用 pneuma-base init <地址> 建库。`)
}

function contextFor({ parsed, io, home }: Invocation, library: Library, grant: Grant | null): Bound {
  const actor = identifyActor({ grant, as: flagValue(parsed, 'as'), env: io.env })
  const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
  return { library, ctx: makeContext(library, actor, session, home), viaGrant: grant !== null }
}

/** Owner commands whose library comes from the local grant their first argument names, not from --library. */
const GRANT_BOUND: ReadonlySet<string> = new Set(['skill install'])

const words = (name: string) => name.split(' ')

/** The library of a grant-bound command: the one its grant points at, used by the owner. */
async function bindByGrant(inv: Invocation, grantName: string | undefined, command: string): Promise<Bound | Answer> {
  if (grantName === undefined) throw new UsageError(`${command} 要写授权名`)
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
  const unknown = () => new UsageError(`不认识的命令：${typed.join(' ') || '（空）'}`)
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
    if (!GRANT_BOUND.has(kernel.name)) throw new UsageError('要用 @<授权名> 或 --library <库的目录> 指明是哪个库。')
    bound = await bindByGrant(inv, args.positional[0], kernel.name)
  } else bound = await bind(inv)
  if ('exit' in bound) return bound
  const command = matchCommand(ownerFace.commands(bound.library.plugins), typed)
  if (!command) throw unknown()
  return answer(await ownerFace.dispatch(ownerCall(inv, bound), command.name, argsOf(command, line)))
}

async function runSpec(spec: Spec, inv: Invocation): Promise<Answer> {
  const name = spec.words.join(' ')
  if (inv.args.length < spec.arity[0] || inv.args.length > spec.arity[1]) throw new UsageError(`${name} 的参数个数不对`)
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
      io.err(`${error.message.includes('\n用法：') ? '' : `${USAGE}\n`}主人命令：pneuma-base --help --library <库的目录> 列出一个库能用的全部。`)
      return 1
    }
    io.err(`出错：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
