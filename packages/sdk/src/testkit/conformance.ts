// The behavioural rules of the plugin standard, as checks run against the real command line on
// temporary libraries. Each check reports what is wrong in Chinese, with the rule it breaks.
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT, KERNEL_COMMAND_NAMES, RESERVED_PLUGIN_NAMES } from '../index.js'
import type { Action, Block, Plugin } from '../types.js'
import { runProcess, type Result } from './run.js'
import { sandbox, type Sandbox, type SandboxOptions, type Viewer } from './sandbox.js'

export const CHECKS = ['loads', 'names', 'cognition', 'examples', 'hooks', 'writes', 'bounded', 'cache', 'catchup', 'blocks', 'remove'] as const
export type CheckName = (typeof CHECKS)[number]

/** What each check holds a plugin to, as the standard says it. */
export const RULES: Record<CheckName, string> = {
  loads: '插件目录的 index.js 默认导出一个插件，符合当前 pneuma-base 的插件契约（contract 为 sdk 的 CONTRACT，当前为 2），并通过加载时的校验',
  names: '所有者命令以「<插件名称> 」开头，视图 ID 以「<插件名称>.」开头，插件名称不是命令行或内核的保留词，命令名称不是内核命令',
  cognition: '认知段以「## <功能>：<用法>」开头，第一句为「此资料库已启用**<标题>**插件。」，命令示例写成 pneuma-base @{{授权的名字}} …，仅使用 {{授权的名字}} 这一个占位符，不重复内核负责的规则',
  examples: '认知段中的每条命令示例，在新资料库上完成准备步骤后，按原样在 Agent 会话中运行，退出码为 0',
  hooks: '每个钩子在空资料库上和每个基本命令之后均不抛出错误，答复中没有该插件报告的问题；登记资料库中已有的文件（插件收到的内容哈希为 null，凭 now.token 识别）和登记目录第一层的未登记文件（插件收到一次 register-files）时同样如此',
  writes: '插件只写入资料库中自己的目录 .pneuma-base/<插件名称>/；不改写、不删除其中已有的文件（声明为配置的文件、缓存目录和破坏性所有者命令除外）；生成视图和条目面板中的分节时不写入任何内容',
  bounded: '插件只向存储查询自身记录指向的位置，每次只取一页：一个钩子或命令中，对资料库内容的一览和探查合计不超过 1000 条；未登记的目录只在目录本身做有预算的探查，不做一览、不获取内容、不读取，其下的位置一概不查询',
  cache: '删除缓存不丢失任何信息：删除插件在本机的缓存目录、声明为缓存的目录和其记录区的行，前后 find、inspect、check 的答复相同',
  catchup: '在已有登记条目的资料库中启用后，经补录即可识别这些条目：对启用前添加的条目，find、inspect、check 和条目面板中插件的答复，与启用后添加的条目相同',
  blocks: '视图和条目面板中的分节返回的均为合法的块，钩子不抛出错误；每个操作调用一个基本命令或此资料库中存在的所有者命令，参数符合其参数表；custom 块带 text，以文字描述其绘制的内容；custom 块指向的页面位于插件的 ui 目录中，可以获取，载入 /plugin-kit/frame.js，并在脚本中调用 pneuma.onData',
  remove: '停用插件后资料库正常可用：配置和说明中不再有该插件，基本命令正常答复且无问题，界面不再列出其视图，内容无缺失',
}

/** Kernel rules a cognition section must not repeat: each phrase, and the rule it belongs to. */
const KERNEL_PHRASES: readonly [phrase: string, rule: string][] = [
  ['--include-archived', '搜索和检查默认不包含已归档的条目'],
  ['在库外写好', '在外部写好后再添加'],
  ['在外部写好', '在外部写好后再添加'],
]

const GRANT_PLACEHOLDER = '{{授权的名字}}'
const GRANT = 'conformance'
const AGENT = 'conformance-agent'
const SESSION = 'conformance'

export type SetupContext = {
  /** The sandbox of the library being checked: its owner, agent and viewer calls. */
  sandbox: Sandbox
  /** The agent's working directory: the examples run here, so files they bring in go here. */
  cwd: string
  /** A directory first on the examples' PATH, for stand-ins of outside commands such as curl. */
  bin: string
}

export type ConformanceOptions = {
  /** What a fresh library needs before the plugin's examples and the scripted run, such as a target the owner sets. */
  setup?: (s: SetupContext) => Promise<void>
  /** Files under the plugin's own directory that it replaces whole as configuration, relative to that directory. */
  configuration?: readonly string[]
} & Pick<SandboxOptions, 'env' | 'timeout' | 'cli'>

export type CheckResult = { name: CheckName; rule: string; ok: boolean; problems: string[] }
export type Report = { plugin: string; ok: boolean; checks: CheckResult[]; reminders: string[]; text: string }

/** A built plugin directory, or a plugin built into the command line, given as its object. */
export type Subject = string | { builtin: Plugin }

type Problems = Map<CheckName, string[]>

/**
 * Checks a plugin against the standard's behavioural rules: the checks in `CHECKS`, each on temporary
 * libraries through the real command line and viewer. Never throws for what it finds; read `ok`, or
 * `text` for what is wrong.
 */
