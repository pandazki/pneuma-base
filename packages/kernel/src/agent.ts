import { archive } from './archive.js'
import { asksOf } from './asks.js'
import { callableIn } from './blocks.js'
import { contentOf } from './content.js'
import { ownerFace } from './owner.js'
import { archivedPath, parseLibraryPath, regionOf } from './paths.js'
import { catchingUp, catchingUpLine } from './catch-up.js'
import { eachPlugin, messageOf, performVerb, pluginContext, type Collected } from './pipeline.js'
import { openDirectories } from './places.js'
import { put } from './put.js'
import { ask, requestNamed, requestsFor } from './requests.js'
import { storageOf, type Storage } from './storage.js'
import { fingerprintOf, levelOf, whatIs, type At } from './things.js'
import {
  isFailure,
  type AgentFace,
  type CheckRequest,
  type CheckResult,
  type Context,
  type FileFacts,
  type FindRequest,
  type FindResult,
  type Hit,
  type InspectRequest,
  type InspectResult,
  type Instant,
  type LibraryPath,
  type PlaceFacts,
  type PluginHit,
  type PluginProblem,
  type PluginSection,
  type SayRequest,
  type SayResult,
  type Section,
} from '@pneuma-base/sdk'

export const NO_HEARER = '这个库没配能记下这句话的插件'

/** The seven verbs. Each ends at the pipeline's single exit, which sends its event (K5). */
export const agentFace: AgentFace = {
  put: (req, ctx) => performVerb('put', req, ctx, () => put(req, ctx)),
  find: (req, ctx) => performVerb('find', req, ctx, () => find(req, ctx)),
  inspect: (req, ctx) => performVerb('inspect', req, ctx, () => inspect(req, ctx)),
  say: (req, ctx) => performVerb('say', req, ctx, () => say(req, ctx)),
  check: (req, ctx) => performVerb('check', req, ctx, () => check(req, ctx)),
  archive: (req, ctx) => performVerb('archive', req, ctx, () => archive(req, ctx)),
  ask: (req, ctx) => performVerb('ask', req, ctx, () => ask(req, ctx, ownerFace.commands(ctx.library.plugins))),
}

/** The plugins' hits, from their indexes: the kernel lists no file by name, since that would walk the library. */
async function find(req: FindRequest, ctx: Context): Promise<FindResult> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onFind?.(req, pctx))
  // A plugin still catching up says so in one line, last among its hits; start's find leaves it to check.
  const behind: Awaited<ReturnType<typeof catchingUp>> = req.skipOwnSession ? new Map() : await catchingUp(ctx)
  const answers = heard.values.map(({ plugin, value }) => {
    const answer = Array.isArray(value) ? { hits: value, problems: [] } : value
    const c = behind.get(plugin)
    return { plugin, ...answer, hits: c === undefined ? answer.hits : [...answer.hits, { path: null, title: catchingUpLine(c), group: null, detail: null }] }
  })
  const found = answers.map(({ plugin, hits }) => hits.map((h) => ({ ...h, by: plugin })))
  const known = await annotate(req, ctx, found.flat())
  const merged = mergeHits(ctx.library.plugins.map((p) => p.name), found, known.hits)
  return {
    hits: await marked(storageOf(ctx.library.root), merged),
    problems: [...heard.problems, ...answers.flatMap(({ plugin, problems }) => problems.map((message) => ({ plugin, message }))), ...known.problems],
  }
}

type Annotation = Hit & { path: LibraryPath }

/**
 * What each plugin with `onFound` knows about the found paths it gave no hit for, in configuration
 * order. A plugin with no such path is not asked. A hit on a path it was not asked about is left out
 * and listed as a problem (K8).
 */
async function annotate(req: FindRequest, ctx: Context, found: Hit[]): Promise<{ hits: Annotation[]; problems: PluginProblem[] }> {
  const paths = [...new Set(found.flatMap((h) => (h.path === null ? [] : [h.path])))]
  const heard = await eachPlugin(ctx, async (plugin, pctx) => {
    const own = new Set(found.filter((h) => h.by === plugin.name).map((h) => h.path))
    const asked = new Set(paths.filter((path) => !own.has(path)))
    if (!plugin.onFound || asked.size === 0) return undefined
    const answered = await plugin.onFound([...asked], req, pctx)
    const fits = (h: PluginHit): h is PluginHit & { path: LibraryPath } => h.path !== null && asked.has(h.path)
    return {
      hits: answered.filter(fits).map((h): Annotation => ({ ...h, by: plugin.name })),
      problems: answered.filter((h) => !fits(h)).map((h) => ({ plugin: plugin.name, message: `onFound 答了${h.path === null ? '一条没有路径的命中' : `没问它的路径 ${h.path}`}，没有采用` })),
    }
  })
  return { hits: heard.values.flatMap(({ value }) => value.hits), problems: [...heard.problems, ...heard.values.flatMap(({ value }) => value.problems)] }
}

