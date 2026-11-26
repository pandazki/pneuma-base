// The viewer face: the read-only side the management UI uses. ARCHITECTURE.md section 6.
// Views are not operations: they change nothing and send no event.
import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileFacts } from './agent.js'
import { agentsPage } from './agents-page.js'
import { asksOf } from './asks.js'
import { callableIn, checkBlocks, checkFilters, checkOpen, checkRefresh, type Callable } from './blocks.js'
import { exists } from './files.js'
import { bundleFiles, enclosingBundle, kindAt, listThings, thingAt } from './things.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { codexHint } from './products.js'
import { kernelSteps, startPart } from './start.js'
import { requestAsks } from './requests.js'
import { agentSign, ownerOnlyRefusal, OWNER_DECIDES, type Env } from './session.js'
import type { KernelCommandName } from './claims.js'
import { machineDirOf } from './plugin-table.js'
import { secretNames } from './secrets.js'
import { ARCHIVE_DIR, DESCRIPTION_FILE, KERNEL_DIR, abs, archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { messageOf, pluginContext } from './pipeline.js'
import {
  formOf,
  type Action,
  type ActionInput,
  type ActorMark,
  type Block,
  type FixedValue,
  type Cell,
  type Context,
  type FileFacts,
  type Library,
  type LibraryPath,
  type Link,
  type ListedView,
  type Plugin,
  type PluginName,
  type PluginProblem,
  type PluginTable,
  type TableRow,
  type Tag,
  type Thing,
  type ViewAnswer,
  type ViewDecl,
  type ViewList,
  type ViewRequest,
  type ViewResult,
} from '@pneuma-base/sdk'

/**
 * What showing a view needs besides the request: the operation's context, the plugins this
 * pneuma-base knows, and, as an owner command's gate reads them, the environment and whether the
 * call came with a grant.
 */
export type ViewerCall = { ctx: Context; table: PluginTable; env: Env; viaGrant: boolean }

type Shown = ViewAnswer & { problems: PluginProblem[] }
type KernelPage = (params: Record<string, string>, call: ViewerCall) => Promise<Shown>

const shown = (title: string, subtitle: string | null, blocks: Block[], problems: PluginProblem[] = []): Shown => ({ title, subtitle, blocks, problems })

const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`
}

const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })
const folderLink = (dir: string): Link => ({ view: 'files', params: dir === '' ? {} : { dir }, target: 'main' })

const archiveAction = (kind: 'archive' | 'unarchive', path: LibraryPath): Action => ({
  label: kind === 'archive' ? '归档' : '取回',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind, path } },
})

const field = (name: string, label: string, opts: { placeholder?: string; value?: string } = {}): ActionInput => ({ name, label, placeholder: opts.placeholder ?? null, value: opts.value ?? null, options: null })

/** Moving a thing within the library: put with --to, the whole of a bundle with it. */
const moveAction = (path: LibraryPath): Action => ({
  label: '挪到',
  tone: 'default',
  confirm: null,
  inputs: [field('to', '新的库内路径', { value: path })],
  call: { face: 'agent', verb: 'put', request: { kind: 'move', from: path, to: '{to}' } },
})

/** Bringing a file of this machine into the library, as put of a file outside does; the page cannot hand over standard input. */
const placeAction = (dir: string | null): Action => ({
  label: '从这台机器放进来',
  tone: 'default',
  confirm: null,
  inputs: [
    field('from', '这台机器上的文件', { placeholder: '绝对路径，比如 /Users/me/Downloads/a.pdf' }),
    field('to', '库内路径', { placeholder: '比如 sources/a.pdf', value: dir === null ? '' : `${dir}/` }),
    field('source', '出处', { placeholder: '网址、书名或别的出处；不知道就留空' }),
  ],
  call: { face: 'agent', verb: 'put', request: { kind: 'place', from: { kind: 'file', path: '{from}' }, to: '{to}', origin: { kind: 'brought', source: '{source}', by: null } } },
})

// ---- files ----

const FILE_COLUMNS = [
  { key: 'name', label: '名字' },
  { key: 'size', label: '大小' },
  { key: 'modified', label: '改于' },
]

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i

/** A thing's name cell: a bundle with its own icon and how many files it holds, an image or a file with theirs. */
function thingName(text: string, kind: Thing['kind'], files: number): Cell {
  if (kind === 'bundle') return { text, mono: true, icon: 'package', tag: { text: `${files} 个文件`, tone: 'neutral' } }
  return { text, mono: true, icon: IMAGE.test(text) ? 'image' : 'file' }
}

const modified = (thing: Thing | null): Cell => (thing ? { text: when(thing.modifiedAt), muted: true, at: thing.modifiedAt } : { text: '' })
const blank: Cell = { text: '' }

/**
 * One folder of the library's content: its folders first, then its things, a bundle as one row that
 * opens the item panel. The kernel's files and the archive are left out.
 */
async function filesPage(params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const input = params.dir ?? ''
  const dir = input === '' ? null : parseLibraryPath(root, input)
  if (input !== '' && (dir === null || regionOf(dir) !== 'content')) {
    return shown('文件', input, [{ kind: 'empty', title: '这个文件夹不在库的内容里', hint: null }])
  }
  const folder = dir === null ? root : abs(root, dir)
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null)
  if (entries === null) return shown('文件', input, [{ kind: 'empty', title: '没有这个文件夹', hint: input }])
  const hidden = new Set(dir === null ? [KERNEL_DIR, DESCRIPTION_FILE, ARCHIVE_DIR] : [])
  const named = entries.filter((e) => !hidden.has(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
  const pathOf = (name: string) => (dir === null ? name : `${dir}/${name}`)
  const kinds = await Promise.all(named.map(async (e) => ({ name: e.name, kind: await kindAt(join(folder, e.name)) })))
  const rows: TableRow[] = []
  if (dir !== null) {
    const parent = posix.dirname(dir)
    rows.push({ key: '..', cells: { name: { text: '..', mono: true, icon: 'corner-left-up', link: folderLink(parent === '.' ? '' : parent) }, size: blank, modified: blank }, link: null, actions: [] })
  }
  for (const { name } of kinds.filter((k) => k.kind === 'folder')) {
    const path = pathOf(name)
    rows.push({ key: path, cells: { name: { text: `${name}/`, mono: true, icon: 'folder', link: folderLink(path) }, size: blank, modified: blank }, link: folderLink(path), actions: [] })
  }
  for (const { name, kind } of kinds) {
    if (kind !== 'file' && kind !== 'bundle') continue
    const path = pathOf(name)
    const thing = await thingAt(abs(root, path as LibraryPath))
    const cells = { name: thingName(name, kind, thing?.files ?? 0), size: { text: thing ? sizeText(thing.size) : '', muted: true }, modified: modified(thing) }
    rows.push({ key: path, cells, link: itemLink(path), actions: [] })
  }
  const table: Block = { kind: 'table', columns: FILE_COLUMNS, rows, empty: '这个文件夹是空的。把文件放进这个文件夹，或者让 agent 用 put 放进来。' }
  return shown('文件', dir ?? '库的根目录', [{ kind: 'actions', actions: [placeAction(dir)] }, table])
}

// ---- archive ----

/** Everything in `_archive/`, each with the path it came from; to take back one, or to purge them all. */
async function archivePage(_params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const dir = join(root, ARCHIVE_DIR)
  const things = (await exists(dir)) ? (await listThings(dir, new Set())).map((t) => ({ path: archivedPath(t.path as LibraryPath), kind: t.kind })) : []
  const paths = things.map((t) => t.path)
  const rows: TableRow[] = []
  for (const { path, kind } of things) {
    const facts = await thingAt(abs(root, path))
    rows.push({
      key: path,
      cells: {
        original: thingName(originalPath(path) ?? path, kind, facts?.files ?? 0),
        at: { text: path, mono: true, muted: true },
        size: { text: facts ? sizeText(facts.size) : '', muted: true },
        modified: modified(facts),
      },
      link: itemLink(path),
      actions: [archiveAction('unarchive', path)],
    })
  }
  const purge = kernelAction('archive purge', '清空归档区', { tone: 'danger', confirm: `归档区里的 ${paths.length} 样东西会被删掉，不能撤回。` })
  const columns = [
    { key: 'original', label: '原来的路径' },
    { key: 'at', label: '在归档区的位置' },
    { key: 'size', label: '大小' },
    { key: 'modified', label: '改于' },
  ]
  const section: Block = {
    kind: 'section',
    title: '归档的东西',
    note: '归档的东西不删；默认的找和查不带它们。',
    count: paths.length,
    blocks: [{ kind: 'table', columns, rows, empty: '归档区是空的。在文件页或一样东西的详情里点「归档」，它会挪到这里，不会被删掉。' }],
    actions: paths.length > 0 ? [purge] : [],
  }
  return shown('归档区', null, [section])
}

// ---- config ----

type FormOptions = { fixed?: Record<string, FixedValue>; values?: Record<string, string> }

/** The form of the kernel's command `name`, made from its `params`, so it asks for what the command line takes. */
const kernelForm = (name: KernelCommandName, opts: FormOptions) => formOf(KERNEL_COMMANDS.find((c) => c.name === name) ?? { name, params: {} }, opts)

function kernelAction(name: KernelCommandName, label: string, opts: FormOptions & { tone?: Action['tone']; confirm?: string } = {}): Action {
  const { inputs, call } = kernelForm(name, opts)
  return { label, tone: opts.tone ?? 'default', confirm: opts.confirm ?? null, inputs, call }
}

/** The secrets each installed plugin declares, whether this machine has each, and a form to set it: the value goes to the command as its standard input. */
async function secretsSection(ctx: Context): Promise<Block | null> {
  const rows: TableRow[] = []
  for (const plugin of ctx.library.plugins) {
    const set = await secretNames(ctx.home, plugin.name)
    for (const secret of plugin.secrets ?? []) {
      const has = set.includes(secret.name)
      const fixed = { plugin: plugin.name, name: secret.name }
      const value: ActionInput = { name: 'value', label: '值', placeholder: null, value: null, options: null, secret: true }
      const form = kernelForm('secret set', { fixed })
      const setter: Action = { label: has ? '换一个' : '设', tone: 'default', confirm: null, inputs: [...form.inputs, value], call: { ...form.call, stdin: '{value}' } }
      rows.push({
        key: `${plugin.name}/${secret.name}`,
        cells: {
          plugin: { text: plugin.name, mono: true },
          name: { text: secret.name, mono: true },
          description: { text: secret.description },
          state: { text: '', tag: has ? { text: '已设', tone: 'good' } : secret.optional === true ? { text: '没设（可选）', tone: 'neutral' } : { text: '没设', tone: 'warn' } },
        },
        link: null,
        actions: [
          setter,
          ...(has ? [kernelAction('secret remove', '删掉', { fixed, tone: 'danger', confirm: `删掉后，插件 ${plugin.name} 在这台机器上读不到 ${secret.name}，要用时得再设。` })] : []),
        ],
      })
    }
  }
  if (rows.length === 0) return null
  return {
    kind: 'section',
    title: '密钥',
    note: `插件用的凭证，只存在这台机器上（${join(ctx.home, 'secrets')}），不进库，不会同步，界面和命令行都不显示它的值。`,
    count: rows.length,
    blocks: [{ kind: 'table', columns: [{ key: 'plugin', label: '插件' }, { key: 'name', label: '密钥' }, { key: 'description', label: '做什么用' }, { key: 'state', label: '状态' }], rows, empty: '' }],
    actions: [],
  }
}

/** The installed plugins, the grants, the skills and the plugins' secrets, each with the owner commands that change them. */
async function configPage(_params: Record<string, string>, { ctx, table }: ViewerCall): Promise<Shown> {
  const { library } = ctx
  const { root, config } = library

  const about: Block = {
    kind: 'fields',
    fields: [
      { label: '位置', value: { text: root, mono: true } },
      { label: '库标识', value: { text: config.id, mono: true, muted: true } },
      { label: '说明', value: { text: DESCRIPTION_FILE, mono: true } },
    ],
  }

  // Every plugin this pneuma-base knows, and every one the library has installed: 卸下 for the installed, 装上 for the rest.
  // Its version and what it brings, as plugin list shows them: the summary, else its cognition's title.
  const dash: Cell = { text: '—', muted: true }
  const pluginRow = (name: string, state: Tag, actions: Action[]): TableRow => {
    const p = library.plugins.find((q) => q.name === name) ?? table.get(name)
    const summary = p?.summary ?? p?.cognition?.title
    return {
      key: name,
      cells: {
        name: { text: name, mono: true },
        version: p?.version === undefined ? dash : { text: p.version, mono: true },
        title: summary === undefined ? dash : { text: summary },
        state: { text: '', tag: state },
      },
      link: null,
      actions,
    }
  }
  const installed = config.plugins.map((name) =>
    pluginRow(name, library.plugins.some((p) => p.name === name) ? { text: '已装', tone: 'good' } : { text: '这个 pneuma-base 里没有', tone: 'warn' }, [kernelAction('plugin remove', '卸下', { fixed: { plugin: name, anyway: false } })]),
  )
  // A plugin installed on this machine, not built in, can also leave the machine once no library here uses it.
  const uninstall = (name: string): Action[] => {
    const p = table.get(name)
    if (p === undefined || machineDirOf(p) === null) return []
    return [kernelAction('plugin uninstall', '从这台机器卸掉', { fixed: { plugin: name }, tone: 'danger', confirm: `从这台机器卸掉插件 ${name}？这台机器上别的库装着它的，会报它不可用。` })]
  }
  const addable = [...table.keys()].filter((name) => !config.plugins.some((p) => p === name))
  const offered = addable.map((name) => pluginRow(name, { text: '没装', tone: 'neutral' }, [kernelAction('plugin add', '装上', { fixed: { plugin: name } }), ...uninstall(name)]))
  const plugins: Block = {
    kind: 'section',
    title: '插件',
    note: '装上一个插件，库就多了它的本事和它的页；卸下时，它名下的目录原样留着。',
    count: config.plugins.length,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'name', label: '名字' }, { key: 'version', label: '版本', optional: true }, { key: 'title', label: '做什么' }, { key: 'state', label: '状态' }],
        rows: [...installed, ...offered],
        empty: '这个 pneuma-base 不认识任何插件。库照样能放、找、看、归档。',
      },
    ],
    actions: [kernelAction('plugin install', '从目录装一个插件到这台机器')],
  }

  const skillAction = (grant: string, agent: 'claude' | 'codex', dir: string): Action =>
    kernelAction('skill install', agent === 'claude' ? '为 Claude 生成技能' : '为 Codex 生成技能', { fixed: { grant, agent }, values: { dir } })
  const grantRows: TableRow[] = config.grants.map((g) => ({
    key: g.id,
    cells: {
      name: { text: g.name, mono: true },
      agent: { text: g.agent },
      area: g.area === null ? { text: '整个库', muted: true } : { text: g.area, mono: true },
      access: { text: '', tag: g.readOnly ? { text: '只读', tone: 'neutral' } : { text: '读写', tone: 'info' } },
    },
    link: null,
    actions: [
      skillAction(g.name, 'claude', '~/.claude/skills'),
      skillAction(g.name, 'codex', '~/.agents/skills'),
      kernelAction('grant revoke', '撤回', { fixed: { name: g.name }, tone: 'danger', confirm: `撤回后，拿着授权 ${g.name} 的 agent 就不能再用这个库。` }),
    ],
  }))
  const grants: Block = {
    kind: 'section',
    title: '授权与技能',
    note: '没发任何授权时，谁都能用整个库；区域留空也是整个库。技能是一个指向说明的短文件，在授权那一行为 Claude 或 Codex 生成。',
    count: config.grants.length,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'name', label: '授权名' }, { key: 'agent', label: '给谁' }, { key: 'area', label: '区域' }, { key: 'access', label: '权限' }],
        rows: grantRows,
        empty: '还没发授权。点「发授权」给一个 agent 一份，再在它那一行为它生成技能。',
      },
      { kind: 'text', tone: 'info', text: codexHint(root) },
    ],
    actions: [kernelAction('grant issue', '发授权')],
  }
  const secrets = await secretsSection(ctx)
  return shown('配置', null, [about, plugins, grants, ...(secrets ? [secrets] : [])])
}

// ---- item ----

/** For an `_archive/…` path with no file: the file taken back to its original path, if there is one. */
async function takenBack(root: string, target: string) {
  const path = parseLibraryPath(root, target)
  const original = path !== null && regionOf(path) === 'archive' ? originalPath(path) : null
  return original === null ? null : fileFacts(root, original)
}

/** A plugin's answer has at least a title and a list of blocks; anything else is the plugin failing. */
const answered = (a: unknown): a is { title: string; blocks: Block[] } =>
  typeof a === 'object' && a !== null && typeof (a as { title?: unknown }).title === 'string' && Array.isArray((a as { blocks?: unknown }).blocks)

/** A section of the item panel; a plugin's part is stamped with the plugin's name. */
const section = (title: string, blocks: Block[], plugin?: PluginName): Block => ({ kind: 'section', title, note: null, count: null, blocks, actions: [], ...(plugin === undefined ? {} : { plugin }) })

type Parts = { blocks: Block[]; actions: Action[]; problems: PluginProblem[] }

/**
 * Each installed plugin's section about `path`, in configuration order, and the actions each gives
 * for the panel's bottom row. A plugin that fails gets a section that says so (K8).
 */
async function pluginSections(ctx: Context, path: LibraryPath, callable: Callable): Promise<Parts> {
  const blocks: Block[] = []
  const actions: Action[] = []
  const problems: PluginProblem[] = []
  for (const plugin of ctx.library.plugins) {
    if (!plugin.onItemView) continue
    try {
      const answer = await plugin.onItemView(path, pluginContext(ctx, plugin.name))
      if (answer === null) continue
      if (!answered(answer)) throw new Error('onItemView answered something that is not a section')
      const checked = checkBlocks(answer.blocks, plugin, callable)
      blocks.push(section(answer.title, checked.blocks, plugin.name))
      problems.push(...checked.problems)
      const own = checkBlocks([{ kind: 'actions', actions: answer.actions ?? [] }], plugin, callable, 'actions')
      const [row] = own.blocks
      if (row?.kind === 'actions') actions.push(...row.actions)
      else blocks.push(...own.blocks)
      problems.push(...own.problems)
    } catch (error) {
      const message = messageOf(error)
      problems.push({ plugin: plugin.name, message })
      blocks.push(section(`插件 ${plugin.name}`, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出它知道的`, hint: message }], plugin.name))
    }
  }
  return { blocks, actions, problems }
}

