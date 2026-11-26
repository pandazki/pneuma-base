// What the owner takes out of the ledger: the statistics as text (`ledger stats`, which an agent may
// run too), and every row of the activity as a file outside the library (`ledger export`).
import { mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { defineCommand, type Grant, type OwnerAnswer } from '@pneuma-base/kernel'
import { readFacts, requestOf, type Fact } from './facts.js'
import { told, whoseOf } from './feeds.js'
import { fold, type Ledger } from './fold.js'
import { DEFAULT_PERIOD, isPeriod, PERIODS, statsOf } from './stats.js'
import { statsText } from './stats-page.js'
import { factLine, who } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

export const LEDGER_STATS = defineCommand({
  name: 'ledger stats',
  summary: '统计：用起来了吗，以前的东西被接着用了吗，谁做了什么，库收拾得怎么样',
  params: { flags: [{ name: 'period', hint: '时间', kind: 'value', options: PERIODS }] },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run({ period }, ctx) {
    const stats = statsOf(await readFacts(ctx.dir), isPeriod(period) ? period : DEFAULT_PERIOD, ctx.now)
    return done(statsText(stats), stats)
  },
})

// ---- the export ----

/** The columns of an exported row, in order: names that stay as they are. */
export const EXPORT_COLUMNS = ['id', 'at', 'actor', 'actor_kind', 'grant', 'session', 'kind', 'path', 'text', 'whose', 'request'] as const
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string>

/** The library path a fact is about: the one it records, where it records one; else where that thing is now. */
function pathOf(ledger: Ledger, f: Fact): string {
  if (f.kind === 'item.enter') return f.path
  if (f.kind === 'item.move') return f.to
  const id = 'item' in f ? f.item : f.kind === 'said' ? f.about : null
  return id === null ? '' : (ledger.items.get(id)?.path ?? '')
}

/** One fact as a row: what the activity page shows of it, in columns. */
function rowOf(ledger: Ledger, f: Fact, grants: readonly Grant[]): ExportRow {
  const grant = f.actor.grant === null ? '' : (grants.find((g) => g.id === f.actor.grant)?.name ?? f.actor.grant)
  return {
    id: f.id,
    at: f.at,
    actor: who(f.actor),
    actor_kind: f.actor.kind,
    grant,
    session: f.scene,
    kind: f.kind,
    path: pathOf(ledger, f),
    text: factLine(ledger, f),
    whose: whoseOf(f) ?? '',
    request: requestOf(f) ?? '',
  }
}

/** The activity's rows, newest first, from `since` (inclusive) to `until` (exclusive), in milliseconds; null leaves that side open. */
export function exportRows(ledger: Ledger, grants: readonly Grant[], since: number | null, until: number | null): ExportRow[] {
  return told(ledger.facts)
    .reverse()
    .filter((f) => {
      const t = Date.parse(f.at)
      return (since === null || t >= since) && (until === null || t < until)
    })
    .map((f) => rowOf(ledger, f, grants))
}

/** A CSV field: quoted when it holds a comma, a quote or a line break, a quote doubled. */
const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** The rows as a file: JSON Lines, or CSV with a header, CRLF line ends and a byte-order mark so spreadsheets read it as UTF-8. */
export function exportText(rows: readonly ExportRow[], format: 'jsonl' | 'csv'): string {
  if (format === 'jsonl') return rows.map((r) => `${JSON.stringify(r)}\n`).join('')
  const lines = [EXPORT_COLUMNS.join(','), ...rows.map((r) => EXPORT_COLUMNS.map((c) => field(r[c])).join(','))]
  return `\uFEFF${lines.map((l) => `${l}\r\n`).join('')}`
}

/** A moment as written: a day (`2026-11-20`) is that day in local time, from its start or, for an end, through its end; else an ISO time. */
function momentOf(input: string, end: boolean): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0)).getTime()
  const t = Date.parse(input)
  return Number.isNaN(t) ? null : t
}

const FORMATS = [
  { value: 'jsonl', label: 'JSON Lines，一行一条' },
  { value: 'csv', label: 'CSV，表格能打开' },
]

export const LEDGER_EXPORT = defineCommand({
  name: 'ledger export',
  summary: '把活动里的每一条记录导出到库外的一个文件，给审计用',
  params: {
    flags: [
      { name: 'to', hint: '库外的文件', kind: 'value', required: true },
      { name: 'since', hint: '从哪个时刻起', kind: 'value' },
      { name: 'until', hint: '到哪个时刻', kind: 'value' },
      { name: 'format', hint: '格式', kind: 'value', options: FORMATS },
    ],
  },
  destructive: false,
  ownerOnly: true,
  readOnly: true,
  async run({ to, since, until, format }, ctx) {
    const from = since === null ? null : momentOf(since, false)
    const till = until === null ? null : momentOf(until, true)
    if (from === null && since !== null) return refused('bad-moment', `--since 要写一天（2026-11-20）或一个时刻（2026-11-20T09:00）：${since}`)
    if (till === null && until !== null) return refused('bad-moment', `--until 要写一天（2026-11-30）或一个时刻（2026-11-30T18:00）：${until}`)
    const path = resolve(ctx.session.cwd, to === '~' || to.startsWith('~/') ? `${homedir()}${to.slice(1)}` : to)
    const inside = relative(ctx.library.root, path)
    if (!inside.startsWith('..') && !isAbsolute(inside)) return refused('inside-library', `导出的文件要放在库外，${to} 在库里。换一个库外的路径，比如 ~/Desktop/pneuma-base-活动.csv。`)
    const kind = format === 'csv' || format === 'jsonl' ? format : path.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl'
    const rows = exportRows(fold(await readFacts(ctx.dir)), ctx.library.config.grants, from, till)
    await mkdir(dirname(path), { recursive: true })
    let handle
    try {
      handle = await open(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return refused('would-overwrite', `${path} 已经有文件了，没有动它。换一个文件名。`)
      throw error
    }
    try {
      await handle.writeFile(exportText(rows, kind))
    } finally {
      await handle.close()
    }
    return done(`已把 ${rows.length} 条记录导出到 ${path}（${kind === 'csv' ? 'CSV' : 'JSON Lines'}）。`, { to: path, format: kind, rows: rows.length, columns: EXPORT_COLUMNS })
  },
})
