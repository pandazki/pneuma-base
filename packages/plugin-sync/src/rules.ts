// The sync rules (design.md 五): no merging of contents, no lost contents. Pure functions only.
import { posix } from 'node:path'
import { regionOf, type Fingerprint, type LibraryPath } from '@pneuma-base/kernel'

export type Side = 'local' | 'target'
/** Library paths of single files, '/'-separated, with the sha256 of each file's content. */
export type Files = ReadonlyMap<LibraryPath, Fingerprint>

/** What one path becomes, from its content on each side and at the end of the last sync (null: absent). */
export type Decision = 'keep' | 'push' | 'pull' | 'conflict' | 'drop'

/**
 * The rule table, totalized. With no base (first sync, or the baseline was lost) every path counts
 * as new on the sides that have it: one side only is copied over, equal is kept, different conflicts.
 * `drop` removes the copy left on the other side; `plan` keeps its content when it would vanish.
 */
export function decide(local: Fingerprint | null, target: Fingerprint | null, base: Fingerprint | null): Decision {
  if (local === target) return 'keep'
  if (local === null) return target === base ? 'drop' : 'pull'
  if (target === null) return local === base ? 'drop' : 'push'
  if (local === base) return 'pull'
  if (target === base) return 'push'
  return 'conflict'
}

/**
 * One change to the sides. `copy` writes the file at `path` to the other side, over `over`.
 * `keep` copies the content at `path` to `to` on both sides before anything replaces it: a
 * conflict copy, an archived copy, or the same path restored. `remove` deletes one side's copy.
 */
export type Step =
  | { kind: 'copy'; from: Side; path: LibraryPath; fingerprint: Fingerprint; over: Fingerprint | null }
  | { kind: 'keep'; from: Side; path: LibraryPath; fingerprint: Fingerprint; to: LibraryPath; as: 'conflict' | 'archive' | 'restore' }
  | { kind: 'remove'; side: Side; path: LibraryPath; fingerprint: Fingerprint }

/** `copy`: where the target's version of `path` is kept, on both sides. */
export type Conflict = { path: LibraryPath; copy: LibraryPath }

/** The steps in the order they run, and what both sides hold once they all ran. */
export type Plan = { steps: Step[]; end: Map<LibraryPath, Fingerprint>; conflicts: Conflict[] }

export const stepPath = (step: Step): LibraryPath => (step.kind === 'keep' ? step.to : step.path)

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The decisions for every path, then every content either side held that the end state would not
 * hold anywhere is kept: a conflict's target version as a conflict copy; a file the other side
 * deleted outside the content (archive, records) restored where it was; anything else under
 * `_archive/`. So every content found on either side before the sync is on both sides after it.
 * Keeps run first, then copies, then removals.
 */