/** What a thing is, in one line: a file or a bundle, its size, and whether it is archived or part of a bundle. */
function whatItIs(facts: FileFacts, bundle: LibraryPath | null): Block {
  const kind = facts.kind === 'bundle' ? `一样东西（带标记的目录），${facts.files} 个文件` : '文件'
  const where = facts.archived ? ' · 已归档' : bundle !== null ? ` · ${bundle} 的一部分` : ''
  return { kind: 'text', tone: 'neutral', text: `${kind} · ${sizeText(facts.size)}${where}` }
}

/**
 * One thing of the library, in a fixed order: what it is in one line; what each plugin knows about
 * it; its own facts, and a bundle's files or a file's preview; then what can be done with it, in one
 * row at the bottom: archive or take back and move, then each plugin's actions. A file inside a
 * bundle names the bundle and offers no archive: the bundle changes only as a whole.
 */
async function itemPage(params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const target = params.path ?? ''
  const facts = target === '' ? null : ((await fileFacts(root, target)) ?? (await takenBack(root, target)))
  const path = facts?.path ?? parseLibraryPath(root, target)
  const known = path === null || regionOf(path) === 'kernel' ? { blocks: [], actions: [], problems: [] } : await pluginSections(ctx, path, callableIn(ctx.library))
  const bottom = (own: Action[]): Block[] => (own.length + known.actions.length > 0 ? [{ kind: 'actions', actions: [...own, ...known.actions] }] : [])
  if (!facts) {
    const missing: Block = { kind: 'text', tone: 'warn', text: `${target || '这个路径'} 上没有文件：不在，或已经除掉了。` }
    return shown(posix.basename(target) || '一样东西', target || null, [missing, ...known.blocks, ...bottom([])], known.problems)
  }
  const original = facts.archived ? (originalPath(facts.path) ?? facts.path) : facts.path
  const bundle = facts.kind === 'file' ? await enclosingBundle(root, facts.path) : null
  const own = bundle !== null ? [] : facts.archived ? [archiveAction('unarchive', facts.path)] : [archiveAction('archive', original), moveAction(original)]
  return shown(posix.basename(original), facts.path, [whatItIs(facts, bundle), ...known.blocks, ...(await thingSections(root, facts, bundle)), ...bottom(own)], known.problems)
}

