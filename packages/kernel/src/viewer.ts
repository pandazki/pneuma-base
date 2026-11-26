// The viewer face: the read-only side the management UI uses. ARCHITECTURE.md section 6.
// Views are not operations: they change nothing and send no event.
import { join } from 'node:path'
import { agentsPage } from './agents-page.js'
import { archivePage, filesPage } from './files-page.js'
import { homePage } from './home.js'
import { itemPage } from './item-page.js'
import { noiseSection } from './noise-commands.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { DESCRIPTION_FILE } from './paths.js'
import { machineDirOf } from './plugin-table.js'
import { pluginPage, pluginViews, shown, type KernelPage, type Shown } from './plugin-views.js'
import { codexHint } from './products.js'
import { secretNames } from './secrets.js'
import { agentSign, ownerOnlyRefusal, OWNER_DECIDES, type Env } from './session.js'
import { storageOf } from './storage.js'
import { kernelAction, kernelForm } from './view-parts.js'
import {
  formOf,
  rowsOf,
  type Action,
  type ActionInput,
  type Block,
  type Cell,
  type Context,
  type Library,
  type ListedView,
  type PluginProblem,
  type PluginTable,
  type TableRow,
  type Tag,
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

const ADDRESSES: Record<string, string> = { path: '本机路径' }
const listText = (v: unknown, names: Record<string, string> = {}) => (Array.isArray(v) && v.length > 0 ? v.map((x) => names[String(x)] ?? String(x)).join('、') : '—')

/** A button of a kernel command found by name, from its params; none while this pneuma-base has no such command. */
function commandAction(name: string, label: string, opts: { fixed?: Record<string, string>; tone?: Action['tone']; confirm?: string } = {}): Action[] {
  const c = KERNEL_COMMANDS.find((k) => (k.name as string) === name)
  return c === undefined ? [] : [{ label, tone: opts.tone ?? 'default', confirm: opts.confirm ?? null, ...formOf(c, { fixed: opts.fixed ?? {} }) }]
}

/**
 * The storage provider the library uses, as it describes itself: its name, version, the addresses it
 * answers and the facets it gives; the storage commands' buttons where this pneuma-base has them.
 * Then the library's noise.
 */
async function storageSection(ctx: Context): Promise<Block> {
  const dash: Cell = { text: '—', muted: true }
  let row: TableRow
  try {
    const d = await storageOf(ctx.library.root).describe()
    const name = typeof d.name === 'string' ? d.name : '?'
    row = {
      key: name,
      cells: {
        name: { text: name, mono: true },
        version: typeof d.version === 'string' ? { text: d.version, mono: true } : dash,
        addresses: { text: listText(d.addresses, ADDRESSES) },
        facets: { text: listText(d.facets), mono: true, muted: true },
        state: { text: '随 pneuma-base 带着', muted: true, tag: { text: '这个库在用', tone: 'good' } },
      },
      link: null,
      actions: [...commandAction('storage update', '更新', { fixed: { name } }), ...commandAction('storage remove', '卸掉', { fixed: { name }, tone: 'danger', confirm: `卸掉存储提供者 ${name}？用它的库在这台机器上打不开，直到再装上。` })],
    }
  } catch (error) {
    row = { key: '?', cells: { name: { text: '?', mono: true }, version: dash, addresses: dash, facets: dash, state: { text: error instanceof Error ? error.message : String(error), tag: { text: '答不上来', tone: 'bad' } } }, link: null, actions: [] }
  }
  return {
    kind: 'section',
    title: '存储',
    note: '存储提供者以主人的身份运行，看得到库里的全部内容。',
    count: null,
    blocks: [
      {
        kind: 'table',
        columns: [{ key: 'name', label: '提供者' }, { key: 'version', label: '版本', optional: true }, { key: 'addresses', label: '地址的写法' }, { key: 'facets', label: '给得出的面', optional: true }, { key: 'state', label: '状态' }],
        rows: [row],
        empty: '',
      },
      await noiseSection(ctx.library.root),
    ],
    actions: commandAction('storage install', '安装别的存储…'),
  }
}

/** The installed plugins, the grants, the skills, the plugins' secrets and storage, each with the owner commands that change them. */
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
  return shown('配置', null, [about, plugins, grants, ...(secrets ? [secrets] : []), await storageSection(ctx)])
}

// ---- the face ----

/** The kernel's own views, each with the page that answers it. */
const KERNEL_VIEWS: readonly { decl: ViewDecl; page: KernelPage }[] = [
  { decl: { id: 'home', title: '首页', icon: 'house', nav: true, filters: [] }, page: (params, call, rows) => homePage(params, call, rows, filesPage) },
  { decl: { id: 'files', title: '文件', icon: 'folder', nav: true, filters: [] }, page: filesPage },
  { decl: { id: 'archive', title: '归档区', icon: 'archive', nav: true, filters: [] }, page: archivePage },
  { decl: { id: 'agents', title: 'Agent', icon: 'users', nav: true, filters: [], ownerOnly: true }, page: agentsPage },
  { decl: { id: 'config', title: '配置', icon: 'settings', nav: true, filters: [], ownerOnly: true }, page: configPage },
  { decl: { id: 'item', title: '一样东西', icon: 'file', nav: false, filters: [] }, page: itemPage },
]

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
    if ('page' in found) return { outcome: 'shown', ...(await found.page(params, call, rowsOf(req))) }
    return { outcome: 'shown', ...(await pluginPage(found.plugin, decl, { view: decl.id, params, ...(req.size === undefined ? {} : { size: req.size }) }, call.ctx)) }
  },
}
