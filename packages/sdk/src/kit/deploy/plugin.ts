// A complete deploy plugin from a name and its targets: an agent declares a thing deployable, the
// owner's switch decides whether it is online, and what is switched on follows the library's
// current content. README.md in this folder.
import { CONTRACT, pluginName } from '../../index.js'
import type { IconName } from '../../icons.js'
import type { Plugin, SayAnswer, SecretDecl } from '../../types.js'
import { commands } from './commands.js'
import { newThingId } from './facts.js'
import { declaredAt, look, looks, record, settle, thingPath, withRun, type Kit } from './reconcile.js'
import type { TargetAdapter } from './target.js'
import { cognitionText, followed, lookText, skippedText, staysOnline, unsettledText } from './words.js'
import { itemSection, sitesPage, sitesView, targetPage, targetPages, viewDecls } from './views.js'

export type DeployOptions = {
  /** The plugin's title for people: in the description, on its page and its item section. Defaults to 部署. */
  readonly title?: string
  /** The heading of its cognition section, `<what>：<how>`. Defaults to 上线：主人开关. */
  readonly heading?: string
  /** A paragraph added to the cognition section, for what agents should know about this target. */
  readonly cognition?: string
  /** The page's icon. Defaults to globe. */
  readonly icon?: IconName
  readonly version?: string
  readonly summary?: string
  /** The directory of the plugin's own pages, for `custom` blocks a target adds. */
  readonly ui?: string
}

/** The secrets its kinds of target read, each name once: the plugin declares them, so `secret set` and the configuration page know them. */
function secretsOf(kit: Kit): { secrets?: SecretDecl[] } {
  const all = new Map(kit.targets.flatMap((t) => t.secrets ?? []).map((s) => [s.name, s]))
  return all.size === 0 ? {} : { secrets: [...all.values()] }
}

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })

/** The plugin `name` that publishes to `targets`; with several, the owner picks one with `--kind`. */
export function deployPlugin(name: string, targets: TargetAdapter | readonly TargetAdapter[], options: DeployOptions = {}): Plugin {
  const kit: Kit = { name: pluginName(name), title: options.title ?? '部署', targets: 'kind' in targets ? [targets] : targets }
  if (kit.targets.length === 0) throw new Error('a deploy plugin needs at least one kind of target')
  const pages = targetPages(kit)
  for (const [i, p] of pages.entries()) {
    if (!/^[a-z][a-z0-9-]*$/.test(p.name) || p.name === 'sites') throw new Error(`a target's page is named in lower-case letters, digits and dashes, and not sites: ${p.name}`)
    if (pages.findIndex((q) => q.name === p.name) !== i) throw new Error(`two kinds of target name a page ${p.name}`)
  }
  return {
    contract: CONTRACT,
    name: kit.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    cognition: { title: kit.title, text: cognitionText(kit, options.heading ?? '上线：主人开关', options.cognition ?? null) },
    storage: [{ dir: '.', kind: 'body' }],
    statements: ['deployable'],
    ownerCommands: commands(kit),
    ...secretsOf(kit),
    views: viewDecls(kit, options.icon ?? 'globe'),

    /** `say deployable <path> [一句话]`: a thing in the library may go online. Declaring puts nothing online. */
    async onSay(req, ctx) {
      const input = req.about ?? req.text
      if (input === null) return refused('要写是哪样东西：say deployable <库内路径>')
      const { tools } = ctx
      const path = await thingPath(tools, input)
      if (path === null) return refused(`${input} 不在库的内容里`)
      if (tools.regionOf(path) === 'archive' || (!(await tools.thing(path)) && (await tools.thing(tools.archivedPath(path))))) {
        return refused(`${path} 已归档；取回之后再声明`)
      }
      if (!(await tools.thing(path))) return refused(`库里没有这样东西：${input}`)
      return withRun(kit, ctx, async (run) => {
        const known = run.d.byPath.get(path)
        if (known !== undefined) return heard(`${path} 早已声明可以部署：${lookText(await look(run, known))}`)
        record(run, { kind: 'declare', thing: newThingId(), path, note: req.about === null ? null : req.text })
        return heard(`${path} 可以部署了。它现在不在线；上不上线由主人决定。`)
      })
    },

    /** New content, a registration or a move: the thing at the path follows. */
    async onPut(req, ctx) {
      return withRun(kit, ctx, async (run) => {
        if (req.kind === 'move') {
          const moved = run.d.byPath.get(req.from)
          if (moved !== undefined) record(run, { kind: 'move', thing: moved, from: req.from, to: req.path })
        }
        const id = run.d.byPath.get(req.path)
        return id === undefined ? null : followed(kit, await settle(run, id), ctx, req.kind === 'move' ? '挪动' : '放入')
      })
    },

    /** An archived thing goes offline; one taken back follows its switch again. */
    async onArchive(req, ctx) {
      if (!req.moved) return null
      return withRun(kit, ctx, async (run) => {
        const id = run.d.byPath.get(req.from)
        if (id === undefined) return null
        record(run, { kind: 'move', thing: id, from: req.from, to: req.to })
        return followed(kit, await settle(run, id), ctx, req.kind === 'archive' ? '归档' : '取回')
      })
    },

    async onInspect(req, ctx) {
      return withRun(kit, ctx, async (run) => {
        const id = await declaredAt(run, req.target)
        if (id === null) return []
        const l = await look(run, id)
        return [{ title: kit.title, body: lookText(l), data: { path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url } }]
      })
    },

    /** What is switched on but not served as it is now, and what should be offline but is still served. Archived ones too: they are on the target. */
    async onCheck(_req, ctx) {
      return withRun(kit, ctx, async (run) => {
        const unsettled = unsettledText(kit, await looks(run), run.target !== null)
        const skipped = skippedText(kit, run.skipped)
        return [...(unsettled ? [{ title: '线上和库里不一致', ...unsettled }] : []), ...(skipped ? [{ title: `${kit.title}记录里读不懂的行`, ...skipped }] : [])]
      })
    },

    /** A declaration purged with the archive is removed, after what is left of it on the target is taken down. */
    async onPurged(paths, ctx) {
      await withRun(kit, ctx, async (run) => {
        const failed: string[] = []
        for (const path of paths) {
          const id = run.d.byPath.get(path)
          if (id === undefined) continue
          const r = await settle(run, id)
          if (r.problem?.kind === 'failed') failed.push(`${path}：${r.problem.message}`)
          record(run, { kind: 'remove', thing: id })
        }
        if (failed.length > 0) throw new Error(`随归档区清掉的东西，线上的站点没能撤下（${kit.name} sync 会再试）：${failed.join('；')}`)
      })
    },

    /** Removing the plugin leaves its sites online, unfollowed: it refuses while any is, and says which. */
    async onRemove(ctx) {
      const online = await withRun(kit, ctx, async (run) => staysOnline(kit, await looks(run)))
      return online === null ? undefined : { refuse: online }
    },

    async onView(req, ctx) {
      if (req.view === sitesView(kit)) return withRun(kit, ctx, sitesPage, true)
      const page = pages.find((p) => p.id === req.view)
      if (page === undefined) return { title: kit.title, subtitle: null, blocks: [{ kind: 'empty', title: '没有这一页', hint: req.view }] }
      return withRun(kit, ctx, (run) => targetPage(run, page), true)
    },

    async onItemView(path, ctx) {
      return withRun(kit, ctx, (run) => itemSection(run, path), true)
    },
  }
}
