// The API face of one library: the verbs and the business owner commands as MCP tools, generated from
// the table the command line reads, answering what the command line answers; the description and the
// pages as resources. Management is not listed, and a call to it by name meets the owner face's gate.
// ARCHITECTURE.md「MCP 服务」.
import {
  describeLibrary,
  identifyActor,
  loadPlugins,
  makeContext,
  ownerFace,
  resolveGrant,
  viewerFace,
  type Env,
  type OwnerArgs,
  type OwnerCommandInfo,
  type OwnerParams,
  type PluginTable,
  type Session,
} from '@pneuma-base/kernel'
import { UsageError } from '../args.js'
import { ownerText } from '../format.js'
import { answer, refusal, VERBS, type Answer, type Bound, type Verb, type VerbInput, type VerbParams } from '../verbs.js'
import type { Face, JsonSchema, Resource, ResourceText, Tool, ToolResult } from './server.js'

/** Written for this face, ahead of the library's description: how its command lines become tools, how put takes content, where management is. */
const PREAMBLE = [
  '你经 MCP 连着一个 Pneuma Base 库，下面是这个库的说明。',
  '说明里的每一条命令行 `pneuma-base @<你的授权名> <命令> …` 就是同名的工具，参数相同：位置参数和开关都写成同名的属性（`--include-archived` 写成 `include-archived`），主人命令名里的空格换成 `_`（`space list` 是工具 `space_list`）；`@<你的授权名>` 已由这次连接定下，不用写。',
  '`put` 放这台机器上库外的文件或目录时，`what` 写它的绝对路径；把一段内容直接放进来时不写 `what`，文字写在 `text`，字节用 base64 写在 `base64`，再写 `to`。',
  '库里的文件你读不到磁盘，要看内容就用 `inspect` 加 `content: true`；带标记的目录先给出文件清单，再写 `file` 读其中一个。',
  '这次连接是一次会话，你做的事都记在你的授权名下；发授权、装卸插件、设密钥、清空归档区这些管理的事由主人在管理界面上做，这里没有它们的工具。',
  '需要主人做其中一件不丢数据的，用 `ask`：`why` 写为什么，`command` 是那条命令的词和参数，比如 `["plugin", "add", "version"]`；主人批准就照原样运行，结果在你下次 `check` 里。',
].join('')

const DESCRIPTION_URI = 'pneuma-base://library/description'
const PAGE_URI = 'pneuma-base://library/show/'

/** An owner command's tool name: its words joined with `_`, as `space list` is `space_list`. */
const toolName = (command: string) => command.replaceAll(' ', '_')

/** What an agent's session may run: neither destructive nor only the owner's. */
const isBusiness = (c: OwnerCommandInfo) => !c.destructive && !c.ownerOnly

const whole = (pattern: string) => `^(?:${pattern})$`
const textSchema = (description: string, pattern?: string): JsonSchema => ({ type: 'string', description, ...(pattern === undefined ? {} : { pattern: whole(pattern) }) })
const listSchema = (description: string, pattern?: string): JsonSchema => ({ type: 'array', items: textSchema(description, pattern), description })

/**
 * A tool's input schema from a verb's or a command's arguments: each positional and flag a property of
 * its name, a text or a list of texts or true or false by its kind, its hint the description, with its
 * pattern, options and whether it is required. Flags the verb does not declare are one object under
 * `more`'s name; a verb that reads standard input takes the content as `text` or `base64` instead.
 */
