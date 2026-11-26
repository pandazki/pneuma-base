// The fold: facts into rows, a batch at a time, each fact taken after the ones before it (by time, then
// id). It reads only the rows the batch names (prefetched in a few asks) and the few that a fact reaches
// through them: a bundle's absorbed things, a source's dependents. ledger-design.md section 3, on rows.
import { originalPath, type LibraryPath, type Place } from '@pneuma-base/kernel'
import { actorKey, inOrder, isTold, mayBeNews, newsKey, requestOf, turned, type Basis, type Fact, type FactActor, type ItemId, type LedgerOrigin } from './facts.js'
import {
  ancestors,
  archived,
  classOf,
  lean,
  live,
  openOf,
  parentOf,
  putActor,
  putDir,
  putItem,
  putMark,
  putPath,
  putSeen,
  sameVersion,
  staleAsRecorded,
  type ActorRow,
  type HeldRow,
  type HistoryRow,
  type ItemRow,
  type OriginLine,
  type SceneRow,
  type SeenRow,
} from './model.js'
import type { Tx } from './rows.js'
import { agentOf, countReuse, hourOf, hourRow, OPEN_COUNTERS, putHour, requestTo, snapshot, type RequestRow } from './stats.js'

/**
 * What a fold changed that the rows' other parts follow: marks to settle, open directories whose strays
 * to work out again, places the tool moved a thing away from or removed it at (whatever a listing taken
 * before says is there is gone), places a fact set anew, to look at; `overflow` when there were more of those than
 * one look takes, and every registered place is to be looked at.
 */
export type FoldOut = { remark: Set<ItemId>; restray: Set<Place>; released: Set<LibraryPath>; voided: Set<LibraryPath>; overflow: boolean }
export const foldOut = (): FoldOut => ({ remark: new Set(), restray: new Set(), released: new Set(), voided: new Set(), overflow: false })
/** How many places a fold names for the look at most; past that the look compares every registered place. */
const VOIDED_MAX = 1000

export const NO_BASIS: Basis = { items: [], outside: [] }
/** How many texts of an item find keeps, and how long each. */
const TEXTS = 12
const TEXT_LENGTH = 300
/** How many of each kind of sentence a scene keeps, and how many of its things it names. */
const SAID_KEPT = 8
const SCENE_ITEMS = 20
const SCENE_SOURCES = 500

const whoName = (a: FactActor) => (a.kind === 'owner' ? '主人' : a.name)
const originLine = (f: Fact & { origin: LedgerOrigin }): OriginLine => ({ origin: lean(f.origin), how: f.how, at: f.at, scene: f.scene, actor: f.actor, where: f.where ?? null })
const historyKey = (item: ItemId, f: Pick<Fact, 'at' | 'id'>) => `${item}|${f.at}|${f.id}`
const basisOfOrigin = (origin: LedgerOrigin): Basis => (origin.kind === 'made' ? origin.basis : NO_BASIS)

/** The fact with every item it names, itself or in a basis, taken through the aliases. */
async function resolved(tx: Tx, f: Fact): Promise<Fact> {
  const r = async (id: ItemId) => (await tx.get<ItemId>('alias', id)) ?? id
  const basis = async (b: Basis): Promise<Basis> => ({ ...b, items: await Promise.all(b.items.map(async (row) => ({ ...row, item: await r(row.item) }))) })
  switch (f.kind) {
    case 'said':
      return f.about === null ? f : { ...f, about: await r(f.about) }
    case 'owner.op':
    case 'request':
    case 'checked':
    case 'items.enter':
    case 'unowned.left':
      return f
    case 'item.enter':
      return { ...f, item: await r(f.item), origin: f.origin.kind === 'made' ? { ...f.origin, basis: await basis(f.origin.basis) } : f.origin }
    case 'item.revise':
      return { ...f, item: await r(f.item), ...(f.basis ? { basis: await basis(f.basis) } : {}) }
    case 'item.basis':
      return { ...f, item: await r(f.item), basis: await basis(f.basis) }
    default:
      return { ...f, item: await r(f.item) }
  }
}