export async function conformance(subject: Subject, options: ConformanceOptions = {}): Promise<Report> {
  const found: Problems = new Map(CHECKS.map((c) => [c, []]))
  const fail = (check: CheckName, what: string) => (found.get(check) as string[]).push(what)
  const reminders: string[] = []
  const dir = typeof subject === 'string' ? resolve(subject) : null
  const loaded = dir === null ? (subject as { builtin: Plugin }).builtin : await importPlugin(dir)
  if (typeof loaded === 'string') {
    fail('loads', loaded)
    for (const c of CHECKS.slice(1)) fail(c, '未检查：插件加载失败')
    return report(dir ?? '?', found, reminders)
  }
  const plugin = loaded
  checkNames(plugin, fail)
  checkCognition(plugin, fail, reminders)
  const install = dir === null ? { builtins: [plugin.name] } : { plugins: [dir] }
  try {
    await checkLibrary(plugin, install, options, fail, reminders)
    if ((found.get('loads') as string[]).length === 0) await checkExamples(plugin, install, options, fail, reminders)
    if ((found.get('loads') as string[]).length === 0) await checkCatchUp(plugin, install, options, fail, reminders)
  } catch (error) {
    fail('loads', error instanceof Error ? error.message : String(error))
  }
  if ((found.get('loads') as string[]).length > 0) {
    for (const c of ['examples', 'hooks', 'writes', 'bounded', 'cache', 'catchup', 'blocks', 'remove'] as const) if ((found.get(c) as string[]).length === 0) fail(c, '未检查：插件加载失败')
  }
  return report(plugin.name, found, reminders)
}

async function importPlugin(dir: string): Promise<Plugin | string> {
  try {
    const module = (await import(pathToFileURL(join(dir, 'index.js')).href)) as { default?: unknown }
    const p = module.default as Plugin | undefined
    if (typeof p !== 'object' || p === null || typeof p.name !== 'string') return `${dir}/index.js 的默认导出不是插件`
    return p
  } catch (error) {
    return `载入 ${dir}/index.js 失败：${error instanceof Error ? error.message : String(error)}`
  }
}

function report(plugin: string, found: Problems, reminders: string[]): Report {
  const checks = CHECKS.map((name): CheckResult => {
    const problems = found.get(name) as string[]
    return { name, rule: RULES[name], ok: problems.length === 0, problems }
  })
  const lines = [`插件 ${plugin} 的符合性检查：`]
  for (const c of checks) {
    lines.push(`  ${c.ok ? '通过' : '不通过'}  ${c.name}`)
    if (!c.ok) lines.push(...c.problems.map((p) => `      - ${p}`), `      规则：${c.rule}`)
  }
  if (reminders.length > 0) lines.push('需人工检查：', ...reminders.map((r) => `  - ${r}`))
  return { plugin, ok: checks.every((c) => c.ok), checks, reminders, text: lines.join('\n') }
}

// ---- what can be read off the plugin object ----

function checkNames(p: Plugin, fail: (c: CheckName, what: string) => void): void {
  if (RESERVED_PLUGIN_NAMES.includes(p.name)) fail('names', `插件名称 ${p.name} 为命令行或内核保留`)
  for (const c of p.ownerCommands) {
    if (!c.name.startsWith(`${p.name} `)) fail('names', `所有者命令「${c.name}」未以「${p.name} 」开头`)
    if ((KERNEL_COMMAND_NAMES as readonly string[]).includes(c.name)) fail('names', `所有者命令「${c.name}」为内核命令`)
  }
  for (const v of p.views ?? []) if (!v.id.startsWith(`${p.name}.`)) fail('names', `视图「${v.id}」未以「${p.name}.」开头`)
  for (const k of p.statements) if (!/^\S+$/u.test(k)) fail('names', `say 类型「${k}」为空或含空白`)
}

/** The command examples of a cognition text: each line of an sh block, continuations joined, comments dropped; and each inline command with no placeholder but the grant. */
export function examplesOf(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] as string)
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  )
  const prose = text.replace(/```sh\n[\s\S]*?```/g, '')
  const inline = [...prose.matchAll(/`(pneuma-base @[^`]+)`/g)].map((m) => m[1] as string).filter((c) => !c.replaceAll(GRANT_PLACEHOLDER, '').includes('<'))
  return [...blocks, ...inline]
}

function checkCognition(p: Plugin, fail: (c: CheckName, what: string) => void, reminders: string[]): void {
  if (p.cognition === null) {
    reminders.push('该插件没有认知段：Agent 读取说明时不会知道它的存在。仅不供 Agent 使用的插件可以没有认知段。')
    return
  }
  const { title, text } = p.cognition
  const [heading = '', ...rest] = text.trimStart().split('\n')
  if (!/^## \S.*：\S/u.test(heading)) fail('cognition', `第一行为「${heading}」，不是「## <功能>：<用法>」形式的标题`)
  const opening = `此资料库已启用**${title}**插件。`
  if (!rest.join('\n').trimStart().startsWith(opening)) fail('cognition', `标题后的第一句不是「${opening}」`)
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) if (m[0] !== GRANT_PLACEHOLDER) fail('cognition', `使用了占位符 ${m[0]}；仅可使用 ${GRANT_PLACEHOLDER}`)
  const commands = [...text.matchAll(/(?:^|[`\n|]\s*)(pneuma-base\s[^\n`]*)/g)].map((m) => (m[1] as string).trim())
  for (const c of commands) if (!c.startsWith(`pneuma-base @${GRANT_PLACEHOLDER} `)) fail('cognition', `命令「${c}」未写成 pneuma-base @${GRANT_PLACEHOLDER} …`)
  for (const [phrase, rule] of KERNEL_PHRASES) if (text.includes(phrase)) fail('cognition', `包含「${phrase}」：「${rule}」是内核规则，说明中已由内核给出`)
  reminders.push(
    '认知段的承诺不超出插件的实际行为（K6）：每句「会」「能」都需有代码实现。',
    '不重复内核和其他插件负责的规则：归档、搜索和检查不包含已归档条目、在外部写好后再添加、不覆盖已有条目。',
    '写明 Agent 不应做和无法做的事（例如仅所有者可开启的开关），以及出现问题时应告知所有者还是重试。',
  )
}

