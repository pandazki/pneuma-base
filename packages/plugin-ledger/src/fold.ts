// fold: facts in, the ledger out. Pure; reads no disk. ledger-design.md section 3.
import { regionOf, type Fingerprint, type Instant, type LibraryPath, type Transcript } from '@pneuma-base/kernel'
import type { Basis, Fact, FactActor, How, ItemId, LedgerOrigin, SceneId } from './facts.js'

export type Said = Extract<Fact, { kind: 'said' }>
export type OwnerOp = Extract<Fact, { kind: 'owner.op' }>

export type Enter = Extract<Fact, { kind: 'item.enter' }>

/** `seen`: the claim was first only seen (how 'observed'), by this actor at this time, before somebody said who changed it. */
export type Version = {
  fingerprint: Fingerprint
  at: Instant
  scene: SceneId
  actor: FactActor
  how: How
  held: string | null
  claimed: boolean
  by: 'owner' | null
  note: string | null
  seen: { at: Instant; actor: FactActor } | null
}

export type ItemRecord = {
  id: ItemId
  path: LibraryPath // from the latest enter or move
  fingerprint: Fingerprint // from the latest enter or revise
  size: number
  origin: LedgerOrigin
  entered: Enter // the enter that gave the current origin: the first one, or the one that replaced an origin nobody knew or that was only seen
  earlier: Enter[] // the enters whose origin a later one replaced, oldest first
  basis: Basis // of the current snapshot
  unknownOrigin: boolean // adopted, and no origin or basis given since
  versions: Version[]
  removed: boolean
  said: Said[] // notes and decisions about it, from any scene
  bundle: boolean // a marked directory
  absorbedInto: ItemId | null // the bundle entered later around its path; it moves and goes with that bundle
}

export type SceneRecord = {
  id: SceneId
  first: Instant
  last: Instant
  actors: FactActor[]
  cwds: string[]
  transcript: (Transcript & { machine: string }) | null // the last pointer the scene's facts carry
  said: Said[]
  items: ItemId[] // entered, revised, moved or given a basis here, in order
}

export type Ledger = {
  facts: Fact[] // by (at, id), item references resolved through aliases
  items: Map<ItemId, ItemRecord>
  pathIndex: Map<LibraryPath, ItemId> // current paths of the items not removed
  scenes: Map<SceneId, SceneRecord>
  ownerOps: OwnerOp[]
  left: Set<LibraryPath> // things nobody registered that the owner chose to leave so, not to be asked about again
}

/**
 * What the reads rebuilt on rows need of the ledger: items by id, the scenes they ask about, and those
 * scenes' owner operations. The folded `Ledger` gives it, and so do the ledger's rows (state.ts).
 */
/** An origin as the reads of an item need it: a made one without the basis it was made from, which `basis` carries. */
export type OriginLike = Exclude<LedgerOrigin, { kind: 'made' }> | { kind: 'made' }
export type ItemLike = Pick<ItemRecord, 'id' | 'path' | 'fingerprint' | 'size' | 'basis' | 'unknownOrigin' | 'removed' | 'bundle' | 'absorbedInto'> & {
  origin: OriginLike
  entered: Pick<Enter, 'how' | 'scene' | 'at' | 'actor'>
}
export type SceneLike = Pick<SceneRecord, 'id' | 'first' | 'last' | 'actors' | 'cwds'> & { said: readonly Pick<Said, 'flavor' | 'text' | 'at'>[] }
export type LedgerLike = { items: ReadonlyMap<ItemId, ItemLike>; scenes: ReadonlyMap<SceneId, SceneLike>; ownerOps: readonly Pick<OwnerOp, 'scene' | 'command' | 'actor'>[] }

export const NO_BASIS: Basis = { items: [], outside: [] }

export const actorKey = (a: FactActor) => `${a.kind}:${a.name}:${a.grant ?? ''}`

export const isArchived = (item: { path: LibraryPath }) => regionOf(item.path) === 'archive'

const byTime = (a: Fact, b: Fact) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The enters an `items.enter` stands for, one per thing, each carrying the act's envelope. */
function entersOf(f: Extract<Fact, { kind: 'items.enter' }>): Enter[] {
  const { items, origin, ...envelope } = f
  return items.map((e) => ({ ...envelope, kind: 'item.enter', ...e, origin }))
}

