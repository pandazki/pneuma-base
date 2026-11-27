// The viewer face: the read-only side the management UI uses. ARCHITECTURE.md「视图是只读的命令」.
// Views are not operations: they change nothing and send no event.
import { join } from 'node:path'
import { agentsPage } from './agents-page.js'
import { archivePage, filesPage } from './files-page.js'
import { homePage } from './home.js'
import { itemPage } from './item-page.js'
import { noiseSection } from './noise-commands.js'
import { DESCRIPTION_FILE } from './paths.js'
import { machineDirOf } from './plugin-table.js'
import { pluginPage, pluginViews, shown, type KernelPage, type Shown } from './plugin-views.js'
import { secretNames } from './secrets.js'
import { storageSection } from './storage-commands.js'
import { agentSign, ownerOnlyRefusal, OWNER_DECIDES, type Env } from './session.js'
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

/** The secrets each installed plugin declares, a row each: set is the usual state and goes unsaid; 设 or, once set, 换一个 and 删掉. The value goes to the command as its standard input. */
async function secretsSection(ctx: Context): Promise<Block | null> {
  const items: ListItem[] = []
  for (const plugin of ctx.library.plugins) {
    const set = await secretNames(ctx.home, plugin.name)
    for (const secret of plugin.secrets ?? []) {
      const has = set.includes(secret.name)
      const fixed = { plugin: plugin.name, name: secret.name }
      const value: ActionInput = { name: 'value', label: '值', placeholder: null, value: null, options: null, secret: true }
      const form = kernelForm('secret set', { fixed })
      const setter: Action = { label: has ? '换一个' : '设', tone: 'default', confirm: null, inputs: [...form.inputs, value], call: { ...form.call, stdin: '{value}' }, ...(has ? { as: 'menu' as const } : {}) }
      const tag: Tag | null = has ? null : secret.optional === true ? { text: '没设（可选）', tone: 'neutral' } : { text: '没设', tone: 'warn' }
      items.push({
        cell: { text: secret.name, icon: 'key', ...(tag ? { tag } : {}) },
        note: plugin.title ?? plugin.name,
        about: secret.description,
        actions: [
          setter,
          ...(has ? [kernelAction('secret remove', '删掉', { fixed, tone: 'danger', confirm: `删掉后，插件 ${plugin.name} 在这台机器上读不到 ${secret.name}，要用时得再设。` })] : []),
        ],
      })
    }
  }
  if (items.length === 0) return null
  return {
    kind: 'section',
    title: '密钥',
    note: null,
    about: `插件用的凭证，只存在这台机器上（${join(ctx.home, 'secrets')}），不进库，不会同步，界面和命令行都不显示它的值。`,
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
    const title = p?.title ?? name
    const fromMachine = known !== undefined && machineDirOf(known) !== null
    const note = [p?.summary ?? p?.cognition?.title ?? null, fromMachine ? (p?.version ?? null) : null].filter((s) => s !== null).join(' · ')
    const about = [p?.about ?? '', title === name ? '' : `命令行里叫 ${name}。`].join('')
    const page = here ? pages.find((v) => v.plugin.name === name) : undefined
    const remove = kernelAction('plugin remove', '卸下', { fixed: { plugin: name, anyway: false } })
    const add = kernelAction('plugin add', '装上', { fixed: { plugin: name } })
    return {
      cell: {
        text: title,
        icon: p?.views?.[0]?.icon ?? 'package',
        ...(page ? { link: { view: page.decl.id, params: {}, target: 'main' as const } } : {}),
        ...(p === undefined ? { tag: { text: '这个 pneuma-base 里没有', tone: 'warn' as const } } : {}),
      },
      note: note === '' ? null : note,
      ...(about === '' ? {} : { about }),
      toggle: { on: here, action: here ? remove : add },
      actions: [
        // A plugin that learns what is registered from puts can catch up on what was registered before it, again at any time.
        ...(here && p?.catchUp !== undefined ? [{ ...kernelAction('plugin catch-up', '补上装上之前登记的', { fixed: { plugin: name } }), as: 'menu' as const, icon: 'history' as const }] : []),
        // One installed on this machine leaves it once no library here uses it.
        ...(!here && fromMachine ? [kernelAction('plugin uninstall', '从这台机器卸掉', { fixed: { plugin: name }, tone: 'danger', confirm: `从这台机器卸掉插件 ${name}？这台机器上别的库装着它的，会报它不可用。` })] : []),
      ],
    }
  }
  const names = [...table.keys(), ...config.plugins.filter((name) => !table.has(name))]
  return {
    kind: 'section',
    title: '插件',
    note: null,
    about: '打开一个插件，库就多了它的本事和它的页；关上时，它名下的目录原样留着。',
    count: null,
    blocks: names.length > 0 ? [{ kind: 'list', items: names.map(item) }] : [{ kind: 'text', tone: 'neutral', text: '这个 pneuma-base 不认识任何插件。库照样能放、找、看、归档。' }],
    actions: [{ ...kernelAction('plugin install', '从目录装一个插件到这台机器'), as: 'icon', icon: 'folder-plus' }],
  }
}

/** Settings: the plugins, their secrets, where the library is kept with its noise; then, folded, the library's id and the file that describes it. */
async function configPage(_params: Record<string, string>, { ctx, table }: ViewerCall): Promise<Shown> {
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
          { label: '库标识', value: { text: config.id, mono: true, muted: true } },
          { label: '说明', value: { text: DESCRIPTION_FILE, mono: true } },
        ],
      },
    ],
  }
  const secrets = await secretsSection(ctx)
  return shown('配置', null, [pluginsSection(ctx, table), ...(secrets ? [secrets] : []), await storageSection(ctx, [await noiseSection(root)]), record])
}

// ---- the face ----

/** The kernel's own views, each with the page that answers it. */
const KERNEL_VIEWS: readonly { decl: ViewDecl; page: KernelPage }[] = [
  { decl: { id: 'home', title: '首页', icon: 'house', nav: true, filters: [] }, page: (params, call, rows) => homePage(params, call, rows, filesPage) },
  { decl: { id: 'files', title: '文件', icon: 'folder', nav: true, filters: [] }, page: filesPage },
  { decl: { id: 'archive', title: '归档区', icon: 'archive', nav: true, filters: [], with: 'files' }, page: archivePage },
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
