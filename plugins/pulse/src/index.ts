// The pulse plugin: how busy the library is. Each time something is put into the library or
// archived, it writes one record (who, when, which thing). Its page draws the last 30 days as a
// grid of day cells (ui/heat.html) and lists how many each actor did; the owner can clear the
// records with `pulse clear`, a destructive command.
//
// Records are append-only (PLUGINS.md 3.7): clearing deletes nothing, it appends a clear record, and
// every activity record at or before the latest clear no longer counts. Both kinds are stores of the
// plugin's record place; the kit reads with them what this plugin wrote in activity/ and clears/
// before it kept them there.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTRACT, defineCommand, definePlugin, pluginName, type Action, type Block, type PluginContext } from '@pneuma-base/sdk'
import { recordStore, type Envelope, type RecordActor } from '@pneuma-base/sdk/kit'

const NAME = pluginName('pulse')
const PAGE = `${NAME}.heat`
export const DAYS = 30

/** One counted event: something put into the library (`put`) or archived (`archive`). */
export type Activity = { what: 'put' | 'archive'; path: string }
/** A clear by the owner: activity at or before its `at` no longer counts. */
export type Clear = { cleared: true }

export function parseActivity(raw: Record<string, unknown>): Activity | string {
  return (raw.what === 'put' || raw.what === 'archive') && typeof raw.path === 'string' ? { what: raw.what, path: raw.path } : '不是有效的活动记录'
}
export function parseClear(raw: Record<string, unknown>): Clear | string {
  return raw.cleared === true ? { cleared: true } : '不是有效的清空记录'
}

const activity = (ctx: PluginContext) => recordStore(ctx, 'activity', parseActivity)
const clears = (ctx: PluginContext) => recordStore(ctx, 'clears', parseClear)

/** One record each, written together. */
async function record(ctx: PluginContext, bodies: readonly Activity[]): Promise<void> {
  const store = activity(ctx)
  await store.append(bodies.map((body) => store.stamp(ctx, body)))
}

/** The activity that still counts: after the latest clear. Records synced in later from before it stay cleared. */
export function counted<T extends Envelope>(all: readonly T[], clearAts: readonly string[]): T[] {
  const cut = clearAts.reduce<string | null>((latest, at) => (latest === null || at > latest ? at : latest), null)
  return cut === null ? [...all] : all.filter((r) => r.at > cut)
}

async function current(ctx: PluginContext) {
  const [acts, cls] = await Promise.all([activity(ctx).read(), clears(ctx).read()])
  return counted(acts.records, cls.records.map((c) => c.at))
}

/** Who did it, as a person reads it. */
export const who = (actor: RecordActor): string => (actor.kind === 'owner' ? '我' : actor.name)

/** `YYYY-MM-DD` of a moment in this process's local time. */
/**
 * The heat map in words, from the same days the frame draws: the total, how many days had activity,
 * the busiest one, and the count of each day that had any.
 */
export function heatText(grid: readonly { day: string; count: number }[], total: number): string {
  const label = (d: { day: string; count: number }) => `${Number(d.day.slice(5, 7))} 月 ${Number(d.day.slice(8))} 日`
  const active = grid.filter((d) => d.count > 0)
  const peak = active.reduce<{ day: string; count: number } | null>((best, d) => (best === null || d.count > best.count ? d : best), null)
  const head = `最近 ${DAYS} 天的添加和归档：${total} 次，活跃天数：${active.length}。`
  if (peak === null) return `${head}暂无活动。`
  return [`${head}最活跃的一天：${label(peak)}，${peak.count} 次。`, `每日（按本机时区）：${active.map((d) => `${label(d)} ${d.count} 次`).join('，')}`].join('\n')
}

export function dayOf(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/** The last `DAYS` local days ending today, oldest first, with how many records fall on each. */
export function days(records: readonly Envelope[], now: Date): { day: string; weekday: number; count: number }[] {
  const out: { day: string; weekday: number; count: number }[] = []
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    out.push({ day: dayOf(d), weekday: d.getDay(), count: 0 })
  }
  const index = new Map(out.map((d, i) => [d.day, i]))
  for (const r of records) {
    const i = index.get(dayOf(new Date(r.at)))
    if (i !== undefined) out[i]!.count++
  }
  return out
}

