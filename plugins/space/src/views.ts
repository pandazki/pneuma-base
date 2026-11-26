// What PneumaSpace adds to the kit's page and item panel: its live columns and fields, a preview of
// the served page and the release history; and its own page, the board (ui/board.html). All of it
// is drawn from the detail `serving` gave each site. The release history is read-only: which content
// is online is the library's.
import { instant, type Block, type Cell, type TableColumn, type Tag } from '@pneuma-base/sdk'
import { STATUS, switchAction, type Look } from '@pneuma-base/sdk/kit'
import type { AppDetail, AppSummary } from './space.ts'

/** What `serving` read about a site: its row in the app list, its detail, whether this library owns it, its requests per hour (only for a drawn answer). */
export type Seen = { summary: AppSummary; detail: AppDetail | null; mine: boolean; spark: number[] | null }

const dash: Cell = { text: '—', muted: true }
/** The app as PneumaSpace serves it for this library; undefined when it does not. */
const live = (s: Seen | null) => (s?.mine && s.detail?.status === 'registered' ? s : undefined)
const takenBy = (s: Seen | null) => (s?.detail && !s.mine ? s.detail.owner : null)

export const LIVE_COLUMNS: TableColumn[] = [
  { key: 'release', label: '版本' },
  { key: 'requests', label: '24 小时请求', optional: true },
  { key: 'lastAccess', label: '最近访问', optional: true },
]

const cell = {
  release: (s: Seen | null): Cell => {
    if (takenBy(s)) return { text: '', tag: { text: '名字被占用', tone: 'bad' } }
    const n = live(s)?.summary.release
    return n == null ? dash : { text: `第 ${n} 版` }
  },
  requests: (s: Seen | null): Cell => {
    const row = live(s)?.summary
    if (row?.requests == null) return dash
    return { text: `${row.requests}${row.errors ? ` · 错 ${row.errors}` : ''}` }
  },
  lastAccess: (s: Seen | null): Cell => {
    const at = live(s)?.summary.lastAccessAt
    if (at == null) return live(s) ? { text: '没人访问过', muted: true } : dash
    return { text: instant(at), at: instant(at) }
  },
}

export const liveCells = (s: Seen | null): Record<string, Cell> => ({ release: cell.release(s), requests: cell.requests(s), lastAccess: cell.lastAccess(s) })

export function liveFields(s: Seen | null): { label: string; value: Cell }[] {
  const by = takenBy(s)
  const there: Cell = by ? { text: `属于 ${by}`, mono: true } : s?.detail ? { text: s.detail.status === 'registered' ? '在服务' : '已撤下，发布记录还在' } : { text: '没有这个应用', muted: true }
  return [
    { label: '版本', value: cell.release(s) },
    { label: '24 小时请求', value: cell.requests(s) },
    { label: '最近访问', value: cell.lastAccess(s) },
    { label: 'PneumaSpace 里', value: there },
  ]
}

export function itemBlocks(l: Look, s: Seen | null): Block[] {
  const by = takenBy(s)
  if (by) return [{ kind: 'text', tone: 'bad', text: `应用名 ${l.site} 在 PneumaSpace 上属于 ${by}，不是这个库，所以不发布也不撤下它。换一个前缀，或在 PneumaSpace 上处理那个应用。` }]
  const blocks: Block[] = []
  if (l.status === 'online' && l.url) blocks.push({ kind: 'embed', url: l.url, title: `${l.site} 的线上页面`, height: 320 })
  const releases = s?.detail?.releases ?? []
  if (releases.length > 0) {
    const current = live(s) ? s?.detail?.current : null
    blocks.push({
      kind: 'section',
      title: '发布记录',
      note: '每次内容变了，PneumaSpace 记下新的一版。线上放哪一版跟着库里的内容；要放回旧内容，先在库里取回它。',
      count: releases.length,
      collapse: 'open',
      blocks: [
        {
          kind: 'timeline',
          entries: releases.map((r) => ({
            at: instant(r.publishedAt),
            title: { text: `第 ${r.number} 版` },
            lines: [`内容 ${r.bundle.slice(0, 12)}`],
            tag: r.number === current ? { text: '线上', tone: 'good' as const } : null,
          })),
        },
      ],
      actions: [],
    })
  }
  return blocks
}

/** What ui/board.html draws: a card per switched-on site, then the switched-off ones. `key` also names the site's switch among the block's actions. */
export type BoardData = {
  cards: { key: string; path: string; site: string | null; url: string | null; state: Tag; release: number | null; requests: number | null; errors: number | null; lastAccessAt: number | null; spark: number[] | null }[]
  off: { key: string; path: string; state: Tag }[]
}

/** The board, from every declared thing as it stands; each switch is the kit's, as the plugin `plugin`'s page offers it. */
export function boardBlock(all: readonly Look<Seen>[], plugin: string): Block {
  const shown = all.filter((l) => l.status !== 'archived')
  const actions = Object.fromEntries(
    shown.flatMap((l) => {
      const action = switchAction(plugin, l)
      return action === null ? [] : [[l.thing.id, action]]
    }),
  )
  const data: BoardData = {
    cards: shown
      .filter((l) => l.thing.on)
      .map((l) => {
        const s = live(l.detail)
        return {
          key: l.thing.id,
          path: l.thing.path,
          site: l.site,
          url: l.status === 'online' ? l.url : null,
          state: STATUS[l.status],
          release: s?.summary.release ?? null,
          requests: s?.summary.requests ?? null,
          errors: s?.summary.errors ?? null,
          lastAccessAt: s?.summary.lastAccessAt ?? null,
          spark: s?.spark ?? null,
        }
      }),
    off: shown.filter((l) => !l.thing.on).map((l) => ({ key: l.thing.id, path: l.thing.path, state: STATUS[l.status] })),
  }
  return {
    kind: 'section',
    title: '站点',
    note: '开关开着的站点各一张卡，小图是线上的页面，折线是过去 24 小时每小时的请求；关着的列在后面。',
    count: data.cards.length,
    blocks: [{ kind: 'custom', entry: 'board.html', height: data.cards.length > 0 ? 330 : 60, data, actions }],
    actions: [],
  }
}