function schemaOf(params: VerbParams): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const p of params.positional ?? []) {
    properties[p.name] = p.many ? listSchema(p.hint, p.pattern) : textSchema(p.hint, p.pattern)
    if (p.required && p.name !== params.stdin) required.push(p.name)
  }
  for (const f of params.flags ?? []) {
    if (f.kind === 'boolean') properties[f.name] = { type: 'boolean', description: f.hint }
    else if (f.kind === 'list') properties[f.name] = listSchema(f.hint, f.pattern)
    else if (f.options) properties[f.name] = { ...textSchema(`${f.hint}：${f.options.map((o) => `${o.value} 是${o.label}`).join('，')}`, f.pattern), enum: f.options.map((o) => o.value) }
    else properties[f.name] = textSchema(f.hint, f.pattern)
    if (f.required) required.push(f.name)
  }
  const { more, stdin } = params
  if (more) properties[more.name] = { type: 'object', description: more.hint, additionalProperties: more.each === 'list' ? { type: 'array', items: { type: 'string' } } : { type: 'string' } }
  if (stdin !== undefined) {
    properties.text = textSchema(`直接放进来的内容，文字（UTF-8）。写了它就不写 ${stdin}，要写 to`)
    properties.base64 = { type: 'string', contentEncoding: 'base64', description: `直接放进来的内容，字节的 base64。写了它就不写 ${stdin}，要写 to` }
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/

/**
 * A verb's values from a tool call's arguments, by its table; a usage error says what does not fit.
 * Inline content stands for standard input: the `stdin` positional is then `-`.
 */
function toolValues({ name, params }: Verb, args: Readonly<Record<string, unknown>>): { values: VerbInput; stdin: Uint8Array | null } {
  const { positional = [], flags = [], more, stdin: stdinAt } = params
  const known = [...positional, ...flags].map((p) => p.name).concat(more ? [more.name] : [], stdinAt === undefined ? [] : ['text', 'base64'])
  const unknown = Object.keys(args).find((key) => !known.includes(key))
  if (unknown !== undefined) throw new UsageError(`${name} 不认识 ${unknown}`)
  const textOf = (key: string, v: unknown): string | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') throw new UsageError(`${name} 的 ${key} 要是文字`)
    return v
  }
  const listOf = (key: string, v: unknown): string[] => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new UsageError(`${name} 的 ${key} 要是文字的列表`)
    return v
  }
  const values: Record<string, VerbInput[string]> = {}
  let stdin: Uint8Array | null = null
  if (stdinAt !== undefined) {
    const content = textOf('text', args.text)
    const encoded = textOf('base64', args.base64)
    if (content !== null && encoded !== null) throw new UsageError(`${name} 的 text 和 base64 只能写一个`)
    if (encoded !== null && !BASE64.test(encoded)) throw new UsageError(`${name} 的 base64 不是 base64`)
    if (content !== null || encoded !== null) {
      const at = textOf(stdinAt, args[stdinAt])
      if (at !== null && at !== '-') throw new UsageError(`写了 ${content !== null ? 'text' : 'base64'} 就不写 ${stdinAt}：内容直接放进来`)
      stdin = content !== null ? Buffer.from(content, 'utf8') : Buffer.from(encoded as string, 'base64')
      values[stdinAt] = '-'
    }
  }
  for (const p of positional) {
    if (p.name in values) continue
    const v = p.many ? listOf(p.name, args[p.name]) : textOf(p.name, args[p.name])
    if (p.required && (v === null || (Array.isArray(v) && v.length === 0))) throw new UsageError(`${name} 少了 ${p.name}（${p.hint}）`)
    values[p.name] = v
  }
  for (const f of flags) {
    const v = args[f.name]
    if (f.kind !== 'boolean') values[f.name] = f.kind === 'list' ? listOf(f.name, v) : textOf(f.name, v)
    else if (v === undefined || v === null || typeof v === 'boolean') values[f.name] = v === true
    else throw new UsageError(`${name} 的 ${f.name} 要是 true 或 false`)
  }
  if (more) {
    const given = args[more.name] ?? {}
    if (typeof given !== 'object' || given === null || Array.isArray(given)) throw new UsageError(`${name} 的 ${more.name} 要是一个对象`)
    const each = (k: string, v: unknown) => (more.each === 'list' ? listOf(`${more.name}.${k}`, v) : (textOf(`${more.name}.${k}`, v) ?? ''))
    values[more.name] = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, each(k, v)]))
  }
  return { values, stdin }
}

/**
 * An owner command's arguments from a tool call's, as the command line would write them, left for the
 * owner face to check as it checks the command line's: positionals in order, a flag true as a switch,
 * false as not written, anything else as its values.
 */
function ownerArgs(params: OwnerParams, args: Readonly<Record<string, unknown>>): OwnerArgs {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
  const names = (params.positional ?? []).map((p) => p.name)
  const positional = (params.positional ?? []).flatMap((p) => (args[p.name] === undefined || args[p.name] === null ? [''] : strings(args[p.name])))
  while (positional.at(-1) === '') positional.pop()
  const flags = Object.entries(args)
    .filter(([k, v]) => !names.includes(k) && v !== false && v !== undefined && v !== null)
    .map(([k, v]): [string, string[] | true] => [k, v === true ? true : strings(v)])
  return { positional, flags: Object.fromEntries(flags) }
}

function result(a: Answer): ToolResult {
  return { content: [{ type: 'text', text: a.lines.join('\n') }], structuredContent: a.json, isError: a.exit === 2 }
}

/** A usage error as a refusal, as the owner face words one: the command line prints the same sentence after 用法错误. */
const usage = (text: string): ToolResult => ({ content: [{ type: 'text', text: `用法错误：${text}` }], structuredContent: { outcome: 'refused', reason: 'usage', text, problems: [] }, isError: true })

export type LibraryFaceOptions = { grant: string; home: string; builtins: PluginTable; env: Env; cwd: string; session: Session }

