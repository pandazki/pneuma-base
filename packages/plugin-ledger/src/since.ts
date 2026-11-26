// What others did since an actor was last here, asked of the rows: the latest facts that are news, read
// newest first from the `news` table until the actor's last visit, at most SINCE_LIMIT of them.
import type { Instant, PluginContext } from '@pneuma-base/kernel'
import type { Fact, FactActor, SceneId } from './facts.js'
import { actorKey, inOrder } from './fold.js'
import { loadScenes, type ActorRow, type LedgerState } from './state.js'
import { SINCE_LIMIT } from './views.js'

/** How many news rows one question reads at most: past them it says what it found. */
const SCAN_LIMIT = 2000
const PAGE = 200

/**
 * When this actor was last here: its latest look (a check, or the owner's 都看过了), else, before it
 * ever looked, its latest fact in another scene; null when it never was.
 */
export function lastHereOf(row: ActorRow | undefined, current: SceneId): Instant | null {
  if (row === undefined) return null
  if (row.checked !== null) return row.checked
  if (row.last.scene !== current) return row.last.at
  return row.other?.at ?? null
}

/**
 * The latest facts that are news to `me` since it was last here (or since the moment given), in the
 * order they happened. Setup commands are already in PNEUMA-BASE.md when an agent first comes, so
 * they are news only after its earliest visit, unless a moment is given.
 */
export async function newsSince(ctx: PluginContext, state: LedgerState, me: FactActor, current: SceneId, since: Instant | 'last' | null): Promise<{ since: Instant | null; facts: Fact[] }> {
  const mine = actorKey(me)
  const row = state.actors.get(mine)
  const explicit = since !== null && since !== 'last'
  const start = explicit ? since : lastHereOf(row, current)
  const firstSeen = row?.first ?? null
  const found: Fact[] = []
  let after: string | undefined
  let read = 0
  scan: for (;;) {
    const page = await ctx.tools.storage.records.under<Fact>('news', '', { limit: PAGE, ...(after === undefined ? {} : { after }) })
    for (const { value: f } of page.rows) {
      read++
      if (start !== null && f.at <= start) break scan
      if (actorKey(f.actor) === mine || f.scene === current) continue
      if (!explicit && f.kind === 'owner.op' && f.setup && (firstSeen === null || f.at <= firstSeen)) continue
      found.push(f)
      if (found.length >= SINCE_LIMIT) break scan
    }
    if (page.more === null || read >= SCAN_LIMIT) break
    after = page.more.after
  }
  const facts = inOrder(found)
  await loadScenes(ctx, state, facts.map((f) => f.scene))
  return { since: start, facts }
}

/** The agents that ever left a fact here. */
export const agentsOf = (state: LedgerState): FactActor[] => [...state.actors.values()].filter((r) => r.actor.kind === 'agent').map((r) => r.actor)
