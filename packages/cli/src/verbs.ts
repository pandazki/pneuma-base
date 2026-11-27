// The agent face as its faces offer it: each verb's arguments as data, and what it runs and answers.
// The command line reads a verb's words by this table, the MCP server makes a tool's input schema
// from it, and both call the same `run`, so the two faces answer the same. ARCHITECTURE.md section 4.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  agentFace,
  ownerFace,
  parseLibraryPath,
  quote,
  TEXT_ROWS,
  viewerFace,
  type Context,
  type Env,
  type FlagParam,
  type Instant,
  type Library,
  type Origin,
  type ParamValues,
  type PluginProblem,
  type PluginTable,
  type PositionalParam,
  type PutRequest,
  type AskRequest,
  type OwnerArgs,
} from '@pneuma-base/kernel'
import { UsageError, argsOf, leadingWords, matchCommand, type Line } from './args.js'
import { archiveText, askText, checkAnswer, FIND_ROWS, findAnswer, inspectText, putText, sayText, startAnswer } from './format.js'
import { pageText, viewListText } from './page.js'

/** 0 answered; 2 refused; 3 accepted but a plugin reported a problem. Usage errors are 1. */
export type Answer = { json: unknown; lines: string[]; exit: number }

function exitOf(...results: { outcome?: string; reason?: string; problems: PluginProblem[] }[]): number {
  if (results.some((r) => r.outcome === 'refused' || (r.outcome === 'not-heard' && r.reason === 'refused'))) return 2
  return results.some((r) => r.problems.length > 0) ? 3 : 0
}

export const answer = (json: { outcome: string; reason?: string; problems: PluginProblem[] }, lines: string[]): Answer => ({ json, lines, exit: exitOf(json) })

export function refusal(reason: string, text: string): Answer {
  return answer({ outcome: 'refused', reason, problems: [] }, [`拒绝（${reason}）：${text}`])
}

/** The library at hand, who acts in which session, and whether the call came with a grant. */
export type Bound = { library: Library; ctx: Context; viaGrant: boolean }

/** What a verb runs with besides its values. `stdin`: what the verb reads when the argument `stdin` names is `-`. */
export type VerbCall = { bound: Bound; table: PluginTable; env: Env; cwd: string; stdin: () => Promise<Uint8Array> }

/** A positional argument. `words`: it takes the rest of the words, joined with spaces, as one text. */
type VerbPositional = PositionalParam & { readonly words?: true }

/**
 * A verb's arguments, shaped as an owner command's `params`. `more`: the flags it does not declare,
 * under one name: `say`'s belong to the plugin that hears the kind, each a list; `show`'s are the
 * page's parameters, each one value. `stdin`: the positional whose value `-` means standard input.
 * `fromEnd`: when fewer positionals are written than declared, the optional ones are filled from the
 * last, as `say <种类> <内容>`. `raw`: the `many` positional that takes the rest of the command line as
 * written, flags too, as `ask` takes the owner's command it asks for.
 */
export type VerbParams = {
  readonly positional?: readonly VerbPositional[]
  readonly flags?: readonly FlagParam[]
  readonly more?: { readonly name: string; readonly hint: string; readonly each: 'list' | 'value' }
  readonly stdin?: string
  readonly fromEnd?: true
  readonly raw?: string
}

/** A verb's values by argument name, as either face read them. */
export type VerbInput = { readonly [name: string]: string | readonly string[] | boolean | null | Readonly<Record<string, string | readonly string[]>> }

type MoreValues<P> = P extends { more: { name: infer N extends string; each: infer E } } ? { readonly [K in N]: Readonly<Record<string, E extends 'list' ? readonly string[] : string>> } : unknown

export type Verb = {
  readonly name: string
  /** One Chinese line on what it does: a tool's description. */
  readonly summary: string
  /** It only reads, as far as the agent can tell. */
  readonly readOnly: boolean
  readonly params: VerbParams
  run(values: VerbInput, call: VerbCall): Promise<Answer>
}

/** A verb whose `run` gets its values typed by its `params`; both faces call it only with values read by them. */
function verb<const P extends VerbParams>(v: Omit<Verb, 'params' | 'run'> & { readonly params: P; run(values: ParamValues<P> & MoreValues<P>, call: VerbCall): Promise<Answer> }): Verb {
  return v as unknown as Verb
}

const ORIGIN_HELP =
  '要说明来历：带进来的用 --brought（可加 --source <出处>、--by owner），做出来的用 --made（可加 --from <库内路径…>、--from-outside "<一句话…>"）。两个只能选一个。'

