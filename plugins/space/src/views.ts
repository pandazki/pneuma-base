// What PneumaSpace adds to the kit's page and item panel, the same for both kinds: its live columns and
// fields, the release history, a preview of the served page where one can be framed; and its own page,
// the board (ui/board.html). All of it is drawn from the Seen each kind's `serving` makes of what its
// API answered. The release history is read-only: which content is online is the library's.
import { instant, type Block, type Cell, type TableColumn, type Tag } from '@pneuma-base/sdk'
import { STATUS, switchAction, type Look, type TargetView } from '@pneuma-base/sdk/kit'

export type Release = { number: number; publishedAt: number; content: string }

/** What `serving` read about an app, in the terms both kinds share. */
export type Seen = {
  /** Who holds the app name, in words, when it is not this library; null when this library does. */
  takenBy: string | null
  /** PneumaSpace's status of the app: registered, removed, draft, purging. */
  status: string
  /** The release this library's app serves now, with what PneumaSpace counts of it; null when it serves none. */
  live: { release: number; requests: number | null; errors: number | null; lastAccessAt: number | null } | null
  /** Newest first. */
  releases: Release[]
  /** Requests per hour over the last 24 hours, oldest first; only for a drawn answer, only where the API gives it. */
  spark: number[] | null
  /** The app's upload allowance and what it has used; only for a drawn answer, only where there is one. */
  uploads: { used: number; max: number; bytes: number; limit: number } | null
  /** When PneumaSpace last observed the app's state, where it says. */
  observedAt: number | null
}

/**
 * How one kind of PneumaSpace is shown. `requests`: what its request count covers, as a column label.
 * `framed`: whether its sites load in a frame of the viewer; where not, `visible` says who can see them.
 */
export type Plane = { requests: string; framed: boolean; visible: string | null; refresh?: number }

const dash: Cell = { text: '—', muted: true }
const THERE: Record<string, string> = { registered: '在服务', removed: '已撤下，发布记录还在', draft: '建好了，还没发布过', purging: '正在清除' }

