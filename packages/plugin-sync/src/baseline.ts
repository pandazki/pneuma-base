// The baseline: what this machine saw at the end of its last run with one target, kept in the plugin's
// cache directory under $PNEUMA_BASE_HOME, outside every library, never synced. Losing it costs a
// first sync's reading, and the rules then keep what they cannot tell apart.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fingerprint } from '@pneuma-base/kernel'
import type { Key } from './scope.js'

/** A key both sides held after the run: its fingerprint, and the state of the target's copy then (`at`). */
export type BaseEntry = { fp: Fingerprint; at: string }
/**
 * Per record place: the cursor its facts were pushed up to, the facts pulls appended (by `factId`),
 * and the last file read of each other library's stream.
 */
export type FactsBase = { cursor: string | null; pulled: Set<string>; read: Map<string, string> }

/** `target`: the target's id. `files`: the keys both sides held. `settled`: the deletion facts already settled. */
export type Baseline = { target: string; files: Map<Key, BaseEntry>; facts: Map<string, FactsBase>; settled: Set<string> }

type BaselineFile = {
  format: 2
  target: string
  files: Record<string, BaseEntry>
  facts: Record<string, { cursor: string | null; pulled: string[]; read: Record<string, string> }>
  settled: string[]
}
const FILE = 'baseline-2.json'

export const emptyBaseline = (target: string): Baseline => ({ target, files: new Map(), facts: new Map(), settled: new Set() })

/** This machine's baseline with the target `target` (null: whichever); null when there is none, it is another target's, or it cannot be read. */
export function readBaseline(cacheDir: string, target: string | null): Baseline | null {
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir, FILE), 'utf8')) as BaselineFile
    if (raw.format !== 2 || (target !== null && raw.target !== target)) return null
    return {
      target: raw.target,
      files: new Map(Object.entries(raw.files) as [Key, BaseEntry][]),
      facts: new Map(Object.entries(raw.facts).map(([place, f]) => [place, { cursor: f.cursor, pulled: new Set(f.pulled), read: new Map(Object.entries(f.read)) }])),
      settled: new Set(raw.settled),
    }
  } catch {
    return null
  }
}

export function writeBaseline(cacheDir: string, b: Baseline): void {
  mkdirSync(cacheDir, { recursive: true })
  const file: BaselineFile = {
    format: 2,
    target: b.target,
    files: Object.fromEntries(b.files),
    facts: Object.fromEntries([...b.facts].map(([place, f]) => [place, { cursor: f.cursor, pulled: [...f.pulled], read: Object.fromEntries(f.read) }])),
    settled: [...b.settled],
  }
  const tmp = join(cacheDir, `.${FILE}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, JSON.stringify(file))
  renameSync(tmp, join(cacheDir, FILE))
}