/** The ids and paths a batch names, to read their rows in a few asks. */
function namedBy(facts: readonly Fact[]) {
  const ids = new Set<string>()
  const paths = new Set<string>()
  const add = (b: Basis | undefined) => b?.items.forEach((row) => ids.add(row.item))
  for (const f of facts) {
    if ('item' in f) ids.add(f.item)
    if (f.kind === 'said' && f.about !== null) ids.add(f.about)
    if (f.kind === 'item.enter') {
      paths.add(f.path)
      if (f.origin.kind === 'made') add(f.origin.basis)
    }
    if (f.kind === 'items.enter') {
      for (const e of f.items) {
        ids.add(e.item)
        paths.add(e.path)
      }
    }
    if (f.kind === 'item.revise' || f.kind === 'item.basis') add(f.basis)
    if (f.kind === 'item.move') {
      paths.add(f.from)
      paths.add(f.to)
    }
  }
  return { ids, paths }
}

/** Folds a batch of facts into the rows; a fact folded before (by id) is not taken again. */
export async function foldFacts(tx: Tx, input: readonly Fact[], out: FoldOut): Promise<void> {
  const ordered = inOrder(input)
  const known = await tx.getMany('ids', ordered.map((f) => f.id))
  const seen = new Set<string>()
  const facts = ordered.filter((f) => !known.has(f.id) && !seen.has(f.id) && seen.add(f.id))
  if (facts.length === 0) return
  const { ids, paths } = namedBy(facts)
  await tx.prefetch('alias', ids)
  const aliases = await tx.getMany<ItemId>('alias', ids)
  await tx.prefetch('items', [...ids, ...aliases.values()])
  await tx.prefetch('paths', paths)
  await tx.prefetch('scenes', facts.map((f) => f.scene))
  await tx.prefetch('actors', facts.map((f) => actorKey(f.actor)))
  await tx.prefetch('stats', facts.map((f) => `h:${hourOf(f.at)}`))
  await tx.prefetch('requests', facts.flatMap((f) => requestOf(f) ?? []))
  const fold = new Folding(tx, out)
  let hour: string | null = null
  for (const raw of facts) {
    if (hour !== null && hourOf(raw.at) !== hour) await fold.endHour(hour)
    hour = hourOf(raw.at)
    await fold.take(raw)
  }
  if (hour !== null) await fold.endHour(hour)
}

class Folding {
  /** Made things whose sources' recorded versions changed: their 「可能过期」 as recorded is worked out again at the end of the hour. */
  private restale = new Set<ItemId>()
  /** The enters of an `items.enter` under way: the owner registering what was there, which is no put. */
  private bulk = false

  constructor(
    private readonly tx: Tx,
    private readonly out: FoldOut,
  ) {}

  private item = (id: ItemId) => this.tx.get<ItemRow>('items', id)

  async take(raw: Fact): Promise<void> {
    const { tx } = this
    tx.set('ids', raw.id, 1)
    await tx.bump('facts', 1)
    const first = await tx.get<string>('meta', 'first')
    if (first === undefined || raw.at < first) tx.set('meta', 'first', raw.at)
    await this.actor(raw)
    if (raw.kind === 'items.enter') {
      const { items, origin, ...envelope } = raw
      this.bulk = true
      for (const e of items) await this.step({ ...envelope, kind: 'item.enter', ...e, origin })
      this.bulk = false
      const row = await hourRow(tx, raw.at)
      if (raw.actor.kind === 'owner') row.owner.registered += items.length
      putHour(tx, row)
    }
    const kept = raw.kind === 'items.enter' ? raw : await this.step(raw)
    if (isTold(kept)) await this.log(kept)
    await this.count(kept)
  }

