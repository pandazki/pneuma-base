import { readFileSync } from 'node:fs'
import {
  abs,
  archivedPath,
  CONTRACT,
  enclosingBundle,
  parseLibraryPath,
  pluginName,
  rankHits,
  regionOf,
  searchTerms,
  thingAt,
  type AcceptedPut,
  type Event,
  type Fingerprint,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type PluginNote,
  type SayAnswer,
  type SayRequest,
} from '@pneuma-base/kernel'
import { itemNamed, load, onDisk, snapshot, statesOf, textOf, type Disk } from './disk.js'
import { fact, factActor, LEDGER_ACTOR, newItemId, sceneOf, writeFacts, type Basis, type Fact, type ItemId, type LedgerOrigin, type SceneId } from './facts.js'
import type { ItemRecord, Ledger, SceneRecord } from './fold.js'
import { heldCommands, heldCopies, heldPath, keep } from './held.js'
import { reconcile } from './reconcile.js'
import {
  ACTIVITY_VIEW,
  activityAnswer,
  itemSection,
  itemsAnswer,
  ITEMS_VIEW,
  LEDGER_VIEWS,
  SCENE_VIEW,
  sceneAnswer,
  SCENES_VIEW,
  scenesAnswer,
  STANDING_VIEW,
  standingAnswer,
  partOfSection,
  unownedSection,
} from './ui.js'
import {
  ambiguousText,
  findableItems,
  findCandidates,
  itemHit,
  itemText,
  itemView,
  originLabel,
  scenesNamed,
  sceneText,
  sceneView,
  sinceText,
  sinceView,
  standingSections,
  type ItemView,
} from './views.js'

/** One hook's writing: the ledger as read, and the facts it will write as one file. */
type Writing = { ctx: PluginContext; ledger: Ledger; facts: Fact[]; adopted: Map<LibraryPath, ItemId> }

async function writing(ctx: PluginContext): Promise<Writing> {
  return { ctx, ledger: await load(ctx), facts: [], adopted: new Map() }
}

const bundleFlag = (disk: Disk | null) => (disk?.bundle ? { bundle: true as const } : {})

/** Enters a thing nobody registered, origin unknown. */
function adopt(w: Writing, path: LibraryPath, disk: Disk): ItemId {
  const item = newItemId()
  w.facts.push(fact(w.ctx, 'tool', { kind: 'item.enter', item, path, fingerprint: disk.fingerprint, size: disk.size, origin: { kind: 'adopted' }, ...bundleFlag(disk) }))
  w.adopted.set(path, item)
  return item
}

/**
 * The item a library path names, with the content it has now: the file at the path, else its
 * archived copy. A file nobody registered is adopted first. Null when there is no such file or item.
 */
async function itemAt(w: Writing, path: LibraryPath): Promise<{ id: ItemId; fingerprint: Fingerprint } | null> {
  for (const candidate of regionOf(path) === 'content' ? [path, archivedPath(path)] : [path]) {
    const disk = await onDisk(w.ctx.library.root, candidate)
    if (disk) return { id: w.ledger.pathIndex.get(candidate) ?? w.adopted.get(candidate) ?? adopt(w, candidate, disk), fingerprint: disk.fingerprint }
  }
  const known = w.ledger.items.get(w.ledger.pathIndex.get(path) ?? ('' as ItemId))
  return known ? { id: known.id, fingerprint: known.fingerprint } : null
}

/** What a caller wrote: an item id, or a path in the library. A path inside a bundle names the bundle. */
async function target(w: Writing, input: string): Promise<{ id: ItemId; fingerprint: Fingerprint } | null> {
  const known = w.ledger.items.get(input as ItemId)
  if (known) return { id: known.id, fingerprint: known.fingerprint }
  const path = await thingPath(w.ctx.library.root, input)
  return path === null ? null : itemAt(w, path)
}

/** The library path of the thing an input names: itself, or the bundle it lies in. Null outside the content and the archive. */
async function thingPath(root: string, input: string): Promise<LibraryPath | null> {
  const path = parseLibraryPath(root, input)
  if (path === null || regionOf(path) === 'kernel') return null
  return (await enclosingBundle(root, path)) ?? path
}

/** Basis rows with each source's content as it is now. */
async function basisOf(w: Writing, from: string[], outside: string[]): Promise<Basis | { missing: string }> {
  const items: Basis['items'] = []
  for (const input of from) {
    const source = await target(w, input)
    if (!source) return { missing: input }
    if (!items.some((row) => row.item === source.id)) items.push({ item: source.id, fingerprint: source.fingerprint })
  }
  return { items, outside }
}

