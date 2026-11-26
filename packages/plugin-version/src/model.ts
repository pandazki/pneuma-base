// The declared things and their versions, folded from the facts. Pure: no storage.
import type { Fingerprint, Instant, LibraryPath, ManifestEntry, Place } from '@pneuma-base/kernel'
import type { Fact, FactId, ThingId, VersionFact, Via, Who } from './facts.js'

/**
 * Where a version's content lies in the plugin's own place. `file`: one object; `tree`: one directory;
 * `files`: a directory version recorded before storage, each file its own object.
 */
export type Kept = { kind: 'file'; size: number } | { kind: 'tree'; files: number; bytes: number } | { kind: 'files'; rows: ManifestEntry[] }

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
  kept: Kept
  via: Via
  note: string | null
  same: number | null
  pruned: boolean
}

/** A thing declared versioned, at its current library path. `gone`: the owner deleted it from the library. */
export type Thing = { id: ThingId; path: LibraryPath; gone: boolean; versions: Version[] }

export const objectPlace = (fingerprint: Fingerprint): Place => `objects/${fingerprint.slice(0, 2)}/${fingerprint}`
export const treePlace = (fingerprint: Fingerprint): Place => `trees/${fingerprint.slice(0, 2)}/${fingerprint}`

/** The places in the plugin's own place that hold a version's content. */
export function placesOf(v: Version): Place[] {
  if (v.kept.kind === 'file') return [objectPlace(v.fingerprint)]
  if (v.kept.kind === 'tree') return [treePlace(v.fingerprint)]
  return v.kept.rows.map((r) => objectPlace(r.fingerprint))
}

export const filesOf = (v: Version): number => (v.kept.kind === 'file' ? 1 : v.kept.kind === 'tree' ? v.kept.files : v.kept.rows.length)

function keptOf(f: VersionFact): Kept {
  if ('tree' in f) return { kind: 'tree', files: f.tree.files, bytes: f.tree.bytes }
  if (f.manifest.kind === 'file') return { kind: 'file', size: f.manifest.rows[0]?.size ?? 0 }
  return { kind: 'files', rows: f.manifest.rows }
}

/**
 * Applies one fact to the thing it is about, as it stands (undefined: not declared yet), and answers
 * the thing after it. A fact about a thing never declared is ignored, and so is a second declaration.
 */
export function step(thing: Thing | undefined, f: Fact): Thing | undefined {
  if (f.kind === 'declare') return thing ?? { id: f.thing, path: f.path, gone: false, versions: [] }
  if (!thing) return undefined
  switch (f.kind) {
    case 'version': {
      const same = thing.versions.findLast((v) => v.fingerprint === f.fingerprint)?.n ?? null
      const { id, at, by, path, fingerprint, via } = f
      thing.versions.push({ id, n: thing.versions.length + 1, at, by, path, fingerprint, kept: keptOf(f), via, note: null, same, pruned: false })
      break
    }
    case 'note': {
      const version = thing.versions.find((v) => v.id === f.version)
      if (version) version.note = f.text
      break
    }
    case 'move':
      thing.path = f.to
      break
    case 'gone':
      thing.gone = true
      break
    case 'prune': {
      const dropped = new Set(f.versions)
      for (const v of thing.versions) if (dropped.has(v.id)) v.pruned = true
      break
    }
  }
  return thing
}

const byId = (a: Fact, b: Fact) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Folds the facts, in id order, into the things they are about: `things` holds those known so far and gains those declared. */
export function fold(things: Map<ThingId, Thing>, facts: readonly Fact[]): void {
  for (const f of [...facts].sort(byId)) {
    const thing = step(things.get(f.thing), f)
    if (thing) things.set(f.thing, thing)
  }
}

/** The newest version whose content is kept: what a put over the thing must already have recorded. */
export function latest(thing: Thing): Version | undefined {
  return thing.versions.findLast((v) => !v.pruned)
}
