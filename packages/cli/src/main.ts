import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  agentFace,
  identifyActor,
  identifySession,
  initLibrary,
  loadPlugins,
  makeContext,
  openLibrary,
  ownerFace,
  parseLibraryPath,
  resolveGrant,
  type Context,
  type Env,
  type Grant,
  type Instant,
  type Library,
  type MachineContext,
  type Origin,
  type OwnerArgs,
  type OwnerCall,
  type OwnerCommandInfo,
  type OwnerResult,
  type PluginProblem,
  type PluginTable,
  type PutRequest,
} from '@pneuma-base/kernel'
import { UsageError, flagList, flagValue, hasFlag, leadingWords, ownFlags, parseCommand, splitLine, type FlagKind, type Line, type Parsed } from './args.js'
import { archiveText, checkText, findText, inspectText, ownerText, putText, sayText, startText } from './format.js'
import { KINDS, scaffold, type Kind } from './scaffold.js'
import { view } from './view.js'

export type Io = {
  env: Env
  cwd: string
  out(text: string): void
  err(text: string): void
  readStdin(): Promise<Uint8Array>
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
    readSecret: async (question) => (process.stdin.isTTY ? hiddenAnswer(question) : Buffer.from(await readStdin()).toString('utf8').replace(/\r?\n$/, '')),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl.question(`${question} 输入 yes 确认：`)
      rl.close()
      return answer.trim() === 'yes'
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
主人：view [<目录>] [--port <端口>] [--no-open]（在浏览器里打开管理界面；pneuma-base <目录> 也一样）
      init <目录> [--bare]
插件作者：plugin new <目录> [--kind blank|deploy] [--name <插件名>] [--packages <两个包文件所在的目录>]（生成一个插件项目）
加 --json 输出结果对象。`

/** `plugin new --help`: the scaffold's own usage. */
const PLUGIN_NEW_USAGE = `用法：pneuma-base plugin new <目录> [--kind blank|deploy] [--name <插件名>] [--packages <两个包文件所在的目录>]
在一个空的或还不存在的目录里生成一个插件项目，不改一行就能构建、通过自己的测试、装进这台机器。不碰任何库。
  --kind      blank（缺省）：一种「说」的种类、一条带参数表的主人命令、一个视图和一个自己画的块；deploy：开发包里的部署库加一个发布到本地目录的目标
  --name      插件名：小写字母开头，只用小写字母、数字和连字符；不写就用目录名
  --packages  pneuma-base 和 @pneuma-base/sdk 两个包文件所在的目录。项目按绝对路径依赖它们，挪到哪里都装得上；包文件要留在原处。不写就用构建这个命令行的仓库里 pnpm pack:dist 打出的，都没有就按包名依赖
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
      : dir === null ? null : await openLibrary(resolve(io.cwd, dir), table)
  return `${USAGE}\n${ownerHelp(ownerFace.commands(library?.plugins ?? []), library)}`
}

/** 0 answered; 2 refused; 3 accepted but a plugin reported a problem. Usage errors are 1. */
type Answer = { json: unknown; lines: string[]; exit: number }

type Bound = { library: Library; ctx: Context; viaGrant: boolean }
/** `table`: every plugin this machine has; `builtins`: the command line's own, which the UI's server joins with the machine's on each request. */
type Invocation = { parsed: Parsed; args: string[]; io: Io; table: PluginTable; builtins: PluginTable; home: string }

/** `flags`: how each of its own flags takes values; `any` for say, whose flags are the plugins'. */
type Spec = { words: string[]; flags: Readonly<Record<string, FlagKind>> | 'any'; arity: [min: number, max: number] } & (
  | { library: true; run: (inv: Invocation, bound: Bound) => Promise<Answer> }
  | { library: false; run: (inv: Invocation) => Promise<Answer> }
)

function exitOf(...results: { outcome?: string; reason?: string; problems: PluginProblem[] }[]): number {
  if (results.some((r) => r.outcome === 'refused' || (r.outcome === 'not-heard' && r.reason === 'refused'))) return 2
  return results.some((r) => r.problems.length > 0) ? 3 : 0
}

const answer = (json: { outcome: string; reason?: string; problems: PluginProblem[] }, lines: string[]): Answer => ({ json, lines, exit: exitOf(json) })
const owner = (r: OwnerResult): Answer => answer(r, ownerText(r))

const ORIGIN_HELP =
  '要说明来历：带进来的用 --brought（可加 --source <出处>、--by owner），做出来的用 --made（可加 --from <库内路径…>、--from-outside "<一句话…>"）。两个只能选一个。'

