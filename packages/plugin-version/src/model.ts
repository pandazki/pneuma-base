// The declared things and their versions, folded from the facts. Pure: no disk.
import { archivedPath, regionOf, type Fingerprint, type Instant, type LibraryPath } from '@pneuma-base/kernel'
import type { Fact, FactId, Manifest, ThingId, Via, Who } from './facts.js'

/**
 * `n` counts every version of the thing in order, pruned ones too, so a number never changes.
 * `same`: the latest earlier version with the same content. `pruned`: its content was dropped.
 */
export type Version = {
  id: FactId
  n: number
  at: Instant
  by: Who
  path: LibraryPath
  fingerprint: Fingerprint
  manifest: Manifest
  via: Via
  note: string | null
  same: number | null
  pruned: boolean
}

/** A thing declared versioned, at its current library path. `gone`: the owner deleted it from the library. */
export type Thing = { id: ThingId; path: LibraryPath; gone: boolean; versions: Version[] }

/** `at` indexes the things that are in the library by their path. */
export type Model = { things: Map<ThingId, Thing>; at: Map<LibraryPath, ThingId> }

export function fold(facts: readonly Fact[]): Model {
  const model: Model = { things: new Map(), at: new Map() }
  for (const f of [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) step(model, f)
  return model
}

/** Applies one fact. A fact about a thing never declared is ignored, and so is a second declaration of one. */
export function step(model: Model, f: Fact): void {
  if (f.kind === 'declare') {
    if (model.things.has(f.thing)) return
    model.things.set(f.thing, { id: f.thing, path: f.path, gone: false, versions: [] })
    model.at.set(f.path, f.thing)
    return
  }
  const thing = model.things.get(f.thing)
  if (!thing) return
  switch (f.kind) {
    case 'version': {
      const same = thing.versions.findLast((v) => v.fingerprint === f.fingerprint)?.n ?? null
      const { id, at, by, path, fingerprint, manifest, via } = f
      thing.versions.push({ id, n: thing.versions.length + 1, at, by, path, fingerprint, manifest, via, note: null, same, pruned: false })
      return
    }
    case 'note': {
      const version = thing.versions.find((v) => v.id === f.version)
      if (version) version.note = f.text
      return
    }
    case 'move':
      unindex(model, thing)
      thing.path = f.to
      if (!thing.gone) model.at.set(thing.path, thing.id)
      return
    case 'gone':
      unindex(model, thing)
      thing.gone = true
      return
    case 'prune': {
      const dropped = new Set(f.versions)
      for (const v of thing.versions) if (dropped.has(v.id)) v.pruned = true
      return
    }
  }
}

function unindex(model: Model, thing: Thing): void {
  if (model.at.get(thing.path) === thing.id) model.at.delete(thing.path)
}

/** The newest version whose content is kept: what a put over the thing must already have recorded. */
export function latest(thing: Thing): Version | undefined {
  return thing.versions.findLast((v) => !v.pruned)
}

/** The thing declared at exactly this library path: what a put, a move or an archive there acts on. */
export function declaredExactly(model: Model, path: LibraryPath): Thing | undefined {
  const id = model.at.get(path)
  return id === undefined ? undefined : model.things.get(id)
}

/** The thing a reader names by a library path: declared there, or at its archived copy. */
export function declaredAt(model: Model, path: LibraryPath): Thing | undefined {
  return declaredExactly(model, path) ?? (regionOf(path) === 'content' ? declaredExactly(model, archivedPath(path)) : undefined)
}

/** Every sha256 some kept version of some thing still needs. */
export function neededContent(model: Model): Set<Fingerprint> {
  const out = new Set<Fingerprint>()
  for (const thing of model.things.values()) for (const v of thing.versions) if (!v.pruned) for (const row of v.manifest.rows) out.add(row.fingerprint)
  return out
}
