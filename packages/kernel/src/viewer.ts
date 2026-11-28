// The viewer face: the read-only side the management UI uses. ARCHITECTURE.md「视图是只读的命令」.
// Views are not operations: they change nothing and send no event.
import { join } from 'node:path'
import { agentsPage } from './agents-page.js'
import { pluginTitle } from './claims.js'
import { archivePage, filesPage } from './files-page.js'
import { homePage } from './home.js'
import { itemPage } from './item-page.js'
import { ignoreSection } from './ignore-commands.js'
import { DESCRIPTION_FILE } from './paths.js'
import { machineDirOf } from './plugin-table.js'
import { pluginPage, pluginViews, shown, type KernelPage, type Shown } from './plugin-views.js'
import { secretNames } from './secrets.js'
import { storageSection } from './storage-commands.js'
import { agentSign, ownerOnlyRefusal, type Env } from './session.js'
import { kernelAction, kernelForm } from './view-parts.js'
import {
  rowsOf,
  type Action,
  type ActionInput,
  type Block,
  type Context,
  type Library,
  type ListedView,
  type ListItem,
  type Plugin,
  type PluginProblem,
  type PluginTable,
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

/** The secrets each installed plugin declares, a row each, by its title: set is the usual state and goes unsaid; 设置 or, once set, 更换 and 删除. The value goes to the command as its standard input. */
async function secretsSection(ctx: Context): Promise<Block | null> {
  const items: ListItem[] = []
  for (const plugin of ctx.library.plugins) {
    const set = await secretNames(ctx.home, plugin.name)
    for (const secret of plugin.secrets ?? []) {
      const has = set.includes(secret.name)
      const fixed = { plugin: plugin.name, name: secret.name }
      const value: ActionInput = { name: 'value', label: '值', placeholder: null, value: null, options: null, secret: true }
      const form = kernelForm('secret set', { fixed })
      const setter: Action = { label: has ? '更换' : '设置', tone: 'default', confirm: null, inputs: [...form.inputs, value], call: { ...form.call, stdin: '{value}' }, ...(has ? { as: 'menu' as const } : {}) }
      const tag: Tag | null = has ? null : secret.optional === true ? { text: '未设置（可选）', tone: 'neutral' } : { text: '未设置', tone: 'warn' }
      items.push({
        cell: { text: secret.title ?? secret.name, icon: 'key', ...(tag ? { tag } : {}) },
        note: pluginTitle(plugin),
        about: secret.description,
        actions: [
          setter,
          ...(has ? [kernelAction('secret remove', '删除', { fixed, tone: 'danger', confirm: `删除密钥 ${secret.title ?? secret.name}？删除后插件 ${pluginTitle(plugin)} 在本机无法读取该密钥，使用前需重新设置。` })] : []),
        ],
      })
    }
  }
  if (items.length === 0) return null
  return {
    kind: 'section',
    title: '密钥',
    note: null,
    about: `插件使用的凭证，仅保存在本机（${join(ctx.home, 'secrets')}），不写入资料库，不会同步；管理界面和命令行均不显示其值。`,
    count: null,
    blocks: [{ kind: 'list', items }],
    actions: [],
  }
}

/**
 * Every plugin this pneuma-base knows and every one the library has installed, a row each in a stable
 * order: the name a person says, opening the plugin's page when it has one; a short line; the whole
 * text with the identifier behind an ⓘ; a switch that installs or removes it. A plugin installed on
 * this machine from elsewhere says its version; the built-in ones are the app's version.
 */
function pluginsSection({ library }: Context, table: PluginTable): Block {
  const { config } = library
  const pages = pluginViews(library).views.filter((v) => v.decl.nav)
  const item = (name: string): ListItem => {
    const here = config.plugins.some((p) => p === name)
    const known = table.get(name)
    const p = library.plugins.find((q) => q.name === name) ?? known
    const title = p === undefined ? name : pluginTitle(p)
    const fromMachine = known !== undefined && machineDirOf(known) !== null
    const note = [p?.summary ?? p?.cognition?.title ?? null, fromMachine ? (p?.version ?? null) : null].filter((s) => s !== null).join(' · ')
    const about = [p?.about ?? '', title === name ? '' : `命令行中的名称：${name}。`].join('')
    const page = here ? pages.find((v) => v.plugin.name === name) : undefined
    const remove = kernelAction('plugin disable', '停用', { fixed: { plugin: name, force: false } })
    const add = kernelAction('plugin enable', '启用', { fixed: { plugin: name } })
    return {
      cell: {
        text: title,
        icon: p?.views?.[0]?.icon ?? 'package',
        ...(page ? { link: { view: page.decl.id, params: {}, target: 'main' as const } } : {}),
        ...(p === undefined ? { tag: { text: '未安装', tone: 'warn' as const } } : {}),
      },
      note: note === '' ? null : note,
      ...(about === '' ? {} : { about }),
      toggle: { on: here, action: here ? remove : add },
      actions: [
        // A plugin that learns what is registered from puts can backfill what was registered before it, again at any time.
        ...(here && p?.catchUp !== undefined ? [{ ...kernelAction('plugin backfill', '补录启用前已登记的条目', { fixed: { plugin: name } }), as: 'menu' as const, icon: 'history' as const }] : []),
        // One installed on this machine leaves it once no library here uses it.
        ...(!here && fromMachine ? [kernelAction('plugin uninstall', '卸载', { fixed: { plugin: name }, tone: 'danger', confirm: `卸载插件 ${title}？本机其他启用该插件的资料库将报告其不可用。` })] : []),
      ],
    }
  }
  const names = [...table.keys(), ...config.plugins.filter((name) => !table.has(name))]
  return {
    kind: 'section',
    title: '插件',
    note: null,
    about: '启用插件后，资料库获得该插件的功能和页面；停用后，插件的数据目录保留不变。',
    count: null,
    blocks: names.length > 0 ? [{ kind: 'list', items: names.map(item) }] : [{ kind: 'text', tone: 'neutral', text: '此 pneuma-base 中没有可用插件。资料库仍可添加、搜索、查看和归档条目。' }],
    actions: [{ ...kernelAction('plugin install', '从目录安装插件'), as: 'icon', icon: 'folder-plus' }],
  }
}

/** Settings: the plugins, their secrets, where the library is kept with its ignore rules; then, folded, the library's id and the file that describes it. */
async function settingsPage(_params: Record<string, string>, { ctx, table }: ViewerCall): Promise<Shown> {
  const { root, config } = ctx.library
  const record: Block = {
    kind: 'section',
    title: '记录',
    note: null,
    count: null,
    collapse: 'closed',
    actions: [],
    blocks: [
      {
        kind: 'fields',
        fields: [
          { label: '资料库 ID', value: { text: config.id, mono: true, muted: true } },
          { label: '说明', value: { text: DESCRIPTION_FILE, mono: true } },
        ],
      },
    ],
  }
  const secrets = await secretsSection(ctx)
  return shown('设置', null, [pluginsSection(ctx, table), ...(secrets ? [secrets] : []), await storageSection(ctx, [await ignoreSection(root)]), record])
}

// ---- the face ----

/** The kernel's own views, each with the page that answers it. */
const KERNEL_VIEWS: readonly { decl: ViewDecl; page: KernelPage }[] = [
  { decl: { id: 'home', title: '首页', icon: 'house', nav: true, filters: [] }, page: (params, call, rows) => homePage(params, call, rows, filesPage) },
  { decl: { id: 'files', title: '文件', icon: 'folder', nav: true, filters: [] }, page: filesPage },
  { decl: { id: 'archive', title: '已归档', icon: 'archive', nav: true, filters: [], with: 'files' }, page: archivePage },
  { decl: { id: 'agents', title: 'Agent', icon: 'users', nav: true, filters: [], ownerOnly: true }, page: agentsPage },
  { decl: { id: 'settings', title: '设置', icon: 'settings', nav: true, filters: [], ownerOnly: true }, page: settingsPage },
  { decl: { id: 'item', title: '条目', icon: 'file', nav: false, filters: [] }, page: itemPage },
]

export const viewerFace = {
  /**
   * Every view of the library, each with who gives it: the plugins' first, in configuration order, then
   * the kernel's. A plugin's only page in the navigation is listed under the plugin's name.
   */
  views(library: Library): ViewList {
    const missing: PluginProblem[] = library.unavailable.map((plugin) => ({ plugin, message: 'installed in this library but not known to this pneuma-base' }))
    const own = pluginViews(library)
    const only = (plugin: Plugin) => own.views.filter((v) => v.plugin === plugin && v.decl.nav).length === 1
    const listed = ({ plugin, decl }: (typeof own.views)[number]): ListedView => ({ ...decl, ...(decl.nav && only(plugin) ? { title: pluginTitle(plugin) } : {}), by: plugin.name })
    const views: ListedView[] = [...own.views.map(listed), ...KERNEL_VIEWS.map((v) => ({ ...v.decl, by: 'kernel' as const }))]
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
    if (sign !== null) return { outcome: 'refused', reason: 'agent-session', text: ownerOnlyRefusal(`show ${decl.id}`, null, sign), problems: [] }
    const params = { ...Object.fromEntries(decl.filters.map((f) => [f.name, f.default])), ...req.params }
    if ('page' in found) return { outcome: 'shown', ...(await found.page(params, call, rowsOf(req))) }
    return { outcome: 'shown', ...(await pluginPage(found.plugin, decl, { view: decl.id, params, ...(req.size === undefined ? {} : { size: req.size }) }, call.ctx)) }
  },
}
