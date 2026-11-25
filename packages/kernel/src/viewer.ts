// The viewer face: the read-only side the management UI uses. ARCHITECTURE.md section 6.
// Views are not operations: they change nothing and send no event.
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { fileFacts } from './agent.js'
import { exists, regularFile } from './files.js'
import { listThings, thingAt } from './things.js'
import { codexHint } from './owner-commands.js'
import { ARCHIVE_DIR, DESCRIPTION_FILE, KERNEL_DIR, abs, archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { messageOf, pluginContext } from './pipeline.js'
import type {
  Action,
  Block,
  Context,
  FileFacts,
  Library,
  LibraryPath,
  Link,
  Plugin,
  PluginProblem,
  PluginTable,
  TableRow,
  ViewAnswer,
  ViewDecl,
  ViewList,
  ViewRequest,
  ViewResult,
} from './types.js'

/** What showing a view needs besides the request: the operation's context and the plugins this pneuma-base knows. */
export type ViewerCall = { ctx: Context; table: PluginTable }

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

// ---- files ----

const FILE_COLUMNS = [
  { key: 'name', label: '名字' },
  { key: 'size', label: '大小' },
  { key: 'modified', label: '改于' },
]

/** One folder of the library's content: its folders first, then its files. The kernel's files and the archive are left out. */
async function filesPage(params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const input = params.dir ?? ''
  const dir = input === '' ? null : parseLibraryPath(root, input)
  if (input !== '' && (dir === null || regionOf(dir) !== 'content')) {
    return shown('文件', input, [{ kind: 'empty', title: '这个文件夹不在库的内容里', hint: null }])
  }
  const entries = await readdir(dir === null ? root : abs(root, dir), { withFileTypes: true }).catch(() => null)
  if (entries === null) return shown('文件', input, [{ kind: 'empty', title: '没有这个文件夹', hint: input }])
  const hidden = new Set(dir === null ? [KERNEL_DIR, DESCRIPTION_FILE, ARCHIVE_DIR] : [])
  const named = entries.filter((e) => !hidden.has(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
  const pathOf = (name: string) => (dir === null ? name : `${dir}/${name}`)
  const rows: TableRow[] = []
  if (dir !== null) {
    const parent = posix.dirname(dir)
    rows.push({ key: '..', cells: { name: { text: '..', mono: true, link: folderLink(parent === '.' ? '' : parent) }, size: { text: '' }, modified: { text: '' } }, link: null, actions: [] })
  }
  for (const e of named.filter((e) => e.isDirectory())) {
    const path = pathOf(e.name)
    rows.push({ key: path, cells: { name: { text: `${e.name}/`, mono: true, link: folderLink(path) }, size: { text: '' }, modified: { text: '' } }, link: folderLink(path), actions: [] })
  }
  for (const e of named.filter((e) => e.isFile())) {
    const path = pathOf(e.name)
    const facts = await regularFile(abs(root, path as LibraryPath))
    const cells = { name: { text: e.name, mono: true }, size: { text: facts ? sizeText(facts.size) : '', muted: true }, modified: { text: facts ? when(facts.modifiedAt) : '', muted: true } }
    rows.push({ key: path, cells, link: itemLink(path), actions: [] })
  }
  const table: Block = { kind: 'table', columns: FILE_COLUMNS, rows, empty: '这个文件夹是空的' }
  return shown('文件', dir ?? '库的根目录', [table])
}

// ---- archive ----

/** Everything in `_archive/`, each with the path it came from; to take back one, or to purge them all. */
async function archivePage(_params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const dir = join(root, ARCHIVE_DIR)
  const paths = (await exists(dir)) ? (await listThings(dir, new Set())).map((t) => archivedPath(t.path as LibraryPath)) : []
  const rows: TableRow[] = []
  for (const path of paths) {
    const facts = await thingAt(abs(root, path))
    rows.push({
      key: path,
      cells: {
        original: { text: originalPath(path) ?? path, mono: true },
        at: { text: path, mono: true, muted: true },
        size: { text: facts ? sizeText(facts.size) : '', muted: true },
        modified: { text: facts ? when(facts.modifiedAt) : '', muted: true },
      },
      link: itemLink(path),
      actions: [archiveAction('unarchive', path)],
    })
  }
  const purge: Action = {
    label: '清空归档区',
    tone: 'danger',
    confirm: `归档区里的 ${paths.length} 个文件会被删掉，不能撤回。`,
    inputs: [],
    call: { face: 'owner', command: 'archive purge', args: { positional: [], flags: {} } },
  }
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
    blocks: [{ kind: 'table', columns, rows, empty: '归档区是空的' }],
    actions: paths.length > 0 ? [purge] : [],
  }
  return shown('归档区', null, [section])
}

// ---- config ----

const owner = (command: string, positional: string[], flags: Record<string, string[] | true> = {}) => ({ face: 'owner' as const, command, args: { positional, flags } })
const input = (name: string, label: string, opts: Partial<Pick<Action['inputs'][number], 'placeholder' | 'value' | 'options'>> = {}) => ({
  name,
  label,
  placeholder: opts.placeholder ?? null,
  value: opts.value ?? null,
  options: opts.options ?? null,
})

/** The installed plugins, the grants, and the skills, each with the owner commands that change them. */
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

  const pluginRows: TableRow[] = config.plugins.map((name) => {
    const plugin = library.plugins.find((p) => p.name === name)
    return {
      key: name,
      cells: {
        name: { text: name, mono: true },
        title: plugin?.cognition ? { text: plugin.cognition.title } : { text: '—', muted: true },
        state: { text: '', tag: plugin ? { text: '已装', tone: 'good' } : { text: '这个 pneuma-base 里没有', tone: 'warn' } },
      },
      link: null,
      actions: [{ label: '卸下', tone: 'default', confirm: null, inputs: [], call: owner('plugin remove', [name]) }],
    }
  })
  const addable = [...table.keys()].filter((name) => !config.plugins.some((p) => p === name))
  const addPlugin: Action = {
    label: '装上插件',
    tone: 'default',
    confirm: null,
    inputs: [input('plugin', '插件', { value: addable[0] ?? null, options: addable.map((name) => ({ value: name, label: table.get(name)?.cognition?.title ? `${name}（${table.get(name)?.cognition?.title}）` : name })) })],
    call: owner('plugin add', ['{plugin}']),
  }
  const plugins: Block = {
    kind: 'section',
    title: '插件',
    note: '卸下插件时，它名下的目录原样留着。',
    count: config.plugins.length,
    blocks: [{ kind: 'table', columns: [{ key: 'name', label: '名字' }, { key: 'title', label: '做什么' }, { key: 'state', label: '状态' }], rows: pluginRows, empty: '没装任何插件。库照样能放、找、看、归档。' }],
    actions: addable.length > 0 ? [addPlugin] : [],
  }

  const skillAction = (grant: string, agent: 'claude' | 'codex', dir: string): Action => ({
    label: agent === 'claude' ? '为 Claude 生成技能' : '为 Codex 生成技能',
    tone: 'default',
    confirm: null,
    inputs: [input('dir', '放技能的目录', { value: dir })],
    call: owner('skill install', [grant], { agent: [agent], dir: ['{dir}'] }),
  })
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
      skillAction(g.name, 'claude', join(homedir(), '.claude', 'skills')),
      skillAction(g.name, 'codex', join(homedir(), '.agents', 'skills')),
      { label: '撤回', tone: 'danger', confirm: `撤回后，拿着授权 ${g.name} 的 agent 就不能再用这个库。`, inputs: [], call: owner('grant revoke', [g.name]) },
    ],
  }))
  const issue: Action = {
    label: '发授权',
    tone: 'default',
    confirm: null,
    inputs: [
      input('name', '授权名', { placeholder: '小写字母、数字和连字符，比如 claude' }),
      input('agent', '给谁', { placeholder: '比如 claude-code 或 codex' }),
      input('area', '区域', { placeholder: '库里的一个子文件夹；留空是整个库' }),
      input('access', '权限', { value: 'no', options: [{ value: 'no', label: '读写' }, { value: 'yes', label: '只读' }] }),
    ],
    call: owner('grant issue', ['{name}'], { agent: ['{agent}'], area: ['{area}'], 'read-only': ['{access}'] }),
  }
  const grants: Block = {
    kind: 'section',
    title: '授权与技能',
    note: '没发任何授权时，谁都能用整个库。技能是一个指向说明的短文件，在授权那一行为 Claude 或 Codex 生成。',
    count: config.grants.length,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'name', label: '授权名' }, { key: 'agent', label: '给谁' }, { key: 'area', label: '区域' }, { key: 'access', label: '权限' }],
        rows: grantRows,
        empty: '还没发授权',
      },
      { kind: 'text', tone: 'info', text: codexHint(root) },
    ],
    actions: [issue],
  }
  return shown('配置', null, [about, plugins, grants])
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