// ---- one library: hooks, writes, blocks, cache, removal ----

type Install = { plugins: readonly string[] } | { builtins: readonly string[] }

type Entry = { dir: boolean; hash: string | null; ino: bigint; mtime: bigint }
type Snapshot = Map<string, Entry>
type Change = { path: string; change: 'added' | 'changed' | 'removed' }

/**
 * Storage's own areas, which no plugin writes: its scratch (`tmp`); its cache (`cache`: what it derives
 * for any plugin, rows and listings, its own to rewrite and throw away); the holds a write keeps until
 * its records are in (`holds`, gone on release); and what a remove or a replace set aside (`trash`).
 */
const NOT_THE_LIBRARY = ['.pneuma-base/tmp', '.pneuma-base/cache', '.pneuma-base/holds', '.pneuma-base/trash']

/** Every file and directory of the library by its library path, NOT_THE_LIBRARY left out; of the check's own unreadable directory, only that it is there. */
async function snapshot(root: string): Promise<Snapshot> {
  const out: Snapshot = new Map()
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      const path = relative(root, abs).split(sep).join('/')
      if (NOT_THE_LIBRARY.some((d) => path === d || path.startsWith(`${d}/`))) continue
      const s = await lstat(abs, { bigint: true })
      const hash = s.isFile() ? createHash('sha256').update(await readFile(abs)).digest('hex') : null
      out.set(path, { dir: s.isDirectory(), hash, ino: s.ino, mtime: s.mtimeNs })
      if (s.isDirectory() && path !== LOCKED) await walk(abs)
    }
  }
  await walk(root)
  return out
}

function changes(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = []
  for (const [path, a] of after) {
    const b = before.get(path)
    if (b === undefined) out.push({ path, change: 'added' })
    else if (!a.dir && (a.hash !== b.hash || a.ino !== b.ino || a.mtime !== b.mtime)) out.push({ path, change: 'changed' })
  }
  for (const path of before.keys()) if (!after.has(path)) out.push({ path, change: 'removed' })
  return out
}

const within = (path: string, prefix: string) => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)

/**
 * A step of the scripted run: what it is, for the report; the library paths the verb itself changes;
 * whether it may delete and rewrite files of the plugin's own directory, as a destructive owner
 * command may; and the call.
 */
type Step = { what: string; touches: readonly string[]; dropsOwn?: true; run: () => Promise<{ problems?: { plugin: string; message: string }[] } | null> }

