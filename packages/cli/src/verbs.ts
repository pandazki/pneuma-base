// The agent face as its faces offer it: each verb's arguments as data, and what it runs and answers.
// The command line reads a verb's words by this table, the MCP server makes a tool's input schema
// from it, and both call the same `run`, so the two faces answer the same. ARCHITECTURE.md「一张命令表生成各个面」.
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
 * last, as `say <类型> <内容>`. `raw`: the `many` positional that takes the rest of the command line as
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
  '需声明来源：导入的条目用 --imported（可加 --source <原始来源>、--by owner），生成的条目用 --generated（可加 --from <库内路径…>、--from-external "<说明…>"）。两者只能选其一。'

const OBSERVED_HELP = '--observed 仅用于登记资料库中已有的条目，需与 --imported --by owner 同时使用：表示由所有者一侧自动检测到、未声明来源的条目，例如应用登记所有者拷入资料库的文件。'

type OriginValues = { imported: boolean; generated: boolean; source: string | null; by: string | null; from: readonly string[]; 'from-external': readonly string[] }

function originOf(v: OriginValues): Origin<string> | null {
  if (v.imported && v.generated) throw new UsageError(ORIGIN_HELP)
  if (!v.imported && (v.source !== null || v.by !== null)) throw new UsageError('--source 和 --by 只能与 --imported 同时使用。')
  if (!v.generated && (v.from.length > 0 || v['from-external'].length > 0)) throw new UsageError('--from 和 --from-external 只能与 --generated 同时使用。')
  if (v.imported) return { kind: 'brought', source: v.source, by: v.by }
  if (v.generated) return { kind: 'made', from: [...v.from], outside: [...v['from-external']] }
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
    if (to === null) throw new UsageError('从标准输入添加时需指定 --to <库内路径>。')
    return { kind: 'place', from: { kind: 'stdin', content: await stdin() }, to, origin: requireOrigin(origin), note }
  }
  const local = resolve(cwd, first)
  const onDisk = isAbsolute(first) || existsSync(local)
  if (onDisk && parseLibraryPath(bound.library.root, local) === null) {
    if (to === null) throw new UsageError('从外部添加时需指定 --to <库内路径>。')
    const kind = statSync(local, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : 'file'
    return { kind: 'place', from: { kind, path: local }, to, origin: requireOrigin(origin), note }
  }
  const path = onDisk ? local : first
  if (to === null) return { kind: 'register', path, origin: requireOrigin(origin), note, ...(observed ? { observed: true as const } : {}) }
  if (origin || note !== null) throw new UsageError('在资料库内移动时不使用 --imported、--generated 或 --note。')
  return { kind: 'move', from: path, to }
}

function sinceOf(value: string | null): Instant | 'last' | null {
  if (value === null || value === 'last') return value
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new UsageError(`--since 的值应为 last 或时间，例如 2026-11-25T08:00:00Z：${value}`)
  return new Date(t).toISOString() as Instant
}

const INCLUDE_ARCHIVED = { name: 'include-archived', hint: '包含已归档', kind: 'boolean' } as const

