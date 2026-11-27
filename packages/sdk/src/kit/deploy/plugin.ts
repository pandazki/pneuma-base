// A complete deploy plugin from a name and its targets: an agent declares a thing deployable, the
// owner's switch decides whether it is online, and what is switched on follows the library's
// current content. README.md in this folder.
import { CONTRACT, pluginName } from '../../index.js'
import type { IconName } from '../../icons.js'
import { formOf } from '../../params.js'
import type { Action, Plugin, PluginAsk, PluginNoteAnswer, SayAnswer, SecretDecl } from '../../types.js'
import { commands, switchName, SWITCH_PARAMS } from './commands.js'
import { newThingId } from './facts.js'
import { foldedRecords } from './folded.js'
import { declaredAt, factsOf, look, looks, record, settle, thingPath, thingsAt, withRun, type Kit } from './reconcile.js'
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

/** The owner's switch for one thing, as a button: 上线 or 不上线. */
function switchAction(kit: Kit, path: string, on: boolean): Action {
  const { inputs, call } = formOf({ name: switchName(kit.name, on), params: SWITCH_PARAMS }, { fixed: { path } })
  return { label: on ? '上线' : '不上线', tone: 'default', confirm: null, inputs, call }
}

/** Several answers as one: their notes in one, every problem. Null for none. */
function joined(answers: readonly PluginNoteAnswer[]): PluginNoteAnswer | null {
  if (answers.length <= 1) return answers[0] ?? null
  const notes = answers.flatMap((a) => ('problems' in a ? (a.note === null ? [] : [a.note]) : [a]))
  const problems = answers.flatMap((a) => ('problems' in a ? a.problems : []))
  const note = notes.length === 0 ? null : { text: notes.map((n) => n.text).join('；') }
  return problems.length === 0 ? note : { note, problems }
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
      if (tools.regionOf(path) === 'archive') return refused(`${path} 已归档；取回之后再声明`)
      const [here, archived] = await thingsAt(tools, [path, tools.archivedPath(path)])
      if (!here && archived) return refused(`${path} 已归档；取回之后再声明`)
      if (!here) return refused(`库里没有这样东西：${input}`)
      return withRun(kit, ctx, async (run) => {
        const known = run.d.byPath.get(path)
        if (known !== undefined) return heard(`${path} 早已声明可以部署：${lookText(await look(run, known))}`)
        record(run, { kind: 'declare', thing: newThingId(), path, note: req.about === null ? null : req.text })
        return heard(`${path} 可以部署了。它现在不在线；上不上线由主人决定。`)
      })
    },

    /** New content, a registration or a move: the thing at the path follows; of the files of a directory registered, each one declared. */
    async onPut(req, ctx) {
      return withRun(kit, ctx, async (run) => {
        if (req.kind === 'move') {
          const moved = run.d.byPath.get(req.from)
          if (moved !== undefined) record(run, { kind: 'move', thing: moved, from: req.from, to: req.path })
        }
        const paths = req.kind === 'register-files' ? req.files.map((f) => f.path) : [req.path]
        const answers: PluginNoteAnswer[] = []
        for (const path of paths) {
          const id = run.d.byPath.get(path)
          const answer = id === undefined ? null : followed(kit, await settle(run, id), ctx, req.kind === 'move' ? '挪动' : '放入')
          if (answer !== null) answers.push(answer)
        }
        return joined(answers)
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

    /** Each thing declared deployable whose switch the owner never set, while it is in the library: put it online, or keep it off. */
    async onAsks(ctx) {
      const { d } = await foldedRecords(ctx, factsOf(ctx))
      const waiting = [...d.things.values()].filter((t) => !t.decided && ctx.tools.regionOf(t.path) === 'content')
      const present = await thingsAt(ctx.tools, waiting.map((t) => t.path))
      const asks: PluginAsk[] = []
      for (const [i, thing] of waiting.entries()) {
        if (present[i] === null) continue
        const by = thing.declaredBy === 'owner' ? '' : `${thing.declaredBy} 说 `
        asks.push({
          key: `${kit.name}:${thing.id}`,
          text: `${by}${thing.path} 可以部署，还没上线。要上线吗？`,
          about: thing.path,
          actions: [switchAction(kit, thing.path, true), switchAction(kit, thing.path, false)],
          suggested: 0,
        })
      }
      return asks
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
