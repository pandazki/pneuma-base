// The statistics as a page and as the text of `ledger stats`: the four questions in order, each a
// sentence with its numbers, then a chart where the shape over time says something. The command's
// text is read off the page's own blocks, so the two say the same. Pure.
import { originalPath, regionOf, type Block, type Cell, type ChartSeries, type ViewAnswer } from '@pneuma-base/kernel'
import { itemLink } from './ui.js'
import { PERIODS, type AgentRow, type Open, type Stats } from './stats.js'

/** The sessions chart's series: the agents with most sessions, the rest as one. */
const SESSION_SERIES = 3

const md = (at: string) => `${new Date(at).getMonth() + 1}月${new Date(at).getDate()}日`
const sinceDay = (s: Stats) => (new Date(s.from).getFullYear() === new Date(s.to).getFullYear() ? md(s.from) : `${new Date(s.from).getFullYear()}年${md(s.from)}`)
/** The period as a sentence opens: 这 7 天, 这 30 天, 11月2日以来. */
const span = (s: Stats) => (s.period === 'all' ? `${sinceDay(s)}以来` : `这 ${s.period === '7d' ? 7 : 30} 天`)
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
  const { brought, made } = s.put
  const put = brought + made === 0 ? `${span(s)}没有放进新东西。` : `${span(s)}放进 ${brought + made} 样东西：带进来 ${brought} 样，做出来 ${made} 样。`
  const agents = s.sessions.byAgent
  const visits = agents.length === 0 ? `${span(s)}没有 agent 来过。` : `${agents.length} 个 agent 来过 ${s.sessions.total} 次会话：${agents.map((a) => `${a.agent} ${a.total} 次`).join('，')}。`
  const top = agents.length > SESSION_SERIES + 1 ? agents.slice(0, SESSION_SERIES) : agents
  const rest = agents.slice(top.length)
  const series = [
    ...top.map((a) => ({ label: a.agent, values: a.byBucket })),
    ...(rest.length > 0 ? [{ label: `其他 ${rest.length} 个`, values: s.buckets.map((_, i) => sum(rest.map((a) => a.byBucket[i] ?? 0))) }] : []),
  ]
  return section('用起来了吗', null, [
    chartOr(s, put, 'stacked', '样', [
      { label: '带进来的', values: s.put.byBucket.brought },
      { label: '做出来的', values: s.put.byBucket.made },
    ]),
    agents.length === 0 ? text(visits) : chartOr(s, visits, 'stacked', '次', series),
  ])
}

// ---- 2. is earlier work built on ----

function builtOn(s: Stats): Block {
  const r = s.reuse
  if (r.made === 0) return section('以前的东西被接着用了吗', null, [text(`${span(s)}没有做出来新东西。`)])
  const sentence = `${span(s)}做出来的 ${r.made} 样里，${r.fromLibrary} 样依据了库里已有的东西；${r.otherSession} 样用了别的会话留下的（${percent(r.otherSession, r.made)}），${r.otherAgent} 样用了别的 agent 带来或做出的（${percent(r.otherAgent, r.made)}）。`
  const chart = chartOr(s, sentence, 'stacked', '样', [
    { label: '用了别的会话留下的', values: r.byBucket.otherSession },
    { label: '其余做出来的', values: r.byBucket.rest },
  ])
  const top: Block[] =
    r.top.length === 0
      ? []
      : [
          section('被接着用得最多的', null, [
            {
              kind: 'list',
              items: r.top.map((t) => {
                // An archived thing by the path people know it by, as the library page shows it.
                const shown = regionOf(t.path) === 'archive' ? originalPath(t.path) : null
                const cell: Cell = { text: shown ?? t.path, mono: true, icon: 'file', link: itemLink(t.path), ...(shown === null ? {} : { tag: { text: '已归档', tone: 'neutral' as const } }) }
                return { cell, note: `被 ${t.uses} 样新做的东西依据 · ${t.by.join('、')}`, actions: [] }
              }),
            },
          ]),
        ]
  return section('以前的东西被接着用了吗', null, [chart, ...top])
}

// ---- 3. who did what ----

/** The parts of a line that have something to say, joined. */
const parts = (list: [number, string][]) => list.filter(([n]) => n > 0).map(([, t]) => t)