/** The facts in the order the fold takes them: by time, then by id. */
export const inOrder = (input: readonly Fact[]): Fact[] => [...input].sort(byTime)

/**
 * The fold one fact at a time, for a reader that wants the ledger as it stood between facts: `take`
 * each fact in `inOrder`, and it answers the fact as the ledger keeps it, items named through aliases.
 */
export function folding(): { ledger: Ledger; take(raw: Fact): Fact } {
  const ledger: Ledger = { facts: [], items: new Map(), pathIndex: new Map(), scenes: new Map(), ownerOps: [], left: new Set() }
  const alias = new Map<ItemId, ItemId>()
  const resolve = (id: ItemId) => alias.get(id) ?? id
  const sceneItems = new Map<SceneId, Set<ItemId>>()
  const step = (f: Fact) => {
    if (f.kind === 'item.enter') {
      const holder = ledger.pathIndex.get(f.path)
      // Two enters claimed the same path: the later item is an alias of the earlier one.
      if (holder !== undefined && holder !== f.item) alias.set(f.item, holder)
    }
    const g = resolved(f, resolve)
    apply(ledger, g, sceneItems)
    return g
  }
  const take = (raw: Fact) => {
    // Many things entered in one act: each is entered as by its own enter, and the act stays one fact.
    if (raw.kind === 'items.enter') entersOf(raw).forEach(step)
    const kept = raw.kind === 'items.enter' ? raw : step(raw)
    ledger.facts.push(kept)
    return kept
  }
  return { ledger, take }
}

export function fold(input: readonly Fact[]): Ledger {
  const folder = folding()
  for (const raw of inOrder(input)) folder.take(raw)
  return folder.ledger
}

/** The fact with every item it names, itself or in a basis, taken through the aliases. */
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

function apply(ledger: Ledger, f: Fact, sceneItems: Map<SceneId, Set<ItemId>>): void {
  // A look is no work in a scene: it only marks when its actor was last here.
  if (f.kind === 'checked') return
  touchScene(ledger, f, sceneItems)
  const item = 'item' in f ? ledger.items.get(f.item) : undefined
  switch (f.kind) {
    case 'item.enter':
      if (item) {
        // An alias that knows where the thing came from replaces an origin nobody knew, or one only
        // seen when it was said; an origin somebody said stays.
        const seen = item.entered.how === 'observed'
        if (f.origin.kind !== 'adopted' && (item.unknownOrigin || (seen && f.how !== 'observed'))) {
          item.earlier.push(item.entered)
          Object.assign(item, { origin: f.origin, basis: basisOf(f.origin), unknownOrigin: false, entered: f })
        }
        // Its note is about the content it registered, which an earlier fact recorded.
        const registered = item.versions.findLast((v) => v.fingerprint === f.fingerprint)
        if (f.note && registered && registered.note === null) registered.note = f.note
        return
      }
      ledger.items.set(f.item, {
        id: f.item,
        path: f.path,
        fingerprint: f.fingerprint,
        size: f.size,
        origin: f.origin,
        entered: f,
        earlier: [],
        basis: basisOf(f.origin),
        unknownOrigin: f.origin.kind === 'adopted',
        versions: [version(f)],
        removed: false,
        said: [],
        bundle: f.bundle === true,
        absorbedInto: null,
      })
      ledger.pathIndex.set(f.path, f.item)
      if (f.bundle) absorb(ledger, f.item, f.path)
      return
    case 'item.revise': {
      if (!item) return
      const last = item.versions.at(-1)
      if (f.claimed && last?.fingerprint === f.fingerprint) {
        // The content it has claimed again: a claim somebody makes replaces one only seen; a claim only seen changes nothing.
        if (last.how === 'observed' && f.how !== 'observed') item.versions[item.versions.length - 1] = { ...version(f), seen: { at: last.at, actor: last.actor } }
        return
      }
      Object.assign(item, { fingerprint: f.fingerprint, size: f.size, basis: f.basis ? mergeBasis(item.basis, f.basis) : item.basis })
      item.versions.push(version(f))
      return
    }
    case 'item.move':
      if (item) relocate(ledger, item, f.to)
      return
    case 'item.basis':
      if (!item) return
      Object.assign(item, { basis: f.basis, unknownOrigin: false })
      return
    case 'item.remove':
      if (item) remove(ledger, item)
      return
    case 'said':
      ledger.scenes.get(f.scene)?.said.push(f)
      if (f.about !== null) ledger.items.get(f.about)?.said.push(f)
      return
    case 'owner.op':
      ledger.ownerOps.push(f)
      return
    case 'unowned.left':
      for (const path of f.paths) ledger.left.add(path)
      return
  }
}

