// The figures of the statistics page and `ledger stats`: four questions about the library, each
// figure counted from the facts in one pass of the fold. Pure; reads no disk. Days are this machine's,
// as the view runs. ARCHITECTURE.md section 10 says how each figure is defined.
import type { Instant, LibraryPath } from '@pneuma-base/kernel'
import { requestOf, type Fact, type FactActor, type ItemId, type SceneId } from './facts.js'
import { folding, inOrder, isArchived, type Ledger } from './fold.js'

export type Period = '7d' | '30d' | 'all'
export const PERIODS: readonly { value: Period; label: string }[] = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
]
export const DEFAULT_PERIOD: Period = '30d'
export const isPeriod = (v: string | null | undefined): v is Period => PERIODS.some((p) => p.value === v)

/** What the charts count by: a day, a week from Monday, a month; `all` takes the shortest that keeps the bars few. */
export type Grain = 'day' | 'week' | 'month'

/** What needs looking at in the things not archived, as recorded, and how many are archived. */
export type Open = { stale: number; changed: number; unknown: number; archived: number }

export type AgentRow = {
  name: string
  sessions: number
  brought: number
  made: number
  decided: number
  notes: number
  asked: number
  approved: number // approved, and the command did it
  refused: number // approved, and the command refused
  declined: number
  withdrawn: number
  pending: number
}

export type OwnerRow = { commands: number; approved: number; declined: number; brought: number; made: number; said: number; registered: number }

export type Stats = {
  period: Period
  from: Instant // the first moment counted: local midnight
  to: Instant // now
  grain: Grain
  buckets: string[] // each bucket's label, in order
  facts: number // facts the library has, any time
  put: { brought: number; made: number; byBucket: { brought: number[]; made: number[] } }
  sessions: { total: number; byAgent: { agent: string; total: number; byBucket: number[] }[] }
  reuse: {
    made: number
    fromLibrary: number
    otherSession: number
    otherAgent: number
    byBucket: { otherSession: number[]; rest: number[] }
    top: { item: ItemId; path: LibraryPath; uses: number; by: string[] }[]
  }
  agents: AgentRow[]
  owner: OwnerRow
  order: { now: Open; start: Open; byBucket: Open[]; archived: number; takenBack: number; purged: number; changes: number }
}

const TOP = 5
const DAY_BARS = 31
const WEEK_BARS = 26

// ---- local time ----

const dayOf = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const plusDays = (t: number, n: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime()
}
const monthOf = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}
const plusMonths = (t: number, n: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
}
const mondayOf = (t: number) => plusDays(dayOf(t), -((new Date(t).getDay() + 6) % 7))
const md = (t: number) => `${new Date(t).getMonth() + 1}月${new Date(t).getDate()}日`

type Bucket = { start: number; label: string }

/** The buckets from `from` to `end`, the grain chosen so `all` stays a few dozen bars. */
function bucketsOf(from: number, end: number): { grain: Grain; buckets: Bucket[] } {
  const days = Math.round((end - from) / 86_400_000)
  const grain: Grain = days <= DAY_BARS ? 'day' : days <= WEEK_BARS * 7 ? 'week' : 'month'
  const first = grain === 'day' ? from : grain === 'week' ? mondayOf(from) : monthOf(from)
  const next = (t: number) => (grain === 'day' ? plusDays(t, 1) : grain === 'week' ? plusDays(t, 7) : plusMonths(t, 1))
  const label = (t: number) => (grain === 'day' ? md(t) : grain === 'week' ? `${md(t)}那周` : `${new Date(t).getFullYear()}年${new Date(t).getMonth() + 1}月`)
  const buckets: Bucket[] = []
  for (let t = first; t < end; t = next(t)) buckets.push({ start: t, label: label(t) })
  return { grain, buckets }
}

// ---- what needs looking at, as the ledger stands ----

/**
 * The things not removed, not part of a bundle and not archived: made from a thing whose content
 * changed since or that is gone; whose latest content is a direct change only seen, nobody saying
 * who made it; whose origin nobody knows. And how many are archived.
 */
