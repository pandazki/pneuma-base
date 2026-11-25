import { readFileSync } from 'node:fs'
import { abs, archivedPath, pluginName, regionOf, thingAt, type Event, type LibraryPath, type Plugin, type PluginNote, type SayAnswer } from '@pneuma-base/kernel'
import { COMMANDS } from './commands.js'
import { newThingId } from './facts.js'
import { declaredAt, look, looks, record, settle, thingPath, withRun, type Settled } from './reconcile.js'
import { itemSection, lookText, sitesView, STATUS, unsettledText, VIEWS } from './views.js'

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })

/**
 * What the agent whose put or archive moved the target is told. A target that failed is a problem
 * the kernel lists while the verb still succeeds (K8); a missing target is a note, as nothing is
 * online anywhere then.
 */
function followed(r: Settled): PluginNote | null {
  const { path } = r.thing
  if (r.problem?.kind === 'failed') throw new Error(`${path} 没能跟上：${r.problem.message}。现在是${STATUS[r.status].text}；目标好了之后可以运行 deploy sync。`)
  if (r.problem?.kind === 'no-target') return { text: `${path} 开着，但还没配部署目标，没有发布` }
  const published = r.done.find((d) => d.kind === 'publish')
  const dropped = r.done.filter((d) => d.kind === 'unpublish').map((d) => d.site)
  if (published) return { text: `${path} 在线，已重新发布${published.url ? `：${published.url}` : ''}${dropped.length > 0 ? `；旧的站点 ${dropped.join('、')} 已撤下` : ''}` }
  return dropped.length > 0 ? { text: `${path} 已从目标上撤下` } : null
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Event): LibraryPath[] {
  if (event.face !== 'owner' || event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/** 部署. README.md. */
export const deploy: Plugin = {
  name: pluginName('deploy'),
  cognition: { title: '部署', text: readFileSync(new URL('../cognition/deploy-section.md', import.meta.url), 'utf8') },
  storage: [{ dir: '.', kind: 'body' }],
  statements: ['deployable'],
  ownerCommands: COMMANDS,
  views: VIEWS,

  /** `say deployable <path> [一句话]`: a thing in the library may go online. Declaring puts nothing online. */
  async onSay(req, ctx) {
    const input = req.about ?? req.text
    if (input === null) return refused('要写是哪样东西：say deployable <库内路径>')
    const { root } = ctx.library
    const path = await thingPath(root, input)
    if (path === null) return refused(`${input} 不在库的内容里`)
    if (regionOf(path) === 'archive' || (!(await thingAt(abs(root, path))) && (await thingAt(abs(root, archivedPath(path)))))) {
      return refused(`${path} 已归档；取回之后再声明`)
    }
    if (!(await thingAt(abs(root, path)))) return refused(`库里没有这样东西：${input}`)
    return withRun(ctx, async (run) => {
      const known = run.d.byPath.get(path)
      if (known !== undefined) return heard(`${path} 早已声明可以部署：${lookText(await look(run, known))}`)
      record(run, { kind: 'declare', thing: newThingId(), path, note: req.about === null ? null : req.text })
      return heard(`${path} 可以部署了。它现在不在线；上不上线由主人决定。`)
    })
  },

  /** New content, a registration or a move: the thing at the path follows. */
  async onPut(req, ctx) {
    return withRun(ctx, async (run) => {
      if (req.kind === 'move') {
        const moved = run.d.byPath.get(req.from)
        if (moved !== undefined) record(run, { kind: 'move', thing: moved, from: req.from, to: req.path })
      }
      const id = run.d.byPath.get(req.path)
      return id === undefined ? null : followed(await settle(run, id))
    })
  },

  /** An archived thing goes offline; one taken back follows its switch again. */
  async onArchive(req, ctx) {
    if (!req.moved) return null
    return withRun(ctx, async (run) => {
      const id = run.d.byPath.get(req.from)
      if (id === undefined) return null
      record(run, { kind: 'move', thing: id, from: req.from, to: req.to })
      return followed(await settle(run, id))
    })
  },

  async onInspect(req, ctx) {
    return withRun(ctx, async (run) => {
      const id = await declaredAt(run, req.target)
      if (id === null) return []
      const l = await look(run, id)
      return [{ title: '部署', body: lookText(l), data: { path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url } }]
    })
  },

  /** What is switched on but not served as it is now, and what should be offline but is still served. Archived ones too: they are on the target. */
  async onCheck(_req, ctx) {
    return withRun(ctx, async (run) => {
      const section = unsettledText(await looks(run), run.target !== null)
      return section ? [{ title: '线上和库里不一致', ...section }] : []
    })
  },

  /** A declaration purged with the archive is removed, after what is left of it on the target is taken down. */
  async observe(event, ctx) {
    const paths = purged(event)
    if (paths.length === 0) return
    await withRun(ctx, async (run) => {
      const failed: string[] = []
      for (const path of paths) {
        const id = run.d.byPath.get(path)
        if (id === undefined) continue
        const r = await settle(run, id)
        if (r.problem?.kind === 'failed') failed.push(`${path}：${r.problem.message}`)
        record(run, { kind: 'remove', thing: id })
      }
      if (failed.length > 0) throw new Error(`随归档区清掉的东西，线上的站点没能撤下（deploy sync 会再试）：${failed.join('；')}`)
    })
  },

  async onView(req, ctx) {
    if (req.view !== 'deploy.sites') return { title: '部署', subtitle: null, blocks: [{ kind: 'empty', title: '没有这一页', hint: req.view }] }
    return withRun(ctx, sitesView)
  },

  async onItemView(path, ctx) {
    return withRun(ctx, (run) => itemSection(run, path))
  },
}