  async endHour(hour: string): Promise<void> {
    const ids = [...this.restale]
    this.restale.clear()
    if (ids.length > 0) {
      const rows = await this.tx.getMany<ItemRow>('items', ids)
      await this.tx.prefetch('items', [...rows.values()].flatMap((r) => r.basis.items.map((b) => b.item)))
      for (const item of rows.values()) await this.touch(item)
    }
    await snapshot(this.tx, `${hour}:00:00.000Z`)
  }

  private async actor(f: Fact): Promise<void> {
    const { tx } = this
    const key = actorKey(f.actor)
    const row = (await tx.get<ActorRow>('actors', key)) ?? { actor: f.actor, first: f.at, checked: null, last: { scene: f.scene, at: f.at }, other: null, scenes: 0, put: 0 }
    if (row.last.scene === f.scene) row.last.at = f.at
    else Object.assign(row, { other: row.last, last: { scene: f.scene, at: f.at } })
    if (f.kind === 'checked') row.checked = f.at
    if (f.kind === 'item.enter') row.put++
    const pair = `a|${key}|${f.scene}`
    if ((await tx.get('touch', pair)) === undefined) {
      tx.set('touch', pair, 1)
      row.scenes++
    }
    putActor(tx, key, row)
  }

  private async step(raw: Fact): Promise<Fact> {
    const { tx } = this
    if (raw.kind === 'item.enter') {
      const holder = (await tx.get<{ id: ItemId }>('paths', raw.path))?.id
      // Two enters claimed the same path: the later item is an alias of the earlier one.
      if (holder !== undefined && holder !== raw.item && (await tx.get('alias', raw.item)) === undefined) tx.set('alias', raw.item, holder)
    }
    const f = await resolved(tx, raw)
    await this.apply(f)
    return f
  }

  private async apply(f: Fact): Promise<void> {
    if (f.kind === 'checked') return
    const scene = await this.scene(f)
    switch (f.kind) {
      case 'item.enter':
        return this.enter(f, scene)
      case 'item.revise':
        return this.revise(f)
      case 'item.move': {
        const item = await this.item(f.item)
        if (!item) return
        await this.relocate(item, f.to)
        if (f.token !== undefined) Object.assign(item, { token: f.token, modified: f.modified ?? item.modified, entries: null })
        this.void(item)
        await this.touch(item)
        return
      }
      case 'item.basis': {
        const item = await this.item(f.item)
        if (!item) return
        await this.rebasis(item, f.basis)
        item.unknownOrigin = false
        await this.recountReuse(item)
        await this.touch(item)
        return
      }
      case 'item.remove': {
        const item = await this.item(f.item)
        if (item) await this.remove(item)
        return
      }
      case 'said':
        return this.said(f, scene)
      case 'owner.op': {
        if (!scene.ops.some((op) => op.command === f.command && actorKey(op.actor) === actorKey(f.actor))) scene.ops.push({ command: f.command, actor: f.actor })
        this.tx.set('scenes', scene.id, scene)
        if (f.command === 'ledger held drop' && f.refused === undefined) await this.dropHeld()
        return
      }
      case 'unowned.left':
        for (const path of f.paths) {
          this.tx.set('left', path, 1)
          this.out.restray.add(parentOf(path))
        }
        return
    }
  }

  private async scene(f: Fact): Promise<SceneRow> {
    const { tx } = this
    let s = await tx.get<SceneRow>('scenes', f.scene)
    if (!s) {
      s = { id: f.scene, first: f.at, last: f.at, actors: [], cwds: [], transcript: null, said: [], ops: [], items: [], touched: 0, put: [], puts: 0, brought: 0, sources: [], outside: [], decided: 0, lastDecided: null, started: false }
      tx.set('sceneOrder', `${turned(f.at)}|${f.scene}`, { id: f.scene })
      await tx.bump('scenes', 1)
    }
    s.last = f.at
    if (!s.actors.some((a) => actorKey(a) === actorKey(f.actor))) s.actors.push(f.actor)
    if (f.where?.cwd && !s.cwds.includes(f.where.cwd)) s.cwds.push(f.where.cwd)
    if (f.where?.transcript) s.transcript = { ...f.where.transcript, machine: f.where.machine }
    if ('item' in f && f.kind !== 'item.remove') {
      const pair = `s|${f.scene}|${f.item}`
      if ((await tx.get('touch', pair)) === undefined) {
        tx.set('touch', pair, 1)
        s.touched++
        if (s.items.length < SCENE_ITEMS) s.items.push(f.item)
      }
    }
    tx.set('scenes', s.id, s)
    return s
  }