export function openOf(ledger: Ledger): Open {
  const open: Open = { stale: 0, changed: 0, unknown: 0, archived: 0 }
  for (const item of ledger.items.values()) {
    if (item.removed || item.absorbedInto !== null) continue
    if (isArchived(item)) {
      open.archived++
      continue
    }
    if (item.unknownOrigin) open.unknown++
    const last = item.versions.at(-1)
    if (last?.claimed && last.how === 'observed') open.changed++
    if (
      item.basis.items.some((row) => {
        const source = ledger.items.get(row.item)
        return source === undefined || source.removed || source.fingerprint !== row.fingerprint
      })
    )
      open.stale++
  }
  return open
}

// ---- the pass ----

const whoName = (a: FactActor) => (a.kind === 'owner' ? '主人' : a.name)

type Made = { item: ItemId; scene: SceneId; actor: FactActor; bucket: number }

const zeros = (n: number) => Array.from({ length: n }, () => 0)
const bump = (list: number[], i: number) => void (list[i] = (list[i] ?? 0) + 1)
const emptyAgent = (name: string): AgentRow => ({ name, sessions: 0, brought: 0, made: 0, decided: 0, notes: 0, asked: 0, approved: 0, refused: 0, declined: 0, withdrawn: 0, pending: 0 })

