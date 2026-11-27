// The facts of every record place between the library and the target. Each library writes its own
// stream per place in the target, one new file per run, never rewritten; a library pulls the other
// streams past the file it read last. A fact is identified by the sha256 of its JSON: a pull never
// appends a fact the place already has, and a push never ships one that came from a pull.
import { createHash } from 'node:crypto'
import type { PluginContext } from '@pneuma-base/kernel'
import type { Baseline, FactsBase } from './baseline.js'
import type { TargetDir } from './target.js'

/** The sync's own record place, whose facts say which things the other libraries registered. */
export const SYNC_PLACE = 'sync'
const FACT_PAGE = 10000

/** JSON with every object's keys sorted, so the same fact is the same text however storage ordered its keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A fact's identity: the sha256 of its canonical JSON, base64url. */
export const factId = (fact: unknown) => createHash('sha256').update(canonical(fact)).digest('base64url')

/** Every fact of a record place in the library, by identity, read a page at a time. */
async function idsHere(ctx: PluginContext, place: string): Promise<Set<string>> {
  const facts = ctx.tools.storage.recordPlace(place).facts
  const out = new Set<string>()
  for (let cursor: string | null = null; ; ) {
    const page = await facts.since(cursor, FACT_PAGE)
    if (page === null) {
      if (cursor === null) throw new Error(`记录处 ${place} 的事实读不出来`)
      out.clear()
      cursor = null
      continue
    }
    for (const f of page.facts) out.add(factId(f.fact))
    if (!page.more) return out
    cursor = page.cursor
  }
}

/** Every fact of one library's stream of `place` in the target, by identity. */
function idsThere(target: TargetDir, place: string, library: string): Set<string> {
  const out = new Set<string>()
  for (const file of target.streamFiles(place, library)) for (const fact of target.readStream(place, library, file)) out.add(factId(fact))
  return out
}

const fresh = (): FactsBase => ({ cursor: null, pulled: new Set(), read: new Map() })

/**
 * What the baseline keeps of a place when it has nothing of it (the first sync, or the cache lost):
 * the facts here that the other streams hold too count as pulled, so they are never pushed.
 */
async function rebuilt(ctx: PluginContext, target: TargetDir, place: string, me: string): Promise<FactsBase> {
  const others = target.streams(place).filter((lib) => lib !== me)
  const out = fresh()
  if (others.length === 0) return out
  const here = await idsHere(ctx, place)
  for (const lib of others) for (const id of idsThere(target, place, lib)) if (here.has(id)) out.pulled.add(id)
  return out
}

/** The facts of the other libraries' streams of `place` past what `fb` read, not had yet; and the last file read of each stream. */
function unread(target: TargetDir, place: string, me: string, fb: FactsBase): { facts: unknown[]; ids: string[]; read: Map<string, string> } {
  const facts: unknown[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  const read = new Map(fb.read)
  for (const lib of target.streams(place)) {
    if (lib === me) continue
    const last = fb.read.get(lib)
    const files = target.streamFiles(place, lib).filter((name) => last === undefined || name > last)
    for (const file of files) {
      for (const fact of target.readStream(place, lib, file)) {
        const id = factId(fact)
        if (fb.pulled.has(id) || seen.has(id)) continue
        seen.add(id)
        facts.push(fact)
        ids.push(id)
      }
    }
    const end = files.at(-1)
    if (end !== undefined) read.set(lib, end)
  }
  return { facts, ids, read }
}

/**
 * Pulls the facts of every place found in the target that this library does not have: appends them to
 * their record places and keeps what was read in `base`. Answers the sync's own facts among them.
 */
export async function pullFacts(ctx: PluginContext, target: TargetDir, base: Baseline, me: string): Promise<unknown[]> {
  let mine: unknown[] = []
  for (const place of target.factPlaces()) {
    const fb = base.facts.get(place) ?? (await rebuilt(ctx, target, place, me))
    const { facts, ids, read } = unread(target, place, me, fb)
    for (let i = 0; i < facts.length; i += FACT_PAGE) await ctx.tools.storage.recordPlace(place).facts.append(facts.slice(i, i + FACT_PAGE))
    for (const id of ids) fb.pulled.add(id)
    fb.read = read
    base.facts.set(place, fb)
    if (place === SYNC_PLACE) mine = facts
  }
  return mine
}

/** The sync's own facts a pull would bring, read without appending anything. */
export async function unpulledSyncFacts(ctx: PluginContext, target: TargetDir, base: Baseline | null, me: string): Promise<unknown[]> {
  const fb = base?.facts.get(SYNC_PLACE)
  if (fb !== undefined) return unread(target, SYNC_PLACE, me, fb).facts
  const here = await idsHere(ctx, SYNC_PLACE)
  return unread(target, SYNC_PLACE, me, { ...fresh(), pulled: here }).facts
}

/**
 * Pushes the facts written on this library since each place's cursor, those pulls appended left out,
 * as one new file of this library's stream per place. Without a cursor, the facts its stream already
 * holds are left out too. Every place the kernel names: its own and each installed plugin's.
 */
export async function pushFacts(ctx: PluginContext, target: TargetDir, base: Baseline, me: string): Promise<void> {
  for (const place of await ctx.tools.storage.recordPlaces()) {
    const facts = ctx.tools.storage.recordPlace(place).facts
    const fb = base.facts.get(place) ?? fresh()
    let cursor = fb.cursor
    let shipped = cursor === null ? idsThere(target, place, me) : new Set<string>()
    let out: unknown[] = []
    for (;;) {
      const page = await facts.since(cursor, FACT_PAGE)
      if (page === null) {
        // The facts under the cursor were rewritten: start again, leaving out what the stream holds.
        cursor = null
        shipped = idsThere(target, place, me)
        out = []
        continue
      }
      for (const f of page.facts) {
        const id = factId(f.fact)
        if (!fb.pulled.has(id) && !shipped.has(id)) out.push(f.fact)
      }
      cursor = page.cursor
      if (!page.more) break
    }
    if (out.length > 0) target.writeStream(place, me, out)
    fb.cursor = cursor
    base.facts.set(place, fb)
  }
}