const basisNote = (basis: Basis) => `，依据库里 ${basis.items.length} 样${basis.outside.length ? `、库外 ${basis.outside.length} 句` : ''}`

async function recordPut(w: Writing, req: AcceptedPut): Promise<PluginNote> {
  const { ctx, ledger } = w
  const disk = await onDisk(ctx.library.root, req.path)
  const size = disk?.size ?? 0
  if (req.kind === 'move') {
    const id = ledger.pathIndex.get(req.from)
    if (id === undefined) return { text: `挪过来的东西没人登记过，已以来历不明入册 · 条目 ${adopt(w, req.path, { fingerprint: req.fingerprint, size, bundle: disk?.bundle ?? false })}` }
    w.facts.push(fact(ctx, 'tool', { kind: 'item.move', item: id, from: req.from, to: req.path, archive: null }))
    return { text: `已记下挪动 · 条目 ${id}`, data: { item: id } }
  }
  const item = ledger.items.get(ledger.pathIndex.get(req.path) ?? ('' as ItemId))
  let origin: LedgerOrigin
  if (req.origin.kind === 'made') {
    const basis = await basisOf(w, req.origin.from, req.origin.outside)
    // The kernel accepted the put only when every --from file was there; one gone since is a failure to record.
    if ('missing' in basis) throw new Error(`依据的文件不在了，没能记下来历：${basis.missing}`)
    // New content made from the thing's own old content: that it changed is the revise; it is no basis of itself.
    origin = { kind: 'made', basis: { ...basis, items: basis.items.filter((row) => row.item !== item?.id) } }
  } else origin = req.origin
  const noted = req.note === null ? {} : { note: req.note }
  const made = origin.kind === 'made' ? basisNote(origin.basis) : ''
  if (!item) {
    const id = newItemId()
    w.facts.push(fact(ctx, 'tool', { kind: 'item.enter', item: id, path: req.path, fingerprint: req.fingerprint, size, origin, ...bundleFlag(disk), ...noted }))
    return { text: `已记下：${originLabel(origin)}${made} · 条目 ${id}`, data: { item: id } }
  }
  if (item.fingerprint === req.fingerprint) {
    if (!item.unknownOrigin) {
      if (req.note === null) return { text: `已在册：条目 ${item.id}，内容和记录一致，没有新记`, data: { item: item.id } }
      // No fact is written for this put, so its sentence is a note about the thing.
      w.facts.push(fact(ctx, 'reported', { kind: 'said', flavor: 'note', text: req.note, about: item.id }))
      return { text: `已在册：条目 ${item.id}，内容和记录一致，已记下备注：${req.note}`, data: { item: item.id } }
    }
    // An enter at a path an item holds is an alias of it; it gives the adopted item its origin.
    w.facts.push(fact(ctx, 'tool', { kind: 'item.enter', item: newItemId(), path: req.path, fingerprint: req.fingerprint, size, origin, ...bundleFlag(disk), ...noted }))
    return { text: `已补上来历：${originLabel(origin)}${made} · 条目 ${item.id}`, data: { item: item.id } }
  }
  const held = req.kind === 'place' && req.previous !== null ? heldPath(ctx, item.id, req.previous, req.path) : null
  const claimed = req.kind === 'register'
  const basis = origin.kind === 'made' ? { basis: origin.basis } : {}
  w.facts.push(fact(ctx, claimed ? 'reported' : 'tool', { kind: 'item.revise', item: item.id, base: item.fingerprint, fingerprint: req.fingerprint, size, ...basis, held, claimed, ...noted }))
  const text = held ? '已记下换了新内容，旧内容进了留存，主人取得回' : claimed ? '已认下这次直接改动' : '已记下换了新内容'
  return { text: `${text} · 条目 ${item.id}`, data: { item: item.id } }
}

const heard = (note: string): SayAnswer => ({ outcome: 'heard', note })
const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })
const SAID = { doing: '在做', decided: '决定', note: '备注' } as const

