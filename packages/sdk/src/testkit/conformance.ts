// The behavioural rules of the plugin standard, as checks run against the real command line on
// temporary libraries. Each check reports what is wrong in Chinese, with the rule it breaks.
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KERNEL_COMMAND_NAMES, RESERVED_PLUGIN_NAMES } from '../index.js'
import type { Action, Block, Plugin } from '../types.js'
import { runProcess, type Result } from './run.js'
import { sandbox, type Sandbox, type SandboxOptions, type Viewer } from './sandbox.js'

export const CHECKS = ['loads', 'names', 'cognition', 'examples', 'hooks', 'writes', 'cache', 'blocks', 'remove'] as const
export type CheckName = (typeof CHECKS)[number]

/** What each check holds a plugin to, as the standard says it. */
export const RULES: Record<CheckName, string> = {
  loads: '插件目录的 index.js 缺省导出一个插件，contract 是这个 pneuma-base 认识的版本，过得了装载时的核对',
  names: '主人命令以「<插件名> 」开头，视图编号以「<插件名>.」开头，插件名不是命令行或内核自己用的词，命令名不是内核的命令',
  cognition: '认知段以「## <它带来什么>：<怎么用>」开头，第一句是「这个库装了**<标题>**插件。」，命令示例写成 pneuma-base @{{授权的名字}} …，只用 {{授权的名字}} 这一个占位，不重复内核管的规矩',
  examples: '认知段里的每条命令示例，在一个新库上做完准备步骤之后，照原样在 agent 的会话里能跑，退出码是 0',
  hooks: '每个钩子在空库上、在每个动词之后都不抛错，答复里没有这个插件的问题',
  writes: '插件只往库里自己名下的 .pneuma-base/<插件名>/ 写；那里已有的文件不改写、不删（声明为配置的文件、缓存目录和破坏性的主人命令除外）；视图和条目面板里的一节什么都不写',
  cache: '缓存删掉什么都不丢：删掉它在本机的缓存目录和声明为缓存的目录前后，找、看、查的答复一样',
  blocks: '视图和条目面板里的一节答复的都是合法的块，钩子不抛错；每个动作调的是一个动词或这个库里在的一条主人命令，参数合它的参数表；custom 块带 text，用字说出它画的；custom 块指向的页面在插件的 ui 目录里，取得到，载入 /plugin-kit/frame.js，脚本里调用 pneuma.onData',
  remove: '卸下插件之后库照常能用：配置和说明里没有它，动词照常答复、没有问题，界面没有它的视图，内容一样不少',
}

/** Kernel rules a cognition section must not repeat: each phrase, and the rule it belongs to. */
const KERNEL_PHRASES: readonly [phrase: string, rule: string][] = [
  ['--include-archived', '找和查默认不带归档的东西'],
  ['在库外写好', '在库外写好再放进来'],
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
    for (const c of CHECKS.slice(1)) fail(c, '没有查：插件没装上')
    return report(dir ?? '?', found, reminders)
  }
  const plugin = loaded
  checkNames(plugin, fail)
  checkCognition(plugin, fail, reminders)
  const install = dir === null ? { builtins: [plugin.name] } : { plugins: [dir] }
  try {
    await checkLibrary(plugin, install, options, fail, reminders)
    if ((found.get('loads') as string[]).length === 0) await checkExamples(plugin, install, options, fail, reminders)
  } catch (error) {
    fail('loads', error instanceof Error ? error.message : String(error))
  }
  if ((found.get('loads') as string[]).length > 0) {
    for (const c of ['examples', 'hooks', 'writes', 'cache', 'blocks', 'remove'] as const) if ((found.get(c) as string[]).length === 0) fail(c, '没有查：插件没装上')
  }
  return report(plugin.name, found, reminders)
}