/** Every figure of the four questions over `period`, ending `now`, from the facts in one pass of the fold. */
export function statsOf(input: readonly Fact[], period: Period, now: Instant): Stats {
  const facts = inOrder(input)
  const today = dayOf(Date.parse(now))
  const end = plusDays(today, 1)
  const first = facts[0] ? dayOf(Date.parse(facts[0].at)) : today
  const from = period === '7d' ? plusDays(today, -6) : period === '30d' ? plusDays(today, -29) : Math.min(first, today)
  const { grain, buckets } = bucketsOf(from, end)
  const n = buckets.length

  const put = { brought: zeros(n), made: zeros(n) }
  const sessions = new Map<string, number[]>()
  const agents = new Map<string, AgentRow>()
  const agent = (name: string) => agents.get(name) ?? (agents.set(name, emptyAgent(name)).get(name) as AgentRow)
  const owner: OwnerRow = { commands: 0, approved: 0, declined: 0, brought: 0, made: 0, said: 0, registered: 0 }
  const made: Made[] = []
  const asked = new Map<string, string>() // request id → the agent that asked, for requests asked in the period
  const approved = new Map<string, boolean>() // request id → whether the command refused
  const declined = new Set<string>()
  const withdrawn = new Set<string>()
  const seen = new Set<ItemId>()
  const started = new Set<SceneId>()
  const order = { archived: 0, takenBack: 0, purged: 0, changes: 0 }

  const folder = folding()
  const samples: Open[] = []
  let start: Open | null = null
  let at = -1 // the bucket the walk is in; -1 before the period
  /** Moves the walk into the bucket that holds `t`, keeping what needed looking at when each bucket it leaves ended. */
  const advance = (t: number) => {
    if (at + 1 >= n || t < (buckets[at + 1] as Bucket).start) return
    const open = openOf(folder.ledger)
    while (at + 1 < n && t >= (buckets[at + 1] as Bucket).start) {
      if (at < 0) start = open
      else samples[at] = open
      at++
    }
  }

  for (const raw of facts) {
    const t = Date.parse(raw.at)
    advance(t)
    const f = folder.take(raw)
    const counted = at >= 0 && t < end
    if (f.actor.kind === 'agent' && f.kind !== 'checked' && !started.has(f.scene)) {
      started.add(f.scene)
      if (counted) bump(sessions.get(f.actor.name) ?? (sessions.set(f.actor.name, zeros(n)).get(f.actor.name) as number[]), at)
    }
    if (f.kind === 'items.enter') {
      for (const e of f.items) seen.add(e.item)
      if (counted && f.actor.kind === 'owner') owner.registered += f.items.length
      continue
    }
    if (f.kind === 'item.enter') {
      const fresh = !seen.has(f.item)
      seen.add(f.item)
      if (!fresh || !counted || f.origin.kind === 'adopted') continue
      const kind = f.origin.kind
      bump(put[kind], at)
      if (f.actor.kind === 'agent') agent(f.actor.name)[kind]++
      else if (f.actor.kind === 'owner') owner[kind]++
      if (kind === 'made') made.push({ item: f.item, scene: f.scene, actor: f.actor, bucket: at })
      continue
    }
    if (f.kind === 'request') {
      if (f.act === 'withdrawn') withdrawn.add(f.request)
      else if (counted && f.actor.kind === 'agent') {
        asked.set(f.request, f.actor.name)
        agent(f.actor.name).asked++
      }
      continue
    }
    if (f.kind === 'owner.op') {
      const decline = f.request ? null : requestOf(f)
      if (f.request) approved.set(f.request.id, f.refused !== undefined)
      if (decline !== null) declined.add(decline)
      if (!counted || f.actor.kind !== 'owner') continue
      if (!f.readOnly) owner.commands++
      if (f.request) owner.approved++
      if (decline !== null) owner.declined++
      continue
    }
    if (!counted) continue
    if (f.kind === 'said') {
      if (f.actor.kind === 'agent' && f.flavor !== 'doing') agent(f.actor.name)[f.flavor === 'decided' ? 'decided' : 'notes']++
      else if (f.actor.kind === 'owner') owner.said++
    } else if (f.kind === 'item.move' && f.archive !== null) order[f.archive === 'in' ? 'archived' : 'takenBack']++
    else if (f.kind === 'item.remove') order.purged++
    else if (f.kind === 'item.revise' && f.claimed) order.changes++
  }
  const ledger = folder.ledger
  const final = openOf(ledger)
  start ??= final
  for (let i = Math.max(0, at); i < n; i++) samples[i] ??= final

  for (const [name, byBucket] of sessions) agent(name).sessions = byBucket.reduce((a, b) => a + b, 0)
  for (const [id, name] of asked) {
    const row = agent(name)
    const refused = approved.get(id)
    if (refused !== undefined) row[refused ? 'refused' : 'approved']++
    else if (declined.has(id)) row.declined++
    else if (withdrawn.has(id)) row.withdrawn++
    else row.pending++
  }

  // What was made in the period and what it was made from: its recorded sources, each by where and by whom it was registered.
  const reuse = { made: made.length, fromLibrary: 0, otherSession: 0, otherAgent: 0, byBucket: { otherSession: zeros(n), rest: zeros(n) } }
  const uses = new Map<ItemId, { uses: number; by: Set<string> }>()
  for (const m of made) {
    const sources = (ledger.items.get(m.item)?.basis.items ?? []).flatMap((row) => (row.item === m.item ? [] : (ledger.items.get(row.item) ?? [])))
    const otherSession = sources.some((s) => s.entered.scene !== m.scene)
    if (sources.length > 0) reuse.fromLibrary++
    if (otherSession) reuse.otherSession++
    if (sources.some((s) => s.entered.actor.kind === 'agent' && whoName(s.entered.actor) !== whoName(m.actor))) reuse.otherAgent++
    bump(reuse.byBucket[otherSession ? 'otherSession' : 'rest'], m.bucket)
    for (const s of new Set(sources)) {
      const u = uses.get(s.id) ?? { uses: 0, by: new Set<string>() }
      uses.set(s.id, u)
      u.uses++
      u.by.add(whoName(m.actor))
    }
  }
  const top = [...uses]
    .flatMap(([id, u]) => {
      const item = ledger.items.get(id)
      return item && !item.removed ? [{ item: id, path: item.path, uses: u.uses, by: [...u.by].sort() }] : []
    })
    .sort((a, b) => b.uses - a.uses || (a.path < b.path ? -1 : 1))
    .slice(0, TOP)

  const byAgent = [...sessions].map(([name, byBucket]) => ({ agent: name, total: byBucket.reduce((a, b) => a + b, 0), byBucket })).sort((a, b) => b.total - a.total || (a.agent < b.agent ? -1 : 1))
  return {
    period,
    from: new Date(from).toISOString() as Instant,
    to: now,
    grain,
    buckets: buckets.map((b) => b.label),
    facts: facts.length,
    put: { brought: sum(put.brought), made: sum(put.made), byBucket: put },
    sessions: { total: sum(byAgent.map((a) => a.total)), byAgent },
    reuse: { ...reuse, top },
    agents: [...agents.values()].sort((a, b) => b.sessions - a.sessions || b.brought + b.made - (a.brought + a.made) || (a.name < b.name ? -1 : 1)),
    owner,
    order: { now: final, start, byBucket: samples, ...order },
  }
}

const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0)