const OBSERVED_HELP = '--observed 只用来登记库里已有的东西，和 --brought --by owner 一起写：主人这边自动看到、没人说过来历的，比如应用登记主人复制进库的文件。'

type OriginValues = { brought: boolean; made: boolean; source: string | null; by: string | null; from: readonly string[]; 'from-outside': readonly string[] }

function originOf(v: OriginValues): Origin<string> | null {
  if (v.brought && v.made) throw new UsageError(ORIGIN_HELP)
  if (!v.brought && (v.source !== null || v.by !== null)) throw new UsageError('--source 和 --by 只跟 --brought 一起用。')
  if (!v.made && (v.from.length > 0 || v['from-outside'].length > 0)) throw new UsageError('--from 和 --from-outside 只跟 --made 一起用。')
  if (v.brought) return { kind: 'brought', source: v.source, by: v.by }
  if (v.made) return { kind: 'made', from: [...v.from], outside: [...v['from-outside']] }
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
async function putRequest(v: OriginValues & { what: string; to: string | null; note: string | null; observed: boolean }, { bound, cwd, stdin }: VerbCall): Promise<PutRequest> {
  const { what: first, to, note, observed } = v
  const origin = originOf(v)
  if (observed && (origin?.kind !== 'brought' || origin.by !== 'owner' || to !== null || first === '-')) throw new UsageError(OBSERVED_HELP)
  if (first === '-') {
    if (to === null) throw new UsageError('从标准输入放进来要写 --to <库内路径>。')
    return { kind: 'place', from: { kind: 'stdin', content: await stdin() }, to, origin: requireOrigin(origin), note }
  }
  const local = resolve(cwd, first)
  const onDisk = isAbsolute(first) || existsSync(local)
  if (onDisk && parseLibraryPath(bound.library.root, local) === null) {
    if (to === null) throw new UsageError('从库外放进来要写 --to <库内路径>。')
    const kind = statSync(local, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : 'file'
    return { kind: 'place', from: { kind, path: local }, to, origin: requireOrigin(origin), note }
  }
  const path = onDisk ? local : first
  if (to === null) return { kind: 'register', path, origin: requireOrigin(origin), note, ...(observed ? { observed: true as const } : {}) }
  if (origin || note !== null) throw new UsageError('在库里挪位置不需要 --brought、--made 或 --note。')
  return { kind: 'move', from: path, to }
}

function sinceOf(value: string | null): Instant | 'last' | null {
  if (value === null || value === 'last') return value
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new UsageError(`--since 要写 last 或一个时间，比如 2026-11-25T08:00:00Z：${value}`)
  return new Date(t).toISOString() as Instant
}

const INCLUDE_ARCHIVED = { name: 'include-archived', hint: '也找归档区里的', kind: 'boolean' } as const

const ASK_HELP = 'ask 要写为什么，再跟上主人的命令和它的参数：ask "<为什么>" <主人的命令…>；撤回自己提的：ask --withdraw <请求号>。'

/** The owner command the words name, and its arguments read by its params; words that name none are left for the kernel to refuse. */
function askedCommand(words: readonly string[], library: Library): { command: string; args: OwnerArgs } {
  const line: Line = { grant: null, global: new Map(), rest: [...words] }
  const typed = leadingWords(line)
  const named = matchCommand(ownerFace.commands(library.plugins), typed)
  return named === undefined ? { command: (typed.length > 0 ? typed : words).join(' '), args: { positional: [], flags: {} } } : { command: named.name, args: argsOf(named, line) }
}

const archiving = (kind: 'archive' | 'unarchive', summary: string): Verb =>
  verb({
    name: kind,
    summary,
    readOnly: false,
    params: { positional: [{ name: 'path', hint: '库内路径', required: true }] },
    run: async ({ path }, { bound: { ctx } }) => {
      const r = await agentFace.archive({ kind, path }, ctx)
      return answer(r, archiveText(kind, r))
    },
  })

/** The agent face's verbs, and `start` and `show`, which the command line adds: one table for both faces. */
export const VERBS: readonly Verb[] = [
  verb({
    name: 'start',
    summary: '开始一件事：记下在做什么，看库的变化与状况，找库里可能相关的',
    readOnly: false,
    params: { positional: [{ name: 'sentence', hint: '一句话，说要做什么', required: true, words: true }] },
    run: async ({ sentence }, { bound: { library, ctx } }) => {
      const say = await agentFace.say({ kind: 'doing', about: null, text: sentence, args: {} }, ctx)
      const check = await agentFace.check({ since: 'last', includeArchived: false }, ctx)
      const find = await agentFace.find({ text: sentence, match: 'words', filters: {}, includeArchived: false, skipOwnSession: true }, ctx)
      return { ...startAnswer(say, check, find, sentence, ownerFace.commands(library.plugins), library.root), exit: exitOf(say, check, find) }
    },
  }),
  verb({
    name: 'find',
    summary: '找库里以前的资料和成果：名字里含任一段文字的，和插件知道的',
    readOnly: true,
    params: {
      positional: [{ name: 'text', hint: '文字', words: true }],
      flags: [
        INCLUDE_ARCHIVED,
        { name: 'scene', hint: '场景号：只要这个场景的', kind: 'value' },
        { name: 'origin', hint: 'brought 或 made：只要带进来的或做出来的', kind: 'value' },
        { name: 'page', hint: `第几页，每页 ${FIND_ROWS} 样；不写是第 1 页`, kind: 'value', pattern: '[1-9][0-9]{0,5}' },
      ],
    },
    run: async ({ text, scene, origin, 'include-archived': includeArchived, page }, { bound: { ctx } }) => {
      const filters = Object.fromEntries(Object.entries({ scene, origin }).filter((e): e is [string, string] => e[1] !== null))
      const r = await agentFace.find({ text, match: 'terms', filters, includeArchived, skipOwnSession: false }, ctx)
      const words = [...(text === null ? [] : [quote(text)]), ...Object.entries(filters).flatMap(([k, v]) => [`--${k}`, quote(v)]), ...(includeArchived ? ['--include-archived'] : [])]
      return { ...findAnswer(r, page === null ? 1 : Number(page), (n) => ['find', ...words, '--page', String(n)].join(' ')), exit: exitOf(r) }
    },
  }),
  verb({
    name: 'inspect',
    summary: '看关于一样东西知道的一切；加 content 也给它的内容，给读不了文件的 agent',
    readOnly: true,
    params: {
      positional: [
        { name: 'target', hint: '库内路径、条目号或场景号', required: true },
        { name: 'file', hint: '带标记的目录里的一个文件，相对这个目录，跟 content 一起写' },
      ],
      flags: [
        { name: 'content', hint: '也给内容：UTF-8 文字给全文，别的给大小和种类，带标记的目录给文件清单', kind: 'boolean' },
        { name: 'fetch', hint: '内容不在这台机器上时先取回来，跟 content 一起写', kind: 'boolean' },
      ],
    },
    run: async ({ target, file, content, fetch }, { bound: { ctx } }) => {
      if (file !== null && !content) throw new UsageError(`${file}：目录里的文件跟 --content 一起写：inspect ${target} --content ${file}`)
      if (fetch && !content) throw new UsageError(`--fetch 跟 --content 一起写：inspect ${target} --content --fetch`)
      const r = await agentFace.inspect({ target, ...(content ? { content: { file, ...(fetch ? { fetch: true } : {}) } } : {}) }, ctx)
      return { json: r, lines: inspectText(target, r, file), exit: exitOf(r) }
    },
  }),
  verb({
    name: 'put',
    summary: '把库外的文件或目录、或一段内容放进库里，说明来历；或登记库里已有的，或在库里挪位置',
    readOnly: false,
    params: {
      positional: [{ name: 'what', hint: '这台机器上库外的文件或目录（写绝对路径），或库内路径；- 是标准输入', required: true }],
      flags: [
        { name: 'to', hint: '放到的库内路径；在库里挪位置时是新路径', kind: 'value' },
        { name: 'brought', hint: '带进来的：网页、文档、主人给的文件', kind: 'boolean' },
        { name: 'made', hint: '做出来的', kind: 'boolean' },
        { name: 'source', hint: '出处，跟 brought 一起写', kind: 'value' },
        { name: 'by', hint: '谁带进来的，只能写 owner，跟 brought 一起写', kind: 'value' },
        { name: 'from', hint: '依据库里的哪些，库内路径，跟 made 一起写', kind: 'list' },
        { name: 'from-outside', hint: '依据库外的什么，各一句话，跟 made 一起写', kind: 'list' },
        { name: 'note', hint: '一句话，说这次放入改了什么', kind: 'value' },
        { name: 'observed', hint: '来历是主人这边自动看到的，不是谁说的；只给主人，跟 brought 和 by owner 一起写', kind: 'boolean' },
      ],
      stdin: 'what',
    },
    run: async (values, call) => {
      const req = await putRequest(values, call)
      const r = await agentFace.put(req, call.bound.ctx)
      return answer(r, putText(req, r))
    },
  }),
  verb({
    name: 'say',
    summary: '对库说一句话，由听得懂这个种类的插件记下',
    readOnly: false,
    params: {
      positional: [
        { name: 'kind', hint: '种类，比如 doing、note', required: true },
        { name: 'about', hint: '关于什么：库内路径或别的标识' },
        { name: 'text', hint: '内容' },
      ],
      more: { name: 'args', hint: '听这个种类的插件的开关，各写成值的列表，比如 {"from": ["a.md", "b.md"]}；不带值的开关写空列表', each: 'list' },
      fromEnd: true,
    },
    run: async ({ kind, about, text, args }, { bound: { ctx } }) => {
      const r = await agentFace.say({ kind, about, text, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, [...v]])) }, ctx)
      return answer(r, sayText(r))
    },
  }),
  verb({
    name: 'check',
    summary: '库的变化与状况',
    readOnly: true,
    params: {
      positional: [{ name: 'dir', hint: '只和 --deep 一起写：深查哪个目录，不写是整个库' }],
      flags: [
        { name: 'since', hint: '从什么时候起：last（上次查之后）或一个时间，比如 2026-11-25T08:00:00Z', kind: 'value' },
        INCLUDE_ARCHIVED,
        { name: 'deep', hint: '深查：读每样登记过的东西的内容，比出真正改了的；先说要读多少，可以随时打断', kind: 'boolean' },
      ],
    },
    run: async ({ dir, since, 'include-archived': includeArchived, deep }, { bound: { library, ctx } }) => {
      if (dir !== null && !deep) throw new UsageError('目录只和 --deep 一起写：check --deep <目录>')
      const scope = dir === null || dir === '.' ? null : parseLibraryPath(library.root, dir)
      if (dir !== null && dir !== '.' && scope === null) throw new UsageError(`这不是库里的目录：${dir}`)
      const r = await agentFace.check({ since: sinceOf(since), includeArchived, ...(deep ? { deep: { dir: scope } } : {}) }, ctx)
      return { ...checkAnswer(r, ownerFace.commands(library.plugins), library.root), exit: exitOf(r) }
    },
  }),
  archiving('archive', '不用了，把一样东西归档：不删，默认的找和查不再带它'),
  archiving('unarchive', '把归档的东西取回原来的路径'),
  verb({
    name: 'ask',
    summary: '请主人做一条只有主人能做的命令：写明为什么，跟上那条命令和它的参数；主人在首页上批准或拒绝，结果在你下次 check 里',
    readOnly: false,
    params: {
      positional: [
        { name: 'why', hint: '为什么：一句话，主人据它决定批不批' },
        { name: 'command', hint: '主人的命令和它的参数，照命令行的写法，比如 plugin add version', many: true },
      ],
      flags: [{ name: 'withdraw', hint: '撤回自己提的、还在等的一个请求：请求号', kind: 'value' }],
      raw: 'command',
    },
    run: async ({ why, command, withdraw }, { bound: { library, ctx } }) => {
      if (withdraw !== null && (why !== null || command.length > 0)) throw new UsageError('撤回只写 ask --withdraw <请求号>。')
      if (withdraw === null && (why === null || command.length === 0)) throw new UsageError(ASK_HELP)
      const req: AskRequest = withdraw !== null ? { kind: 'withdraw', id: withdraw } : { kind: 'ask', why: why as string, ...askedCommand(command, library) }
      const r = await agentFace.ask(req, ctx)
      if (r.outcome === 'refused' && r.reason === 'usage') throw new UsageError(r.text)
      return answer(r, askText(r))
    },
  }),
  verb({
    name: 'show',
    summary: '看主人在管理界面上看到的一页，只读；不写编号列出这个库的页',
    readOnly: true,
    params: {
      positional: [{ name: 'view', hint: '页的编号' }],
      more: { name: 'params', hint: '页的参数，比如条目面板 {"path": "notes/a.md"}', each: 'value' },
    },
    run: async ({ view, params }, { bound: { library, ctx, viaGrant }, table, env }) => {
      if (view === null) {
        const list = viewerFace.views(library)
        return { json: list, lines: viewListText(list), exit: exitOf(list) }
      }
      // The text form shows the first rows of a long list and the command for more, as --json does.
      const r = await viewerFace.show({ view, params: { ...params }, size: TEXT_ROWS }, { ctx, table, env, viaGrant })
      if (r.outcome === 'no-such-view') throw new UsageError(`这个库没有这一页：${view}。pneuma-base show 列出这个库的页。`)
      if (r.outcome === 'refused') return answer(r, [`拒绝（${r.reason}）：${r.text}`])
      const decl = viewerFace.views(library).views.find((v) => v.id === view)
      return { json: r, lines: pageText(r, ownerFace.commands(library.plugins), { view, params: { ...params } }, decl), exit: exitOf(r) }
    },
  }),
]