async function importPlugin(dir: string): Promise<Plugin | string> {
  try {
    const module = (await import(pathToFileURL(join(dir, 'index.js')).href)) as { default?: unknown }
    const p = module.default as Plugin | undefined
    if (typeof p !== 'object' || p === null || typeof p.name !== 'string') return `${dir}/index.js 的缺省导出不是插件`
    return p
  } catch (error) {
    return `载入 ${dir}/index.js 时出错：${error instanceof Error ? error.message : String(error)}`
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
  if (reminders.length > 0) lines.push('查不了、要自己看的：', ...reminders.map((r) => `  - ${r}`))
  return { plugin, ok: checks.every((c) => c.ok), checks, reminders, text: lines.join('\n') }
}

// ---- what can be read off the plugin object ----

function checkNames(p: Plugin, fail: (c: CheckName, what: string) => void): void {
  if (RESERVED_PLUGIN_NAMES.includes(p.name)) fail('names', `插件名 ${p.name} 是命令行或内核自己用的词`)
  for (const c of p.ownerCommands) {
    if (!c.name.startsWith(`${p.name} `)) fail('names', `主人命令「${c.name}」不以「${p.name} 」开头`)
    if ((KERNEL_COMMAND_NAMES as readonly string[]).includes(c.name)) fail('names', `主人命令「${c.name}」是内核自己的命令`)
  }
  for (const v of p.views ?? []) if (!v.id.startsWith(`${p.name}.`)) fail('names', `视图「${v.id}」不以「${p.name}.」开头`)
  for (const k of p.statements) if (!/^\S+$/u.test(k)) fail('names', `「说」的种类「${k}」是空的或带空白`)
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
    reminders.push('它没有认知段：agent 读说明时不知道它在。只有不给 agent 用的插件才这样。')
    return
  }
  const { title, text } = p.cognition
  const [heading = '', ...rest] = text.trimStart().split('\n')
  if (!/^## \S.*：\S/u.test(heading)) fail('cognition', `第一行是「${heading}」，不是「## <它带来什么>：<怎么用>」这样的标题`)
  const opening = `这个库装了**${title}**插件。`
  if (!rest.join('\n').trimStart().startsWith(opening)) fail('cognition', `标题之后的第一句不是「${opening}」`)
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) if (m[0] !== GRANT_PLACEHOLDER) fail('cognition', `用了占位 ${m[0]}；能用的只有 ${GRANT_PLACEHOLDER}`)
  const commands = [...text.matchAll(/(?:^|[`\n|]\s*)(pneuma-base\s[^\n`]*)/g)].map((m) => (m[1] as string).trim())
  for (const c of commands) if (!c.startsWith(`pneuma-base @${GRANT_PLACEHOLDER} `)) fail('cognition', `命令「${c}」没有写成 pneuma-base @${GRANT_PLACEHOLDER} …`)
  for (const [phrase, rule] of KERNEL_PHRASES) if (text.includes(phrase)) fail('cognition', `写了「${phrase}」：「${rule}」是内核的规矩，说明里内核已经说了`)
  reminders.push(
    '认知段许诺的不超出插件真做的（K6）：每句「会」「能」都要有代码在做。',
    '不重复内核和别的插件管的规矩：归档、找和查不带归档、在库外写好再放、不要覆盖已有的东西。',
    '说清 agent 不该做、做不了的（比如只有主人能开的开关），和出了问题该告诉主人还是重试。',
  )
}

// ---- one library: hooks, writes, blocks, cache, removal ----

type Install = { plugins: readonly string[] } | { builtins: readonly string[] }

type Entry = { dir: boolean; hash: string | null; ino: bigint; mtime: bigint }
type Snapshot = Map<string, Entry>
type Change = { path: string; change: 'added' | 'changed' | 'removed' }

/**
 * The kernel's scratch directory, and storage's cache area: what storage derives there for any plugin
 * (rows, listings) is its own to rewrite at any time, and may be thrown away.
 */
const NOT_THE_LIBRARY = ['.pneuma-base/tmp', '.pneuma-base/cache']

