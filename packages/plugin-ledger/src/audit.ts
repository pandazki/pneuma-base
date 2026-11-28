// What the owner takes out of the ledger: the statistics as text (`ledger stats`, which an agent may
// run too), and every row of the activity as a file outside the library (`ledger export`).
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineCommand, type Grant, type OwnerAnswer, type PluginContext } from '@pneuma-base/kernel'
import { createOutside } from './export-file.js'
import { requestOf, type Fact } from './facts.js'
import { whoseOf } from './feeds.js'
import { stateOf } from './look.js'
import { lookupOf } from './queries.js'
import { pagesOf } from './rows.js'
import { DEFAULT_PERIOD, isPeriod, PERIODS, statsFrom } from './stats.js'
import { statsText } from './stats-page.js'
import { factLine, who, type Lookup } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

export const LEDGER_STATS = defineCommand({
  name: 'ledger stats',
  summary: '统计：使用情况、复用情况、操作分布、资料库健康度',
  params: { flags: [{ name: 'period', hint: '时间', kind: 'value', options: PERIODS }] },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run({ period }, ctx) {
    await stateOf(ctx)
    const stats = await statsFrom(ctx.tools.storage.records, isPeriod(period) ? period : DEFAULT_PERIOD, ctx.now)
    return done(statsText(stats), stats)
  },
})

// ---- the export ----

/** How many rows of the log one page of the export reads. */
const EXPORT_PAGE = 1000

/** The columns of an exported row, in order: names that stay as they are. */
export const EXPORT_COLUMNS = ['id', 'at', 'actor', 'actor_kind', 'grant', 'session', 'kind', 'path', 'text', 'whose', 'request'] as const
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string>

/** The library path a fact is about: the one it records, where it records one; else where that thing is now. */
function pathOf(lookup: Lookup, f: Fact): string {
  if (f.kind === 'item.enter') return f.path
  if (f.kind === 'item.move') return f.to
  const id = 'item' in f ? f.item : f.kind === 'said' ? f.about : null
  return id === null ? '' : (lookup.items.get(id)?.path ?? '')
}

/** One fact as a row: what the activity page shows of it, in columns. */
function rowOf(lookup: Lookup, f: Fact, grants: readonly Grant[]): ExportRow {
  const grant = f.actor.grant === null ? '' : (grants.find((g) => g.id === f.actor.grant)?.name ?? f.actor.grant)
  return {
    id: f.id,
    at: f.at,
    actor: who(f.actor),
    actor_kind: f.actor.kind,
    grant,
    session: f.scene,
    kind: f.kind,
    path: pathOf(lookup, f),
    text: factLine(lookup, f),
    whose: whoseOf(f) ?? '',
    request: requestOf(f) ?? '',
  }
}

/**
 * The activity's rows, newest first as the activity shows them, from `since` (inclusive) to `until`
 * (exclusive), in milliseconds (null leaves that side open): read from the log a page at a time, each
 * page's paths as they are now, read from the rows for that page alone.
 */
export async function* exportRows(ctx: PluginContext, grants: readonly Grant[], since: number | null, until: number | null): AsyncGenerator<ExportRow[]> {
  const records = ctx.tools.storage.records
  for await (const page of pagesOf<Fact>(records, 'log', '', EXPORT_PAGE)) {
    const facts = page.map((r) => r.value)
    const kept = facts.filter((f) => {
      const t = Date.parse(f.at)
      return (since === null || t >= since) && (until === null || t < until)
    })
    const lookup = await lookupOf(records, kept)
    if (kept.length > 0) yield kept.map((f) => rowOf(lookup, f, grants))
    // Newest first: past the start of the span there is nothing more to give.
    if (since !== null && facts.some((f) => Date.parse(f.at) < since)) return
  }
}

/** A CSV field: quoted when it holds a comma, a quote or a line break, a quote doubled. */
const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** The head of the file: CSV's byte-order mark, so spreadsheets read it as UTF-8, and its header; nothing for JSON Lines. */
export const exportHead = (format: 'jsonl' | 'csv') => (format === 'jsonl' ? '' : `\uFEFF${EXPORT_COLUMNS.join(',')}\r\n`)

/** Rows as lines of the file: JSON Lines, or CSV with CRLF line ends. */
export function exportText(rows: readonly ExportRow[], format: 'jsonl' | 'csv'): string {
  if (format === 'jsonl') return rows.map((r) => `${JSON.stringify(r)}\n`).join('')
  return rows.map((r) => `${EXPORT_COLUMNS.map((c) => field(r[c])).join(',')}\r\n`).join('')
}

/** A moment as written: a day (`2026-11-20`) is that day in local time, from its start or, for an end, through its end; else an ISO time. */
function momentOf(input: string, end: boolean): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0)).getTime()
  const t = Date.parse(input)
  return Number.isNaN(t) ? null : t
}

const FORMATS = [
  { value: 'jsonl', label: 'JSON Lines（每行一条记录）' },
  { value: 'csv', label: 'CSV（可用表格软件打开）' },
]

export const LEDGER_EXPORT = defineCommand({
  name: 'ledger export',
  act: { kind: 'exported', object: 'to' },
  summary: '将活动中的全部记录导出到外部文件，用于审计',
  params: {
    flags: [
      { name: 'to', hint: '外部文件', kind: 'value', required: true },
      { name: 'since', hint: '开始时间', kind: 'value' },
      { name: 'until', hint: '结束时间', kind: 'value' },
      { name: 'format', hint: '格式', kind: 'value', options: FORMATS },
    ],
  },
  destructive: false,
  ownerOnly: true,
  async run({ to, since, until, format }, ctx) {
    const from = since === null ? null : momentOf(since, false)
    const till = until === null ? null : momentOf(until, true)
    if (from === null && since !== null) return refused('bad-moment', `--since 需为日期（2026-11-20）或时刻（2026-11-20T09:00）：${since}`)
    if (till === null && until !== null) return refused('bad-moment', `--until 需为日期（2026-11-30）或时刻（2026-11-30T18:00）：${until}`)
    const path = resolve(ctx.session.cwd, to === '~' || to.startsWith('~/') ? `${homedir()}${to.slice(1)}` : to)
    const inside = relative(ctx.library.root, path)
    if (!inside.startsWith('..') && !isAbsolute(inside)) return refused('inside-library', `导出文件须位于资料库之外，${to} 在资料库中。请使用外部路径，例如 ~/Desktop/pneuma-base-活动.csv。`)
    const kind = format === 'csv' || format === 'jsonl' ? format : path.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl'
    await stateOf(ctx)
    const file = await createOutside(path)
    if (file === null) return refused('would-overwrite', `${path} 已存在，未修改。请使用其他文件名。`)
    let n = 0
    try {
      await file.write(exportHead(kind))
      for await (const rows of exportRows(ctx, ctx.library.config.grants, from, till)) {
        await file.write(exportText(rows, kind))
        n += rows.length
      }
    } finally {
      await file.close()
    }
    return done(`已将 ${n} 条记录导出到 ${path}（${kind === 'csv' ? 'CSV' : 'JSON Lines'}）。`, { to: path, format: kind, rows: n, columns: EXPORT_COLUMNS })
  },
})