/** How many files of a bundle the panel lists. */
const INNER_LIMIT = 500

/** The thing's own facts, then a bundle's files, each opening its own panel, or a file's preview, which folds. */
async function thingSections(root: string, facts: FileFacts, bundle: LibraryPath | null): Promise<Block[]> {
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '路径', value: { text: facts.path, mono: true, ...(facts.archived ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}) } },
      ...(bundle !== null ? [{ label: '在', value: { text: bundle, mono: true, icon: 'package' as const, link: itemLink(bundle) } }] : []),
      { label: '种类', value: { text: facts.kind === 'bundle' ? '一样东西（带标记的目录）' : '文件' } },
      ...(facts.kind === 'bundle' ? [{ label: '文件数', value: { text: String(facts.files) } }] : []),
      { label: '大小', value: { text: sizeText(facts.size) } },
      { label: '改于', value: { text: when(facts.modifiedAt), at: facts.modifiedAt } },
      { label: '指纹', value: { text: facts.fingerprint.slice(0, 16), mono: true, muted: true } },
    ],
  }
  const partOf: Block[] = bundle === null ? [] : [{ kind: 'text', tone: 'neutral', text: `它是 ${bundle} 的一部分。${bundle} 是一样东西，只能整个一起放、挪、归档。` }]
  const own = section('文件', [fields, ...partOf])
  if (facts.kind === 'file') return [own, { kind: 'section', title: '预览', note: null, count: null, blocks: [{ kind: 'preview', path: facts.path }], actions: [], collapse: 'open' }]
  const files = await bundleFiles(abs(root, facts.path))
  const rows: TableRow[] = files.slice(0, INNER_LIMIT).map((f) => ({
    key: f.path,
    cells: { path: { text: f.path, mono: true, icon: IMAGE.test(f.path) ? 'image' : 'file' }, size: { text: sizeText(f.size), muted: true } },
    link: itemLink(`${facts.path}/${f.path}`),
    actions: [],
  }))
  const inner: Block = {
    kind: 'section',
    title: '里面的文件',
    note: files.length > INNER_LIMIT ? `只列出了前 ${INNER_LIMIT} 个。` : null,
    count: files.length,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '文件' }, { key: 'size', label: '大小' }], rows, empty: '这个目录里没有算进来的文件。' }],
    actions: [],
  }
  return [own, inner]
}