async function recordSay(w: Writing, req: SayRequest): Promise<SayAnswer> {
  const { ctx } = w
  if (req.kind === 'doing' || req.kind === 'decided' || req.kind === 'note') {
    if (!req.text) return refused(`要写一句话：say ${req.kind} "<一句话>"`)
    const about = req.about === null ? null : await target(w, req.about)
    if (req.about !== null && !about) return refused(`库里没有这个文件：${req.about}`)
    w.facts.push(fact(ctx, 'reported', { kind: 'said', flavor: req.kind, text: req.text, about: about?.id ?? null }))
    return heard(`${SAID[req.kind]}：${req.text}${req.about !== null ? `（关于 ${req.about}）` : ''}`)
  }
  if (req.kind === 'from') {
    const input = req.about ?? req.text
    const subject = input === null ? null : await target(w, input)
    if (!subject) return refused(input === null ? '要写是哪样东西：say from <库内路径> --from <库内路径…>' : `库里没有这个文件：${input}`)
    const basis = await basisOf(w, req.args.from ?? [], req.args['from-outside'] ?? [])
    if ('missing' in basis) return refused(`库里没有这个文件：${basis.missing}`)
    if (basis.items.length === 0 && basis.outside.length === 0) return refused('要写 --from <库内路径…> 或 --from-outside "<一句话>"')
    const fingerprint = w.ledger.items.get(subject.id)?.fingerprint ?? subject.fingerprint
    w.facts.push(fact(ctx, 'reported', { kind: 'item.basis', item: subject.id, fingerprint, basis }))
    return heard(`已补上 ${input} 的依据${basisNote(basis)}`)
  }
  if (req.kind === 'revised') {
    const input = req.about ?? req.text
    const by = req.args.by?.[0]?.trim() || null
    if (by !== null && by !== 'owner') return refused('say revised 的 --by 只能写 owner：say revised <库内路径> [--by owner]')
    const path = input === null ? null : await thingPath(ctx.library.root, input)
    const item = w.ledger.items.get((path !== null && w.ledger.pathIndex.get(path)) || ('' as ItemId))
    if (!item || path === null) return refused(`没人登记过这个文件：${input ?? '（没写）'}。要补来历，用 put <库内路径> --brought 或 --made。`)
    const disk = await onDisk(ctx.library.root, path)
    if (!disk) return refused(`文件不在：${input}`)
    if (disk.fingerprint === item.fingerprint) return heard(`${input} 的内容和记录一致，没有要认的改动`)
    // The envelope's actor is who the library recognised; what the caller says goes in the body.
    const forOwner = by === 'owner' && ctx.actor.kind !== 'owner'
    w.facts.push(fact(ctx, 'reported', { kind: 'item.revise', item: item.id, base: item.fingerprint, fingerprint: disk.fingerprint, size: disk.size, held: null, claimed: true, ...(forOwner ? { by: 'owner' as const } : {}) }))
    return heard(forOwner ? `已记下 ${input} 的这次直接改动是主人做的` : `已认下 ${input} 的直接改动`)
  }
  return refused(`记账插件不认识这个种类：${req.kind}`)
}

const archiveSide = (from: LibraryPath, to: LibraryPath) => {
  const [a, b] = [regionOf(from) === 'archive', regionOf(to) === 'archive']
  return a === b ? null : b ? ('in' as const) : ('out' as const)
}

/** The library paths an archive purge deleted, from its answer. */
function purged(event: Extract<Event, { face: 'owner' }>): LibraryPath[] {
  if (event.command !== 'archive purge' || event.result.outcome !== 'done') return []
  const paths = (event.result.data as { paths?: unknown } | undefined)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is LibraryPath => typeof p === 'string') : []
}

/**
 * An owner command's answer as one line of the record, its lines joined, each absolute path or
 * file URL shortened to its last name: it is read in check, on the scene card and in the activity
 * list, where a name will do and the whole path only crowds the line.
 */
export const ownerSummary = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('；')
    .replace(/(^|[\s：:（(「，,]|file:\/\/)\/(?:[^\s/：:，,。；、）)」]+\/)*([^\s/：:，,。；、）)」]+\/?)/gu, (_, before: string, name: string) => `${before === 'file://' ? '' : before}${name}`)

/** An item as inspect and the item panel show it: its state and its direct sources' states from their own files, and its held copies. */
async function viewOfItem(ctx: PluginContext, ledger: Ledger, item: ItemRecord): Promise<ItemView> {
  const states = await statesOf(ctx.library.root, ledger, [item.id, ...item.basis.items.map((row) => row.item)])
  const held = (await heldCopies(ctx, item.id)).map((c) => c.path)
  return itemView(ledger, item, states, held)
}

/** Whether a file is at a content or archive path, or at its archived copy. */
async function fileAt(root: string, path: LibraryPath): Promise<boolean> {
  if (regionOf(path) === 'kernel') return false
  return (await onDisk(root, path)) !== null || (regionOf(path) === 'content' && (await onDisk(root, archivedPath(path))) !== null)
}

/**
 * The item the panel at `path` is about: the one recorded there, or the one that moved there.
 * Only full reconciliation tells a move, so it runs only when the item has no file or the file at
 * `path` has no item; it writes nothing, unlike check.
 */