async function checkLibrary(p: Plugin, install: Install, options: ConformanceOptions, fail: (c: CheckName, what: string) => void, reminders: string[]): Promise<void> {
  const sb = await sandbox({ bare: true, ...pick(options) })
  let planted = false
  try {
    if ('plugins' in install) {
      const r = await sb.run(['plugin', 'install', install.plugins[0] as string, '--json'])
      if (r.json?.outcome !== 'done') return fail('loads', `plugin install 失败：${r.json?.text ?? r.stderr}`)
    }
    const listed = (await sb.run(['plugin', 'list', '--json'])).json?.data?.plugins?.find((x: { name: string }) => x.name === p.name)
    if (listed === undefined) return fail('loads', `plugin list 中没有 ${p.name}`)
    if (listed.failed !== null) return fail('loads', `加载失败：${listed.failed}`)
    if (p.contract !== CONTRACT) return fail('loads', `该插件按插件契约第 ${p.contract} 版编写，当前 pneuma-base 的插件契约为第 ${CONTRACT} 版`)
    if (listed.contract !== p.contract) fail('loads', `plugin list 显示其契约为 ${listed.contract}，插件声明的是 ${p.contract}`)

    const own = `.pneuma-base/${p.name}`
    const mine = (r: { problems?: { plugin: string; message: string }[] } | null) => (r?.problems ?? []).filter((x) => x.plugin === p.name).map((x) => x.message)
    const hooksOn = (what: string, r: { problems?: { plugin: string; message: string }[] } | null) => {
      for (const m of mine(r)) fail('hooks', `${what}：${m}`)
    }
    const agent = (args: string[], input?: string) => sb.agent(AGENT, SESSION, [...args, '--json'], input === undefined ? {} : { input }).then((r) => jsonOf(r))
    const owner = (args: string[]) => sb.owner([...args, '--json']).then((r) => jsonOf(r))
    const watch = boundedWatch(sb.toolLog, p.name, fail)

    // On the empty library: being added and removed, and every hook that needs no content.
    hooksOn('plugin enable（onAdd）', await expectDone(owner(['plugin', 'enable', p.name]), 'plugin enable', fail))
    const viewer = await sb.viewer()
    const empty: Step[] = [
      { what: '空资料库上的 find', touches: [], run: () => agent(['find', '符合性']) },
      { what: '空资料库上的 check', touches: [], run: () => agent(['check']) },
      { what: '空资料库上 inspect 不存在的路径', touches: [], run: () => agent(['inspect', 'conformance/nothing.md']) },
      ...p.statements.flatMap((kind): Step[] => [
        { what: `空资料库上的 say ${kind}`, touches: [], run: () => agent(['say', kind]) },
        { what: `空资料库上的 say ${kind} conformance/nothing.md`, touches: [], run: () => agent(['say', kind, 'conformance/nothing.md', '符合性检查']) },
      ]),
    ]
    await runSteps(sb.library, empty, own, p, options, fail, hooksOn, watch)
    await checkViews(p, viewer, ['conformance/nothing.md'], '空资料库上', fail, watch)
    hooksOn('空资料库上的 plugin disable（onRemove）', await removeIt(owner, p.name, fail))
    hooksOn('空资料库上再次 plugin enable（onAdd）', await expectDone(owner(['plugin', 'enable', p.name]), 'plugin enable', fail))

    await options.setup?.({ sandbox: sb, cwd: sb.work, bin: join(sb.work, '.bin') })
    await addOpener(sb, owner, fail)

    // The scripted run of every verb, each step watched for what it changed and what it asked of storage.
    await plantUnregistered(sb.library)
    planted = true
    const t0 = new Date().toISOString()
    await mkdir(join(sb.work, 'site'), { recursive: true })
    await writeFile(join(sb.work, 'site', 'index.html'), '<h1>符合性检查</h1>\n')
    await writeFile(join(sb.work, 'site', 'style.css'), 'h1 { color: teal; }\n')
    /** A file written into the library as an agent's tool writes it, without the command line. */
    const written = async (path: string, text: string) => {
      await mkdir(join(sb.library, path, '..'), { recursive: true })
      await writeFile(join(sb.library, path), text)
    }
    const purge = async () => {
      const action = await purgeAction(viewer)
      if (action === null) throw new Error('归档页没有「清空归档」')
      return (await viewer.act(action)).result
    }
    const script: Step[] = [
      { what: 'put 文件', touches: ['conformance/note.md'], run: () => agent(['put', '-', '--to', 'conformance/note.md', '--generated', '--note', '符合性检查'], '# 符合性检查\n\n一段文字。\n') },
      { what: 'put 目录', touches: ['conformance/site'], run: () => agent(['put', 'site', '--to', 'conformance/site', '--generated']) },
      {
        what: 'put 登记资料库中已有的文件',
        touches: ['conformance/written.md'],
        run: async () => {
          await written('conformance/written.md', '# 写在库里\n')
          return agent(['put', 'conformance/written.md', '--generated'])
        },
      },
      {
        what: 'put 登记目录第一层的未登记文件',
        touches: [`${OPEN_DIR}/loose-a.md`, `${OPEN_DIR}/loose-b.md`],
        run: async () => {
          await written(`${OPEN_DIR}/loose-a.md`, '散文件 a\n')
          await written(`${OPEN_DIR}/loose-b.md`, '散文件 b\n')
          return agent(['put', OPEN_DIR, '--generated'])
        },
      },
      { what: 'find', touches: [], run: () => agent(['find', '符合性']) },
      { what: 'inspect', touches: [], run: () => agent(['inspect', 'conformance/note.md']) },
      ...p.statements.map((kind): Step => ({ what: `say ${kind}`, touches: [], run: () => agent(['say', kind, 'conformance/site', '符合性检查']) })),
      { what: 'check', touches: [], run: () => agent(['check', '--since', t0]) },
      { what: '在同一路径 put 不同内容', touches: ['conformance/note.md'], run: () => agent(['put', '-', '--to', 'conformance/note.md', '--generated'], '# 符合性检查\n\n改过的一段文字。\n') },
      { what: 'put 移动', touches: ['conformance/note.md', 'conformance/moved.md'], run: () => agent(['put', 'conformance/note.md', '--to', 'conformance/moved.md']) },
      { what: 'archive', touches: ['conformance/moved.md', '_archive/conformance/moved.md'], run: () => agent(['archive', 'conformance/moved.md']) },
      { what: 'unarchive', touches: ['conformance/moved.md', '_archive/conformance/moved.md'], run: () => agent(['unarchive', 'conformance/moved.md']) },
      { what: '归档目录', touches: ['conformance/site', '_archive/conformance/site'], run: () => agent(['archive', 'conformance/site']) },
      { what: 'archive purge（onPurged）', touches: ['_archive'], run: purge },
      ...p.ownerCommands.filter((c) => c.readOnly === true && callable(c)).map((c): Step => ({ what: `所有者命令 ${c.name}`, touches: [], run: () => owner(c.name.split(' ')) })),
      // Confirmed as a person confirms on the page, the one confirmation a sandbox can give.
      ...p.ownerCommands.filter((c) => c.destructive && callable(c)).map((c): Step => ({ what: `所有者命令 ${c.name}`, touches: [], dropsOwn: true, run: async () => (await viewer.act(confirmedCall(c.name))).result })),
    ]
    for (const c of p.ownerCommands.filter((c) => c.destructive && !callable(c))) reminders.push(`破坏性所有者命令 ${c.name} 需要参数，未运行：该命令应只删除、改写插件自身目录中的文件，不改动其他位置。`)
    await runSteps(sb.library, script, own, p, options, fail, hooksOn, watch)
    const before = await snapshot(sb.library)
    await checkViews(p, viewer, ['conformance/moved.md', 'conformance/site', '_archive/conformance/site'], '', fail, watch)
    for (const c of changes(before, await snapshot(sb.library))) fail('writes', `打开视图和条目面板时，${c.path} ${WORD[c.change]}`)

    await checkCache(p, sb, agent, t0, fail, reminders)
    await checkRemove(p, sb, viewer, owner, agent, fail)
  } finally {
    if (planted) await chmod(join(sb.library, LOCKED), 0o755)
    await sb.cleanup()
  }
}

