import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { posix, relative } from 'node:path'
import {
  abs,
  archivedPath,
  fingerprintOfFile,
  parseLibraryPath,
  pluginName,
  rankHits,
  regionOf,
  searchTerms,
  type AcceptedPut,
  type Fingerprint,
  type LibraryPath,
  type Plugin,
  type PluginContext,
  type PluginNote,
  type SayAnswer,
  type SayRequest,
} from '@pneuma-base/kernel'
import { fact, factActor, newItemId, readFacts, sceneOf, writeFacts, type Basis, type Fact, type ItemId, type LedgerOrigin, type SceneId } from './facts.js'
import { fold, type Ledger } from './fold.js'
import { classify, type ItemState } from './reconcile.js'
import { findableItems, findCandidates, itemText, itemView, originLabel, sceneText, sceneView, sinceText, sinceView } from './views.js'

export { fold } from './fold.js'
export { classify, marksOf } from './reconcile.js'

const TEXT_LIMIT = 1024 * 1024

async function load(ctx: PluginContext): Promise<Ledger> {
  return fold(await readFacts(ctx.dir))
}

type Disk = { fingerprint: Fingerprint; size: number }

/** The fingerprint and size of the regular file at `path`; null when there is none. */
async function onDisk(root: string, path: LibraryPath): Promise<Disk | null> {
  const file = abs(root, path)
  const s = await stat(file).catch(() => null)
  return s?.isFile() ? { fingerprint: await fingerprintOfFile(file), size: s.size } : null
}

/** The file's text when it is UTF-8 and at most 1 MB; otherwise empty. */
async function textOf(root: string, path: LibraryPath): Promise<string> {
  const file = abs(root, path)
  const s = await stat(file).catch(() => null)
  if (!s?.isFile() || s.size > TEXT_LIMIT) return ''
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
    return text.includes('\u0000') ? '' : text
  } catch {
    return ''
  }
}

/** One hook's writing: the ledger as read, and the facts it will write as one file. */
type Writing = { ctx: PluginContext; ledger: Ledger; facts: Fact[]; adopted: Map<LibraryPath, ItemId> }

async function writing(ctx: PluginContext): Promise<Writing> {
  return { ctx, ledger: await load(ctx), facts: [], adopted: new Map() }
}

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

/** Where `revise` keeps the content a new version replaced, relative to the library root. */
function heldPath(ctx: PluginContext, item: ItemId, fingerprint: Fingerprint, path: LibraryPath): string {
  return posix.join(relative(ctx.library.root, ctx.dir).split('\\').join('/'), 'held', item, fingerprint, posix.basename(path))
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
  return refused(`记账插件不认识这个种类：${req.kind}`)
}

/** Each item's state from its own file only; no search for moved files. */
async function statesOf(root: string, ledger: Ledger, ids: ItemId[]): Promise<Map<ItemId, ItemState>> {
  const states = new Map<ItemId, ItemState>()
  for (const id of ids) {
    const item = ledger.items.get(id)
    if (item) states.set(id, classify(item, item.removed ? null : ((await onDisk(root, item.path))?.fingerprint ?? null), null))
  }
  return states
}

/** 记账与对账. ledger-design.md. */
export const ledger: Plugin = {
  name: pluginName('ledger'),
  cognition: { title: '记账与对账', text: readFileSync(new URL('../cognition/2-ledger-section.md', import.meta.url), 'utf8') },
  storage: [{ dir: 'facts', kind: 'body' }],
  statements: ['doing', 'decided', 'note', 'from'],
  ownerCommands: [],

  async onPut(req, ctx) {
    const w = await writing(ctx)
    const note = await recordPut(w, req)
    await writeFacts(ctx.dir, w.facts)
    return note
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
    const path = parseLibraryPath(root, req.target)
    const id = ledger.items.has(req.target as ItemId)
      ? (req.target as ItemId)
      : path === null
        ? undefined
        : (ledger.pathIndex.get(path) ?? (regionOf(path) === 'content' ? ledger.pathIndex.get(archivedPath(path)) : undefined))
    const item = id === undefined ? undefined : ledger.items.get(id)
    if (!item) {
      if (path === null || regionOf(path) === 'kernel' || !(await onDisk(root, path) ?? (regionOf(path) === 'content' ? await onDisk(root, archivedPath(path)) : null))) return []
      const body = '没人登记过这个文件，来历不明。知道它从哪来，就用 put <库内路径> --brought 或 --made 补上。'
      return [{ title: '来历', body, data: { kind: 'unowned', path } }]
    }
    const states = await statesOf(root, ledger, [item.id, ...item.basis.items.map((row) => row.item)])
    const view = itemView(ledger, item, states, [])
    return [{ title: '来历', body: itemText(view), data: view }]
  },

  async onCheck(req, ctx) {
    const ledger = await load(ctx)
    const since = sinceView(ledger, factActor(ctx.actor), sceneOf(ctx), req.since)
    return since.scenes.length > 0 ? [{ title: '自上次以来', body: sinceText(since), data: since }] : []
  },
}
