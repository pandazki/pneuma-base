// fold: facts in, the ledger out. Pure; reads no disk. ledger-design.md section 3.
import { regionOf, type Fingerprint, type Instant, type LibraryPath } from '@pneuma-base/kernel'
import type { Basis, Fact, FactActor, How, ItemId, LedgerOrigin, SceneId } from './facts.js'

export type Said = Extract<Fact, { kind: 'said' }>
export type OwnerOp = Extract<Fact, { kind: 'owner.op' }>

export type Version = { fingerprint: Fingerprint; at: Instant; scene: SceneId; actor: FactActor; how: How; held: string | null; claimed: boolean }

export type ItemRecord = {
  id: ItemId
  path: LibraryPath // from the latest enter or move
  fingerprint: Fingerprint // from the latest enter or revise
  size: number
  origin: LedgerOrigin
  entered: Extract<Fact, { kind: 'item.enter' }>
  basis: Basis // of the current snapshot
  unknownOrigin: boolean // adopted, and no origin or basis given since
  versions: Version[]
  removed: boolean
  said: Said[] // notes and decisions about it, from any scene
}

export type SceneRecord = {
  id: SceneId
  first: Instant
  last: Instant
  actors: FactActor[]
  cwds: string[]
  said: Said[]
  items: ItemId[] // entered, revised, moved or given a basis here, in order
}

export type Ledger = {
  facts: Fact[] // by (at, id), item references resolved through aliases
  items: Map<ItemId, ItemRecord>
  pathIndex: Map<LibraryPath, ItemId> // current paths of the items not removed
  scenes: Map<SceneId, SceneRecord>
  ownerOps: OwnerOp[]
}

export const NO_BASIS: Basis = { items: [], outside: [] }

export const actorKey = (a: FactActor) => `${a.kind}:${a.name}:${a.grant ?? ''}`

export const isArchived = (item: ItemRecord) => regionOf(item.path) === 'archive'

const byTime = (a: Fact, b: Fact) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function fold(input: readonly Fact[]): Ledger {
  const ledger: Ledger = { facts: [], items: new Map(), pathIndex: new Map(), scenes: new Map(), ownerOps: [] }
  const alias = new Map<ItemId, ItemId>()
  const resolve = (id: ItemId) => alias.get(id) ?? id
  for (const raw of [...input].sort(byTime)) {
    let f = raw
    if (f.kind === 'item.enter') {
      const holder = ledger.pathIndex.get(f.path)
      // Two enters claimed the same path: the later item is an alias of the earlier one.
      if (holder !== undefined && holder !== f.item) alias.set(f.item, holder)
    }
    f = resolved(f, resolve)
    apply(ledger, f)
    ledger.facts.push(f)
  }
  return ledger
}

/** The fact with every item it names, itself or in a basis, taken through the aliases. */
function resolved(f: Fact, resolve: (id: ItemId) => ItemId): Fact {
  const basis = (b: Basis): Basis => ({ ...b, items: b.items.map((row) => ({ ...row, item: resolve(row.item) })) })
  switch (f.kind) {
    case 'said':
      return f.about === null ? f : { ...f, about: resolve(f.about) }
    case 'owner.op':
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

function apply(ledger: Ledger, f: Fact): void {
  touchScene(ledger, f)
  const item = 'item' in f ? ledger.items.get(f.item) : undefined
  switch (f.kind) {
    case 'item.enter':
      if (item) {
        // An alias that knows where the thing came from fills in an adopted item's origin.
        if (item.unknownOrigin && f.origin.kind !== 'adopted') Object.assign(item, { origin: f.origin, basis: basisOf(f.origin), unknownOrigin: false })
        return
      }
      ledger.items.set(f.item, {
        id: f.item,
        path: f.path,
        fingerprint: f.fingerprint,
        size: f.size,
        origin: f.origin,
        entered: f,
        basis: basisOf(f.origin),
        unknownOrigin: f.origin.kind === 'adopted',
        versions: [version(f, null, false)],
        removed: false,
        said: [],
      })
      ledger.pathIndex.set(f.path, f.item)
      return
    case 'item.revise':
      if (!item) return
      Object.assign(item, { fingerprint: f.fingerprint, size: f.size, basis: f.basis ? mergeBasis(item.basis, f.basis) : item.basis })
      item.versions.push(version(f, f.held, f.claimed))
      return
    case 'item.move':
      if (!item) return
      if (ledger.pathIndex.get(item.path) === item.id) ledger.pathIndex.delete(item.path)
      item.path = f.to
      ledger.pathIndex.set(f.to, item.id)
      return
    case 'item.basis':
      if (!item) return
      Object.assign(item, { basis: f.basis, unknownOrigin: false })
      return
    case 'item.remove':
      if (!item) return
      item.removed = true
      if (ledger.pathIndex.get(item.path) === item.id) ledger.pathIndex.delete(item.path)
      return
    case 'said':
      ledger.scenes.get(f.scene)?.said.push(f)
      if (f.about !== null) ledger.items.get(f.about)?.said.push(f)
      return
    case 'owner.op':
      ledger.ownerOps.push(f)
      return
  }
}

function touchScene(ledger: Ledger, f: Fact): void {
  let scene = ledger.scenes.get(f.scene)
  if (!scene) {
    scene = { id: f.scene, first: f.at, last: f.at, actors: [], cwds: [], said: [], items: [] }
    ledger.scenes.set(f.scene, scene)
  }
  scene.last = f.at
  if (!scene.actors.some((a) => actorKey(a) === actorKey(f.actor))) scene.actors.push(f.actor)
  if (f.where?.cwd && !scene.cwds.includes(f.where.cwd)) scene.cwds.push(f.where.cwd)
  if ('item' in f && f.kind !== 'item.remove' && !scene.items.includes(f.item)) scene.items.push(f.item)
}

function version(f: Fact & { fingerprint: Fingerprint }, held: string | null, claimed: boolean): Version {
  return { fingerprint: f.fingerprint, at: f.at, scene: f.scene, actor: f.actor, how: f.how, held, claimed }
}

const basisOf = (origin: LedgerOrigin): Basis => (origin.kind === 'made' ? origin.basis : NO_BASIS)

/** A revise that names a basis replaces the rows for the same source items and adds the new ones. */
function mergeBasis(previous: Basis, next: Basis): Basis {
  const replaced = new Map(next.items.map((row) => [row.item, row]))
  const kept = previous.items.map((row) => replaced.get(row.item) ?? row)
  const added = next.items.filter((row) => !previous.items.some((p) => p.item === row.item))
  return { items: [...kept, ...added], outside: [...new Set([...previous.outside, ...next.outside])] }
}