export function plan(files: { local: Files; target: Files; base: Files }, conflictName: (path: LibraryPath, n: number) => LibraryPath): Plan {
  const { local, target, base } = files
  const end = new Map<LibraryPath, Fingerprint>()
  const copies: Step[] = []
  const removes: Extract<Step, { kind: 'remove' }>[] = []
  const theirs: { path: LibraryPath; fingerprint: Fingerprint }[] = []
  for (const path of [...new Set([...local.keys(), ...target.keys(), ...base.keys()])].sort(byPath)) {
    const l = local.get(path) ?? null
    const t = target.get(path) ?? null
    switch (decide(l, t, base.get(path) ?? null)) {
      case 'keep':
        if (l !== null) end.set(path, l)
        break
      case 'push':
        end.set(path, l as Fingerprint)
        copies.push({ kind: 'copy', from: 'local', path, fingerprint: l as Fingerprint, over: t })
        break
      case 'pull':
        end.set(path, t as Fingerprint)
        copies.push({ kind: 'copy', from: 'target', path, fingerprint: t as Fingerprint, over: l })
        break
      case 'conflict':
        end.set(path, l as Fingerprint)
        copies.push({ kind: 'copy', from: 'local', path, fingerprint: l as Fingerprint, over: t })
        theirs.push({ path, fingerprint: t as Fingerprint })
        break
      case 'drop':
        removes.push(l !== null ? { kind: 'remove', side: 'local', path, fingerprint: l } : { kind: 'remove', side: 'target', path, fingerprint: t as Fingerprint })
    }
  }

  const keeps: Extract<Step, { kind: 'keep' }>[] = []
  const taken = (path: LibraryPath) => end.has(path) || local.has(path) || target.has(path)
  const kept = new Set(end.values())
  const keep = (step: Extract<Step, { kind: 'keep' }>) => {
    keeps.push(step)
    end.set(step.to, step.fingerprint)
    kept.add(step.fingerprint)
  }

  const conflicts = theirs.map(({ path, fingerprint }): Conflict => {
    if (kept.has(fingerprint)) return { path, copy: [...end].find(([, f]) => f === fingerprint)?.[0] as LibraryPath }
    let n = 1
    while (taken(conflictName(path, n))) n++
    keep({ kind: 'keep', from: 'target', path, fingerprint, to: conflictName(path, n), as: 'conflict' })
    return { path, copy: conflictName(path, n) }
  })

  for (const [from, side] of [['local', local], ['target', target]] as const) {
    for (const [path, fingerprint] of [...side].sort(([a], [b]) => byPath(a, b))) {
      if (kept.has(fingerprint)) continue
      if (regionOf(path) !== 'content' && !end.has(path)) keep({ kind: 'keep', from, path, fingerprint, to: path, as: 'restore' })
      else keep({ kind: 'keep', from, path, fingerprint, to: archiveName(path, fingerprint, taken), as: 'archive' })
    }
  }
  const restored = new Set(keeps.filter((k) => k.as === 'restore').map((k) => k.path))
  return { steps: [...keeps, ...copies, ...removes.filter((r) => !restored.has(r.path))], end, conflicts }
}

/** `_archive/<path>`; when taken, with the first eight characters of the fingerprint, then a counter. */
function archiveName(path: LibraryPath, fingerprint: Fingerprint, taken: (path: LibraryPath) => boolean): LibraryPath {
  const archived = (regionOf(path) === 'archive' ? path : `_archive/${path}`) as LibraryPath
  const short = fingerprint.slice(0, 8)
  if (!taken(archived)) return archived
  for (let n = 1; ; n++) {
    const name = withSuffix(archived, n === 1 ? short : `${short}-${n}`)
    if (!taken(name)) return name
  }
}

/** `a/b.md` with suffix `s` becomes `a/b.s.md`; a name without an extension gets `.s` at the end. */
function withSuffix(path: LibraryPath, suffix: string): LibraryPath {
  const name = posix.basename(path)
  const dot = name.lastIndexOf('.')
  const renamed = dot > 0 ? `${name.slice(0, dot)}.${suffix}${name.slice(dot)}` : `${name}.${suffix}`
  const dir = posix.dirname(path)
  return (dir === '.' ? renamed : `${dir}/${renamed}`) as LibraryPath
}

/** `<name>.conflict-<machine>-<moment><extension>`, with `-<n>` after the moment from the second on. */
export function conflictName(path: LibraryPath, machine: string, moment: string, n: number): LibraryPath {
  return withSuffix(path, `conflict-${machine}-${moment}${n > 1 ? `-${n}` : ''}`)
}

const CONFLICT = /^(.+)\.conflict-[A-Za-z0-9-]+?-\d{8}T\d{6}Z(?:-\d+)?(\.[^.]+)?$/

/** The path a conflict copy was made for; null when `path` is not a conflict copy's name. */
export function conflictOrigin(path: LibraryPath): LibraryPath | null {
  const name = posix.basename(path)
  const m = CONFLICT.exec(name)
  if (!m) return null
  const dir = posix.dirname(path)
  const original = `${m[1]}${m[2] ?? ''}`
  return (dir === '.' ? original : `${dir}/${original}`) as LibraryPath
}

/** A machine name as it may appear in a file name. */
export function machineSlug(machine: string): string {
  return machine.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'machine'
}

/** `2026-11-25T08:00:00.000Z` becomes `20261125T080000Z`. */
export function moment(at: string): string {
  return `${at.slice(0, 4)}${at.slice(5, 7)}${at.slice(8, 10)}T${at.slice(11, 13)}${at.slice(14, 16)}${at.slice(17, 19)}Z`
}