  // ---- items ----

  private addText(item: ItemRow, text: string | null | undefined): void {
    if (!text || item.texts.includes(text) || item.texts.length >= TEXTS) return
    item.texts.push(text.slice(0, TEXT_LENGTH))
  }

  /** A fact set what the thing is now anew: what a look found before no longer stands, and it is to be looked at. */
  private void(item: ItemRow): void {
    if (item.state === 'moved' && item.to !== null) this.tx.set('taken', item.to, null)
    Object.assign(item, { state: 'consistent', now: null, to: null })
    this.toLook(item.path)
  }

  private toLook(path: LibraryPath): void {
    if (this.out.voided.size < VOIDED_MAX) this.out.voided.add(path)
    else this.out.overflow = true
  }

  private async enter(f: Extract<Fact, { kind: 'item.enter' }>, scene: SceneRow): Promise<void> {
    const { tx } = this
    const item = await this.item(f.item)
    if (item) {
      // An alias that knows where the thing came from replaces an origin nobody knew, or one only seen
      // when it was said; an origin somebody said stays.
      const seenOnly = item.entered.how === 'observed'
      if (f.origin.kind !== 'adopted' && (item.unknownOrigin || (seenOnly && f.how !== 'observed'))) {
        item.earlier.push(item.entered)
        await this.rebasis(item, basisOfOrigin(f.origin))
        Object.assign(item, { origin: lean(f.origin), unknownOrigin: false, entered: originLine(f) })
        if (f.origin.kind === 'brought') this.addText(item, f.origin.source)
        await this.recountReuse(item)
      }
      // Its note is about the content it registered, which an earlier fact recorded.
      if (f.note) {
        this.addText(item, f.note)
        const last = item.last.key === null ? undefined : await tx.get<HistoryRow>('history', item.last.key)
        if (last?.kind === 'version' && last.note === null && sameVersion(item.last, f)) tx.set('history', item.last.key as string, { ...last, note: f.note })
      }
      await this.touch(item)
      return
    }
    const key = historyKey(f.item, f)
    const fresh: ItemRow = {
      id: f.item,
      path: f.path,
      holds: true,
      bundle: f.bundle === true,
      removed: false,
      absorbedInto: null,
      absorbed: [],
      dependents: [],
      token: f.token ?? null,
      fingerprint: f.fingerprint,
      size: f.size,
      modified: f.modified ?? null,
      entries: null,
      origin: lean(f.origin),
      basis: NO_BASIS,
      entered: originLine(f),
      earlier: [],
      unknownOrigin: f.origin.kind === 'adopted',
      last: { how: f.how, claimed: false, token: f.token ?? null, fingerprint: f.fingerprint, key, at: f.at },
      versions: 1,
      texts: [],
      state: 'consistent',
      now: null,
      to: null,
      marks: [],
      marked: false,
      open: null,
      reuse: null,
      find: null,
      cls: null,
      time: null,
    }
    tx.set('history', key, { kind: 'version', fingerprint: f.fingerprint, token: f.token ?? null, at: f.at, scene: f.scene, actor: f.actor, how: f.how, held: null, claimed: false, by: null, note: f.note ?? null, seen: null } satisfies HistoryRow)
    if (f.origin.kind === 'brought') this.addText(fresh, f.origin.source)
    this.addText(fresh, f.note)
    await this.rebasis(fresh, basisOfOrigin(f.origin))
    await this.claim(fresh, f.path)
    await this.bumpDirs(f.path, 1)
    this.toLook(f.path)
    if (fresh.bundle) await this.absorb(fresh)
    // Counted as put once, when it first enters, by how it came; an adoption and the owner registering what was there are no puts.
    if (f.origin.kind !== 'adopted') {
      if (!this.bulk) {
        const row = await hourRow(tx, f.at)
        row.put[f.origin.kind]++
        if (f.actor.kind === 'agent') agentOf(row, f.actor.name)[f.origin.kind]++
        else if (f.actor.kind === 'owner') row.owner[f.origin.kind]++
        putHour(tx, row)
      }
      scene.puts++
      if (f.origin.kind === 'brought') scene.brought++
      if (scene.put.length < SCENE_ITEMS) scene.put.push(fresh.id)
      if (f.origin.kind === 'made' && !this.bulk) await this.recountReuse(fresh, true)
    }
    this.sceneSources(scene, fresh)
    await this.touch(fresh)
  }

