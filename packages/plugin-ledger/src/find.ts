// Find, asked of the rows (ARCHITECTURE.md「找和看」): the registered things and the
// scenes, matched by what the records hold (the path, what was said, the notes of the puts, where a
// thing came from); no file is read and nothing unregistered is among the hits. The `find` table is
// read a page at a time and only the rows that match are kept. A scene that matches brings the things
// entered in it. For start, the caller's own things match by their path only and come bare: the ledger
// gives a session nothing about itself.
import { shortDir, type FindRequest, type LibraryPath, type PluginContext, type PluginHit } from '@pneuma-base/kernel'
import { posix } from 'node:path'
import { sceneOf, type ItemId, type SceneId } from './facts.js'
import { archived, type FindRow, type ItemRow, type SceneRow } from './model.js'
import { getAll, scenesNamed } from './queries.js'
import { pagesOf, wherePages } from './rows.js'
import { originLabel, sceneLine } from './views.js'
import { storedOrigin } from './words.js'

type ItemFind = Extract<FindRow, { item: ItemId }>
type SceneFind = Extract<FindRow, { texts: string; scene: SceneId }> & { item?: undefined }
type Found = { item: ItemFind } | { scene: SceneId }

/** How many matching rows one find keeps to rank; past that it ranks the ones it found first. */
const KEPT = 2000
/** How many things of one matching scene come with it. */
const PER_SCENE = 20

const isItem = (row: FindRow): row is ItemFind => 'item' in row

function itemHit(scenes: ReadonlyMap<string, SceneRow>, row: Pick<ItemFind, 'path' | 'scene' | 'origin' | 'how'>): PluginHit {
  const scene = scenes.get(row.scene)
  return { path: row.path, title: posix.basename(row.path), group: scene ? sceneLine(scene) : null, detail: originLabel(row.origin, row.how) }
}

function sceneHit(s: SceneRow): PluginHit {
  const decided = s.said.filter((x) => x.flavor === 'decided').map((x) => x.text)
  const parts = [...(s.cwds.length ? [`在 ${s.cwds.map((d) => shortDir(d)).join('、')}`] : []), ...(decided.length ? [`决定：${decided.join('；')}`] : [])]
  return { path: null, title: `场景 ${s.id}`, group: sceneLine(s), detail: parts.length ? parts.join(' · ') : null }
}

const bareHit = (path: LibraryPath): PluginHit => ({ path, title: posix.basename(path), group: null, detail: null })

/** The origin a find's filter names, as the rows keep it: undefined without the filter, null for a word that names none. */
const originFilter = (req: FindRequest) => (req.filters.origin === undefined ? undefined : storedOrigin(req.filters.origin))

/** The rows a find with these filters reads: by the scene or the origin it names, else every thing (and every scene), page by page. */
async function* rowsOf(ctx: PluginContext, req: FindRequest): AsyncGenerator<FindRow[]> {
  const records = ctx.tools.storage.records
  const { scene } = req.filters
  const origin = originFilter(req)
  if (origin === null) return
  const keep = (rows: { key: string; value: FindRow }[]) => rows.filter((r) => req.includeArchived || !r.key.startsWith('a|')).map((r) => r.value)
  if (scene !== undefined) {
    for (const s of (await scenesNamed(records, scene)).scenes) for await (const page of wherePages<FindRow>(records, 'find', 'scene', s.id)) yield keep(page).filter((r) => origin === undefined || (isItem(r) && r.origin.kind === origin))
    return
  }
  if (origin !== undefined) {
    for await (const page of wherePages<FindRow>(records, 'find', 'origin', origin)) yield keep(page)
    return
  }
  for (const prefix of ['l|', ...(req.includeArchived ? ['a|'] : []), 's|']) for await (const page of pagesOf<FindRow>(records, 'find', prefix)) yield page.map((r) => r.value)
}

/** The things and scenes that match the words of the request, best first; for start, then the things of the scenes that matched. */
export async function findHits(req: FindRequest, ctx: PluginContext): Promise<PluginHit[]> {
  const records = ctx.tools.storage.records
  const terms = ctx.tools.searchTerms(req.text, req.match)
  const lower = terms.map((t) => t.toLowerCase())
  const skip = req.skipOwnSession ? sceneOf(ctx) : null
  const candidates: { hit: Found; haystack: string }[] = []
  for await (const page of rowsOf(ctx, req)) {
    for (const row of page) {
      if (candidates.length >= KEPT) break
      const own = row.scene === skip
      if (!isItem(row) && (own || row.texts === '')) continue
      const haystack = (isItem(row) ? (own ? [row.shown] : [row.shown, row.texts]) : [row.texts]).join('\n').toLowerCase()
      if (lower.length > 0 && !lower.some((t) => haystack.includes(t))) continue
      candidates.push({ hit: isItem(row) ? { item: row } : { scene: (row as SceneFind).scene }, haystack })
    }
    if (candidates.length >= KEPT) break
  }
  // Equal matches come in the order of their paths (a scene by its id): the rows' own order is by item id, which says nothing.
  const name = (c: { hit: Found }) => ('item' in c.hit ? c.hit.item.path : c.hit.scene)
  candidates.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))
  const ranked = ctx.tools.rankHits(candidates, terms, req.match)
  // A scene that matches brings the things entered in it: the things of what was being done then.
  const theirs: ItemFind[] = []
  const hit = new Set(ranked.flatMap((f) => ('item' in f ? [f.item.item] : [])))
  for (const f of ranked) {
    if (!('scene' in f)) continue
    const page = await records.where<FindRow>('find', 'scene', f.scene, { limit: PER_SCENE + hit.size })
    theirs.push(...page.rows.map((r) => r.value).filter((r): r is ItemFind => isItem(r) && !hit.has(r.item) && (req.includeArchived || !archived(r))).slice(0, PER_SCENE))
  }
  const found: Found[] = [...ranked, ...theirs.map((item) => ({ item }))]
  const scenes = await getAll<SceneRow>(records, 'scenes', found.map((f) => ('item' in f ? f.item.scene : f.scene)))
  return found.flatMap((f) => {
    if ('scene' in f) return scenes.has(f.scene) ? [sceneHit(scenes.get(f.scene) as SceneRow)] : []
    return [f.item.scene === skip ? bareHit(f.item.path) : itemHit(scenes, f.item)]
  })
}

/** The scene and origin of each found path that is a thing this find would give: start's own session left out. A file nobody registered gets nothing. */
export async function foundHits(paths: readonly LibraryPath[], req: FindRequest, ctx: PluginContext): Promise<PluginHit[]> {
  const records = ctx.tools.storage.records
  const skip = req.skipOwnSession ? sceneOf(ctx) : null
  const origin = originFilter(req)
  const held = await getAll<{ id: ItemId }>(records, 'paths', paths)
  const items = [...(await getAll<ItemRow>(records, 'items', [...held.values()].map((v) => v.id))).values()].filter(
    (item) => !item.removed && item.absorbedInto === null && item.entered.scene !== skip && (req.includeArchived || !archived(item)) && (origin === undefined || item.origin.kind === origin),
  )
  const scenes = await getAll<SceneRow>(records, 'scenes', items.map((i) => i.entered.scene))
  return items.map((item) => itemHit(scenes, { path: item.path, scene: item.entered.scene, origin: item.origin, how: item.entered.how }))
}