// ---- home ----

/**
 * The page the owner opens on: 「开始」 while a step of getting started is left (start.ts); what waits
 * on the owner, the agents' pending requests first, oldest first, then every plugin's `onAsks`; then
 * each plugin view declared `home`, its blocks as they are, in configuration order, but for the steps
 * they give, which join 「开始」. With no such view the page says so and shows the library's top
 * folder, so a library without plugins has a home too.
 */
async function homePage(_params: Record<string, string>, call: ViewerCall): Promise<Shown> {
  const { ctx } = call
  const asked = await asksOf(ctx, callableIn(ctx.library))
  const titleOf = (by: string | ActorMark) => (typeof by === 'string' ? (ctx.library.plugins.find((p) => p.name === by)?.cognition?.title ?? by) : by)
  const asks = [...(await requestAsks(ctx.library)), ...asked.asks.map((a) => ({ ...a, by: titleOf(a.by) }))]
  const decide: Block = {
    kind: 'section',
    title: '等你决定',
    note: null,
    count: asks.length > 0 ? asks.length : null,
    blocks: [{ kind: 'asks', asks, empty: '没有要你决定的事。' }],
    actions: [],
  }
  const parts = pluginViews(ctx.library).views.filter((v) => v.decl.home === true)
  const problems = [...asked.problems]
  const given: Block[] = []
  for (const { plugin, decl } of parts) {
    const part = await pluginPage(plugin, decl, { view: decl.id, params: Object.fromEntries(decl.filters.map((f) => [f.name, f.default])) }, ctx)
    given.push(...part.blocks)
    problems.push(...part.problems)
  }
  const { start, rest } = startPart(await kernelSteps(call), given)
  const blocks: Block[] = [...(start === null ? [] : [start]), decide, ...rest]
  if (parts.length === 0) {
    const files = await filesPage({}, call)
    const why = ctx.library.plugins.length === 0 ? '这个库没装插件：首页只有要你决定的事和库里的文件。装上插件，这里会有 agent 做了什么、哪些东西要留意。' : '装着的插件没有给首页添内容，下面是库里的文件。'
    blocks.push({ kind: 'text', tone: 'neutral', text: why }, { kind: 'section', title: '库里的文件', note: null, count: null, blocks: files.blocks, actions: [] })
  }
  return shown('首页', null, blocks, problems)
}

