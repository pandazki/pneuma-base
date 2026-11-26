// The figures of the statistics page and `ledger stats`: four questions about the library. The fold
// counts each fact into the row of its hour (UTC), so a period's figures are the sum of its hours' rows,
// asked for and nothing else; what needed looking at is kept as it stood at the end of each hour. Days
// are this machine's, as the view runs. ARCHITECTURE.md section 10 says how each figure is defined.
import type { Instant, LibraryPath } from '@pneuma-base/kernel'
import { turned, type FactActor, type ItemId } from './facts.js'
import { pagesOf, type Records, type Tx } from './rows.js'
import type { ItemRow } from './model.js'

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

// ---- what the fold keeps ----

export type AgentCounts = Omit<AgentRow, 'name' | 'sessions' | 'pending'>
/** One hour's counts: what was put and by whom, the sessions begun, who did what, what was kept in order, what was built on what. */
export type HourRow = {
  hour: string
  put: { brought: number; made: number }
  sessions: Record<string, number>
  agents: Record<string, AgentCounts>
  owner: OwnerRow
  order: { archived: number; takenBack: number; purged: number; changes: number }
  reuse: { fromLibrary: number; otherSession: number; otherAgent: number }
  uses: Record<string, { n: number; by: Record<string, number> }>
  open: Open | null // after this hour's facts
}
/** A request an agent asked: who, in which hour, and how it stands. */
export type RequestRow = { by: FactActor; hour: string; outcome: Outcome }
export type Outcome = 'pending' | 'withdrawn' | 'declined' | 'approved' | 'refused'

export const OPEN_COUNTERS = { stale: 'open:stale', changed: 'open:changed', unknown: 'open:unknown', archived: 'open:archived' } as const

export const hourOf = (at: string) => at.slice(0, 13)
const hourKey = (hour: string) => `h:${hour}`
const emptyAgent = (): AgentCounts => ({ brought: 0, made: 0, decided: 0, notes: 0, asked: 0, approved: 0, refused: 0, declined: 0, withdrawn: 0 })
const emptyOwner = (): OwnerRow => ({ commands: 0, approved: 0, declined: 0, brought: 0, made: 0, said: 0, registered: 0 })

/** The row of an hour as this change has it, made when there is none; write it back with `putHour`. */
export async function hourRow(tx: Tx, at: string): Promise<HourRow> {
  const hour = hourOf(at)
  const known = await tx.get<HourRow>('stats', hourKey(hour))
  return known ?? { hour, put: { brought: 0, made: 0 }, sessions: {}, agents: {}, owner: emptyOwner(), order: { archived: 0, takenBack: 0, purged: 0, changes: 0 }, reuse: { fromLibrary: 0, otherSession: 0, otherAgent: 0 }, uses: {}, open: null }
}

export const putHour = (tx: Tx, row: HourRow) => tx.set('stats', hourKey(row.hour), row)
export const agentOf = (row: HourRow, name: string): AgentCounts => (row.agents[name] ??= emptyAgent())

/** Keeps what needs looking at as it stands now as the end of the hour. */
export async function snapshot(tx: Tx, at: string): Promise<void> {
  const row = await hourRow(tx, at)
  row.open = { stale: await tx.counter(OPEN_COUNTERS.stale), changed: await tx.counter(OPEN_COUNTERS.changed), unknown: await tx.counter(OPEN_COUNTERS.unknown), archived: await tx.counter(OPEN_COUNTERS.archived) }
  putHour(tx, row)
  tx.set('hrev', turned(row.hour), { hour: row.hour, open: row.open })
}

/** Moves a request to `outcome` in the hour it was asked; an approval decides it whatever came before, a decline over a withdrawal. */
export async function requestTo(tx: Tx, id: string, outcome: Outcome): Promise<void> {
  const req = await tx.get<RequestRow>('requests', id)
  if (!req) return
  const rank = (o: Outcome) => (o === 'approved' || o === 'refused' ? 3 : o === 'declined' ? 2 : o === 'withdrawn' ? 1 : 0)
  if (rank(outcome) < rank(req.outcome) || (rank(outcome) < 3 && outcome === req.outcome)) return
  const row = await hourRow(tx, `${req.hour}:00:00.000Z`)
  const counts = agentOf(row, req.by.name)
  if (req.outcome !== 'pending') counts[req.outcome]--
  if (outcome !== 'pending') counts[outcome]++
  putHour(tx, row)
  tx.set('requests', id, { ...req, outcome })
}