/** Per actor within the window: puts, archives, total; most active first. */
export function byActor(records: readonly (Envelope & Activity)[]) {
  const rows = new Map<string, { name: string; kind: RecordActor['kind']; put: number; archive: number; last: Envelope['at'] }>()
  for (const r of records) {
    const key = `${r.actor.kind}:${r.actor.name}`
    const row = rows.get(key) ?? { name: who(r.actor), kind: r.actor.kind, put: 0, archive: 0, last: r.at }
    row[r.what]++
    if (r.at > row.last) row.last = r.at
    rows.set(key, row)
  }
  return [...rows.entries()].map(([key, r]) => ({ key, ...r, total: r.put + r.archive })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

const clear = defineCommand({
  name: `${NAME} clear`,
  summary: '清空活动热度的全部记录，不可撤销',
  params: {},
  destructive: true,
  ownerOnly: false,
  async run(_args, ctx) {
    const before = (await current(ctx)).length
    const store = clears(ctx)
    await store.append([store.stamp(ctx, { cleared: true })])
    return { outcome: 'done', text: before === 0 ? '无可清空的记录；此后的活动从现在开始计算。' : `已清空 ${before} 条活动记录，此后的活动从现在开始计算。`, data: { cleared: before } }
  },
})

const CLEAR: Action = {
  label: '清空记录',
  tone: 'danger',
  confirm: '清空活动热度的全部记录？此操作不可撤销。',
  inputs: [],
  call: { face: 'owner', command: clear.name, args: { positional: [], flags: {} } },
}

/** src/cognition.md, without the notes to the plugin's author. */
const cognition = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->\n*/g, '')
  .trim()

export default definePlugin({
  contract: CONTRACT,
  name: NAME,
  version: '0.1.0',
  summary: '记录每次添加和归档的执行者、时间和条目，以格子图显示最近 30 天的活动热度。',
  cognition: { title: '活动热度', text: cognition },
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: 'activity', kind: 'body' },
    { dir: 'clears', kind: 'body' },
  ],
  statements: [],
  ownerCommands: [clear],
  views: [{ id: PAGE, title: '活动热度', icon: 'activity', nav: true, filters: [] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  /** Registering or placing a thing counts as putting it in, each loose file of a directory registered once; a move only renames, so it does not count. */
  async onPut(req, ctx) {
    if (req.kind === 'register-files') await record(ctx, req.files.map((f) => ({ what: 'put', path: f.path })))
    else if (req.kind !== 'move') await record(ctx, [{ what: 'put', path: req.path }])
    return null
  },

  /** Archiving counts when something actually moved into the archive; taking it back does not. */
  async onArchive(req, ctx) {
    if (req.kind === 'archive' && req.moved) await record(ctx, [{ what: 'archive', path: req.from }])
    return null
  },

  /** Reads the records and writes nothing. */
  async onView(req, ctx) {
    if (req.view !== PAGE) return { title: '活动热度', subtitle: null, blocks: [{ kind: 'empty', title: '页面不存在', hint: req.view }] }
    const now = new Date(ctx.now)
    const all = await current(ctx)
    const grid = days(all, now)
    const first = grid[0]!.day
    const inWindow = all.filter((r) => dayOf(new Date(r.at)) >= first)
    const actors = byActor(inWindow)
    const total = inWindow.length
    const blocks: Block[] = [
      { kind: 'custom', entry: 'heat.html', height: 190, text: heatText(grid, total), data: { days: grid, total }, actions: {} },
      {
        kind: 'section',
        title: '按执行者',
        note: '最近 30 天，每次添加或归档计一次',
        count: actors.length,
        actions: [],
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'who', label: '执行者' },
              { key: 'total', label: '次数' },
              { key: 'put', label: '添加', optional: true },
              { key: 'archive', label: '归档', optional: true },
              { key: 'last', label: '最近一次', optional: true },
            ],
            rows: actors.map((a) => ({
              key: a.key,
              cells: {
                who: { text: a.name, icon: a.kind === 'owner' ? 'key' : 'users', ...(a.kind === 'owner' ? { muted: true } : {}) },
                total: { text: String(a.total) },
                put: { text: String(a.put) },
                archive: { text: String(a.archive) },
                last: { text: a.last, at: a.last },
              },
              link: null,
              actions: [],
            })),
            empty: '最近 30 天暂无添加或归档',
          },
        ],
      },
      { kind: 'actions', actions: [CLEAR] },
    ]
    // The window moves at midnight without the library changing, so look again now and then.
    return { title: '活动热度', subtitle: `最近 ${DAYS} 天 ${total} 次`, blocks, refresh: 600 }
  },
})
