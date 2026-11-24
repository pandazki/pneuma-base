import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  agentFace,
  identifyActor,
  identifySession,
  initLibrary,
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
  type Origin,
  type OwnerArgs,
  type OwnerCall,
  type OwnerResult,
  type PluginProblem,
  type PluginTable,
  type PutRequest,
} from '@pneuma-base/kernel'
import { GLOBAL_FLAGS, UsageError, flagList, flagValue, hasFlag, ownFlags, parseArgs, type Parsed } from './args.js'
import { archiveText, checkText, findText, inspectText, ownerText, putText, sayText } from './format.js'

export type Io = {
  env: Env
  cwd: string
  out(text: string): void
  err(text: string): void
  readStdin(): Promise<Uint8Array>
  confirm(question: string): Promise<boolean>
}

export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    },
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl.question(`${question} 输入 yes 确认：`)
      rl.close()
      return answer.trim() === 'yes'
    },
  }
}

const USAGE = `用法：
  pneuma-base @<授权名> <动词> …
  pneuma-base --library <库的目录> [--as <agent 名>] <动词> …
动词：start "<一句话>" | find <文字> [--include-archived] | inspect <库内路径>
      put <文件|-|库内路径> [--to <库内路径>] (--brought [--source <出处>] [--by owner] | --made [--from <库内路径…>] [--from-outside <一句话…>])
      say <种类> [<关于>] [<内容>] | check [--since <时间>|last] [--include-archived]
      archive <库内路径> | unarchive <库内路径>
主人：init <目录> [--bare] | plugin add|remove <名字> --library <目录>
      grant issue <名字> --library <目录> --agent <给谁> [--area <子文件夹>] [--read-only] | grant revoke <名字> --library <目录>
      skill install <授权名> --agent claude|codex --dir <目录> | archive purge --library <目录>（会丢数据，要当面确认）
加 --json 输出结果对象。`

/** 0 answered; 2 refused; 3 accepted but a plugin reported a problem. Usage errors are 1. */
type Answer = { json: unknown; lines: string[]; exit: number }

type Bound = { library: Library; ctx: Context; viaGrant: boolean }
type Invocation = { parsed: Parsed; args: string[]; io: Io; table: PluginTable; home: string }