  private async revise(f: Extract<Fact, { kind: 'item.revise' }>): Promise<void> {
    const { tx } = this
    const item = await this.item(f.item)
    if (!item) return
    if (f.claimed && sameVersion(item.last, f)) {
      // The content it has claimed again: a claim somebody makes replaces one only seen; a claim only seen changes nothing.
      if (item.last.how === 'observed' && f.how !== 'observed' && item.last.key !== null) {
        const last = await tx.get<HistoryRow>('history', item.last.key)
        if (last?.kind === 'version') tx.set('history', item.last.key, { ...last, how: f.how, actor: f.actor, scene: f.scene, at: f.at, claimed: true, by: f.by ?? null, note: f.note ?? null, seen: { at: last.at, actor: last.actor } } satisfies HistoryRow)
        item.last = { ...item.last, how: f.how, claimed: true }
        await this.touch(item)
      }
      return
    }
    const key = historyKey(item.id, f)
    tx.set('history', key, { kind: 'version', fingerprint: f.fingerprint, token: f.token ?? null, at: f.at, scene: f.scene, actor: f.actor, how: f.how, held: f.held, claimed: f.claimed, by: f.by ?? null, note: f.note ?? null, seen: null } satisfies HistoryRow)
    Object.assign(item, { token: f.token ?? null, fingerprint: f.fingerprint, size: f.size, modified: f.modified ?? null, entries: null, versions: item.versions + 1 })
    item.last = { how: f.how, claimed: f.claimed, token: f.token ?? null, fingerprint: f.fingerprint, key, at: f.at }
    if (f.basis) await this.rebasis(item, mergeBasis(item.basis, f.basis))
    this.addText(item, f.note)
    this.void(item)
    for (const id of item.dependents) this.restale.add(id)
    if (f.basis) await this.recountReuse(item)
    if (f.held !== null) await this.held(item, f)
    await this.touch(item)
  }

  private async said(f: Extract<Fact, { kind: 'said' }>, scene: SceneRow): Promise<void> {
    const { tx } = this
    const kept = scene.said.filter((x) => x.flavor === f.flavor)
    if (!kept.some((x) => x.text === f.text) && kept.length < SAID_KEPT) scene.said.push({ id: f.id, flavor: f.flavor, text: f.text, at: f.at, actor: f.actor, about: f.about })
    if (f.flavor === 'decided') Object.assign(scene, { decided: scene.decided + 1, lastDecided: f.text })
    tx.set('scenes', scene.id, scene)
    const texts = scene.said.map((x) => x.text).join('\n')
    tx.set('find', `s|${scene.id}`, { scene: scene.id, texts }, { scene: scene.id })
    const about = f.about === null ? undefined : await this.item(f.about)
    if (about) {
      tx.set('history', historyKey(about.id, f), { kind: 'said', id: f.id, flavor: f.flavor, text: f.text, at: f.at, scene: f.scene, actor: f.actor, about: f.about } satisfies HistoryRow)
      this.addText(about, f.text)
      await this.touch(about)
    }
  }