/** The directories the scripted run makes in the library and nobody registers: one with more files than a page, one nobody can read. */
const HEAP = 'conformance-heap'
const LOCKED = 'conformance-locked'
const UNREGISTERED = [HEAP, LOCKED]
const HEAP_FILES = 1200
/** The most entries a plugin's listings of the content take in one step: one page of an overview. */
const PAGE = 1000

async function plantUnregistered(root: string): Promise<void> {
  await mkdir(join(root, HEAP))
  for (let i = 0; i < HEAP_FILES; i++) await writeFile(join(root, HEAP, `${i}.txt`), `${i}\n`)
  await mkdir(join(root, LOCKED))
  await writeFile(join(root, LOCKED, 'inside.txt'), '读不到\n')
  await chmod(join(root, LOCKED), 0o000)
}

/** One line of the kernel's tool log (`PNEUMA_BASE_TOOL_LOG`): what a plugin asked of storage, and how many entries came back. */
type ToolCall = { plugin: string; area: string; tool: string; place?: string; entries?: number }

/** The tools that look into a place of the content, as the report names them. */
const LOOKS: Record<string, string> = { overview: '一览', probe: '探查', content: '获取内容', read: '读取' }

/** Runs a step, then judges what the plugin asked of the content in it, from the lines the step added to the tool log. */
type Watch = <T>(what: string, run: () => Promise<T>) => Promise<T>

function boundedWatch(log: string, plugin: string, fail: (c: CheckName, what: string) => void): Watch {
  const calls = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ToolCall)
  return async (what, run) => {
    const before = (await calls()).length
    const result = await run()
    const asked = (await calls()).slice(before).filter((c) => c.plugin === plugin && c.area === 'content')
    const listed = asked.filter((c) => c.tool === 'overview' || c.tool === 'probe').reduce((n, c) => n + (c.entries ?? 0), 0)
    if (listed > PAGE) fail('bounded', `${what}时，插件对资料库内容的一览和探查共获取 ${listed} 条，超过一页（${PAGE} 条）`)
    const inside = asked.flatMap((c) => {
      const dir = UNREGISTERED.find((d) => c.place !== undefined && within(c.place, d))
      // A budgeted probe of the directory itself is how a closed directory is looked at; anything else there or below it is not.
      if (dir === undefined || LOOKS[c.tool] === undefined || (c.tool === 'probe' && c.place === dir)) return []
      return [`${what}时，插件对未登记的目录 ${dir} 执行${LOOKS[c.tool]}：${c.place}`]
    })
    for (const problem of new Set(inside)) fail('bounded', problem)
    return result
  }
}

const WORD: Record<Change['change'], string> = { added: '被创建', changed: '被改写', removed: '被删除' }

/** The directory the check's own plugin keeps open, as a ledger's records would: registering it registers the loose files of its level. */
const OPEN_DIR = 'conformance/open'
const OPENER = 'conformance-opener'

/** Installs and adds the check's own plugin, whose only part is `openDirs`. */
async function addOpener(sb: Sandbox, owner: (args: string[]) => Promise<unknown>, fail: (c: CheckName, what: string) => void): Promise<void> {
  const dir = join(sb.work, '.opener')
  await mkdir(dir, { recursive: true })
  const plugin = { contract: CONTRACT, name: OPENER, cognition: null, storage: [], statements: [], ownerCommands: [] }
  await writeFile(join(dir, 'index.js'), `export default { ...${JSON.stringify(plugin)}, openDirs: async () => [${JSON.stringify(OPEN_DIR)}] }\n`)
  const installed = await sb.run(['plugin', 'install', dir, '--json'])
  if (installed.json?.outcome !== 'done') return fail('loads', `检查所用的插件 ${OPENER} 安装失败：${installed.json?.text ?? installed.stderr}`)
  await expectDone(owner(['plugin', 'enable', OPENER]), `plugin enable ${OPENER}`, fail)
}

/** An owner command every argument of which may be left out, so the check can run it as it is. */
const callable = (c: Plugin['ownerCommands'][number]) => [...(c.params.positional ?? []), ...(c.params.flags ?? [])].every((x) => x.required !== true)

/** The owner command `name` with no arguments, as a button whose question the person confirms. */
const confirmedCall = (name: string): Action => ({ label: name, tone: 'danger', confirm: `${name}？`, inputs: [], call: { face: 'owner', command: name, args: { positional: [], flags: {} } } })

