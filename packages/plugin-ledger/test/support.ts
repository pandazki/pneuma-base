// Facts built by hand for the pure functions' tests.
import type { Fingerprint, Instant, LibraryPath } from '@pneuma-base/kernel'
import type { Basis, Fact, FactActor, FactBody, ItemId, SceneId } from '../src/facts.js'

export const claude: FactActor = { kind: 'agent', name: 'claude-code', grant: null }
export const codex: FactActor = { kind: 'agent', name: 'codex', grant: null }

export const at = (second: number) => `2026-11-25T00:00:${String(second).padStart(2, '0')}.000Z` as Instant
export const fp = (s: string) => s.padEnd(64, '0') as Fingerprint
export const p = (s: string) => s as LibraryPath
export const id = (s: string) => s as ItemId

/** A fact at second `second` of the test day, in scene `scene`. */
export function f(second: number, body: FactBody, opts: { scene?: string; actor?: FactActor } = {}): Fact {
  return {
    id: `f_${String(second).padStart(4, '0')}`,
    at: at(second),
    scene: (opts.scene ?? 's1') as SceneId,
    actor: opts.actor ?? claude,
    where: { cwd: '/work', machine: 'm', sessionSource: 'flag', transcript: null },
    how: 'tool',
    ...body,
  }
}

export const basis = (rows: [string, string][], outside: string[] = []): Basis => ({ items: rows.map(([item, print]) => ({ item: id(item), fingerprint: fp(print) })), outside })

type Enter = Extract<FactBody, { kind: 'item.enter' }>

export const enter = (item: string, path: string, print: string, origin: Enter['origin'] = { kind: 'brought', source: null, by: null }): Enter => ({
  kind: 'item.enter',
  item: id(item),
  path: p(path),
  fingerprint: fp(print),
  size: 1,
  origin,
})