  /** Takes `path` for the item; another that held it does no longer. */
  private async claim(item: ItemRow, path: LibraryPath): Promise<void> {
    const holder = (await this.tx.get<{ id: ItemId }>('paths', path))?.id
    if (holder !== undefined && holder !== item.id) {
      const other = await this.item(holder)
      if (other) {
        other.holds = false
        putItem(this.tx, other)
      }
    }
    putPath(this.tx, path, item.id)
    this.out.restray.add(parentOf(path))
  }

  private async release(item: ItemRow): Promise<void> {
    if ((await this.tx.get<{ id: ItemId }>('paths', item.path))?.id === item.id) putPath(this.tx, item.path, null)
    item.holds = false
    this.out.restray.add(parentOf(item.path))
    this.out.released.add(item.path)
  }

  /** Counts a thing in or out of every directory above it: those directories are open while anything is counted in them. */
  private async bumpDirs(path: LibraryPath, by: number): Promise<void> {
    const { tx } = this
    for (const dir of ancestors(path)) {
      const was = (await tx.get<number>('dirs', dir)) ?? 0
      const now = was + by
      putDir(tx, dir, now)
      if (was <= 0 && now > 0) this.out.restray.add(parentOf(dir))
      if (was > 0 && now <= 0) {
        // No longer open: its listing and its strays go; in the level above it is a directory nobody looked into.
        const seen = await tx.get<SeenRow>('seen', dir)
        for (const key of seen?.strays ?? []) putMark(tx, key, null)
        if (seen) putSeen(tx, dir, null)
        this.out.restray.add(parentOf(dir))
      }
    }
  }

  /** The items under a bundle entered there that no bundle absorbed yet are absorbed into it. */
  private async absorb(bundle: ItemRow): Promise<void> {
    for (const { value } of await this.tx.under<{ id: ItemId }>('paths', `${bundle.path}/`)) {
      const other = await this.item(value.id)
      if (!other || other.id === bundle.id || !live(other)) continue
      await this.bumpDirs(other.path, -1)
      other.absorbedInto = bundle.id
      bundle.absorbed.push(other.id)
      await this.touch(other)
    }
  }

  /** Moves an item to `to`, and the items a bundle absorbed along with it. */
  private async relocate(item: ItemRow, to: LibraryPath): Promise<void> {
    const from = item.path
    if (live(item)) await this.bumpDirs(from, -1)
    await this.release(item)
    item.path = to
    item.holds = true
    await this.claim(item, to)
    if (live(item)) await this.bumpDirs(to, 1)
    for (const id of item.bundle ? item.absorbed : []) {
      const other = await this.item(id)
      if (other) {
        await this.relocate(other, `${to}${other.path.slice(from.length)}` as LibraryPath)
        await this.touch(other)
      }
    }
  }

  private async remove(item: ItemRow): Promise<void> {
    if (live(item)) await this.bumpDirs(item.path, -1)
    item.removed = true
    await this.release(item)
    if (item.state === 'moved' && item.to !== null) this.tx.set('taken', item.to, null)
    for (const id of item.dependents) this.restale.add(id)
    await this.touch(item)
    for (const id of item.bundle ? item.absorbed : []) {
      const other = await this.item(id)
      if (other && !other.removed) await this.remove(other)
    }
  }

  /** Gives an item a new basis, keeping each source's list of what was made from it. */
  private async rebasis(item: ItemRow, basis: Basis): Promise<void> {
    const before = new Set(item.basis.items.map((r) => r.item))
    const after = new Set(basis.items.map((r) => r.item))
    item.basis = basis
    for (const id of new Set([...before, ...after])) {
      if (id === item.id || before.has(id) === after.has(id)) continue
      const source = await this.item(id)
      if (!source) continue
      source.dependents = after.has(id) ? [...source.dependents, item.id] : source.dependents.filter((d) => d !== item.id)
      putItem(this.tx, source)
    }
  }