/** Every file and directory of the library by its library path, NOT_THE_LIBRARY left out. */
async function snapshot(root: string): Promise<Snapshot> {
  const out: Snapshot = new Map()
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const abs = join(e.parentPath, e.name)
    const path = relative(root, abs).split(sep).join('/')
    if (NOT_THE_LIBRARY.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue
    const s = await lstat(abs, { bigint: true })
    const hash = s.isFile() ? createHash('sha256').update(await readFile(abs)).digest('hex') : null
    out.set(path, { dir: s.isDirectory(), hash, ino: s.ino, mtime: s.mtimeNs })
  }
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
  try {
    if ('plugins' in install) {
      const r = await sb.run(['plugin', 'install', install.plugins[0] as string, '--json'])
      if (r.json?.outcome !== 'done') return fail('loads', `plugin install 没有装上：${r.json?.text ?? r.stderr}`)
    }
    const listed = (await sb.run(['plugin', 'list', '--json'])).json?.data?.plugins?.find((x: { name: string }) => x.name === p.name)
    if (listed === undefined) return fail('loads', `plugin list 里没有 ${p.name}`)
    if (listed.failed !== null) return fail('loads', `它没能加载：${listed.failed}`)
    if (listed.contract !== p.contract) fail('loads', `plugin list 说它的契约是 ${listed.contract}，它自己写的是 ${p.contract}`)

    const own = `.pneuma-base/${p.name}`
    const mine = (r: { problems?: { plugin: string; message: string }[] } | null) => (r?.problems ?? []).filter((x) => x.plugin === p.name).map((x) => x.message)
    const hooksOn = (what: string, r: { problems?: { plugin: string; message: string }[] } | null) => {
      for (const m of mine(r)) fail('hooks', `${what}：${m}`)
    }
    const agent = (args: string[], input?: string) => sb.agent(AGENT, SESSION, [...args, '--json'], input === undefined ? {} : { input }).then((r) => jsonOf(r))
    const owner = (args: string[]) => sb.owner([...args, '--json']).then((r) => jsonOf(r))

    // On the empty library: being added and removed, and every hook that needs no content.
    hooksOn('plugin add（onAdd）', await expectDone(owner(['plugin', 'add', p.name]), 'plugin add', fail))
    const viewer = await sb.viewer()
    const empty: Step[] = [
      { what: '空库上的 find', touches: [], run: () => agent(['find', '符合性']) },
      { what: '空库上的 check', touches: [], run: () => agent(['check']) },
      { what: '空库上 inspect 一个不在的路径', touches: [], run: () => agent(['inspect', 'conformance/nothing.md']) },
      ...p.statements.flatMap((kind): Step[] => [
        { what: `空库上的 say ${kind}`, touches: [], run: () => agent(['say', kind]) },
        { what: `空库上的 say ${kind} conformance/nothing.md`, touches: [], run: () => agent(['say', kind, 'conformance/nothing.md', '符合性检查']) },
      ]),
    ]
    await runSteps(sb.library, empty, own, p, options, fail, hooksOn)
    await checkViews(p, viewer, ['conformance/nothing.md'], '空库上', fail)
    hooksOn('空库上的 plugin remove（onRemove）', await removeIt(owner, p.name, fail))
    hooksOn('空库上再 plugin add（onAdd）', await expectDone(owner(['plugin', 'add', p.name]), 'plugin add', fail))

    await options.setup?.({ sandbox: sb, cwd: sb.work, bin: join(sb.work, '.bin') })

    // The scripted run of every verb, each step watched for what it changed.
    const t0 = new Date().toISOString()
    await mkdir(join(sb.work, 'site'), { recursive: true })
    await writeFile(join(sb.work, 'site', 'index.html'), '<h1>符合性检查</h1>\n')
    await writeFile(join(sb.work, 'site', 'style.css'), 'h1 { color: teal; }\n')
    const purge = async () => {
      const action = await purgeAction(viewer)
      if (action === null) throw new Error('归档页没有「清空归档区」')
      return (await viewer.act(action)).result
    }
    const script: Step[] = [
      { what: 'put 一个文件', touches: ['conformance/note.md'], run: () => agent(['put', '-', '--to', 'conformance/note.md', '--made', '--note', '符合性检查'], '# 符合性检查\n\n一段文字。\n') },
      { what: 'put 一个目录', touches: ['conformance/site'], run: () => agent(['put', 'site', '--to', 'conformance/site', '--made']) },
      { what: 'find', touches: [], run: () => agent(['find', '符合性']) },
      { what: 'inspect', touches: [], run: () => agent(['inspect', 'conformance/note.md']) },
      ...p.statements.map((kind): Step => ({ what: `say ${kind}`, touches: [], run: () => agent(['say', kind, 'conformance/site', '符合性检查']) })),
      { what: 'check', touches: [], run: () => agent(['check', '--since', t0]) },
      { what: '在同一路径 put 不同的内容', touches: ['conformance/note.md'], run: () => agent(['put', '-', '--to', 'conformance/note.md', '--made'], '# 符合性检查\n\n改过的一段文字。\n') },
      { what: 'put 挪位置', touches: ['conformance/note.md', 'conformance/moved.md'], run: () => agent(['put', 'conformance/note.md', '--to', 'conformance/moved.md']) },
      { what: 'archive', touches: ['conformance/moved.md', '_archive/conformance/moved.md'], run: () => agent(['archive', 'conformance/moved.md']) },
      { what: 'unarchive', touches: ['conformance/moved.md', '_archive/conformance/moved.md'], run: () => agent(['unarchive', 'conformance/moved.md']) },
      { what: '归档一个目录', touches: ['conformance/site', '_archive/conformance/site'], run: () => agent(['archive', 'conformance/site']) },
      { what: 'archive purge（onPurged）', touches: ['_archive'], run: purge },
      ...p.ownerCommands.filter((c) => c.readOnly === true && callable(c)).map((c): Step => ({ what: `主人命令 ${c.name}`, touches: [], run: () => owner(c.name.split(' ')) })),
      // Confirmed as a person confirms on the page, the one confirmation a sandbox can give.
      ...p.ownerCommands.filter((c) => c.destructive && callable(c)).map((c): Step => ({ what: `主人命令 ${c.name}`, touches: [], dropsOwn: true, run: async () => (await viewer.act(confirmedCall(c.name))).result })),
    ]
    for (const c of p.ownerCommands.filter((c) => c.destructive && !callable(c))) reminders.push(`破坏性的主人命令 ${c.name} 要参数，没有跑：它只该删、改写插件自己目录里的文件，别处什么都不动。`)
    await runSteps(sb.library, script, own, p, options, fail, hooksOn)
    const before = await snapshot(sb.library)
    await checkViews(p, viewer, ['conformance/moved.md', 'conformance/site', '_archive/conformance/site'], '', fail)
    for (const c of changes(before, await snapshot(sb.library))) fail('writes', `打开视图和条目面板时，${c.path} ${WORD[c.change]}`)

    await checkCache(p, sb, agent, t0, fail, reminders)
    await checkRemove(p, sb, viewer, owner, agent, fail)
  } finally {
    await sb.cleanup()
  }
}