/**
 * The library a grant names, as a `Face`. Each request rebuilds the plugin table and reopens the
 * library through the grant, as each command line does, so a plugin added, removed or revoked grant
 * is seen at once. The actor is the grant's agent and the session is the connection's.
 */
export function libraryFace({ grant, home, builtins, env, cwd, session }: LibraryFaceOptions): Face {
  async function now(): Promise<{ bound: Bound; table: PluginTable } | Answer> {
    const table = await loadPlugins(home, builtins)
    const r = await resolveGrant(home, grant, table)
    if (!r.ok) return refusal(r.reason, r.text)
    const actor = identifyActor({ grant: r.grant, as: null, env: {} })
    return { bound: { library: r.library, ctx: makeContext(r.library, actor, session, home), viaGrant: true }, table }
  }

  const runVerb = (verb: Verb, args: Readonly<Record<string, unknown>>, { bound, table }: { bound: Bound; table: PluginTable }): Promise<Answer> => {
    const { values, stdin } = toolValues(verb, args)
    const content = async () => {
      if (stdin === null) throw new UsageError(`${verb.name} 的内容用 text 或 base64 给`)
      return stdin
    }
    return verb.run(values, { bound, table, env, cwd, stdin: content })
  }

  async function runCommand(command: OwnerCommandInfo, args: Readonly<Record<string, unknown>>, { bound, table }: { bound: Bound; table: PluginTable }): Promise<Answer> {
    const call = { ctx: bound.ctx, table, env, viaGrant: true, confirm: async () => false, readSecret: async () => null }
    const r = await ownerFace.dispatch(call, command.name, ownerArgs(command.params, args))
    if (r.outcome === 'refused' && r.reason === 'usage') throw new UsageError(r.text)
    return answer(r, ownerText(r))
  }

  const show = (at: { bound: Bound; table: PluginTable }, view: string) => runVerb(VERBS.find((v) => v.name === 'show') as Verb, { view }, at)

  async function instructions(): Promise<string> {
    const at = await now()
    return `${PREAMBLE}\n\n${'exit' in at ? at.lines.join('\n') : (await describeLibrary(at.bound.ctx)).text}`
  }

  return {
    instructions,

    async tools() {
      const at = await now()
      const commands = 'exit' in at ? [] : ownerFace.commands(at.bound.library.plugins).filter(isBusiness)
      const tools: Tool[] = [
        ...VERBS.map((v) => ({ name: v.name, description: v.summary, inputSchema: schemaOf(v.params), annotations: { readOnlyHint: v.readOnly, destructiveHint: false } })),
        ...commands.map((c) => ({ name: toolName(c.name), description: c.summary, inputSchema: schemaOf(c.params), annotations: { readOnlyHint: c.readOnly, destructiveHint: false } })),
      ]
      return tools.filter((t, i) => tools.findIndex((u) => u.name === t.name) === i)
    },

    async call(name, args) {
      const at = await now()
      try {
        if ('exit' in at) return result(at)
        const verb = VERBS.find((v) => v.name === name)
        if (verb) return result(await runVerb(verb, args, at))
        const command = ownerFace.commands(at.bound.library.plugins).find((c) => toolName(c.name) === name)
        return command ? result(await runCommand(command, args, at)) : null
      } catch (error) {
        if (error instanceof UsageError) return usage(error.message)
        const message = error instanceof Error ? error.message : String(error)
        return { content: [{ type: 'text', text: `出错：${message}` }], structuredContent: { outcome: 'failed', message }, isError: true }
      }
    },

    async resources() {
      const at = await now()
      if ('exit' in at) return []
      const pages = viewerFace.views(at.bound.library).views.filter((v) => v.nav && v.ownerOnly !== true)
      const description: Resource = { uri: DESCRIPTION_URI, name: 'description', title: '这个库的说明', mimeType: 'text/markdown' }
      return [description, ...pages.map((v): Resource => ({ uri: `${PAGE_URI}${v.id}`, name: v.id, title: v.title, description: `show ${v.id}`, mimeType: 'text/plain' }))]
    },

    async read(uri): Promise<ResourceText | null> {
      if (uri === DESCRIPTION_URI) return { uri, mimeType: 'text/markdown', text: await instructions() }
      if (!uri.startsWith(PAGE_URI)) return null
      const at = await now()
      if ('exit' in at) return { uri, mimeType: 'text/plain', text: at.lines.join('\n') }
      try {
        return { uri, mimeType: 'text/plain', text: (await show(at, uri.slice(PAGE_URI.length))).lines.join('\n') }
      } catch (error) {
        if (error instanceof UsageError) return null
        throw error
      }
    },
  }
}