  /** What a thing made when it first entered was built on, counted into the hour it was made in. */
  private async recountReuse(item: ItemRow, fresh = false): Promise<void> {
    if (!fresh && item.reuse === null) return
    const sources = (await Promise.all(item.basis.items.filter((r) => r.item !== item.id).map((r) => this.item(r.item)))).filter((s): s is ItemRow => s !== undefined)
    const unique = [...new Map(sources.map((s) => [s.id, s])).values()]
    const actor = whoName(item.entered.actor)
    const next = {
      hour: item.reuse?.hour ?? hourOf(item.entered.at),
      actor,
      fromLibrary: unique.length > 0,
      otherSession: unique.some((s) => s.entered.scene !== item.entered.scene),
      otherAgent: unique.some((s) => s.entered.actor.kind === 'agent' && whoName(s.entered.actor) !== actor),
      uses: unique.map((s) => s.id),
    }
    await countReuse(this.tx, item, next)
  }

  private sceneSources(scene: SceneRow, item: ItemRow): void {
    for (const row of item.basis.items) if (!scene.sources.includes(row.item) && scene.sources.length < SCENE_SOURCES) scene.sources.push(row.item)
    for (const o of item.basis.outside) if (!scene.outside.includes(o) && scene.outside.length < SCENE_SOURCES) scene.outside.push(o)
    this.tx.set('scenes', scene.id, scene)
  }

  private async held(item: ItemRow, f: Extract<Fact, { kind: 'item.revise' }>): Promise<void> {
    const path = f.held as string
    const at = path.indexOf('held/')
    const place = at === -1 ? path : path.slice(at)
    const key = place.split('/')[2] ?? ''
    const rowKey = `${item.id}|${key}`
    if ((await this.tx.get('held', rowKey)) === undefined) await this.tx.bump('held', 1)
    this.tx.set('held', rowKey, { item: item.id, key, place, path, fingerprint: f.base, at: f.at } satisfies HeldRow)
  }

  private async dropHeld(): Promise<void> {
    const rows = await this.tx.under('held', '')
    for (const r of rows) this.tx.set('held', r.key, null)
    await this.tx.bump('held', -(await this.tx.counter('held')))
  }

  /**
   * After any change to an item: what it counts toward (the library page's classes, what needs looking
   * at as recorded), its rows in `find` and `bytime`, and that its marks are to be settled.
   */
  async touch(item: ItemRow): Promise<void> {
    const { tx } = this
    const cls = classOf(item)
    if (cls !== item.cls) {
      if (item.cls !== null) await tx.bump(`class:${item.cls}`, -1)
      if (cls !== null) await tx.bump(`class:${cls}`, 1)
      item.cls = cls
    }
    const stale = live(item) && !archived(item) && item.basis.items.length > 0 && (await this.staleNow(item))
    const open = openOf(item, stale)
    for (const k of ['stale', 'changed', 'unknown', 'archived'] as const) {
      const was = item.open?.[k] ? 1 : 0
      const now = open?.[k] ? 1 : 0
      if (was !== now) await tx.bump(OPEN_COUNTERS[k], now - was)
    }
    item.open = open
    const find = live(item) ? `${archived(item) ? 'a' : 'l'}|${item.id}` : null
    if (item.find !== null && item.find !== find) tx.set('find', item.find, null)
    if (find !== null) {
      const shown = archived(item) ? (originalPath(item.path) ?? item.path) : item.path
      tx.set('find', find, { item: item.id, path: item.path, shown, texts: item.texts.join('\n'), scene: item.entered.scene, origin: item.origin, how: item.entered.how, bundle: item.bundle }, { scene: item.entered.scene, origin: item.origin.kind })
    }
    item.find = find
    const time = cls === null ? null : `${turned(item.last.at)}|${item.id}`
    if (item.time !== null && item.time !== time) tx.set('bytime', item.time, null)
    if (time !== null) tx.set('bytime', time, { id: item.id }, { show: cls as string, ...(cls === 'archived' ? {} : { live: 'y' }) })
    item.time = time
    putItem(tx, item)
    this.out.remark.add(item.id)
  }