const WORD: Record<Change['change'], string> = { added: '多了出来', changed: '被改写了', removed: '被删掉了' }

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
  if (r.json === null) throw new Error(`命令没有给出 JSON（退出码 ${r.code}）：\n${r.stdout}${r.stderr}`)
  return r.json
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
async function expectDone(call: Promise<any>, what: string, fail: (c: CheckName, what: string) => void) {
  const r = await call
  if (r.outcome !== 'done') fail('loads', `${what} 没有做成：${r.text ?? r.reason}`)
  return r
}

/** `plugin remove`, and with `--anyway` when the plugin refuses, as the owner can. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
async function removeIt(owner: (args: string[]) => Promise<any>, name: string, fail: (c: CheckName, what: string) => void) {
  const first = await owner(['plugin', 'remove', name])
  const r = first.outcome === 'refused' && first.reason === 'plugin-refused' ? await owner(['plugin', 'remove', name, '--anyway']) : first
  if (r.outcome !== 'done') fail('remove', `plugin remove 没有做成：${r.text ?? r.reason}`)
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
): Promise<void> {
  const rewritable = [...(options.configuration ?? []), ...p.storage.filter((s) => s.kind === 'cache').map((s) => s.dir)]
  for (const step of steps) {
    const before = await snapshot(root)
    hooksOn(step.what, await step.run())
    for (const c of changes(before, await snapshot(root))) {
      if (within(c.path, own)) {
        const rel = c.path === own ? '.' : c.path.slice(own.length + 1)
        if (c.change === 'added' || rel === '.' || step.dropsOwn || rewritable.some((r) => within(rel, r))) continue
        fail('writes', `${step.what}时，它自己目录里已有的 ${c.path} ${WORD[c.change]}`)
      } else if (!step.touches.some((t) => within(c.path, t) || t.startsWith(`${c.path}/`))) {
        fail('writes', `${step.what}时，${c.path} ${WORD[c.change]}，它不在插件自己的目录 ${own}/ 下`)
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
async function checkViews(p: Plugin, viewer: Viewer, paths: readonly string[], where: string, fail: (c: CheckName, what: string) => void): Promise<void> {
  const pages = [
    ...(p.views ?? []).map((v) => ({ what: `${where}视图 ${v.id}`, get: () => viewer.view(v.id, Object.fromEntries(v.filters.map((f) => [f.name, f.default]))) })),
    ...(p.onItemView ? paths.map((path) => ({ what: `${where}${path} 的条目面板`, get: () => viewer.item(path) })) : []),
  ]
  for (const page of pages) {
    const r = await page.get()
    for (const x of r.problems.filter((x) => x.plugin === p.name)) fail('blocks', `${page.what}：${x.message}`)
    if (r.outcome !== 'shown') {
      fail('blocks', `${page.what}没有打开（${r.outcome}）`)
      continue
    }
    for (const b of allBlocks(r.blocks)) {
      if (b.kind !== 'custom' || b.plugin !== p.name) continue
      const entry = `/plugin-ui/${p.name}/${b.entry.split('/').map(encodeURIComponent).join('/')}`
      const reply = await viewer.get(entry)
      if (!reply.ok) {
        fail('blocks', `${page.what}里的 custom 块指向 ${b.entry}，取它答复 ${reply.status}`)
        continue
      }
      for (const wrong of await pageFaults(viewer, p.name, entry, await reply.text())) fail('blocks', `${page.what}里的 custom 块指向 ${b.entry}：${wrong}`)
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
    ...(framed ? [] : [`页没有载入 ${FRAME_SCRIPT}，pneuma 不在：要写 <script src="${FRAME_SCRIPT}"></script>`]),
    ...(texts.some((t) => /\bonData\b/.test(t)) ? [] : ['页的脚本没有调用 pneuma.onData，收不到块的数据']),
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
  const after = await answers()
  for (const [i, [what]] of asks.entries()) {
    if (first[i] !== again[i]) reminders.push(`${what} 问两次答得不一样，删掉缓存前后没法比，没有查。`)
    else if (after[i] !== first[i]) fail('cache', `删掉缓存之后，${what} 的答复变了`)
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
  if (config.plugins.includes(p.name)) fail('remove', '卸下之后，配置里还有它')
  const description = await readFile(join(sb.library, 'PNEUMA-BASE.md'), 'utf8')
  if (p.cognition !== null && description.includes(`这个库装了**${p.cognition.title}**插件`)) fail('remove', '卸下之后，说明里还有它的那一段')
  const after = content(await snapshot(sb.library))
  for (const [path, e] of before) if (after.get(path)?.hash !== e.hash) fail('remove', `卸下之后，${path} 不在了或变了`)
  const asks: [string, () => Promise<{ outcome?: string; problems: { plugin: string; message: string }[] }>][] = [
    ['find', () => agent(['find', '符合性'])],
    ['check', () => agent(['check'])],
    ['inspect', () => agent(['inspect', 'conformance/moved.md'])],
    ['put', () => agent(['put', '-', '--to', 'conformance/after.md', '--made'], '卸下之后放进来的。\n')],
  ]
  for (const [what, ask] of asks) {
    const r = await ask()
    if (r.outcome === 'refused') fail('remove', `卸下之后，${what} 被拒绝了`)
    for (const x of r.problems) fail('remove', `卸下之后，${what} 的答复里有问题：${x.plugin}：${x.message}`)
  }
  const state = await viewer.state()
  for (const v of state.views) if (v.id.startsWith(`${p.name}.`)) fail('remove', `卸下之后，界面还列着视图 ${v.id}`)
  for (const x of state.problems) fail('remove', `卸下之后，界面报问题：${x.plugin}：${x.message}`)
}

// ---- a second library: the examples ----

async function checkExamples(p: Plugin, install: Install, options: ConformanceOptions, fail: (c: CheckName, what: string) => void, reminders: string[]): Promise<void> {
  const examples = p.cognition === null ? [] : examplesOf(p.cognition.text)
  if (examples.length === 0) return
  if (process.platform === 'win32') {
    reminders.push('在 Windows 上没有 sh，认知段的命令示例没有跑。')
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
    const issued = await sb.owner(['grant', 'issue', GRANT, '--agent', AGENT, '--json'])
    if (issued.json?.outcome !== 'done') throw new Error(`发授权没有做成：${issued.stdout}${issued.stderr}`)
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
