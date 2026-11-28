// The statistics as a page and as the text of `ledger stats`: the four questions in order, each a
// sentence with its numbers, then a chart where the shape over time says something. The command's
// text is read off the page's own blocks, so the two say the same. Pure.
import { originalPath, regionOf, type Block, type Cell, type ChartSeries, type ViewAnswer } from '@pneuma-base/kernel'
import { itemLink, ME } from './ui.js'
import { OWNER_KEY, PERIODS, type AgentRow, type Open, type Stats } from './stats.js'
import { OWNER } from './views.js'

/** The sessions chart's series: the agents with most sessions, the rest as one. */
const SESSION_SERIES = 3

const md = (at: string) => `${new Date(at).getMonth() + 1}月${new Date(at).getDate()}日`
const sinceDay = (s: Stats) => (new Date(s.from).getFullYear() === new Date(s.to).getFullYear() ? md(s.from) : `${new Date(s.from).getFullYear()}年${md(s.from)}`)
/** The period as a sentence opens: 近 7 天, 近 30 天, 11月2日以来. */
const span = (s: Stats) => (s.period === 'all' ? `${sinceDay(s)}以来` : `近 ${s.period === '7d' ? 7 : 30} 天`)
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`
const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0)
const text = (t: string): Block => ({ kind: 'text', text: t, tone: 'neutral' })
const section = (title: string, note: string | null, blocks: Block[]): Block => ({ kind: 'section', title, note, count: null, blocks, actions: [] })

/** A chart when it has a shape to show, more than one bucket and some bar, or a line that moves; else its sentence alone. */
function chartOr(s: Stats, sentence: string, form: 'stacked' | 'line', unit: string, series: ChartSeries[]): Block {
  const shape = s.buckets.length > 1 && series.some((x) => x.values.some((v) => v !== (form === 'line' ? x.values[0] : 0)))
  return shape ? { kind: 'chart', form, text: sentence, unit, x: s.buckets, series } : text(sentence)
}

// ---- 1. is it used ----

function used(s: Stats): Block {
  const { imported, generated } = s.put
  const put = imported + generated === 0 ? `${span(s)}无新增条目。` : `${span(s)}新增 ${imported + generated} 个条目：导入 ${imported} 个，生成 ${generated} 个。`
  const agents = s.sessions.byAgent
  const visits = agents.length === 0 ? `${span(s)}无 Agent 访问。` : `${agents.length} 个 Agent 共 ${s.sessions.total} 次会话：${agents.map((a) => `${a.agent} ${a.total} 次`).join('，')}。`
  const top = agents.length > SESSION_SERIES + 1 ? agents.slice(0, SESSION_SERIES) : agents
  const rest = agents.slice(top.length)
  const series = [
    ...top.map((a) => ({ label: a.agent, values: a.byBucket })),
    ...(rest.length > 0 ? [{ label: `其他 ${rest.length} 个`, values: s.buckets.map((_, i) => sum(rest.map((a) => a.byBucket[i] ?? 0))) }] : []),
  ]
  return section('使用情况', null, [
    chartOr(s, put, 'stacked', '个', [
      { label: '导入', values: s.put.byBucket.imported },
      { label: '生成', values: s.put.byBucket.generated },
    ]),
    agents.length === 0 ? text(visits) : chartOr(s, visits, 'stacked', '次', series),
  ])
}

// ---- 2. is earlier work built on ----

function builtOn(s: Stats, owner: string): Block {
  const r = s.reuse
  if (r.generated === 0) return section('复用情况', null, [text(`${span(s)}无新生成的条目。`)])
  const sentence = `${span(s)}生成的 ${r.generated} 个条目中，${r.fromLibrary} 个依据了资料库中已有的条目；${r.otherSession} 个引用了其他会话的条目（${percent(r.otherSession, r.generated)}），${r.otherAgent} 个引用了其他 Agent 导入或生成的条目（${percent(r.otherAgent, r.generated)}）。`
  const chart = chartOr(s, sentence, 'stacked', '个', [
    { label: '引用其他会话的条目', values: r.byBucket.otherSession },
    { label: '其余为生成', values: r.byBucket.rest },
  ])
  const top: Block[] =
    r.top.length === 0
      ? []
      : [
          section('被引用最多', null, [
            {
              kind: 'list',
              items: r.top.map((t) => {
                // An archived thing by the path people know it by, as the library page shows it.
                const shown = regionOf(t.path) === 'archive' ? originalPath(t.path) : null
                const cell: Cell = { text: shown ?? t.path, mono: true, icon: 'file', link: itemLink(t.path), ...(shown === null ? {} : { tag: { text: '已归档', tone: 'neutral' as const } }) }
                return { cell, note: `被 ${t.uses} 个新生成的条目引用 · ${t.by.map((name) => (name === OWNER_KEY ? owner : name)).join('、')}`, actions: [] }
              }),
            },
          ]),
        ]
  return section('复用情况', null, [chart, ...top])
}

// ---- 3. who did what ----

/** The parts of a line that have something to say, joined. */
const parts = (list: [number, string][]) => list.filter(([n]) => n > 0).map(([, t]) => t)

function agentLine(a: AgentRow): string {
  const asked =
    a.asked === 0
      ? []
      : [
          `请求 ${a.asked} 项：${parts([
            [a.approved, `已批准 ${a.approved} 项`],
            [a.refused, `批准后执行失败 ${a.refused} 项`],
            [a.declined, `已拒绝 ${a.declined} 项`],
            [a.withdrawn, `已撤回 ${a.withdrawn} 项`],
            [a.pending, `待处理 ${a.pending} 项`],
          ]).join('，')}`,
        ]
  const did = parts([
    [a.imported, `导入 ${a.imported} 个`],
    [a.generated, `生成 ${a.generated} 个`],
    [a.decisions, `决策 ${a.decisions} 条`],
    [a.notes, `备注 ${a.notes} 条`],
  ])
  return [`${a.sessions} 次会话`, ...did, ...asked].join(' · ')
}

function ownerLine(s: Stats): string | null {
  const o = s.owner
  const decided = parts([
    [o.approved, `批准 ${o.approved} 个请求`],
    [o.declined, `拒绝 ${o.declined} 个`],
  ])
  const line = parts([
    [o.commands, `执行 ${o.commands} 次操作${decided.length > 0 ? `，其中${decided.join('、')}` : ''}`],
    [o.imported + o.generated, `添加 ${o.imported + o.generated} 个条目`],
    [o.said, `添加 ${o.said} 条决策和备注`],
    [o.registered, `批量登记原有文件 ${o.registered} 个`],
  ])
  return line.length === 0 ? null : line.join(' · ')
}

function whoDid(s: Stats, owner: string): Block {
  const line = ownerLine(s)
  const items = [
    ...s.agents.map((a) => ({ cell: { text: a.name, actor: { kind: 'agent' as const, name: a.name } }, note: agentLine(a), actions: [] })),
    ...(line === null ? [] : [{ cell: { text: owner, actor: { kind: 'owner' as const, name: owner } }, note: line, actions: [] }]),
  ]
  return section('操作分布', null, items.length === 0 ? [text(`${span(s)}暂无操作。`)] : [{ kind: 'list', items }])
}

// ---- 4. is it kept in order ----

const open = (o: Open) => o.stale + o.changed + o.unknown

function inOrder(s: Stats): Block {
  const { now, start } = s.order
  const what = parts([
    [now.stale, `可能已过期 ${now.stale} 个`],
    [now.changed, `未确认的外部修改 ${now.changed} 个`],
    [now.unknown, `来源未知 ${now.unknown} 个`],
  ])
  const state = what.length === 0 ? '当前无待处理条目：无可能已过期、未确认的外部修改或来源未知的条目。' : `当前待处理 ${open(now)} 个：${what.join('，')}。`
  const moved = `${span(s)}开始时待处理 ${open(start)} 个，当前 ${open(now)} 个。`
  const series = [
    { label: '可能已过期', values: s.order.byBucket.map((o) => o.stale) },
    { label: '未确认的外部修改', values: s.order.byBucket.map((o) => o.changed) },
    { label: '来源未知', values: s.order.byBucket.map((o) => o.unknown) },
  ]
  const kept = parts([
    [s.order.archived, `归档 ${s.order.archived} 个`],
    [s.order.takenBack, `取消归档 ${s.order.takenBack} 个`],
    [s.order.purged, `清除 ${s.order.purged} 个`],
    [s.order.changes, `记录外部修改 ${s.order.changes} 次`],
  ])
  const archive = `已归档 ${now.archived} 个${kept.length === 0 ? '' : `；${span(s)}${kept.join('，')}`}。`
  return section('资料库健康度', '按溯源记录计算；文件与记录是否一致，见「状态」页。', [text(state), chartOr(s, moved, 'line', '个', series), text(archive)])
}

// ---- the page and its text ----

const periodLabel = (s: Stats) => PERIODS.find((p) => p.value === s.period)?.label ?? s.period

/**
 * The page: the four questions, or one sentence for a library with nothing recorded yet. `owner`: how
 * the owner is named, 我 on the page and 所有者 in the command's text.
 */
export function statsAnswer(s: Stats, owner = ME): ViewAnswer {
  const filters = [{ name: 'period', options: PERIODS.map((p) => ({ value: p.value, label: p.label })) }]
  if (s.facts === 0) {
    const hint = `Agent 添加条目、说明任务，以及${owner}执行的操作，均计入统计：使用情况、复用情况、操作分布、资料库健康度。`
    return { title: '统计', subtitle: null, blocks: [{ kind: 'empty', title: '暂无可统计的记录', hint }], filters }
  }
  // The period is the chosen tab, and each chart's axis says its days.
  return { title: '统计', subtitle: null, blocks: [used(s), builtOn(s, owner), whoDid(s, owner), inOrder(s)], filters }
}

function linesOf(block: Block, depth: number): string[] {
  switch (block.kind) {
    case 'section':
      return ['', `${'#'.repeat(depth)} ${block.title}`, ...(block.note === null ? [] : [block.note]), ...block.blocks.flatMap((b) => linesOf(b, depth + 1))]
    case 'text':
    case 'chart':
      return [block.text]
    case 'list':
      return block.items.map((i) => `- ${i.cell.text}${i.note === null ? '' : `：${i.note}`}`)
    case 'empty':
      return [block.title, ...(block.hint === null ? [] : [block.hint])]
    default:
      return []
  }
}

/** The page as `ledger stats` prints it: its sentences and lists, each question under its heading; the numbers by day are in --json and on the page. */
export function statsText(s: Stats, answer: ViewAnswer = statsAnswer(s, OWNER)): string {
  const head = `# 统计 · ${periodLabel(s)}${answer.subtitle === null ? '' : `（${answer.subtitle}）`}`
  return [head, ...answer.blocks.flatMap((b) => linesOf(b, 2))].join('\n')
}