// ---- the face ----

/** The kernel's own views, each with the page that answers it. */
const KERNEL_VIEWS: readonly { decl: ViewDecl; page: KernelPage }[] = [
  { decl: { id: 'home', title: '首页', icon: 'house', nav: true, filters: [] }, page: homePage },
  { decl: { id: 'files', title: '文件', icon: 'folder', nav: true, filters: [] }, page: filesPage },
  { decl: { id: 'archive', title: '归档区', icon: 'archive', nav: true, filters: [] }, page: archivePage },
  { decl: { id: 'agents', title: 'Agent', icon: 'users', nav: true, filters: [], ownerOnly: true }, page: agentsPage },
  { decl: { id: 'config', title: '配置', icon: 'settings', nav: true, filters: [], ownerOnly: true }, page: configPage },
  { decl: { id: 'item', title: '一样东西', icon: 'file', nav: false, filters: [] }, page: itemPage },
]

/** Each installed plugin's views, in configuration order. A view whose id does not start with `<plugin name>.` is left out as a problem. */
function pluginViews(library: Library): { views: { plugin: Plugin; decl: ViewDecl }[]; problems: PluginProblem[] } {
  const views: { plugin: Plugin; decl: ViewDecl }[] = []
  const problems: PluginProblem[] = []
  for (const plugin of library.plugins) {
    for (const decl of plugin.views ?? []) {
      if (decl.id.startsWith(`${plugin.name}.`)) views.push({ plugin, decl })
      else problems.push({ plugin: plugin.name, message: `view ${decl.id} does not start with ${plugin.name}.` })
    }
  }
  return { views, problems }
}