type Spec = { words: string[]; flags: readonly string[] | 'any'; arity: [min: number, max: number] } & (
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
 * The four forms of put. A relative first argument names a file next to the caller when one is
 * there, otherwise a path in the library. A file outside the library is placed; a path inside is
 * registered, or moved when `--to` is given.
 */
async function putRequest(inv: Invocation, library: Library): Promise<PutRequest> {
  const first = inv.args[0] as string
  const to = flagValue(inv.parsed, 'to')
  const origin = originOf(inv.parsed)
  if (first === '-') {
    if (to === null) throw new UsageError('从标准输入放进来要写 --to <库内路径>。')
    return { kind: 'place', from: { kind: 'stdin', content: await inv.io.readStdin() }, to, origin: requireOrigin(origin) }
  }
  const local = resolve(inv.io.cwd, first)
  const onDisk = isAbsolute(first) || existsSync(local)
  if (onDisk && parseLibraryPath(library.root, local) === null) {
    if (to === null) throw new UsageError('从库外放进来要写 --to <库内路径>。')
    return { kind: 'place', from: { kind: 'file', path: local }, to, origin: requireOrigin(origin) }
  }
  const path = onDisk ? local : first
  if (to === null) return { kind: 'register', path, origin: requireOrigin(origin) }
  if (origin) throw new UsageError('在库里挪位置不需要 --brought 或 --made。')
  return { kind: 'move', from: path, to }
}

function sinceOf(value: string | null): Instant | 'last' | null {
  if (value === null || value === 'last') return value
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new UsageError(`--since 要写 last 或一个时间，比如 2026-11-25T08:00:00Z：${value}`)
  return new Date(t).toISOString() as Instant
}

function ownerCall(inv: Invocation, bound: Bound): OwnerCall {
  return { ctx: bound.ctx, table: inv.table, home: inv.home, env: inv.io.env, viaGrant: bound.viaGrant, confirm: (q) => inv.io.confirm(q) }
}

const SPECS: Spec[] = [
  {
    words: ['start'],
    flags: [],
    arity: [1, Infinity],
    library: true,
    run: async ({ args }, { ctx }) => {
      const sentence = args.join(' ')
      const say = await agentFace.say({ kind: 'doing', about: null, text: sentence, args: {} }, ctx)
      const check = await agentFace.check({ since: 'last', includeArchived: false }, ctx)
      const find = await agentFace.find({ text: sentence, filters: {}, includeArchived: false }, ctx)
      const lines = ['【记下】', ...sayText(say), '【自上次以来的变化】', ...checkText(check), '【库里可能相关的】', ...findText(find)]
      return { json: { say, check, find }, lines, exit: exitOf(say, check, find) }
    },
  },
  {
    words: ['find'],
    flags: ['include-archived'],
    arity: [0, Infinity],
    library: true,
    run: async ({ args, parsed }, { ctx }) => {
      const r = await agentFace.find({ text: args.length === 0 ? null : args.join(' '), filters: {}, includeArchived: hasFlag(parsed, 'include-archived') }, ctx)
      return { json: r, lines: findText(r), exit: exitOf(r) }
    },
  },
  {
    words: ['inspect'],
    flags: [],
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
    flags: ['to', 'brought', 'made', 'source', 'by', 'from', 'from-outside'],
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
    flags: ['since', 'include-archived'],
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
      flags: [],
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
    flags: ['bare'],
    arity: [1, 1],
    library: false,
    run: async ({ args, parsed, io, table }) => {
      const actor = identifyActor({ grant: null, as: flagValue(parsed, 'as'), env: io.env })
      const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
      const plugins = hasFlag(parsed, 'bare') ? [] : ['ledger']
      return owner(await initLibrary(resolve(io.cwd, args[0] as string), { plugins, table, actor, session }))
    },
  },
  {
    words: ['grant', 'issue'],
    flags: ['agent', 'area', 'read-only'],
    arity: [1, 1],
    library: true,
    run: async (inv, bound) => {
      const agent = flagValue(inv.parsed, 'agent')
      if (agent === null) throw new UsageError('要写 --agent <给谁>，比如 --agent claude-code。')
      const req = { name: inv.args[0] as string, agent, area: flagValue(inv.parsed, 'area'), readOnly: hasFlag(inv.parsed, 'read-only') }
      return owner(await ownerFace.issueGrant(ownerCall(inv, bound), req))
    },
  },
  {
    words: ['grant', 'revoke'],
    flags: [],
    arity: [1, 1],
    library: true,
    run: async (inv, bound) => owner(await ownerFace.revokeGrant(ownerCall(inv, bound), inv.args[0] as string)),
  },
  {
    words: ['plugin', 'add'],
    flags: [],
    arity: [1, 1],
    library: true,
    run: async (inv, bound) => owner(await ownerFace.addPlugin(ownerCall(inv, bound), inv.args[0] as string)),
  },
  {
    words: ['plugin', 'remove'],
    flags: [],
    arity: [1, 1],
    library: true,
    run: async (inv, bound) => owner(await ownerFace.removePlugin(ownerCall(inv, bound), inv.args[0] as string)),
  },
  {
    words: ['skill', 'install'],
    flags: ['agent', 'dir'],
    arity: [1, 1],
    library: false,
    run: async (inv) => {
      const agent = flagValue(inv.parsed, 'agent')
      const dir = flagValue(inv.parsed, 'dir')
      if (agent !== 'claude' && agent !== 'codex') throw new UsageError('要写 --agent claude 或 --agent codex。')
      if (dir === null) throw new UsageError('要写 --dir <放技能的目录>。')
      const grantName = inv.args[0] as string
      const resolved = await resolveGrant(inv.home, grantName, inv.table)
      if (!resolved.ok) return refusal(resolved.reason, resolved.text)
      const call = ownerCall(inv, contextFor(inv, resolved.library, null))
      return owner(await ownerFace.installSkill(call, { grantName, agent, dir: resolve(inv.io.cwd, dir) }))
    },
  },
  {
    words: ['archive', 'purge'],
    flags: [],
    arity: [0, 0],
    library: true,
    run: async (inv, bound) => owner(await ownerFace.purgeArchive(ownerCall(inv, bound))),
  },
]

function matchSpec(positional: string[]): Spec | null {
  let best: Spec | null = null
  for (const spec of SPECS) {
    if (spec.words.every((w, i) => positional[i] === w) && spec.words.length > (best?.words.length ?? 0)) best = spec
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

function contextFor({ parsed, io }: Invocation, library: Library, grant: Grant | null): Bound {
  const actor = identifyActor({ grant, as: flagValue(parsed, 'as'), env: io.env })
  const session = identifySession({ flag: flagValue(parsed, 'session'), env: io.env, cwd: io.cwd, machine: hostname() })
  return { library, ctx: makeContext(library, actor, session), viaGrant: grant !== null }
}

/** A command an installed plugin added to the owner face, matched by its words. */
async function pluginCommand(inv: Invocation): Promise<Answer> {
  const { parsed } = inv
  const unknown = new UsageError(`不认识的命令：${parsed.positional.join(' ') || '（空）'}`)
  if (parsed.grant === null && !hasFlag(parsed, 'library')) throw unknown
  const bound = await bind(inv)
  if ('exit' in bound) return bound
  const words = (name: string) => name.split(' ')
  const match = bound.library.plugins
    .flatMap((plugin) => plugin.ownerCommands.map((command) => ({ plugin, command })))
    .filter(({ command }) => words(command.name).every((w, i) => parsed.positional[i] === w))
    .sort((a, b) => words(b.command.name).length - words(a.command.name).length)[0]
  if (!match) throw unknown
  const args: OwnerArgs = { positional: parsed.positional.slice(words(match.command.name).length), flags: Object.fromEntries(ownFlags(parsed)) }
  return owner(await ownerFace.run(ownerCall(inv, bound), match.plugin, match.command, args))
}

async function runSpec(spec: Spec, inv: Invocation): Promise<Answer> {
  const name = spec.words.join(' ')
  if (inv.args.length < spec.arity[0] || inv.args.length > spec.arity[1]) throw new UsageError(`${name} 的参数个数不对`)
  if (spec.flags !== 'any') {
    const allowed = new Set<string>([...GLOBAL_FLAGS, ...spec.flags])
    for (const flag of inv.parsed.flags.keys()) if (!allowed.has(flag)) throw new UsageError(`${name} 不认识 --${flag}`)
  }
  if (!spec.library) return spec.run(inv)
  const bound = await bind(inv)
  return 'exit' in bound ? bound : spec.run(inv, bound)
}

export async function main(argv: readonly string[], table: PluginTable, io: Io): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
      io.out(USAGE)
      return argv.length === 0 ? 1 : 0
    }
    const parsed = parseArgs(argv)
    const home = io.env.PNEUMA_BASE_HOME ?? join(homedir(), '.pneuma-base')
    const spec = matchSpec(parsed.positional)
    const inv: Invocation = { parsed, args: parsed.positional.slice(spec?.words.length ?? 0), io, table, home }
    const result = spec ? await runSpec(spec, inv) : await pluginCommand(inv)
    io.out(hasFlag(parsed, 'json') ? JSON.stringify(result.json, null, 2) : result.lines.join('\n'))
    return result.exit
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`用法错误：${error.message}`)
      io.err(USAGE)
      return 1
    }
    io.err(`出错：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