const pick = (o: ConformanceOptions): Pick<SandboxOptions, 'env' | 'timeout' | 'cli'> => ({
  ...(o.env === undefined ? {} : { env: o.env }),
  ...(o.timeout === undefined ? {} : { timeout: o.timeout }),
  ...(o.cli === undefined ? {} : { cli: o.cli }),
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the command line's JSON, read by the fields each check needs
function jsonOf(r: Result): any {
  if (r.json === null) throw new Error(`命令未输出 JSON（退出码 ${r.code}）：\n${r.stdout}${r.stderr}`)
  return r.json
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
async function expectDone(call: Promise<any>, what: string, fail: (c: CheckName, what: string) => void) {
  const r = await call
  if (r.outcome !== 'done') fail('loads', `${what} 失败：${r.text ?? r.reason}`)
  return r
}

/** `plugin disable`, and with `--force` when the plugin refuses, as the owner can. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
async function removeIt(owner: (args: string[]) => Promise<any>, name: string, fail: (c: CheckName, what: string) => void) {
  const first = await owner(['plugin', 'disable', name])
  const r = first.outcome === 'refused' && first.reason === 'plugin-refused' ? await owner(['plugin', 'disable', name, '--force']) : first
  if (r.outcome !== 'done') fail('remove', `plugin disable 失败：${r.text ?? r.reason}`)
  return r
}

/** Runs each step, then judges what it changed: only the paths its verb changes, and new files under the plugin's own directory. */
async function runSteps(
  root: string,
  steps: readonly Step[],
  own: string,
  p: Plugin,
  options: ConformanceOptions,
  fail: (c: CheckName, what: string) => void,
  hooksOn: (what: string, r: { problems?: { plugin: string; message: string }[] } | null) => void,
  watch: Watch,
): Promise<void> {
  const rewritable = [...(options.configuration ?? []), ...p.storage.filter((s) => s.kind === 'cache').map((s) => s.dir)]
  for (const step of steps) {
    const before = await snapshot(root)
    hooksOn(step.what, await watch(step.what, step.run))
    for (const c of changes(before, await snapshot(root))) {
      if (within(c.path, own)) {
        const rel = c.path === own ? '.' : c.path.slice(own.length + 1)
        if (c.change === 'added' || rel === '.' || step.dropsOwn || rewritable.some((r) => within(rel, r))) continue
        fail('writes', `${step.what}时，插件自身目录中已有的 ${c.path} ${WORD[c.change]}`)
      } else if (!step.touches.some((t) => within(c.path, t) || t.startsWith(`${c.path}/`))) {
        fail('writes', `${step.what}时，${c.path} ${WORD[c.change]}，该路径不在插件自身目录 ${own}/ 下`)
      }
    }
  }
}

/** The archive page's purge action, as the person clicks it. */
async function purgeAction(viewer: Viewer) {
  const page = await viewer.view('archive')
  if (page.outcome !== 'shown') return null
  return allBlocks(page.blocks).flatMap(actionsOf).find((a) => a.call.face === 'owner' && a.call.command === 'archive purge') ?? null
}

function allBlocks(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((b) => [b, ...(b.kind === 'section' ? allBlocks(b.blocks) : [])])
}

function actionsOf(b: Block) {
  switch (b.kind) {
    case 'section':
    case 'actions':
      return b.actions
    case 'table':
      return b.rows.flatMap((r) => r.actions)
    case 'list':
      return b.items.flatMap((i) => i.actions)
    case 'timeline':
      return b.entries.flatMap((e) => e.actions ?? [])
    case 'custom':
      return Object.values(b.actions)
    default:
      return []
  }
}

/** Every view of the plugin with its filters' defaults, and its item section for each path: no problem of its own, each custom page served. */
async function checkViews(p: Plugin, viewer: Viewer, paths: readonly string[], where: string, fail: (c: CheckName, what: string) => void, watch: Watch): Promise<void> {
  const pages = [
    ...(p.views ?? []).map((v) => ({ what: `${where}视图 ${v.id}`, get: () => viewer.view(v.id, Object.fromEntries(v.filters.map((f) => [f.name, f.default]))) })),
    ...(p.onItemView ? paths.map((path) => ({ what: `${where}${path} 的条目面板`, get: () => viewer.item(path) })) : []),
  ]
  for (const page of pages) {
    const r = await watch(page.what, page.get)
    for (const x of r.problems.filter((x) => x.plugin === p.name)) fail('blocks', `${page.what}：${x.message}`)
    if (r.outcome !== 'shown') {
      fail('blocks', `${page.what}无法打开（${r.outcome}）`)
      continue
    }
    for (const b of allBlocks(r.blocks)) {
      if (b.kind !== 'custom' || b.plugin !== p.name) continue
      const entry = `/plugin-ui/${p.name}/${b.entry.split('/').map(encodeURIComponent).join('/')}`
      const reply = await viewer.get(entry)
      if (!reply.ok) {
        fail('blocks', `${page.what}中的 custom 块指向 ${b.entry}，获取时返回 ${reply.status}`)
        continue
      }
      for (const wrong of await pageFaults(viewer, p.name, entry, await reply.text())) fail('blocks', `${page.what}中的 custom 块指向 ${b.entry}：${wrong}`)
    }
  }
}

const FRAME_SCRIPT = '/plugin-kit/frame.js'

/**
 * What can be told of a plugin's page without running it: whether it loads the frame script the
 * server gives, and whether its scripts ask for the block's data. Its scripts are the inline ones and
 * those it names in its own ui directory; what they import is not read.
 */
async function pageFaults(viewer: Viewer, plugin: string, entry: string, html: string): Promise<string[]> {
  const page = new URL(entry, 'http://viewer')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(m[1] as string)?.[1]
    return src === undefined ? { at: null, inline: m[2] as string } : { at: new URL(src, page), inline: '' }
  })
  const framed = scripts.some(({ at }) => at?.origin === page.origin && at.pathname === FRAME_SCRIPT)
  const texts = await Promise.all(
    scripts.map(async ({ at, inline }) => {
      if (at === null) return inline
      if (at.origin !== page.origin || !at.pathname.startsWith(`/plugin-ui/${plugin}/`)) return ''
      const reply = await viewer.get(at.pathname)
      return reply.ok ? reply.text() : ''
    }),
  )
  return [
    ...(framed ? [] : [`页面未载入 ${FRAME_SCRIPT}，pneuma 不可用：需添加 <script src="${FRAME_SCRIPT}"></script>`]),
    ...(texts.some((t) => /\bonData\b/.test(t)) ? [] : ['页面脚本未调用 pneuma.onData，无法接收块的数据']),
  ]
}

/** The answers of find, inspect and check before and after its caches are deleted. */
async function checkCache(
  p: Plugin,
  sb: Sandbox,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  agent: (args: string[]) => Promise<any>,
  t0: string,
  fail: (c: CheckName, what: string) => void,
  reminders: string[],
): Promise<void> {
  const asks: [string, string[]][] = [
    ['find 符合性', ['find', '符合性']],
    ['inspect conformance/moved.md', ['inspect', 'conformance/moved.md']],
    ['check', ['check', '--since', t0]],
  ]
  const answers = async () => Promise.all(asks.map(async ([, args]) => JSON.stringify(await agent(args))))
  const first = await answers()
  const again = await answers()
  const { id } = JSON.parse(await readFile(join(sb.library, '.pneuma-base', 'config.json'), 'utf8')) as { id: string }
  await rm(join(sb.home, 'cache', id, p.name), { recursive: true, force: true })
  for (const s of p.storage.filter((s) => s.kind === 'cache')) await rm(join(sb.library, '.pneuma-base', p.name, s.dir), { recursive: true, force: true })
  // The rows of its record place, which storage keeps in its cache area (`<name>.sqlite` and the files beside it).
  const rows = join(sb.library, '.pneuma-base', 'cache', 'rows')
  for (const f of await readdir(rows).catch(() => [] as string[])) if (f === `${p.name}.sqlite` || f.startsWith(`${p.name}.sqlite-`)) await rm(join(rows, f), { force: true })
  const after = await answers()
  for (const [i, [what]] of asks.entries()) {
    if (first[i] !== again[i]) reminders.push(`${what} 两次查询的答复不同，无法比较删除缓存前后的结果，未检查。`)
    else if (after[i] !== first[i]) fail('cache', `删除缓存后，${what} 的答复发生变化`)
  }
}

async function checkRemove(
  p: Plugin,
  sb: Sandbox,
  viewer: Viewer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  owner: (args: string[]) => Promise<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  agent: (args: string[], input?: string) => Promise<any>,
  fail: (c: CheckName, what: string) => void,
): Promise<void> {
  const content = (s: Snapshot) => new Map([...s].filter(([path]) => !path.startsWith('.pneuma-base/') && path !== 'PNEUMA-BASE.md'))
  const before = content(await snapshot(sb.library))
  await removeIt(owner, p.name, fail)
  const config = JSON.parse(await readFile(join(sb.library, '.pneuma-base', 'config.json'), 'utf8')) as { plugins: string[] }
  if (config.plugins.includes(p.name)) fail('remove', '停用后，配置中仍有该插件')
  const description = await readFile(join(sb.library, 'PNEUMA-BASE.md'), 'utf8')
  if (p.cognition !== null && description.includes(`此资料库已启用**${p.cognition.title}**插件`)) fail('remove', '停用后，说明中仍有其认知段')
  const after = content(await snapshot(sb.library))
  for (const [path, e] of before) if (after.get(path)?.hash !== e.hash) fail('remove', `停用后，${path} 已缺失或已修改`)
  const asks: [string, () => Promise<{ outcome?: string; problems: { plugin: string; message: string }[] }>][] = [
    ['find', () => agent(['find', '符合性'])],
    ['check', () => agent(['check'])],
    ['inspect', () => agent(['inspect', 'conformance/moved.md'])],
    ['put', () => agent(['put', '-', '--to', 'conformance/after.md', '--generated'], '停用后添加的。\n')],
  ]
  for (const [what, ask] of asks) {
    const r = await ask()
    if (r.outcome === 'refused') fail('remove', `停用后，${what} 被拒绝`)
    for (const x of r.problems) fail('remove', `停用后，${what} 的答复中有问题：${x.plugin}：${x.message}`)
  }
  const state = await viewer.state()
  for (const v of state.views) if (v.id.startsWith(`${p.name}.`)) fail('remove', `停用后，界面仍列出视图 ${v.id}`)
  for (const x of state.problems) fail('remove', `停用后，界面报告问题：${x.plugin}：${x.message}`)
}

// ---- two more libraries: catching up ----

const EARLY_FILE = 'conformance/early.md'
const EARLY_SITE = 'conformance/early-site'
const EARLY_WORDS = '符合性早先'
/** What differs between two libraries' answers without saying anything about what a plugin knows: moments, and ids made of hex. */
const comparable = (answer: unknown) =>
  JSON.stringify(answer)
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?Z/g, '<时刻>')
    .replace(/[0-9a-f]{8,}/g, '<号>')