/** A plugin's view. A plugin that throws or answers no view gets a page that says it failed, and the problem (K8). */
async function pluginPage(plugin: Plugin, decl: ViewDecl, req: ViewRequest, ctx: Context): Promise<Shown> {
  try {
    if (!plugin.onView) throw new Error(`declares the view ${decl.id} but has no onView`)
    const answer = await plugin.onView(req, pluginContext(ctx, plugin.name))
    if (!answered(answer)) throw new Error(`onView answered something that is not a view for ${decl.id}`)
    const { blocks, problems } = checkBlocks(answer.blocks, plugin, callableIn(ctx.library))
    const { refresh, problems: refreshProblems } = checkRefresh((answer as ViewAnswer).refresh, plugin)
    const { filters, problems: filterProblems } = checkFilters((answer as ViewAnswer).filters, decl, plugin)
    const { open, problems: openProblems } = checkOpen((answer as ViewAnswer).open, plugin)
    return {
      ...shown(answer.title, answer.subtitle ?? null, blocks, [...problems, ...refreshProblems, ...filterProblems, ...openProblems]),
      ...(refresh === undefined ? {} : { refresh }),
      ...(filters === undefined ? {} : { filters }),
      ...(open === undefined ? {} : { open }),
    }
  } catch (error) {
    const message = messageOf(error)
    return shown(decl.title, null, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出这一页`, hint: message }], [{ plugin: plugin.name, message }])
  }
}

export const viewerFace = {
  /** Every view of the library, each with who gives it: the plugins' first, in configuration order, then the kernel's. */
  views(library: Library): ViewList {
    const missing: PluginProblem[] = library.unavailable.map((plugin) => ({ plugin, message: 'installed in this library but not known to this pneuma-base' }))
    const own = pluginViews(library)
    const views: ListedView[] = [...own.views.map((v) => ({ ...v.decl, by: v.plugin.name })), ...KERNEL_VIEWS.map((v) => ({ ...v.decl, by: 'kernel' as const }))]
    return { views, problems: [...missing, ...library.clashes, ...own.problems] }
  },

  /**
   * One view, a filter not given taking its default. Showing changes nothing and sends no event. A
   * page of management (`ownerOnly`) is refused in an agent's session as an owner-only command is.
   */
  async show(req: ViewRequest, call: ViewerCall): Promise<ViewResult> {
    const found = KERNEL_VIEWS.find((v) => v.decl.id === req.view) ?? pluginViews(call.ctx.library).views.find((v) => v.decl.id === req.view)
    if (found === undefined) return { outcome: 'no-such-view', problems: [] }
    const { decl } = found
    const sign = decl.ownerOnly === true ? agentSign(call.env, call.viaGrant, call.ctx.actor) : null
    if (sign !== null) return { outcome: 'refused', reason: 'agent-session', text: ownerOnlyRefusal(`show ${decl.id}`, OWNER_DECIDES, sign), problems: [] }
    const params = { ...Object.fromEntries(decl.filters.map((f) => [f.name, f.default])), ...req.params }
    if ('page' in found) return { outcome: 'shown', ...(await found.page(params, call)) }
    return { outcome: 'shown', ...(await pluginPage(found.plugin, decl, { view: decl.id, params }, call.ctx)) }
  },
}