/** Counts a made thing's sources into the hour it was made in, after taking out what was counted before. */
export async function countReuse(tx: Tx, item: ItemRow, next: ItemRow['reuse']): Promise<void> {
  for (const [r, sign] of [
    [item.reuse, -1],
    [next, 1],
  ] as const) {
    if (r === null) continue
    const row = await hourRow(tx, `${r.hour}:00:00.000Z`)
    row.reuse.fromLibrary += r.fromLibrary ? sign : 0
    row.reuse.otherSession += r.otherSession ? sign : 0
    row.reuse.otherAgent += r.otherAgent ? sign : 0
    for (const id of r.uses) {
      const u = (row.uses[id] ??= { n: 0, by: {} })
      u.n += sign
      u.by[r.actor] = (u.by[r.actor] ?? 0) + sign
      if (u.by[r.actor] === 0) delete u.by[r.actor]
      if (u.n <= 0) delete row.uses[id]
    }
    putHour(tx, row)
  }
  item.reuse = next
}

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

const DAY_BARS = 31
const WEEK_BARS = 26
const TOP = 5

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

const zeros = (n: number) => Array.from({ length: n }, () => 0)
const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0)
const ZERO: Open = { stale: 0, changed: 0, unknown: 0, archived: 0 }
const hourStart = (hour: string) => Date.parse(`${hour}:00:00.000Z`)
const utcHour = (t: number) => new Date(t).toISOString().slice(0, 13)