/**
 * Each plugin's ranked hits as one list. The hits on one path stay together, at the best rank any
 * finder gave that path; on equal ranks the plugins come in configuration order. Annotations join their
 * path's entry and leave its rank alone. A hit without a path is its own entry at its rank.
 */
function mergeHits(answerers: readonly Hit['by'][], found: Hit[][], annotations: Annotation[]): Hit[] {
  type Entry = { rank: number; answerer: number; order: number; hits: Hit[] }
  const entries = new Map<string, Entry>()
  let order = 0
  found.forEach((hits, answerer) =>
    hits.forEach((hit, rank) => {
      const key = hit.path === null ? `\0${order}` : hit.path
      const entry = entries.get(key) ?? { rank, answerer, order: order++, hits: [] }
      entries.set(key, entry)
      entry.hits.push(hit)
      if (rank < entry.rank) Object.assign(entry, { rank, answerer })
    }),
  )
  for (const hit of annotations) entries.get(hit.path)?.hits.push(hit)
  const place = (hit: Hit) => answerers.indexOf(hit.by)
  const ranked = [...entries.values()].sort((a, b) => a.rank - b.rank || a.answerer - b.answerer || a.order - b.order)
  return ranked.flatMap(({ hits }) => hits.sort((a, b) => place(a) - place(b)))
}

/**
 * The kernel's mark (目录, 已归档) in front of the detail of the first hit on each path: a bundle from one
 * glance at the found paths, an archived thing from its path. The kernel finds nothing by name itself:
 * that would walk the library; what is found comes from the plugins' indexes.
 */
async function marked(store: Storage, hits: Hit[]): Promise<Hit[]> {
  const paths = [...new Set(hits.flatMap((h) => (h.path === null ? [] : [h.path])))]
  const bundles = new Set((await whatIs(store, paths)).filter((at) => at.kind === 'bundle').map((at) => at.path))
  const seen = new Set<string>()
  return hits.map((hit) => {
    if (hit.path === null || seen.has(hit.path)) return hit
    seen.add(hit.path)
    const marks = [...(bundles.has(hit.path) ? ['目录'] : []), ...(regionOf(hit.path) === 'archive' ? ['已归档'] : [])].join('，')
    return marks === '' ? hit : { ...hit, detail: hit.detail === null ? marks : `${marks}，${hit.detail}` }
  })
}

async function inspect(req: InspectRequest, ctx: Context): Promise<InspectResult> {
  const store = storageOf(ctx.library.root)
  const named = await namedBy(ctx, store, req.target, req.content !== undefined)
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onInspect?.(req, pctx))
  const request = named.file === null && named.place === undefined ? await requestNamed(ctx.library.root, req.target) : null
  const result: InspectResult = { file: named.file, ...(named.place ? { place: named.place } : {}), sections: stamp(heard), problems: heard.problems, ...(request === null ? {} : { request }) }
  if (req.content === undefined) return result
  return { ...result, content: named.file === null ? { kind: 'unavailable', path: null, reason: 'no-such-file' } : await contentOf(ctx, store, named.file, req.content.file, req.content.fetch === true) }
}

/** The thing a target names, as storage says it is now: the main one, else its archived copy; `_archive/…` names the archived copy. */
export async function fileFacts(root: string, target: string): Promise<FileFacts | null> {
  const path = parseLibraryPath(root, target)
  if (path === null || regionOf(path) === 'kernel') return null
  const store = storageOf(root)
  const thing = (await whatIs(store, regionOf(path) === 'archive' ? [path] : [path, archivedPath(path)])).find((at) => at.kind === 'file' || at.kind === 'bundle')
  return thing === undefined ? null : factsOf(store, thing, false)
}

