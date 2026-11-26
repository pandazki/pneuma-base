// The ledger's state as rows in its record place, derived from the facts one step at a time: read the
// facts after the saved cursor, fold them into the rows, save the changed rows and the new cursor in one
// commit (tmp/run-7 STORAGE.md section 5). The rows keep what start, check and the home page ask about;
// `fold` over every fact stays for the pages not rebuilt yet, and a test keeps the two in agreement.
import { regionOf, type Fingerprint, type Instant, type LibraryPath, type Place, type PluginContext, type Row } from '@pneuma-base/kernel'
import { factsSince, type Basis, type Fact, type FactActor, type How, type ItemId, type LedgerOrigin, type SceneId } from './facts.js'
import { actorKey, inOrder, NO_BASIS, type LedgerLike, type OriginLike } from './fold.js'
import { QUIET_OWNER_COMMANDS, toldByItsCommand } from './views.js'

/** An item as the rows keep it: what its state, its line in check and its find need. */
export type Slim = {
  id: ItemId
  path: LibraryPath
  holds: boolean // its path names it; false only when another item took the path since
  fingerprint: Fingerprint
  size: number
  origin: OriginLike
  basis: Basis
  entered: { how: How; scene: SceneId; at: Instant; actor: FactActor }
  unknownOrigin: boolean
  removed: boolean
  bundle: boolean
  absorbedInto: ItemId | null
  last: { how: How; claimed: boolean } // of the version that gave `fingerprint`
  texts: string[] // what find matches besides the path: what was said about it, the notes of its puts, where it came from
}

export type SlimSaid = { flavor: 'doing' | 'decided' | 'note'; text: string; at: Instant }
export type SlimScene = { id: SceneId; first: Instant; last: Instant; actors: FactActor[]; cwds: string[]; said: SlimSaid[]; ops: { command: string; actor: FactActor }[] }
export type ActorRow = { actor: FactActor; first: Instant; checked: Instant | null; last: { scene: SceneId; at: Instant }; other: { scene: SceneId; at: Instant } | null }

export type LedgerState = {
  cursor: string | null
  items: Map<ItemId, Slim>
  paths: Map<LibraryPath, ItemId>
  alias: Map<ItemId, ItemId>
  dirs: Map<Place, number> // the open directories: how many registered things lie at some depth below each
  actors: Map<string, ActorRow>
  left: Set<LibraryPath>
  scenes: Map<SceneId, SlimScene> // only the scenes read or touched in this process
}

/** What one fold changed: the rows to write, and the items and paths its facts named. */
export type Folded = { rows: Record<string, Row[]>; items: Set<ItemId>; paths: Set<LibraryPath> }
type Named = Pick<Folded, 'items' | 'paths'>

/** The items and paths a fact names, which a look made before it was folded must not judge. */
function nameInto(named: Named, f: Fact): void {
  if ('item' in f) named.items.add(f.item)
  if (f.kind === 'item.enter') named.paths.add(f.path)
  if (f.kind === 'item.move') for (const path of [f.from, f.to]) named.paths.add(path)
  if (f.kind === 'items.enter') {
    for (const e of f.items) {
      named.items.add(e.item)
      named.paths.add(e.path)
    }
  }
}

export const emptyState = (): LedgerState => ({ cursor: null, items: new Map(), paths: new Map(), alias: new Map(), dirs: new Map(), actors: new Map(), left: new Set(), scenes: new Map() })

/** The origin a row keeps: a made one's basis is the item's `basis` already. */
const lean = (origin: LedgerOrigin): OriginLike => (origin.kind === 'made' ? { kind: 'made' } : origin)

/** How many texts of an item find keeps, and how long each. */
const TEXTS = 12
const TEXT_LENGTH = 300
/** How many of each kind of sentence a scene keeps. */
const SAID_KEPT = 8