/** Every figure of the four questions over `period`, ending `now`, from the rows of the hours in it. */
export async function statsFrom(records: Pick<Records, 'get' | 'under'>, period: Period, now: Instant): Promise<Stats> {
  const meta = new Map((await records.get<unknown>('meta', ['counts', 'first'])).rows.map((r) => [r.key, r.value]))
  const counts = (meta.get('counts') ?? {}) as Record<string, number>
  const firstAt = meta.get('first') as string | undefined
  const today = dayOf(Date.parse(now))
  const end = plusDays(today, 1)
  const first = firstAt ? dayOf(Date.parse(firstAt)) : today
  const from = period === '7d' ? plusDays(today, -6) : period === '30d' ? plusDays(today, -29) : Math.min(first, today)
  const { grain, buckets } = bucketsOf(from, end)
  const n = buckets.length
  const fromHour = utcHour(from)
  const endHour = utcHour(end)

  const before = await records.under<{ hour: string; open: Open }>('hrev', '', { after: turned(fromHour), limit: 1 })
  const final: Open = { stale: counts[OPEN_COUNTERS.stale] ?? 0, changed: counts[OPEN_COUNTERS.changed] ?? 0, unknown: counts[OPEN_COUNTERS.unknown] ?? 0, archived: counts[OPEN_COUNTERS.archived] ?? 0 }

  const put = { brought: zeros(n), made: zeros(n) }
  const sessions = new Map<string, number[]>()
  const agents = new Map<string, AgentCounts>()
  const owner = emptyOwner()
  const order = { archived: 0, takenBack: 0, purged: 0, changes: 0 }
  const reuse = { fromLibrary: 0, otherSession: 0, otherAgent: 0, byBucket: { otherSession: zeros(n), made: zeros(n) } }
  const uses = new Map<string, { n: number; by: Set<string> }>()
  const samples: (Open | undefined)[] = []
  let current: Open | null = null
  let at = 0
  let last = -1
  for await (const page of pagesOf<HourRow>(records, 'stats', 'h:', 1000, hourKey(utcHour(hourStart(fromHour) - 3_600_000)))) {
    for (const { value: row } of page) {
      if (row.hour >= endHour) break
      const t = hourStart(row.hour)
      while (at + 1 < n && t >= (buckets[at + 1] as Bucket).start) samples[at++] = current ?? undefined
      last = at
      if (row.open) current = row.open
      put.brought[at] = (put.brought[at] ?? 0) + row.put.brought
      put.made[at] = (put.made[at] ?? 0) + row.put.made
      reuse.byBucket.made[at] = (reuse.byBucket.made[at] ?? 0) + row.put.made
      reuse.byBucket.otherSession[at] = (reuse.byBucket.otherSession[at] ?? 0) + row.reuse.otherSession
      reuse.fromLibrary += row.reuse.fromLibrary
      reuse.otherSession += row.reuse.otherSession
      reuse.otherAgent += row.reuse.otherAgent
      for (const [name, k] of Object.entries(row.sessions)) {
        const list = sessions.get(name) ?? zeros(n)
        sessions.set(name, list)
        list[at] = (list[at] ?? 0) + k
      }
      for (const [name, c] of Object.entries(row.agents)) {
        const into = agents.get(name) ?? emptyAgent()
        agents.set(name, into)
        for (const key of Object.keys(c) as (keyof AgentCounts)[]) into[key] += c[key]
      }
      for (const key of Object.keys(owner) as (keyof OwnerRow)[]) owner[key] += row.owner[key]
      for (const key of Object.keys(order) as (keyof typeof order)[]) order[key] += row.order[key]
      for (const [id, u] of Object.entries(row.uses)) {
        const into = uses.get(id) ?? { n: 0, by: new Set<string>() }
        uses.set(id, into)
        into.n += u.n
        for (const name of Object.keys(u.by)) into.by.add(name)
      }
    }
  }
  const start = last === -1 ? final : (before.rows[0]?.value.open ?? ZERO)
  let carry = start
  const byBucket = buckets.map((_, i) => {
    if (i >= Math.max(0, last)) return final
    carry = samples[i] ?? carry
    return carry
  })

  // The most built-upon things, as the rows name them now; one removed since is left out.
  const ranked = [...uses].filter(([, u]) => u.n > 0).sort((a, b) => b[1].n - a[1].n)
  const top: Stats['reuse']['top'] = []
  for (let i = 0; i < ranked.length && top.length < TOP * 4; i += TOP * 4) {
    const chunk = ranked.slice(i, i + TOP * 4)
    const rows = new Map((await records.get<ItemRow>('items', chunk.map(([id]) => id))).rows.map((r) => [r.key, r.value]))
    for (const [id, u] of chunk) {
      const item = rows.get(id)
      if (item && !item.removed) top.push({ item: id as ItemId, path: item.path, uses: u.n, by: [...u.by].sort() })
    }
  }
  top.sort((a, b) => b.uses - a.uses || (a.path < b.path ? -1 : 1))

  const names = new Set([...sessions.keys(), ...agents.keys()])
  const agentRows: AgentRow[] = [...names].map((name) => {
    const c = agents.get(name) ?? emptyAgent()
    const s = sum(sessions.get(name) ?? [])
    return { name, sessions: s, ...c, pending: c.asked - c.approved - c.refused - c.declined - c.withdrawn }
  })
  const byAgent = [...sessions].map(([agent, list]) => ({ agent, total: sum(list), byBucket: list })).sort((a, b) => b.total - a.total || (a.agent < b.agent ? -1 : 1))
  const made = sum(put.made)
  return {
    period,
    from: new Date(from).toISOString() as Instant,
    to: now,
    grain,
    buckets: buckets.map((b) => b.label),
    facts: counts.facts ?? 0,
    put: { brought: sum(put.brought), made, byBucket: put },
    sessions: { total: sum(byAgent.map((a) => a.total)), byAgent },
    reuse: {
      made,
      fromLibrary: reuse.fromLibrary,
      otherSession: reuse.otherSession,
      otherAgent: reuse.otherAgent,
      byBucket: { otherSession: reuse.byBucket.otherSession, rest: reuse.byBucket.made.map((m, i) => m - (reuse.byBucket.otherSession[i] ?? 0)) },
      top: top.slice(0, TOP),
    },
    agents: agentRows.sort((a, b) => b.sessions - a.sessions || b.brought + b.made - (a.brought + a.made) || (a.name < b.name ? -1 : 1)),
    owner,
    order: { now: final, start, byBucket, ...order },
  }
}
