// start's find, asked of the rows (tmp/run-7 architecture.md section 5, 「找」): the registered things
// and the scenes, matched by what the records hold, the path and what was said; no file is read and
// nothing unregistered is among the hits. A scene that matches brings the things entered in it, as the
// things of what was being done then. The caller's own things match by their path only, and come bare,
// with no scene: the ledger gives a session nothing about itself. The find verb keeps its own until it
// is rebuilt on storage.
import { originalPath, rankHits, searchTerms, shortDir, type FindRequest, type LibraryPath, type PluginContext, type PluginHit } from '@pneuma-base/kernel'
import { posix } from 'node:path'
import { sceneOf } from './facts.js'
import { allScenes, archived, liveItems, loadScenes, stateOf, type LedgerState, type Slim, type SlimScene } from './state.js'
import { originLabel, sceneLine } from './views.js'

type Found = { item: Slim } | { scene: SlimScene }

function itemHit(state: LedgerState, item: Slim): PluginHit {
  const scene = state.scenes.get(item.entered.scene)
  return { path: item.path, title: posix.basename(item.path), group: scene ? sceneLine(scene) : null, detail: originLabel(item.origin, item.entered.how) }
}

function sceneHit(s: SlimScene): PluginHit {
  const decided = s.said.filter((x) => x.flavor === 'decided').map((x) => x.text)
  const parts = [...(s.cwds.length ? [`在 ${s.cwds.map((d) => shortDir(d)).join('、')}`] : []), ...(decided.length ? [`决定：${decided.join('；')}`] : [])]
  return { path: null, title: `场景 ${s.id}`, group: sceneLine(s), detail: parts.length ? parts.join(' · ') : null }
}

/** How many things of one matching scene come with it. */
const PER_SCENE = 20

const shownPath = (item: Slim) => (archived(item) ? (originalPath(item.path) ?? item.path) : item.path)

/** The things and scenes that match the words of start's sentence, best first, then the things of the scenes that matched. */
export async function startFind(req: FindRequest, ctx: PluginContext): Promise<PluginHit[]> {
  const terms = searchTerms(req.text, req.match)
  const { state } = await stateOf(ctx)
  const skip = sceneOf(ctx)
  const items = liveItems(state).filter((item) => req.includeArchived || !archived(item))
  const scenes = (await allScenes(ctx, state)).filter((s) => s.id !== skip && s.said.length > 0)
  const candidates = [
    ...items.map((item) => ({
      hit: { item } as Found,
      haystack: (item.entered.scene === skip ? [shownPath(item)] : [shownPath(item), ...item.texts]).join('\n').toLowerCase(),
    })),
    ...scenes.map((scene) => ({ hit: { scene } as Found, haystack: scene.said.map((x) => x.text).join('\n').toLowerCase() })),
  ]
  const ranked = rankHits(candidates, terms, req.match)
  const hit = new Set(ranked.flatMap((f) => ('item' in f ? [f.item.id] : [])))
  const matched = new Set(ranked.flatMap((f) => ('scene' in f ? [f.scene.id] : [])))
  const theirs = new Map<string, Slim[]>()
  for (const item of items) {
    const list = theirs.get(item.entered.scene) ?? []
    if (matched.has(item.entered.scene) && !hit.has(item.id) && list.length < PER_SCENE) theirs.set(item.entered.scene, [...list, item])
  }
  const found = [...ranked, ...[...theirs.values()].flat().map((item) => ({ item }) as Found)]
  await loadScenes(ctx, state, found.flatMap((f) => ('item' in f ? [f.item.entered.scene] : [])))
  return found.map((f) => ('scene' in f ? sceneHit(f.scene) : f.item.entered.scene === skip ? bareHit(f.item) : itemHit(state, f.item)))
}

const bareHit = (item: Slim): PluginHit => ({ path: item.path, title: posix.basename(item.path), group: null, detail: null })

/** The scene and origin of each found path that is a thing of another session. */
export async function startFound(paths: readonly LibraryPath[], ctx: PluginContext): Promise<PluginHit[]> {
  const { state } = await stateOf(ctx)
  const skip = sceneOf(ctx)
  const items = paths.flatMap((path) => {
    const item = state.items.get(state.paths.get(path) ?? ('' as Slim['id']))
    return item && !item.removed && item.absorbedInto === null && item.entered.scene !== skip ? [item] : []
  })
  await loadScenes(ctx, state, items.map((item) => item.entered.scene))
  return items.map((item) => itemHit(state, item))
}