/** A thing as storage says it is now, with its first level for a bundle; its fingerprint only when asked. */
async function factsOf(store: Storage, at: At, fingerprint: boolean): Promise<FileFacts> {
  const entry = at.entry as NonNullable<At['entry']>
  const kind = at.kind === 'bundle' ? 'bundle' : 'file'
  const level = kind === 'bundle' ? await levelOf(store, at.path) : null
  const print = fingerprint ? await fingerprintOf(store, at.path, at.kind) : null
  return {
    path: at.path,
    kind,
    size: kind === 'file' ? (entry.size ?? 0) : null,
    modifiedAt: (entry.modified ?? '') as Instant,
    token: print?.token ?? entry.token ?? '',
    fingerprint: print?.fingerprint ?? null,
    archived: regionOf(at.path) === 'archive',
    ...(level === null ? {} : { level }),
  }
}

/**
 * What a target names, by the kind of place (ARCHITECTURE.md「找、看、说、查、归档」, 看): a thing, the main
 * one before its archived copy (`_archive/…` names the archived copy); else a directory, open (its first
 * level) or closed (a probe within its budget); else noise, by which name or path.
 */
async function namedBy(ctx: Context, store: Storage, target: string, fingerprint: boolean): Promise<{ file: FileFacts | null; place?: PlaceFacts }> {
  const path = parseLibraryPath(ctx.library.root, target)
  if (path === null || regionOf(path) === 'kernel') return { file: null }
  const candidates = regionOf(path) === 'archive' ? [path] : [path, archivedPath(path)]
  const ats = await whatIs(store, candidates)
  const thing = ats.find((at) => at.kind === 'file' || at.kind === 'bundle')
  if (thing !== undefined) return { file: await factsOf(store, thing, fingerprint) }
  const [at] = ats as [At]
  if (at.failed === 'noise') return { file: null, place: { kind: 'noise', path, by: await noiseRule(store, path) } }
  if (at.kind !== 'folder') return { file: null }
  if ((await openDirectories(ctx)).includes(path)) {
    const level = await levelOf(store, path)
    return { file: null, ...(level === null ? {} : { place: { kind: 'open', path, level } }) }
  }
  const probe = await store.probe(path)
  if (isFailure(probe)) return { file: null }
  return { file: null, place: { kind: 'closed', path, files: probe.files, exceeded: probe.exceeded, markers: probe.markers } }
}

/** Which of the library's noise names or paths covers `path`. */
export async function noiseRule(store: Storage, path: LibraryPath): Promise<{ name: string } | { path: string }> {
  const { names, paths } = await store.noise.list()
  const segments = path.split('/')
  const name = segments.find((s) => names.includes(s))
  if (name !== undefined) return { name }
  return { path: paths.find((p) => path === p || path.startsWith(`${p}/`)) ?? path }
}

async function say(req: SayRequest, ctx: Context): Promise<SayResult> {
  const hearer = ctx.library.plugins.find((p) => p.onSay && p.statements.includes(req.kind))
  if (!hearer?.onSay) return { outcome: 'not-heard', reason: 'no-plugin-for-kind', note: NO_HEARER, problems: [] }
  try {
    const answer = await hearer.onSay(req, pluginContext(ctx, hearer.name))
    if (answer.outcome === 'heard') return { outcome: 'heard', by: hearer.name, note: answer.note, problems: (answer.problems ?? []).map((message) => ({ plugin: hearer.name, message })) }
    return { ...answer, problems: [] }
  } catch (error) {
    return {
      outcome: 'not-heard',
      reason: 'plugin-failed',
      note: `插件 ${hearer.name} 没能记下这句话`,
      problems: [{ plugin: hearer.name, message: messageOf(error) }],
    }
  }
}

async function check(req: CheckRequest, ctx: Context): Promise<CheckResult> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onCheck?.(req, pctx))
  // A plugin still catching up says so in one line among its sections.
  const behind = await catchingUp(ctx)
  for (const plugin of ctx.library.plugins) {
    const c = behind.get(plugin.name)
    if (c === undefined || plugin.onCheck === undefined) continue
    const section = { title: '装上之前登记的', body: catchingUpLine(c) }
    const at = heard.values.find((v) => v.plugin === plugin.name)
    if (at) at.value = [...at.value, section]
    else heard.values.push({ plugin: plugin.name, value: [section] })
  }
  const order = ctx.library.plugins.map((p) => p.name)
  heard.values.sort((a, b) => order.indexOf(a.plugin) - order.indexOf(b.plugin))
  const asked = await asksOf(ctx, callableIn(ctx.library))
  return { sections: stamp(heard), asks: asked.asks, requests: await requestsFor(ctx), problems: [...heard.problems, ...asked.problems] }
}

function stamp(heard: Collected<PluginSection[]>): Section[] {
  return heard.values.flatMap(({ plugin, value }) => value.map((s) => ({ ...s, plugin })))
}