/** A text file and a directory put into the library as an agent puts them. */
async function putEarly(sb: Sandbox): Promise<void> {
  await mkdir(join(sb.work, 'early-site'), { recursive: true })
  await writeFile(join(sb.work, 'early-site', 'index.html'), `<h1>${EARLY_WORDS}</h1>\n`)
  for (const args of [['put', '-', '--to', EARLY_FILE, '--generated'], ['put', join(sb.work, 'early-site'), '--to', EARLY_SITE, '--generated']]) {
    const r = await sb.agent(AGENT, SESSION, args, { input: `# ${EARLY_WORDS}\n\n一段文字。\n` })
    if (r.code !== 0) throw new Error(`添加 ${args[3]} 失败：${r.stderr || r.stdout}`)
  }
}

/** What the plugin answers about the two things: its hits, its sections, its part of each item panel. */
async function answersAbout(p: Plugin, sb: Sandbox): Promise<[string, string][]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the command line's JSON, as the other checks read it
  const agent = async (args: string[]): Promise<any> => jsonOf(await sb.agent(AGENT, SESSION, [...args, '--json']))
  const mine = (list: { plugin?: string; by?: string }[] | undefined) => (list ?? []).filter((x) => (x.plugin ?? x.by) === p.name)
  const viewer = await sb.viewer()
  const out: [string, string][] = [[`find ${EARLY_WORDS}`, comparable(mine((await agent(['find', EARLY_WORDS]))?.hits))]]
  for (const path of [EARLY_FILE, EARLY_SITE]) out.push([`inspect ${path}`, comparable(mine((await agent(['inspect', path]))?.sections))])
  out.push(['check', comparable(mine((await agent(['check']))?.sections))])
  for (const path of [EARLY_FILE, EARLY_SITE]) {
    const item = await viewer.item(path, { plugin: p.name })
    out.push([`条目面板 ${path}`, comparable(item.outcome === 'shown' ? { blocks: item.blocks, problems: item.problems } : item)])
  }
  return out
}