const ancestors = (path: LibraryPath): Place[] => {
  const parts = path.split('/')
  const out: Place[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** A key that sorts the latest fact first: the digits of its moment turned around, then its id. */
export function newsKey(f: Pick<Fact, 'at' | 'id'>): string {
  const turned = f.at.replace(/[^0-9]/g, '').replace(/[0-9]/g, (d) => String(9 - Number(d)))
  return `${turned}|${f.id}`
}

/** Whether a fact can be news to anyone: setup commands are judged against each reader when asked. */
export const mayBeNews = (f: Fact) => f.kind !== 'checked' && !toldByItsCommand(f) && !(f.kind === 'owner.op' && (QUIET_OWNER_COMMANDS.has(f.command) || f.readOnly))

const counts = (item: Slim) => !item.removed && item.absorbedInto === null

/**
 * Folds facts into the state, as `fold` would take them after the ones already folded, and answers the
 * rows that changed. `seen` holds the ids already folded that this batch must not take again.
 */
export function foldInto(state: LedgerState, input: readonly Fact[], seen: ReadonlySet<string>): Folded {
  const touched = { items: new Map<ItemId, Slim>(), scenes: new Map<SceneId, SlimScene>(), actors: new Set<string>(), dirs: new Set<Place>(), alias: new Map<ItemId, ItemId>(), left: new Set<LibraryPath>() }
  const news: Row[] = []
  const ids: Row[] = []
  const named = { items: new Set<ItemId>(), paths: new Set<LibraryPath>() }
  const resolve = (id: ItemId) => state.alias.get(id) ?? id
  const dirty = (item: Slim) => touched.items.set(item.id, item)
  const bump = (path: LibraryPath, by: number) => {
    for (const dir of ancestors(path)) {
      state.dirs.set(dir, (state.dirs.get(dir) ?? 0) + by)
      touched.dirs.add(dir)
    }
  }
  const take = (path: LibraryPath, id: ItemId) => {
    const holder = state.paths.get(path)
    if (holder !== undefined && holder !== id) {
      const other = state.items.get(holder)
      if (other) dirty(Object.assign(other, { holds: false }))
    }
    state.paths.set(path, id)
  }
  const release = (item: Slim) => {
    if (state.paths.get(item.path) === item.id) state.paths.delete(item.path)
    item.holds = false
  }
  const addText = (item: Slim, text: string | null | undefined) => {
    if (!text || item.texts.includes(text) || item.texts.length >= TEXTS) return
    item.texts.push(text.slice(0, TEXT_LENGTH))
  }
  const absorbedBy = (id: ItemId) => [...state.items.values()].filter((other) => other.absorbedInto === id)
  const relocate = (item: Slim, to: LibraryPath) => {
    const from = item.path
    if (counts(item)) bump(from, -1)
    release(item)
    item.path = to
    item.holds = true
    take(to, item.id)
    if (counts(item)) bump(to, 1)
    dirty(item)
    if (item.bundle) for (const other of absorbedBy(item.id)) relocate(other, `${to}${other.path.slice(from.length)}` as LibraryPath)
  }
  const remove = (item: Slim) => {
    if (counts(item)) bump(item.path, -1)
    item.removed = true
    release(item)
    dirty(item)
    if (item.bundle) for (const other of absorbedBy(item.id)) remove(other)
  }
  const scene = (f: Fact): SlimScene => {
    const known = state.scenes.get(f.scene) ?? { id: f.scene, first: f.at, last: f.at, actors: [], cwds: [], said: [], ops: [] }
    state.scenes.set(f.scene, known)
    touched.scenes.set(f.scene, known)
    return known
  }
  const actorRow = (f: Fact) => {
    const key = actorKey(f.actor)
    const row = state.actors.get(key)
    if (!row) state.actors.set(key, { actor: f.actor, first: f.at, checked: f.kind === 'checked' ? f.at : null, last: { scene: f.scene, at: f.at }, other: null })
    else {
      if (row.last.scene === f.scene) row.last.at = f.at
      else Object.assign(row, { other: row.last, last: { scene: f.scene, at: f.at } })
      if (f.kind === 'checked') row.checked = f.at
    }
    touched.actors.add(key)
  }
  const apply = (f: Fact) => {
    if (f.kind === 'checked') return
    const s = scene(f)
    s.last = f.at
    if (!s.actors.some((a) => actorKey(a) === actorKey(f.actor))) s.actors.push(f.actor)
    if (f.where?.cwd && !s.cwds.includes(f.where.cwd)) s.cwds.push(f.where.cwd)
    const item = 'item' in f ? state.items.get(f.item) : undefined
    nameInto(named, f)
    switch (f.kind) {
      case 'item.enter': {
        if (item) {
          const seenOnly = item.entered.how === 'observed'
          if (f.origin.kind !== 'adopted' && (item.unknownOrigin || (seenOnly && f.how !== 'observed'))) {
            Object.assign(item, { origin: lean(f.origin), basis: f.origin.kind === 'made' ? f.origin.basis : NO_BASIS, unknownOrigin: false, entered: { how: f.how, scene: f.scene, at: f.at, actor: f.actor } })
            if (f.origin.kind === 'brought') addText(item, f.origin.source)
          }
          addText(item, f.note)
          dirty(item)
          return
        }
        const fresh: Slim = {
          id: f.item,
          path: f.path,
          holds: true,
          fingerprint: f.fingerprint,
          size: f.size,
          origin: lean(f.origin),
          basis: f.origin.kind === 'made' ? f.origin.basis : NO_BASIS,
          entered: { how: f.how, scene: f.scene, at: f.at, actor: f.actor },
          unknownOrigin: f.origin.kind === 'adopted',
          removed: false,
          bundle: f.bundle === true,
          absorbedInto: null,
          last: { how: f.how, claimed: false },
          texts: [],
        }
        if (f.origin.kind === 'brought') addText(fresh, f.origin.source)
        addText(fresh, f.note)
        state.items.set(fresh.id, fresh)
        take(f.path, fresh.id)
        bump(f.path, 1)
        dirty(fresh)
        if (fresh.bundle) {
          for (const other of state.items.values()) {
            if (other.id !== fresh.id && counts(other) && other.path.startsWith(`${f.path}/`)) {
              bump(other.path, -1)
              other.absorbedInto = fresh.id
              dirty(other)
            }
          }
        }
        return
      }
      case 'item.revise': {
        if (!item) return
        if (f.claimed && item.fingerprint === f.fingerprint) {
          if (item.last.how === 'observed' && f.how !== 'observed') dirty(Object.assign(item, { last: { how: f.how, claimed: true } }))
          return
        }
        Object.assign(item, { fingerprint: f.fingerprint, size: f.size, basis: f.basis ? mergeBasis(item.basis, f.basis) : item.basis, last: { how: f.how, claimed: f.claimed } })
        addText(item, f.note)
        dirty(item)
        return
      }
      case 'item.move':
        if (item) relocate(item, f.to)
        return
      case 'item.basis':
        if (item) dirty(Object.assign(item, { basis: f.basis, unknownOrigin: false }))
        return
      case 'item.remove':
        if (item) remove(item)
        return
      case 'said': {
        const kept = s.said.filter((x) => x.flavor === f.flavor)
        if (!kept.some((x) => x.text === f.text) && kept.length < SAID_KEPT) s.said.push({ flavor: f.flavor, text: f.text, at: f.at })
        const about = f.about === null ? undefined : state.items.get(f.about)
        if (about) {
          addText(about, f.text)
          dirty(about)
        }
        return
      }
      case 'owner.op':
        if (!s.ops.some((op) => op.command === f.command && actorKey(op.actor) === actorKey(f.actor))) s.ops.push({ command: f.command, actor: f.actor })
        return
      case 'unowned.left':
        for (const path of f.paths) {
          state.left.add(path)
          touched.left.add(path)
        }
        return
    }
  }
  const step = (raw: Fact) => {
    if (raw.kind === 'item.enter') {
      const holder = state.paths.get(raw.path)
      // Two enters claimed the same path: the later item is an alias of the earlier one.
      if (holder !== undefined && holder !== raw.item) {
        state.alias.set(raw.item, holder)
        touched.alias.set(raw.item, holder)
      }
    }
    const f = resolved(raw, resolve)
    apply(f)
    return f
  }
  const fresh = new Set<string>()
  for (const raw of inOrder(input)) {
    if (seen.has(raw.id) || fresh.has(raw.id)) continue
    fresh.add(raw.id)
    ids.push({ key: raw.id, value: 1 })
    actorRow(raw)
    if (raw.kind === 'items.enter') {
      const { items, origin, ...envelope } = raw
      for (const e of items) step({ ...envelope, kind: 'item.enter', ...e, origin })
    }
    const kept = raw.kind === 'items.enter' ? raw : step(raw)
    if (mayBeNews(kept)) news.push({ key: newsKey(kept), value: kept })
  }
  const rows: Record<string, Row[]> = {
    items: [...touched.items.values()].map((item) => ({ key: item.id, value: item })),
    scenes: [...touched.scenes.values()].map((s) => ({ key: s.id, value: s })),
    actors: [...touched.actors].map((key) => ({ key, value: state.actors.get(key) })),
    dirs: [...touched.dirs].map((dir) => ({ key: dir, value: (state.dirs.get(dir) ?? 0) > 0 ? state.dirs.get(dir) : null })),
    alias: [...touched.alias].map(([key, value]) => ({ key, value })),
    left: [...touched.left].map((key) => ({ key, value: 1 })),
    news,
    ids,
  }
  for (const [dir, n] of state.dirs) if (n <= 0) state.dirs.delete(dir)
  return { rows, ...named }
}

/** The fact with every item it names, itself or in a basis, taken through the aliases; as `fold` does. */
function resolved(f: Fact, resolve: (id: ItemId) => ItemId): Fact {
  const basis = (b: Basis): Basis => ({ ...b, items: b.items.map((row) => ({ ...row, item: resolve(row.item) })) })
  switch (f.kind) {
    case 'said':
      return f.about === null ? f : { ...f, about: resolve(f.about) }
    case 'owner.op':
    case 'request':
    case 'checked':
    case 'items.enter':
    case 'unowned.left':
      return f
    case 'item.enter':
      return { ...f, item: resolve(f.item), origin: f.origin.kind === 'made' ? { ...f.origin, basis: basis(f.origin.basis) } : f.origin }
    case 'item.revise':
      return { ...f, item: resolve(f.item), ...(f.basis ? { basis: basis(f.basis) } : {}) }
    case 'item.basis':
      return { ...f, item: resolve(f.item), basis: basis(f.basis) }
    default:
      return { ...f, item: resolve(f.item) }
  }
}

function mergeBasis(previous: Basis, next: Basis): Basis {
  const replaced = new Map(next.items.map((row) => [row.item, row]))
  const kept = previous.items.map((row) => replaced.get(row.item) ?? row)
  const added = next.items.filter((row) => !previous.items.some((p) => p.item === row.item))
  return { items: [...kept, ...added], outside: [...new Set([...previous.outside, ...next.outside])] }
}

// ---- the rows in storage ----

const PAGE = 10000

async function all<V>(ctx: PluginContext, table: string): Promise<Row<V>[]> {
  const out: Row<V>[] = []
  let after: string | undefined
  for (;;) {
    const page = await ctx.tools.storage.records.under<V>(table, '', { limit: PAGE, ...(after === undefined ? {} : { after }) })
    out.push(...page.rows)
    if (page.more === null) return out
    after = page.more.after
  }
}

/** The state as the rows hold it, scenes aside: they are read when asked for. */
/** The shape of the rows; rows of another shape are derived again from the facts. */
const ROWS_VERSION = 1

async function loaded(ctx: PluginContext): Promise<LedgerState> {
  const { rows, cursor } = await ctx.tools.storage.records.get<number>('meta', ['version'])
  const state = emptyState()
  if (cursor === null) return state
  if (rows[0]?.value !== ROWS_VERSION) {
    await ctx.tools.storage.records.reset()
    return state
  }
  const [items, dirs, alias, actors, left] = await Promise.all([all<Slim>(ctx, 'items'), all<number>(ctx, 'dirs'), all<ItemId>(ctx, 'alias'), all<ActorRow>(ctx, 'actors'), all<number>(ctx, 'left')])
  state.cursor = cursor
  for (const { value } of items) {
    state.items.set(value.id, value)
    if (value.holds) state.paths.set(value.path, value.id)
  }
  for (const { key, value } of dirs) state.dirs.set(key, value)
  for (const { key, value } of alias) state.alias.set(key as ItemId, value)
  for (const { value } of actors) state.actors.set(actorKey(value.actor), value)
  for (const { key } of left) state.left.add(key as LibraryPath)
  return state
}

/** The state this process holds, by the ledger directory it is of. */
const held = new Map<string, LedgerState>()

/**
 * The ledger's state now: the rows, with the facts after their cursor folded in and saved. Answers the
 * items and paths named by the facts after the state this process held when called, which a look that
 * came before them must not judge, whichever process folded them.
 */
export async function stateOf(ctx: PluginContext): Promise<{ state: LedgerState; named: Named }> {
  const records = ctx.tools.storage.records
  const named: Named = { items: new Set<ItemId>(), paths: new Set<LibraryPath>() }
  let start: string | null | undefined
  // Another process folded some of the facts after `start` first: name them all from the facts.
  const answer = async (state: LedgerState) => {
    if (start !== undefined && start !== state.cursor) for (const f of (await factsSince(ctx, start))?.facts ?? []) nameInto(named, f)
    return { state, named }
  }
  for (let tries = 0; ; tries++) {
    const state = held.get(ctx.dir) ?? (await loaded(ctx))
    if (start === undefined) start = state.cursor
    const batch = await factsSince(ctx, state.cursor)
    if (batch === null) {
      // The facts the rows came from are not there any more: derive everything again.
      await records.reset()
      held.set(ctx.dir, emptyState())
      continue
    }
    if (batch.facts.length === 0) {
      held.set(ctx.dir, state)
      return answer(state)
    }
    const seen = state.cursor === null ? new Set<string>() : new Set((await records.get('ids', batch.facts.map((f) => f.id))).rows.map((r) => r.key))
    const before = state.cursor
    await loadScenes(ctx, state, batch.facts.map((f) => f.scene))
    const folded = foldInto(state, batch.facts, seen)
    if (before === null) folded.rows.meta = [{ key: 'version', value: ROWS_VERSION }]
    const put = await records.put(folded.rows, { cursor: batch.cursor, expect: before })
    if (!put.written) {
      // Another process folded the same facts first: take its rows.
      held.delete(ctx.dir)
      if (tries > 5) throw new Error('记账插件的行一直在被别的进程改写，没能读到一致的状态')
      continue
    }
    for (const id of folded.items) named.items.add(id)
    for (const path of folded.paths) named.paths.add(path)
    if (start === before) start = batch.cursor
    state.cursor = batch.cursor
    held.set(ctx.dir, state)
    return answer(state)
  }
}

/** Reads the scenes not yet held. */
export async function loadScenes(ctx: PluginContext, state: LedgerState, ids: readonly SceneId[]): Promise<void> {
  const wanted = [...new Set(ids)].filter((id) => !state.scenes.has(id))
  if (wanted.length === 0 || state.cursor === null) return
  for (const { value } of (await ctx.tools.storage.records.get<SlimScene>('scenes', wanted)).rows) state.scenes.set(value.id, value)
}

/** Every scene, for a find over what was said in them. */
export async function allScenes(ctx: PluginContext, state: LedgerState): Promise<SlimScene[]> {
  for (const { value } of await all<SlimScene>(ctx, 'scenes')) if (!state.scenes.has(value.id)) state.scenes.set(value.id, value)
  return [...state.scenes.values()]
}

/** The rows as the reads written for the folded ledger take them. */
export function ledgerOf(state: LedgerState): LedgerLike {
  return { items: state.items, scenes: state.scenes, ownerOps: [...state.scenes.values()].flatMap((s) => s.ops.map((op) => ({ scene: s.id, ...op }))) }
}

/** The items that count as registered things now: not removed, not part of a bundle. */
export const liveItems = (state: LedgerState): Slim[] => [...state.items.values()].filter(counts)

/** Whether an item is in the archive. */
export const archived = (item: { path: LibraryPath }) => regionOf(item.path) === 'archive'

/**
 * The open directories as the rows last saved them, without folding the facts after: what the
 * management UI's change poll looks at. A new fact moves the cursor, which the poll sees first.
 */
export async function openDirsNow(ctx: PluginContext): Promise<LibraryPath[]> {
  return (await all<number>(ctx, 'dirs')).map((r) => r.key as LibraryPath)
}
