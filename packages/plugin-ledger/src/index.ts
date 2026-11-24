import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  abs,
  archivedPath,
  parseLibraryPath,
  pluginName,
  rankHits,
  regionOf,
  searchTerms,
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
import type { Ledger } from './fold.js'
import { heldCommands, heldCopies, heldPath, keep } from './held.js'
import { reconcile } from './reconcile.js'
import { findableItems, findCandidates, itemText, itemView, originLabel, sceneText, sceneView, sinceText, sinceView, standingSections } from './views.js'

/** One hook's writing: the ledger as read, and the facts it will write as one file. */
type Writing = { ctx: PluginContext; ledger: Ledger; facts: Fact[]; adopted: Map<LibraryPath, ItemId> }

async function writing(ctx: PluginContext): Promise<Writing> {
  return { ctx, ledger: await load(ctx), facts: [], adopted: new Map() }
}

/** Enters a file nobody registered, origin unknown. */
function adopt(w: Writing, path: LibraryPath, disk: Disk): ItemId {
  const item = newItemId()
  w.facts.push(fact(w.ctx, 'tool', { kind: 'item.enter', item, path, fingerprint: disk.fingerprint, size: disk.size, origin: { kind: 'adopted' } }))
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

/** What a caller wrote: an item id, or a path in the library. */
async function target(w: Writing, input: string): Promise<{ id: ItemId; fingerprint: Fingerprint } | null> {
  const known = w.ledger.items.get(input as ItemId)
  if (known) return { id: known.id, fingerprint: known.fingerprint }
  const path = parseLibraryPath(w.ctx.library.root, input)
  return path === null || regionOf(path) === 'kernel' ? null : itemAt(w, path)
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
    if (id === undefined) return { text: `挪过来的文件没人登记过，已以来历不明入册 · 条目 ${adopt(w, req.path, { fingerprint: req.fingerprint, size })}` }
    w.facts.push(fact(ctx, 'tool', { kind: 'item.move', item: id, from: req.from, to: req.path, archive: null }))
    return { text: `已记下挪动 · 条目 ${id}`, data: { item: id } }
  }
  let origin: LedgerOrigin
  if (req.origin.kind === 'made') {
    const basis = await basisOf(w, req.origin.from, req.origin.outside)
    // The kernel accepted the put only when every --from file was there; one gone since is a failure to record.
    if ('missing' in basis) throw new Error(`依据的文件不在了，没能记下来历：${basis.missing}`)
    origin = { kind: 'made', basis }
  } else origin = req.origin
  const made = origin.kind === 'made' ? basisNote(origin.basis) : ''
  const item = ledger.items.get(ledger.pathIndex.get(req.path) ?? ('' as ItemId))
  if (!item) {
    const id = newItemId()
    w.facts.push(fact(ctx, 'tool', { kind: 'item.enter', item: id, path: req.path, fingerprint: req.fingerprint, size, origin }))
    return { text: `已记下：${originLabel(origin)}${made} · 条目 ${id}`, data: { item: id } }
  }
  if (item.fingerprint === req.fingerprint) {
    if (!item.unknownOrigin) return { text: `已在册：条目 ${item.id}，内容和记录一致，没有新记`, data: { item: item.id } }
    // An enter at a path an item holds is an alias of it; it gives the adopted item its origin.
    w.facts.push(fact(ctx, 'tool', { kind: 'item.enter', item: newItemId(), path: req.path, fingerprint: req.fingerprint, size, origin }))
    return { text: `已补上来历：${originLabel(origin)}${made} · 条目 ${item.id}`, data: { item: item.id } }
  }
  const held = req.kind === 'place' && req.previous !== null ? heldPath(ctx, item.id, req.previous, req.path) : null
  const claimed = req.kind === 'register'
  const basis = origin.kind === 'made' ? { basis: origin.basis } : {}
  w.facts.push(fact(ctx, claimed ? 'reported' : 'tool', { kind: 'item.revise', item: item.id, base: item.fingerprint, fingerprint: req.fingerprint, size, ...basis, held, claimed }))
  const text = held ? `已记为新的一版，旧的一版留存在 ${held}` : claimed ? '已认下这次直接改动，记为新的一版' : '已记为新的一版'
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
    const path = input === null ? null : parseLibraryPath(ctx.library.root, input)
    const item = w.ledger.items.get((path !== null && w.ledger.pathIndex.get(path)) || ('' as ItemId))
    if (!item || path === null) return refused(`没人登记过这个文件：${input ?? '（没写）'}。要补来历，用 put <库内路径> --brought 或 --made。`)
    const disk = await onDisk(ctx.library.root, path)
    if (!disk) return refused(`文件不在：${input}`)
    if (disk.fingerprint === item.fingerprint) return heard(`${input} 的内容和记录一致，没有要认的改动`)
    w.facts.push(fact(ctx, 'reported', { kind: 'item.revise', item: item.id, base: item.fingerprint, fingerprint: disk.fingerprint, size: disk.size, held: null, claimed: true }))
    return heard(`已认下 ${input} 的直接改动，记为新的一版`)
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

/** 记账与对账. ledger-design.md. */
export const ledger: Plugin = {
  name: pluginName('ledger'),
  cognition: { title: '记账与对账', text: readFileSync(new URL('../cognition/2-ledger-section.md', import.meta.url), 'utf8') },
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'held', kind: 'body' },
  ],
  statements: ['doing', 'decided', 'note', 'from', 'revised'],
  ownerCommands: heldCommands,

  async onPut(req, ctx) {
    const w = await writing(ctx)
    const note = await recordPut(w, req)
    await writeFacts(ctx.dir, w.facts)
    return note
  },

  /** Keeps the bytes on disk in held/ before the kernel writes the new version; a file nobody registered is adopted first. */
  async revise(req, ctx) {
    const w = await writing(ctx)
    const size = (await stat(abs(ctx.library.root, req.path))).size
    const id = w.ledger.pathIndex.get(req.path) ?? adopt(w, req.path, { fingerprint: req.current, size })
    if ((await keep(ctx, id, req.path, req.current)) === null) return { outcome: 'declined', reason: `${req.path} 正在被改动，没能留存旧的一版` }
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
    const content = new Map<ItemId, string>()
    if (terms.length > 0) for (const item of findableItems(ledger, req)) content.set(item.id, await textOf(ctx.library.root, item.path))
    return rankHits(findCandidates(ledger, { ...req, current: sceneOf(ctx), content }), terms, req.match)
  },

  async onInspect(req, ctx) {
    const ledger = await load(ctx)
    const { root } = ctx.library
    const scene = ledger.scenes.get(req.target as SceneId)
    if (scene) {
      const view = sceneView(ledger, scene)
      return [{ title: '场景', body: sceneText(view), data: view }]
    }
    const item = itemNamed(ledger, root, req.target)
    if (!item) {
      const path = parseLibraryPath(root, req.target)
      if (path === null || regionOf(path) === 'kernel' || !(await onDisk(root, path) ?? (regionOf(path) === 'content' ? await onDisk(root, archivedPath(path)) : null))) return []
      const body = '没人登记过这个文件，来历不明。知道它从哪来，就用 put <库内路径> --brought 或 --made 补上。'
      return [{ title: '来历', body, data: { kind: 'unowned', path } }]
    }
    const states = await statesOf(root, ledger, [item.id, ...item.basis.items.map((row) => row.item)])
    const held = (await heldCopies(ctx, item.id)).map((c) => c.path)
    const view = itemView(ledger, item, states, held)
    return [{ title: '来历', body: itemText(view), data: view }]
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

  /** Records each owner operation that was done, so agents see it in check; an archive purge removes the items it deleted. */
  async observe(event, ctx) {
    if (event.face !== 'owner' || event.result.outcome !== 'done') return
    const w = await writing(ctx)
    w.facts.push(fact(ctx, 'tool', { kind: 'owner.op', command: event.command, summary: event.result.text, destructive: event.destructive }))
    for (const path of purged(event)) {
      const id = w.ledger.pathIndex.get(path)
      if (id !== undefined) w.facts.push(fact(ctx, 'tool', { kind: 'item.remove', item: id }))
    }
    await writeFacts(ctx.dir, w.facts)
  },
}