/**
 * A library where the plugin heard two things put, and one where they were put before it was added:
 * after catching up, its answers about them are the same. The plugin that keeps the register is not
 * checked: there is nothing it could learn the register from but itself.
 */
async function checkCatchUp(p: Plugin, install: Install, options: ConformanceOptions, fail: (c: CheckName, what: string) => void, reminders: string[]): Promise<void> {
  if (p.registered !== undefined) {
    reminders.push('该插件自行记录资料库的登记内容（registered），未检查 catchup。')
    return
  }
  const heard = await sandbox({ ...pick(options), ...install })
  const late = await sandbox(pick(options))
  try {
    await options.setup?.({ sandbox: heard, cwd: heard.work, bin: join(heard.work, '.bin') })
    await putEarly(heard)
    const first = await answersAbout(p, heard)
    const again = await answersAbout(p, heard)
    await putEarly(late)
    if ('plugins' in install) {
      const r = await late.run(['plugin', 'install', install.plugins[0] as string, '--json'])
      if (r.json?.outcome !== 'done') return fail('catchup', `plugin install 失败：${r.json?.text ?? r.stderr}`)
    }
    const added = jsonOf(await late.owner(['plugin', 'enable', p.name, '--json']))
    if (added?.outcome !== 'done') return fail('catchup', `plugin enable 失败：${added?.text ?? ''}`)
    for (const x of added.problems ?? []) if (x.plugin === p.name) fail('catchup', `plugin enable 补录时：${x.message}`)
    await options.setup?.({ sandbox: late, cwd: late.work, bin: join(late.work, '.bin') })
    const after = await answersAbout(p, late)
    for (const [i, [what, answer]] of first.entries()) {
      if (again[i]?.[1] !== answer) reminders.push(`${what} 两次查询的答复不同，无法与后启用的结果比较，未检查。`)
      else if (after[i]?.[1] !== answer) fail('catchup', `后启用并补录后，${what} 的答复与启用状态下添加时不同`)
    }
  } finally {
    await heard.cleanup()
    await late.cleanup()
  }
}

// ---- a second library: the examples ----

async function checkExamples(p: Plugin, install: Install, options: ConformanceOptions, fail: (c: CheckName, what: string) => void, reminders: string[]): Promise<void> {
  const examples = p.cognition === null ? [] : examplesOf(p.cognition.text)
  if (examples.length === 0) return
  if (process.platform === 'win32') {
    reminders.push('Windows 上没有 sh，未运行认知段的命令示例。')
    return
  }
  const sb = await sandbox({ bare: true, ...pick(options), ...install })
  try {
    const cwd = join(sb.work, 'agent')
    const bin = join(sb.work, '.bin')
    await mkdir(cwd, { recursive: true })
    await mkdir(bin, { recursive: true })
    const shim = join(bin, 'pneuma-base')
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${sb.cli}" "$@"\n`)
    await chmod(shim, 0o755)
    const issued = await sb.owner(['grant', 'create', GRANT, '--agent', AGENT, '--json'])
    if (issued.json?.outcome !== 'done') throw new Error(`新建授权失败：${issued.stdout}${issued.stderr}`)
    await options.setup?.({ sandbox: sb, cwd, bin })
    const env = { ...sb.env, PATH: `${bin}:${sb.env.PATH ?? ''}`, PNEUMA_BASE_SESSION: 'conformance-examples' }
    for (const example of examples) {
      const command = example.replaceAll(GRANT_PLACEHOLDER, GRANT)
      const r = await runProcess('/bin/sh', ['-c', command], { cwd, env, timeout: options.timeout ?? 60_000 }).catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }))
      if (r.code !== 0) fail('examples', `示例「${example}」退出码 ${r.code}：${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
    }
  } finally {
    await sb.cleanup()
  }
}