/** The items under `path` that no bundle absorbed yet are absorbed into the bundle `id` entered there. */
function absorb(ledger: Ledger, id: ItemId, path: LibraryPath): void {
  for (const other of ledger.items.values()) {
    if (other.id !== id && !other.removed && other.absorbedInto === null && other.path.startsWith(`${path}/`)) other.absorbedInto = id
  }
}

/** Only a bundle absorbs; asking only for bundles keeps a ledger of many moves linear. */
const absorbedBy = (ledger: Ledger, bundle: ItemRecord) => [...ledger.items.values()].filter((other) => other.absorbedInto === bundle.id)

/** Moves an item to `to`, and the items a bundle absorbed along with it. */
function relocate(ledger: Ledger, item: ItemRecord, to: LibraryPath): void {
  const from = item.path
  if (ledger.pathIndex.get(from) === item.id) ledger.pathIndex.delete(from)
  item.path = to
  ledger.pathIndex.set(to, item.id)
  if (item.bundle) for (const other of absorbedBy(ledger, item)) relocate(ledger, other, `${to}${other.path.slice(from.length)}` as LibraryPath)
}

/** Marks an item removed, and the items a bundle absorbed with it. */
function remove(ledger: Ledger, item: ItemRecord): void {
  item.removed = true
  if (ledger.pathIndex.get(item.path) === item.id) ledger.pathIndex.delete(item.path)
  if (item.bundle) for (const other of absorbedBy(ledger, item)) remove(ledger, other)
}

function touchScene(ledger: Ledger, f: Fact, sceneItems: Map<SceneId, Set<ItemId>>): void {
  let scene = ledger.scenes.get(f.scene)
  if (!scene) {
    scene = { id: f.scene, first: f.at, last: f.at, actors: [], cwds: [], transcript: null, said: [], items: [] }
    ledger.scenes.set(f.scene, scene)
    sceneItems.set(f.scene, new Set())
  }
  scene.last = f.at
  if (!scene.actors.some((a) => actorKey(a) === actorKey(f.actor))) scene.actors.push(f.actor)
  if (f.where?.cwd && !scene.cwds.includes(f.where.cwd)) scene.cwds.push(f.where.cwd)
  if (f.where?.transcript) scene.transcript = { ...f.where.transcript, machine: f.where.machine }
  const items = sceneItems.get(f.scene) as Set<ItemId>
  if ('item' in f && f.kind !== 'item.remove' && !items.has(f.item)) {
    items.add(f.item)
    scene.items.push(f.item)
  }
}

function version(f: Extract<Fact, { kind: 'item.enter' | 'item.revise' }>): Version {
  const revise = f.kind === 'item.revise' ? f : null
  return { fingerprint: f.fingerprint, at: f.at, scene: f.scene, actor: f.actor, how: f.how, held: revise?.held ?? null, claimed: revise?.claimed ?? false, by: revise?.by ?? null, note: f.note ?? null, seen: null }
}

const basisOf = (origin: LedgerOrigin): Basis => (origin.kind === 'made' ? origin.basis : NO_BASIS)

/** A revise that names a basis replaces the rows for the same source items and adds the new ones. */
function mergeBasis(previous: Basis, next: Basis): Basis {
  const replaced = new Map(next.items.map((row) => [row.item, row]))
  const kept = previous.items.map((row) => replaced.get(row.item) ?? row)
  const added = next.items.filter((row) => !previous.items.some((p) => p.item === row.item))
  return { items: [...kept, ...added], outside: [...new Set([...previous.outside, ...next.outside])] }
}