  private async staleNow(item: ItemRow): Promise<boolean> {
    for (const row of item.basis.items) if (row.item !== item.id && staleAsRecorded(row, await this.item(row.item))) return true
    return false
  }

  // ---- what every fact is counted as ----

  private async log(f: Fact): Promise<void> {
    const { tx } = this
    tx.set('log', newsKey(f), f, { who: f.actor.kind, scene: f.scene, ...(f.actor.kind === 'agent' ? { agent: f.actor.name } : {}), ...(mayBeNews(f) ? { news: 'y' } : {}) })
    await tx.bump('log', 1)
    await tx.bump(`log:who:${f.actor.kind}`, 1)
    if (f.actor.kind === 'agent') await tx.bump(`log:agent:${f.actor.name}`, 1)
  }

  private async count(f: Fact): Promise<void> {
    const { tx } = this
    const scene = f.kind === 'checked' ? undefined : await tx.get<SceneRow>('scenes', f.scene)
    const row = await hourRow(tx, f.at)
    // A session counts on the hour an agent first acted in it, under that agent; a look alone is no act.
    if (scene && !scene.started && f.actor.kind === 'agent') {
      scene.started = true
      tx.set('scenes', scene.id, scene)
      row.sessions[f.actor.name] = (row.sessions[f.actor.name] ?? 0) + 1
    }
    switch (f.kind) {
      case 'request':
        if (f.act === 'asked' && f.actor.kind === 'agent') {
          agentOf(row, f.actor.name).asked++
          tx.set('requests', f.request, { by: f.actor, hour: hourOf(f.at), outcome: 'pending' } satisfies RequestRow)
        } else if (f.act === 'withdrawn') {
          putHour(tx, row)
          await requestTo(tx, f.request, 'withdrawn')
          return
        }
        break
      case 'owner.op': {
        const decline = f.request ? null : requestOf(f)
        if (f.actor.kind === 'owner') {
          if (!f.readOnly) row.owner.commands++
          if (f.request) row.owner.approved++
          if (decline !== null) row.owner.declined++
        }
        putHour(tx, row)
        if (f.request) await requestTo(tx, f.request.id, f.refused === undefined ? 'approved' : 'refused')
        if (decline !== null) await requestTo(tx, decline, 'declined')
        return
      }
      case 'said':
        if (f.actor.kind === 'agent' && f.flavor !== 'doing') agentOf(row, f.actor.name)[f.flavor === 'decided' ? 'decided' : 'notes']++
        else if (f.actor.kind === 'owner') row.owner.said++
        break
      case 'item.revise':
        // Each direct change recorded counts, a claim that replaces one only seen as well.
        if (f.claimed) row.order.changes++
        break
      case 'item.move':
        if (f.archive !== null) row.order[f.archive === 'in' ? 'archived' : 'takenBack']++
        break
      case 'item.remove':
        row.order.purged++
        break
    }
    putHour(tx, row)
  }
}

/** A revise that names a basis replaces the rows for the same source items and adds the new ones. */
function mergeBasis(previous: Basis, next: Basis): Basis {
  const replaced = new Map(next.items.map((row) => [row.item, row]))
  const kept = previous.items.map((row) => replaced.get(row.item) ?? row)
  const added = next.items.filter((row) => !previous.items.some((p) => p.item === row.item))
  return { items: [...kept, ...added], outside: [...new Set([...previous.outside, ...next.outside])] }
}