const ASK_HELP = 'ask 需写明原因，后接所有者命令及其参数：ask "<原因>" <所有者命令…>；撤回自己提交的请求：ask --withdraw <请求编号>。'

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
    summary: '开始一项任务：记录任务描述，查看资料库的变化与状态，搜索可能相关的条目',
    readOnly: false,
    params: { positional: [{ name: 'sentence', hint: '任务描述', required: true, words: true }] },
    run: async ({ sentence }, { bound: { library, ctx } }) => {
      const say = await agentFace.say({ kind: 'task', about: null, text: sentence, args: {} }, ctx)
      const check = await agentFace.check({ since: 'last', includeArchived: false }, ctx)
      const find = await agentFace.find({ text: sentence, match: 'words', filters: {}, includeArchived: false, skipOwnSession: true }, ctx)
      return { ...startAnswer(say, check, find, sentence, ownerFace.commands(library.plugins), library.root), exit: exitOf(say, check, find) }
    },
  }),
  verb({
    name: 'find',
    summary: '搜索资料库中已有的资料和成果：名称含任一关键词的条目，以及插件返回的结果',
    readOnly: true,
    params: {
      positional: [{ name: 'text', hint: '关键词', words: true }],
      flags: [
        INCLUDE_ARCHIVED,
        { name: 'scene', hint: '场景编号：仅限该场景的条目', kind: 'value' },
        { name: 'origin', hint: 'imported 或 generated：仅限导入或生成的条目', kind: 'value' },
        { name: 'page', hint: `页码，每页 ${FIND_ROWS} 个条目；默认为第 1 页`, kind: 'value', pattern: '[1-9][0-9]{0,5}' },
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
    summary: '查看条目的全部信息；加 content 时同时返回其内容，供无法读取文件的 Agent 使用',
    readOnly: true,
    params: {
      positional: [
        { name: 'target', hint: '库内路径、条目编号或场景编号', required: true },
        { name: 'file', hint: '带标记的目录中的文件，路径相对于该目录，需与 content 同时使用' },
      ],
      flags: [
        { name: 'content', hint: '同时返回内容：UTF-8 文本返回全文，其他文件返回大小和类型，带标记的目录返回文件列表', kind: 'boolean' },
        { name: 'fetch', hint: '内容未下载时先下载，需与 content 同时使用', kind: 'boolean' },
      ],
    },
    run: async ({ target, file, content, fetch }, { bound: { ctx } }) => {
      if (file !== null && !content) throw new UsageError(`${file}：读取目录中的文件需使用 --content：inspect ${target} --content ${file}`)
      if (fetch && !content) throw new UsageError(`--fetch 需与 --content 同时使用：inspect ${target} --content --fetch`)
      const r = await agentFace.inspect({ target, ...(content ? { content: { file, ...(fetch ? { fetch: true } : {}) } } : {}) }, ctx)
      return { json: r, lines: inspectText(target, r, file), exit: exitOf(r) }
    },
  }),
  verb({
    name: 'put',
    summary: '将外部文件、目录或一段内容添加到资料库并声明来源；或登记资料库中已有的条目；或在资料库内移动条目',
    readOnly: false,
    params: {
      positional: [{ name: 'what', hint: '本机的外部文件或目录（绝对路径），或库内路径；- 表示标准输入', required: true }],
      flags: [
        { name: 'to', hint: '目标库内路径；在资料库内移动时为新路径', kind: 'value' },
        { name: 'imported', hint: '导入：网页、文档、所有者提供的文件', kind: 'boolean' },
        { name: 'generated', hint: '生成：基于其他条目或资料生成的成果', kind: 'boolean' },
        { name: 'source', hint: '原始来源，需与 imported 同时使用', kind: 'value' },
        { name: 'by', hint: '导入者，仅可为 owner，需与 imported 同时使用', kind: 'value' },
        { name: 'from', hint: '依据的条目（库内路径），需与 generated 同时使用', kind: 'list' },
        { name: 'from-external', hint: '外部依据，每项一条说明，需与 generated 同时使用', kind: 'list' },
        { name: 'note', hint: '本次修改的说明', kind: 'value' },
        { name: 'observed', hint: '来源由所有者一侧自动检测，而非声明；仅所有者，需与 imported 和 by owner 同时使用', kind: 'boolean' },
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
    summary: '记录一条信息，由声明该类型的插件保存',
    readOnly: false,
    params: {
      positional: [
        { name: 'kind', hint: '类型，例如 task、note', required: true },
        { name: 'about', hint: '对象：库内路径或其他标识' },
        { name: 'text', hint: '内容' },
      ],
      more: { name: 'args', hint: '处理该类型的插件的选项，每项写成值的列表，例如 {"from": ["a.md", "b.md"]}；无值的选项写空列表', each: 'list' },
      fromEnd: true,
    },
    run: async ({ kind, about, text, args }, { bound: { ctx } }) => {
      const r = await agentFace.say({ kind, about, text, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, [...v]])) }, ctx)
      return answer(r, sayText(r))
    },
  }),
  verb({
    name: 'check',
    summary: '资料库的变化与状态',
    readOnly: true,
    params: {
      positional: [{ name: 'dir', hint: '仅与 --deep 同时使用：深度检查的目录，默认为整个资料库' }],
      flags: [
        { name: 'since', hint: '开始时间：last（上次检查之后）或时间，例如 2026-11-25T08:00:00Z', kind: 'value' },
        INCLUDE_ARCHIVED,
        { name: 'deep', hint: '深度检查：读取每个已登记条目的内容，找出实际修改的条目；开始前给出读取量，可随时中断', kind: 'boolean' },
      ],
    },
    run: async ({ dir, since, 'include-archived': includeArchived, deep }, { bound: { library, ctx } }) => {
      if (dir !== null && !deep) throw new UsageError('目录参数仅与 --deep 同时使用：check --deep <目录>')
      const scope = dir === null || dir === '.' ? null : parseLibraryPath(library.root, dir)
      if (dir !== null && dir !== '.' && scope === null) throw new UsageError(`不是资料库中的目录：${dir}`)
      const r = await agentFace.check({ since: sinceOf(since), includeArchived, ...(deep ? { deep: { dir: scope } } : {}) }, ctx)
      return { ...checkAnswer(r, ownerFace.commands(library.plugins), library.root), exit: exitOf(r) }
    },
  }),
  archiving('archive', '归档不再使用的条目：不删除，默认的搜索和检查不再包含它'),
  archiving('unarchive', '取消归档，将条目恢复到原路径'),
  verb({
    name: 'ask',
    summary: '请求所有者执行一条仅所有者可执行的命令：写明原因，后接该命令及其参数；所有者在首页批准或拒绝，结果见下次 check',
    readOnly: false,
    params: {
      positional: [
        { name: 'why', hint: '原因：所有者据此决定是否批准' },
        { name: 'command', hint: '所有者命令及其参数，按命令行写法，例如 plugin enable version', many: true },
      ],
      flags: [{ name: 'withdraw', hint: '撤回自己提交的待处理请求：请求编号', kind: 'value' }],
      raw: 'command',
    },
    run: async ({ why, command, withdraw }, { bound: { library, ctx } }) => {
      if (withdraw !== null && (why !== null || command.length > 0)) throw new UsageError('撤回请求的写法为 ask --withdraw <请求编号>。')
      if (withdraw === null && (why === null || command.length === 0)) throw new UsageError(ASK_HELP)
      const req: AskRequest = withdraw !== null ? { kind: 'withdraw', id: withdraw } : { kind: 'ask', why: why as string, ...askedCommand(command, library) }
      const r = await agentFace.ask(req, ctx)
      if (r.outcome === 'refused' && r.reason === 'usage') throw new UsageError(r.text)
      return answer(r, askText(r))
    },
  }),
  verb({
    name: 'show',
    summary: '查看所有者在管理界面中看到的页面，只读；不写页面 ID 时列出此资料库的页面',
    readOnly: true,
    params: {
      positional: [{ name: 'view', hint: '页面 ID' }],
      more: { name: 'params', hint: '页面参数，例如条目面板 {"path": "notes/a.md"}', each: 'value' },
    },
    run: async ({ view, params }, { bound: { library, ctx, viaGrant }, table, env }) => {
      if (view === null) {
        const list = viewerFace.views(library)
        return { json: list, lines: viewListText(list), exit: exitOf(list) }
      }
      // The text form shows the first rows of a long list and the command for more, as --json does.
      const r = await viewerFace.show({ view, params: { ...params }, size: TEXT_ROWS }, { ctx, table, env, viaGrant })
      if (r.outcome === 'no-such-view') throw new UsageError(`此资料库没有该页面：${view}。pneuma-base show 列出此资料库的页面。`)
      if (r.outcome === 'refused') return answer(r, [`拒绝（${r.reason}）：${r.text}`])
      const decl = viewerFace.views(library).views.find((v) => v.id === view)
      return { json: r, lines: pageText(r, ownerFace.commands(library.plugins), { view, params: { ...params } }, decl), exit: exitOf(r) }
    },
  }),
]