const MiB = 1024 * 1024
const size = (bytes: number) => (bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`)

const cell = {
  release: (s: Seen | null): Cell => {
    if (s?.takenBy) return { text: '', tag: { text: '名字被占用', tone: 'bad' } }
    return s?.live ? { text: `第 ${s.live.release} 版` } : dash
  },
  requests: (s: Seen | null): Cell => {
    const live = s?.live
    if (live?.requests == null) return dash
    return { text: `${live.requests}${live.errors ? ` · 错 ${live.errors}` : ''}` }
  },
  lastAccess: (s: Seen | null): Cell => {
    if (!s?.live) return dash
    const at = s.live.lastAccessAt
    return at === null ? { text: '没人访问过', muted: true } : { text: instant(at), at: instant(at) }
  },
}

function fields(plane: Plane, s: Seen | null): { label: string; value: Cell }[] {
  const there: Cell = s?.takenBy ? { text: s.takenBy } : s ? { text: THERE[s.status] ?? s.status } : { text: '没有这个应用', muted: true }
  return [
    { label: '版本', value: cell.release(s) },
    { label: plane.requests, value: cell.requests(s) },
    { label: '最近访问', value: cell.lastAccess(s) },
    { label: 'PneumaSpace 里', value: there },
    ...(s?.uploads ? [{ label: '上传额度', value: { text: `用了 ${s.uploads.used}/${s.uploads.max} 次，包合计 ${size(s.uploads.bytes)}/${size(s.uploads.limit)}` } }] : []),
    ...(s?.observedAt ? [{ label: '状态取自', value: { text: instant(s.observedAt), at: instant(s.observedAt) } }] : []),
  ]
}

function itemBlocks(plane: Plane, l: Look, s: Seen | null): Block[] {
  if (s?.takenBy) return [{ kind: 'text', tone: 'bad', text: `应用名 ${l.site} 在 PneumaSpace 上已经有了：${s.takenBy}。它不归这个库，所以不发布也不撤下它。换一个前缀，或在 PneumaSpace 上处理那个应用。` }]
  const blocks: Block[] = []
  if (l.status === 'online' && l.url) blocks.push(plane.framed ? { kind: 'embed', url: l.url, title: `${l.site} 的线上页面`, height: 320 } : { kind: 'text', tone: 'neutral', text: plane.visible ?? '' })
  const releases = s?.releases ?? []
  if (releases.length > 0) {
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
            lines: [`内容 ${r.content.slice(0, 12)}`],
            tag: r.number === s?.live?.release ? { text: '线上', tone: 'good' as const } : null,
          })),
        },
      ],
      actions: [],
    })
  }
  return blocks
}

/**
 * What ui/board.html draws: a card per switched-on site, then the switched-off ones. `key` also names
 * the site's switch among the block's actions. `visible`: where a site cannot be framed, the line the
 * card shows in place of its preview.
 */
export type BoardData = {
  cards: { key: string; path: string; site: string | null; url: string | null; state: Tag; release: number | null; requests: number | null; errors: number | null; lastAccessAt: number | null; spark: number[] | null }[]
  off: { key: string; path: string; state: Tag }[]
  visible: string | null
}

/**
 * The board in words, from the same data the frame draws: each card's thing, state, address, release
 * and traffic, and why previews are not shown when they are not; then the things switched off.
 */
export function boardText(data: BoardData, requests: string): string {
  const minute = (at: number) => `${instant(at).slice(0, 10)} ${instant(at).slice(11, 16)}Z`
  const card = (c: BoardData['cards'][number]) =>
    [
      `${c.path}：${c.state.text}`,
      c.url ?? (c.site === null ? null : `站点 ${c.site}`),
      c.release === null ? null : `第 ${c.release} 版`,
      c.requests === null ? null : `${requests} ${c.requests}${c.errors ? `，错 ${c.errors}` : ''}`,
      c.lastAccessAt === null ? null : `最近访问 ${minute(c.lastAccessAt)}`,
      c.spark === null ? null : `过去 24 小时每小时的请求 ${c.spark.join(' ')}`,
    ]
      .filter((part) => part !== null)
      .join(' · ')
  const on = data.cards.length === 0 ? ['还没有打开开关的站点。'] : [...data.cards.map(card), ...(data.visible === null ? [] : [data.visible])]
  const off = data.off.length === 0 ? [] : [`开关关着的：${data.off.map((o) => `${o.path}（${o.state.text}）`).join('、')}`]
  return [...on, ...off].join('\n')
}

/** The board, from every declared thing as it stands; each switch is the kit's, as the plugin `plugin`'s page offers it. */
function boardBlock(plane: Plane, all: readonly Look<Seen>[], plugin: string): Block {
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
        const live = l.detail?.live ?? null
        return {
          key: l.thing.id,
          path: l.thing.path,
          site: l.site,
          url: l.status === 'online' ? l.url : null,
          state: STATUS[l.status],
          release: live?.release ?? null,
          requests: live?.requests ?? null,
          errors: live?.errors ?? null,
          lastAccessAt: live?.lastAccessAt ?? null,
          spark: l.detail?.spark ?? null,
        }
      }),
    off: shown.filter((l) => !l.thing.on).map((l) => ({ key: l.thing.id, path: l.thing.path, state: STATUS[l.status] })),
    visible: plane.framed ? null : plane.visible,
  }
  const picture = plane.framed ? '小图是线上的页面，折线是过去 24 小时每小时的请求' : '地址在新标签页打开'
  return {
    kind: 'section',
    title: '站点',
    note: `开关开着的站点各一张卡，${picture}；关着的列在后面。`,
    count: data.cards.length,
    blocks: [{ kind: 'custom', entry: 'board.html', height: data.cards.length > 0 ? 330 : 60, text: boardText(data, plane.requests), data, actions }],
    actions: [],
  }
}

/** The views of a target on `plane`, for the plugin `plugin`. */
export function viewOf(plane: Plane, plugin: string): TargetView<Seen> {
  const columns: TableColumn[] = [
    { key: 'release', label: '版本' },
    { key: 'requests', label: plane.requests, optional: true },
    { key: 'lastAccess', label: '最近访问', optional: true },
  ]
  return {
    columns,
    cells: (l) => ({ release: cell.release(l.detail), requests: cell.requests(l.detail), lastAccess: cell.lastAccess(l.detail) }),
    fields: (l) => fields(plane, l.detail),
    item: (l) => itemBlocks(plane, l, l.detail),
    pages: { board: (all) => [boardBlock(plane, all, plugin)] },
    ...(plane.refresh === undefined ? {} : { refresh: plane.refresh }),
  }
}