function agentLine(a: AgentRow): string {
  const asked =
    a.asked === 0
      ? []
      : [
          `请主人做 ${a.asked} 件：${parts([
            [a.approved, `批准 ${a.approved} 件`],
            [a.refused, `批准了但命令没做成 ${a.refused} 件`],
            [a.declined, `拒绝 ${a.declined} 件`],
            [a.withdrawn, `自己撤回 ${a.withdrawn} 件`],
            [a.pending, `还在等 ${a.pending} 件`],
          ]).join('，')}`,
        ]
  const did = parts([
    [a.brought, `带进来 ${a.brought} 样`],
    [a.made, `做出来 ${a.made} 样`],
    [a.decided, `决定 ${a.decided} 条`],
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
    [o.commands, `做了 ${o.commands} 次操作${decided.length > 0 ? `，其中${decided.join('、')}` : ''}`],
    [o.brought + o.made, `放进 ${o.brought + o.made} 样`],
    [o.said, `记了 ${o.said} 条决定和备注`],
    [o.registered, `一次登记了原有的 ${o.registered} 样`],
  ])
  return line.length === 0 ? null : line.join(' · ')
}

function whoDid(s: Stats): Block {
  const owner = ownerLine(s)
  const items = [
    ...s.agents.map((a) => ({ cell: { text: a.name, actor: { kind: 'agent' as const, name: a.name } }, note: agentLine(a), actions: [] })),
    ...(owner === null ? [] : [{ cell: { text: '主人', actor: { kind: 'owner' as const, name: '主人' } }, note: owner, actions: [] }]),
  ]
  return section('谁做了什么', null, items.length === 0 ? [text(`${span(s)}没有谁在库里做过事。`)] : [{ kind: 'list', items }])
}

// ---- 4. is it kept in order ----

const open = (o: Open) => o.stale + o.changed + o.unknown

function inOrder(s: Stats): Block {
  const { now, start } = s.order
  const what = parts([
    [now.stale, `可能过期 ${now.stale} 样`],
    [now.changed, `直接改过、还没人认的 ${now.changed} 样`],
    [now.unknown, `来历不明 ${now.unknown} 样`],
  ])
  const state = what.length === 0 ? '现在没有要收拾的：没有可能过期、没人认的直接改动或来历不明的东西。' : `现在要收拾的有 ${open(now)} 样：${what.join('，')}。`
  const moved = `${span(s)}开始时要收拾的有 ${open(start)} 样，现在 ${open(now)} 样。`
  const series = [
    { label: '可能过期', values: s.order.byBucket.map((o) => o.stale) },
    { label: '没人认的直接改动', values: s.order.byBucket.map((o) => o.changed) },
    { label: '来历不明', values: s.order.byBucket.map((o) => o.unknown) },
  ]
  const kept = parts([
    [s.order.archived, `归档 ${s.order.archived} 样`],
    [s.order.takenBack, `取回 ${s.order.takenBack} 样`],
    [s.order.purged, `清掉 ${s.order.purged} 样`],
    [s.order.changes, `记下直接改动 ${s.order.changes} 次`],
  ])
  const archive = `已归档 ${now.archived} 样${kept.length === 0 ? '' : `；${span(s)}${kept.join('，')}`}。`
  return section('库收拾得怎么样', '按账上的记录算；文件现在和记录对不对得上，看「状况」。', [text(state), chartOr(s, moved, 'line', '样', series), text(archive)])
}

// ---- the page and its text ----

const periodLabel = (s: Stats) => PERIODS.find((p) => p.value === s.period)?.label ?? s.period

/** The page: the four questions, or one sentence for a library with nothing recorded yet. */
export function statsAnswer(s: Stats): ViewAnswer {
  const filters = [{ name: 'period', options: PERIODS.map((p) => ({ value: p.value, label: p.label })) }]
  if (s.facts === 0) {
    const hint = 'agent 放东西、说在做什么，主人做操作，都会算进这里：用起来了吗，以前的东西被接着用了吗，谁做了什么，库收拾得怎么样。'
    return { title: '统计', subtitle: null, blocks: [{ kind: 'empty', title: '还没有可以统计的记录', hint }], filters }
  }
  return { title: '统计', subtitle: `${sinceDay(s)} 到今天`, blocks: [used(s), builtOn(s), whoDid(s), inOrder(s)], filters }
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
export function statsText(s: Stats, answer: ViewAnswer = statsAnswer(s)): string {
  const head = `# 统计 · ${periodLabel(s)}${answer.subtitle === null ? '' : `（${answer.subtitle}）`}`
  return [head, ...answer.blocks.flatMap((b) => linesOf(b, 2))].join('\n')
}