const section = (title: string, blocks: Block[]): Block => ({ kind: 'section', title, note: null, count: null, blocks, actions: [] })

/** Each installed plugin's section about `path`, in configuration order. A plugin that fails gets a section that says so (K8). */
async function pluginSections(ctx: Context, path: LibraryPath): Promise<{ blocks: Block[]; problems: PluginProblem[] }> {
  const blocks: Block[] = []
  const problems: PluginProblem[] = []
  for (const plugin of ctx.library.plugins) {
    if (!plugin.onItemView) continue
    try {
      const answer = await plugin.onItemView(path, pluginContext(ctx, plugin.name))
      if (answer === null) continue
      if (!answered(answer)) throw new Error('onItemView answered something that is not a section')
      blocks.push(section(answer.title, answer.blocks))
    } catch (error) {
      const message = messageOf(error)
      problems.push({ plugin: plugin.name, message })
      blocks.push(section(`插件 ${plugin.name}`, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出它知道的`, hint: message }]))
    }
  }
  return { blocks, problems }
}

/** One thing of the library: the file's facts, archive or take back, a preview; then what each plugin knows about it. */
async function itemPage(params: Record<string, string>, { ctx }: ViewerCall): Promise<Shown> {
  const { root } = ctx.library
  const target = params.path ?? ''
  const facts = target === '' ? null : ((await fileFacts(root, target)) ?? (await takenBack(root, target)))
  const path = facts?.path ?? parseLibraryPath(root, target)
  const known = path === null || regionOf(path) === 'kernel' ? { blocks: [], problems: [] } : await pluginSections(ctx, path)
  if (!facts) {
    const missing: Block = { kind: 'text', tone: 'warn', text: `${target || '这个路径'} 上没有文件：不在，或已经除掉了。` }
    return shown(posix.basename(target) || '一样东西', target || null, [missing, ...known.blocks], known.problems)
  }
  const original = facts.archived ? (originalPath(facts.path) ?? facts.path) : facts.path
  return shown(posix.basename(original), facts.path, [...fileBlocks(facts, original), ...known.blocks], known.problems)
}

/** The file's own facts, the archive or take-back button, and its preview. */
function fileBlocks(facts: FileFacts, original: LibraryPath): Block[] {
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '路径', value: { text: facts.path, mono: true, ...(facts.archived ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}) } },
      { label: '大小', value: { text: sizeText(facts.size) } },
      { label: '改于', value: { text: when(facts.modifiedAt) } },
      { label: '指纹', value: { text: facts.fingerprint.slice(0, 16), mono: true, muted: true } },
    ],
  }
  const actions: Block = { kind: 'actions', actions: [facts.archived ? archiveAction('unarchive', facts.path) : archiveAction('archive', original)] }
  return [fields, actions, { kind: 'preview', path: facts.path }]
}

// ---- the face ----

const KERNEL_VIEWS: readonly ViewDecl[] = [
  { id: 'files', title: '文件', icon: 'folder', nav: true, filters: [] },
  { id: 'archive', title: '归档区', icon: 'archive', nav: true, filters: [] },
  { id: 'config', title: '配置', icon: 'settings', nav: true, filters: [] },
  { id: 'item', title: '一样东西', icon: 'file', nav: false, filters: [] },
]

const KERNEL_PAGES: ReadonlyMap<string, KernelPage> = new Map([
  ['files', filesPage],
  ['archive', archivePage],
  ['config', configPage],
  ['item', itemPage],
])

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
    return shown(answer.title, answer.subtitle ?? null, answer.blocks)
  } catch (error) {
    const message = messageOf(error)
    return shown(decl.title, null, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出这一页`, hint: message }], [{ plugin: plugin.name, message }])
  }
}

export const viewerFace = {
  /** Every view of the library: the plugins' first, in configuration order, then the kernel's. */
  views(library: Library): ViewList {
    const missing: PluginProblem[] = library.unavailable.map((plugin) => ({ plugin, message: 'installed in this library but not known to this pneuma-base' }))
    const own = pluginViews(library)
    return { views: [...own.views.map((v) => v.decl), ...KERNEL_VIEWS], problems: [...missing, ...own.problems] }
  },

  /** One view. Showing changes nothing and sends no event. */
  async show(req: ViewRequest, call: ViewerCall): Promise<ViewResult> {
    const page = KERNEL_PAGES.get(req.view)
    if (page) return { outcome: 'shown', ...(await page(req.params, call)) }
    const found = pluginViews(call.ctx.library).views.find((v) => v.decl.id === req.view)
    if (!found) return { outcome: 'no-such-view', problems: [] }
    return { outcome: 'shown', ...(await pluginPage(found.plugin, found.decl, req, call.ctx)) }
  },
}