function originOf(parsed: Parsed): Origin<string> | null {
  const brought = hasFlag(parsed, 'brought')
  const made = hasFlag(parsed, 'made')
  if (brought && made) throw new UsageError(ORIGIN_HELP)
  if (!brought && (hasFlag(parsed, 'source') || hasFlag(parsed, 'by'))) throw new UsageError('--source 和 --by 只跟 --brought 一起用。')
  if (!made && (hasFlag(parsed, 'from') || hasFlag(parsed, 'from-outside'))) throw new UsageError('--from 和 --from-outside 只跟 --made 一起用。')
  if (brought) return { kind: 'brought', source: flagValue(parsed, 'source'), by: flagValue(parsed, 'by') }
  if (made) return { kind: 'made', from: flagList(parsed, 'from'), outside: flagList(parsed, 'from-outside') }
  return null
}

function requireOrigin(origin: Origin<string> | null): Origin<string> {
  if (!origin) throw new UsageError(ORIGIN_HELP)
  return origin
}

/**
 * The four forms of put. A relative first argument names a file or directory next to the caller
 * when one is there, otherwise a path in the library. A file or directory outside the library is
 * placed; a path inside is registered, or moved when `--to` is given.
 */
async function putRequest(inv: Invocation, library: Library): Promise<PutRequest> {
  const first = inv.args[0] as string
  const to = flagValue(inv.parsed, 'to')
  const origin = originOf(inv.parsed)
  const note = flagValue(inv.parsed, 'note')
  if (first === '-') {
    if (to === null) throw new UsageError('从标准输入放进来要写 --to <库内路径>。')
    return { kind: 'place', from: { kind: 'stdin', content: await inv.io.readStdin() }, to, origin: requireOrigin(origin), note }
  }
  const local = resolve(inv.io.cwd, first)
  const onDisk = isAbsolute(first) || existsSync(local)
  if (onDisk && parseLibraryPath(library.root, local) === null) {
    if (to === null) throw new UsageError('从库外放进来要写 --to <库内路径>。')
    const kind = statSync(local, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : 'file'
    return { kind: 'place', from: { kind, path: local }, to, origin: requireOrigin(origin), note }
  }
  const path = onDisk ? local : first
  if (to === null) return { kind: 'register', path, origin: requireOrigin(origin), note }
  if (origin || note !== null) throw new UsageError('在库里挪位置不需要 --brought、--made 或 --note。')
  return { kind: 'move', from: path, to }
}

function sinceOf(value: string | null): Instant | 'last' | null {
  if (value === null || value === 'last') return value
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new UsageError(`--since 要写 last 或一个时间，比如 2026-11-25T08:00:00Z：${value}`)
  return new Date(t).toISOString() as Instant
}

function ownerCall(inv: Invocation, bound: Bound): OwnerCall {
  return { ctx: bound.ctx, table: inv.table, env: inv.io.env, viaGrant: bound.viaGrant, confirm: (q) => inv.io.confirm(q), readSecret: (q) => inv.io.readSecret(q) }
}

const SPECS: Spec[] = [
  {
    words: ['start'],
    flags: {},
    arity: [1, Infinity],
    library: true,
    run: async ({ args }, { ctx }) => {
      const sentence = args.join(' ')
      const say = await agentFace.say({ kind: 'doing', about: null, text: sentence, args: {} }, ctx)
      const check = await agentFace.check({ since: 'last', includeArchived: false }, ctx)
      const find = await agentFace.find({ text: sentence, match: 'words', filters: {}, includeArchived: false, skipOwnSession: true }, ctx)
      return { json: { say, check, find }, lines: startText(say, check, find), exit: exitOf(say, check, find) }
    },
  },
  {
    words: ['find'],
    flags: { 'include-archived': 'boolean', scene: 'value', origin: 'value' },
    arity: [0, Infinity],
    library: true,
    run: async ({ args, parsed }, { ctx }) => {
      const filters = Object.fromEntries((['scene', 'origin'] as const).flatMap((name) => (hasFlag(parsed, name) ? [[name, flagValue(parsed, name) as string]] : [])))
      const text = args.length === 0 ? null : args.join(' ')
      const r = await agentFace.find({ text, match: 'terms', filters, includeArchived: hasFlag(parsed, 'include-archived'), skipOwnSession: false }, ctx)
      return { json: r, lines: findText(r), exit: exitOf(r) }
    },
  },
  {
    words: ['inspect'],
    flags: {},
    arity: [1, 1],
    library: true,
    run: async ({ args }, { ctx }) => {
      const target = args[0] as string
      const r = await agentFace.inspect({ target }, ctx)
      return { json: r, lines: inspectText(target, r), exit: exitOf(r) }
    },
  },
  {
    words: ['put'],
    flags: { to: 'value', brought: 'boolean', made: 'boolean', source: 'value', by: 'value', from: 'list', 'from-outside': 'list', note: 'value' },
    arity: [1, 1],
    library: true,
    run: async (inv, { library, ctx }) => {
      const req = await putRequest(inv, library)
      const r = await agentFace.put(req, ctx)
      return answer(r, putText(req, r))
    },
  },
  {
    words: ['say'],
    flags: 'any',
    arity: [1, 3],
    library: true,
    run: async ({ args, parsed }, { ctx }) => {
      const [kind, ...rest] = args as [string, ...string[]]
      const [about, text] = rest.length === 2 ? [rest[0] as string, rest[1] as string] : [null, rest[0] ?? null]
      const sayArgs = Object.fromEntries(ownFlags(parsed).map(([name, value]) => [name, value === true ? [] : value]))
      const r = await agentFace.say({ kind, about, text, args: sayArgs }, ctx)
      return answer(r, sayText(r))
    },
  },
  {
    words: ['check'],
    flags: { since: 'value', 'include-archived': 'boolean' },
    arity: [0, 0],
    library: true,
    run: async ({ parsed }, { ctx }) => {
      const r = await agentFace.check({ since: sinceOf(flagValue(parsed, 'since')), includeArchived: hasFlag(parsed, 'include-archived') }, ctx)
      return { json: r, lines: checkText(r), exit: exitOf(r) }
    },
  },
  ...(['archive', 'unarchive'] as const).map(
    (kind): Spec => ({
      words: [kind],
      flags: {},
      arity: [1, 1],
      library: true,
      run: async ({ args }, { ctx }) => {
        const r = await agentFace.archive({ kind, path: args[0] as string }, ctx)
        return answer(r, archiveText(kind, r))
      },
    }),
  ),
  {
    words: ['init'],
    flags: { bare: 'boolean' },
    arity: [1, 1],
    library: false,
    run: async ({ args, parsed, io, table, home }) => {
      const actor = identifyActor({ grant: null, as: flagValue(parsed, 'as'), env: io.env })
      const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
      const plugins = hasFlag(parsed, 'bare') ? [] : ['ledger']
      return owner(await initLibrary(resolve(io.cwd, args[0] as string), { plugins, table, actor, session, home }))
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
      const where = r.packages === null ? ['没找到两个包文件，package.json 按包名依赖它们，发布之后才装得上；要现在用，加 --packages <目录> 指向 pnpm pack:dist 打出的包文件。'] : []
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
      const stopped = await view({ dir, builtins, home, io, port: port === null ? 0 : Number(port), open: !hasFlag(parsed, 'no-open') })
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

function refusal(reason: string, text: string): Answer {
  return answer({ outcome: 'refused', reason, problems: [] }, [`拒绝（${reason}）：${text}`])
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
  const library = await openLibrary(resolve(io.cwd, dir), table)
  return library ? contextFor(inv, library, null) : refusal('not-a-library', `${dir} 不是一个库。先用 pneuma-base init <目录> 建库。`)
}

function contextFor({ parsed, io, home }: Invocation, library: Library, grant: Grant | null): Bound {
  const actor = identifyActor({ grant, as: flagValue(parsed, 'as'), env: io.env })
  const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
  return { library, ctx: makeContext(library, actor, session, home), viaGrant: grant !== null }
}

/** Owner commands whose library comes from the local grant their first argument names, not from --library. */
const GRANT_BOUND: ReadonlySet<string> = new Set(['skill install'])

const words = (name: string) => name.split(' ')

/** The owner command with the most words that start the typed words. */
function matchCommand(commands: OwnerCommandInfo[], typed: readonly string[]): OwnerCommandInfo | undefined {
  return commands.filter((c) => words(c.name).every((w, i) => typed[i] === w)).sort((a, b) => words(b.name).length - words(a.name).length)[0]
}

/**
 * The arguments after the command's name, read by its `params`: a flag it does not declare is a
 * switch, which the owner face then refuses with the usage line.
 */
function argsOf(command: OwnerCommandInfo, line: Line): OwnerArgs {
  const kinds = Object.fromEntries((command.params.flags ?? []).map((f) => [f.name, f.kind]))
  const parsed = parseCommand(line, words(command.name).length, kinds, 'switch', command.name)
  return { positional: parsed.positional, flags: Object.fromEntries(ownFlags(parsed)) }
}

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
    const table = await loadPlugins(home, builtins)
    if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
      io.out(await help(argv, io, table, home))
      return argv.length === 0 ? 1 : 0
    }
    const line = impliedView(splitLine(argv), io.cwd)
    const spec = verbSpec(leadingWords(line))
    const name = spec?.words.join(' ') ?? ''
    const parsed = spec ? parseCommand(line, spec.words.length, spec.flags === 'any' ? {} : spec.flags, spec.flags === 'any' ? 'table' : 'error', name) : { grant: line.grant, positional: [], flags: new Map(line.global) }
    const inv: Invocation = { parsed, args: parsed.positional, io, table, builtins, home }
    const result = spec ? await runSpec(spec, inv) : await ownerCommand(inv, line)
    io.out(hasFlag(parsed, 'json') ? JSON.stringify(result.json, null, 2) : result.lines.join('\n'))
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