async function panelView(ctx: PluginContext, ledger: Ledger, path: LibraryPath): Promise<ItemView | null> {
  const { root } = ctx.library
  const named = itemNamed(ledger, root, path)
  const known = named ? await viewOfItem(ctx, ledger, named) : null
  if (known ? known.state.kind !== 'missing' : !(await fileAt(root, path))) return known
  const standing = await reconcile(ledger, await snapshot(root))
  const moved = named ?? [...ledger.items.values()].find((item) => {
    const state = standing.states.get(item.id)
    return state?.kind === 'moved' && state.to === path
  })
  const state = moved ? standing.states.get(moved.id) : undefined
  if (!moved || state?.kind !== 'moved') return known
  return { ...(known ?? (await viewOfItem(ctx, ledger, moved))), state }
}

/** 记账与对账. ledger-design.md. */
export const ledger: Plugin = {
  contract: CONTRACT,
  name: pluginName('ledger'),
  cognition: { title: '记账与对账', text: readFileSync(new URL('../cognition/2-ledger-section.md', import.meta.url), 'utf8') },
  keeps: 'every',
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'held', kind: 'body' },
  ],
  statements: ['doing', 'decided', 'note', 'from', 'revised'],
  ownerCommands: heldCommands,
  views: LEDGER_VIEWS,

  async onPut(req, ctx) {
    const w = await writing(ctx)
    const note = await recordPut(w, req)
    await writeFacts(ctx.dir, w.facts)
    return note
  },

  /** Keeps the thing on disk in held/ before the kernel writes the new version; a thing nobody registered is adopted first. */
  async revise(req, ctx) {
    const w = await writing(ctx)
    const thing = await thingAt(abs(ctx.library.root, req.path))
    const id = w.ledger.pathIndex.get(req.path) ?? adopt(w, req.path, { fingerprint: req.current, size: thing?.size ?? 0, bundle: thing?.kind === 'bundle' })
    if ((await keep(ctx, id, req.path, req.current)) === null) return { outcome: 'declined', reason: `${req.path} 正在被改动，没能留存旧内容；稍后再放。` }
    await writeFacts(ctx.dir, w.facts)
    return { outcome: 'held', note: null }
  },

  async onSay(req, ctx) {
    const w = await writing(ctx)
    const answer = await recordSay(w, req)
    if (answer.outcome === 'heard') await writeFacts(ctx.dir, w.facts)
    return answer
  },

  async onFind(req, ctx) {
    const ledger = await load(ctx)
    const terms = searchTerms(req.text, req.match)
    const scope = { ...req, skip: req.skipOwnSession ? sceneOf(ctx) : null }
    const content = new Map<ItemId, string>()
    if (terms.length > 0) for (const item of findableItems(ledger, scope)) content.set(item.id, await textOf(ctx.library.root, item.path))
    return rankHits(findCandidates(ledger, { ...scope, content }), terms, req.match)
  },

  /**
   * The scene and origin of each found path that is an item this find would give: start's own
   * session stays left out, as in `onFind`. A file nobody registered gets nothing.
   */
  async onFound(paths, req, ctx) {
    const ledger = await load(ctx)
    const asked = new Set(paths)
    const scope = { ...req, skip: req.skipOwnSession ? sceneOf(ctx) : null }
    return findableItems(ledger, scope).flatMap((item) => (asked.has(item.path) ? [itemHit(ledger, item)] : []))
  },

  /** The target is a scene id, an item id or path, a file nobody registered, else a scene id prefix: exact names first. */
  async onInspect(req, ctx) {
    const ledger = await load(ctx)
    const { root } = ctx.library
    const card = (scene: SceneRecord) => {
      const view = sceneView(ledger, scene)
      return [{ title: '场景', body: sceneText(view), data: view }]
    }
    const scene = ledger.scenes.get(req.target as SceneId)
    if (scene) return card(scene)
    const item = itemNamed(ledger, root, req.target)
    if (item) {
      const view = await viewOfItem(ctx, ledger, item)
      return [{ title: '来历', body: itemText(view), data: view }]
    }
    const path = parseLibraryPath(root, req.target)
    const region = path === null ? 'kernel' : regionOf(path)
    const bundle = path === null || region === 'kernel' ? null : ((await enclosingBundle(root, path)) ?? (region === 'content' ? await enclosingBundle(root, archivedPath(path)) : null))
    if (path !== null && bundle !== null) {
      const body = `它是 ${bundle} 的一部分：${bundle} 是一样东西（带标记的目录），来历见 inspect ${bundle}。`
      return [{ title: '来历', body, data: { kind: 'part-of', path, bundle } }]
    }
    if (path !== null && regionOf(path) !== 'kernel' && (await onDisk(root, path) ?? (regionOf(path) === 'content' ? await onDisk(root, archivedPath(path)) : null))) {
      const body = '没人登记过这个文件，来历不明。知道它从哪来，就用 put <库内路径> --brought 或 --made 补上。'
      return [{ title: '来历', body, data: { kind: 'unowned', path } }]
    }
    const scenes = scenesNamed(ledger, req.target)
    if (scenes.length === 1) return card(scenes[0] as SceneRecord)
    if (scenes.length === 0) return []
    return [{ title: '场景', body: ambiguousText(req.target, scenes), data: { kind: 'ambiguous', prefix: req.target, scenes: scenes.map((s) => s.id) } }]
  },

  async onCheck(req, ctx) {
    const ledger = await load(ctx)
    const standing = await reconcile(ledger, await snapshot(ctx.library.root))
    // A moved file is taken back: its new path is recorded, as seen by the ledger itself.
    const moves = [...standing.states].flatMap(([item, state]) => {
      const from = ledger.items.get(item)?.path
      return state.kind === 'moved' && from ? [fact(ctx, 'observed', { kind: 'item.move', item, from, to: state.to, archive: archiveSide(from, state.to) }, LEDGER_ACTOR)] : []
    })
    await writeFacts(ctx.dir, moves)
    const since = sinceView(ledger, factActor(ctx.actor), sceneOf(ctx), req.since)
    return [...(since.scenes.length > 0 ? [{ title: '自上次以来', body: sinceText(since), data: since }] : []), ...standingSections(ledger, standing, req.includeArchived)]
  },

  async onArchive(req, ctx) {
    if (!req.moved) return null
    const w = await writing(ctx)
    const known = w.ledger.pathIndex.get(req.from)
    const disk = await onDisk(ctx.library.root, req.to)
    const id = known ?? (disk ? adopt(w, req.from, disk) : undefined)
    if (id === undefined) return null
    w.facts.push(fact(ctx, 'tool', { kind: 'item.move', item: id, from: req.from, to: req.to, archive: req.kind === 'archive' ? 'in' : 'out' }))
    await writeFacts(ctx.dir, w.facts)
    const what = req.kind === 'archive' ? '已记下归档' : '已记下取回'
    return { text: `${what}${known ? '' : '；这个文件以前没人登记过，已以来历不明入册'} · 条目 ${id}`, data: { item: id } }
  },

  /** The ledger's pages, from the same fold and reconciliation check uses. Writes nothing: a move it sees stays for check to record. */
  async onView(req, ctx) {
    const ledger = await load(ctx)
    const standing = async () => reconcile(ledger, await snapshot(ctx.library.root))
    switch (req.view) {
      case ITEMS_VIEW:
        return itemsAnswer(ledger, await standing(), req.params)
      case STANDING_VIEW:
        return standingAnswer(ledger, await standing())
      case SCENES_VIEW:
        return scenesAnswer(ledger)
      case SCENE_VIEW:
        return sceneAnswer(ledger, req.params)
      case ACTIVITY_VIEW:
        return activityAnswer(ledger, req.params)
      default:
        throw new Error(`the ledger has no view ${req.view}`)
    }
  },

  /** The item panel's provenance section, from the same view inspect gives; a file nobody registered says so. */
  async onItemView(path, ctx) {
    const ledger = await load(ctx)
    const { root } = ctx.library
    // A file inside a bundle that was never an item of its own has the bundle's provenance.
    const bundle = itemNamed(ledger, root, path) ? null : await enclosingBundle(root, path)
    if (bundle !== null) return partOfSection(bundle)
    const view = await panelView(ctx, ledger, path)
    if (view) return itemSection(view)
    return (await fileAt(root, path)) ? unownedSection(path) : null
  },

  /** Records each owner operation that was done, so agents see it in check; an archive purge removes the items it deleted. */
  async observe(event, ctx) {
    if (event.face !== 'owner' || event.result.outcome !== 'done') return
    const w = await writing(ctx)
    w.facts.push(fact(ctx, 'tool', { kind: 'owner.op', command: event.command, summary: ownerSummary(event.result.text), destructive: event.destructive, ...(event.readOnly ? { readOnly: true as const } : {}), ...(event.setup ? { setup: true as const } : {}) }))
    for (const path of purged(event)) {
      const id = w.ledger.pathIndex.get(path)
      if (id !== undefined) w.facts.push(fact(ctx, 'tool', { kind: 'item.remove', item: id }))
    }
    await writeFacts(ctx.dir, w.facts)
  },
}
