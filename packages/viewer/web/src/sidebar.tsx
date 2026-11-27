// The sidebar, on the page's ground: the library's name with a quiet sign of whether the page keeps
// up by itself, the search field that opens the palette, and the pages in groups. It folds to a
// rail of icons and remembers its width.
import type { ListedView } from '@pneuma-base/kernel'
import { ChevronDown, Copy, PanelLeft, Search, Command } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import type { State } from './api'
import { ViewIcon } from './chrome'
import { Kbd, MAC, Menu } from './controls'
import { IN_SHELL } from './shell'
import { clockTime } from './time'

/** How often the page asks whether the library changed. */
export const POLL_MS = 2000

/** A group of entries in the navigation, set apart from the one above it by a line. */
export type NavGroup = { views: ListedView[] }

/** The view whose entry a view shares, when it names one in the navigation; else none. */
const rootOf = (views: readonly ListedView[], v: ListedView): ListedView | null => {
  const root = v.with === undefined ? undefined : views.find((r) => r.id === v.with && r.nav && r.with === undefined)
  return root ?? null
}

/** The views of the entry `view` belongs to: the one in the navigation first, then those that share it, in the server's order. */
export function entryOf(views: readonly ListedView[], view: string | null): ListedView[] {
  const v = views.find((x) => x.id === view)
  if (!v || !v.nav) return []
  const root = rootOf(views, v) ?? v
  return [root, ...views.filter((x) => x.nav && x !== root && rootOf(views, x) === root)]
}

/**
 * The entries of the navigation: the home page, the first plugin's pages and the kernel's on top; the
 * other plugins' below a line; the configuration at the bottom. A view that shares another's entry
 * has none of its own. Each in the order the server lists them.
 */
export function navGroups(views: ListedView[]): { groups: NavGroup[]; foot: ListedView[] } {
  const shown = views.filter((v) => v.nav && rootOf(views, v) === null)
  const kernel = (id: string) => (v: ListedView) => v.by === 'kernel' && v.id === id
  const foot = shown.filter(kernel('config'))
  const home = shown.filter(kernel('home'))
  const rest = shown.filter((v) => !foot.includes(v) && !home.includes(v))
  const first = rest.find((v) => v.by !== 'kernel')?.by
  const parts = [[...home, ...rest.filter((v) => v.by === first), ...rest.filter((v) => v.by === 'kernel')], rest.filter((v) => v.by !== first && v.by !== 'kernel')]
  return { groups: parts.filter((vs) => vs.length > 0).map((vs) => ({ views: vs })), foot }
}

/** Every page the navigation reaches, top to bottom, each entry's own views after it: the palette goes to them in this order. */
export const navOrder = (views: ListedView[]): ListedView[] => {
  const { groups, foot } = navGroups(views)
  return [...groups.flatMap((g) => g.views), ...foot].flatMap((v) => entryOf(views, v.id))
}

/** The page the app opens on: the first in the navigation. */
export const firstPage = (views: ListedView[]): string | null => navGroups(views).groups[0]?.views[0]?.id ?? null

type Props = {
  state: State
  current: string | null
  rail: boolean
  down: boolean
  changedAt: Date | null
  onSelect(view: string): void
  onSearch(): void
  onToggle(): void
}

export function Sidebar({ state, current, rail, down, changedAt, onSelect, onSearch, onToggle }: Props) {
  const nav = useRef<HTMLElement | null>(null)
  const root = state.library?.root ?? state.dir
  const name = root.split('/').filter(Boolean).at(-1) ?? root
  const { groups, foot } = navGroups(state.views)
  const listed = [...groups.flatMap((g) => g.views), ...foot]
  const here = entryOf(state.views, current)[0]?.id ?? current
  const tabbable = listed.some((v) => v.id === here) ? here : (listed[0]?.id ?? null)
  const fresh = down ? '连不上服务' : changedAt ? `自动更新 · ${clockTime(changedAt)} 有变化` : `自动更新：每 ${POLL_MS / 1000} 秒看一次库有没有变`

  // ↑ ↓ Home End move between the pages; only the current one is in the Tab order.
  const onNavKey = (e: KeyboardEvent) => {
    const items = [...(nav.current?.querySelectorAll<HTMLButtonElement>('.nav-item') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (to === null || at < 0) return
    e.preventDefault()
    items[(to + items.length) % items.length]?.focus()
  }
  const item = (v: ListedView) => (
    <button
      key={v.id}
      type="button"
      className="nav-item"
      aria-current={v.id === here ? 'page' : undefined}
      tabIndex={v.id === tabbable ? 0 : -1}
      data-tip={rail ? v.title : undefined}
      onClick={() => onSelect(v.id)}
    >
      <ViewIcon name={v.icon} />
      <span>{v.title}</span>
    </button>
  )
  const toggle = (
    <button type="button" className="icon-btn side-toggle" aria-label={rail ? '展开侧栏' : '收起侧栏'} data-tip={`${rail ? '展开侧栏' : '收起侧栏'}${MAC ? ' ⌃⌘S' : ''}`} onClick={onToggle}>
      <PanelLeft strokeWidth={1.75} aria-hidden />
    </button>
  )

  return (
    <div className="side" data-chrome>
      <div className="side-inner">
        {IN_SHELL ? (
          <div className="side-top" data-drag>
            {toggle}
          </div>
        ) : null}
        <div className="side-head">
          <Menu
            label="库"
            entries={[
              { label: '复制库的路径', icon: <Copy strokeWidth={1.75} />, onSelect: () => void navigator.clipboard.writeText(root).catch(() => undefined) },
              { label: '命令面板', icon: <Command strokeWidth={1.75} />, keys: MAC ? '⌘K' : 'Ctrl K', onSelect: onSearch },
              'separator',
              { label: rail ? '展开侧栏' : '收起侧栏', icon: <PanelLeft strokeWidth={1.75} />, keys: MAC ? '⌃⌘S' : undefined, onSelect: onToggle },
            ]}
            trigger={({ ref, open, toggle: show, onKeyDown }) => (
              <button ref={ref} type="button" className="lib-btn" aria-haspopup="menu" aria-expanded={open} data-tip={state.library?.shown ?? root} onClick={show} onKeyDown={onKeyDown}>
                <span className="lib-logo" aria-hidden>
                  {[...name][0]?.toUpperCase()}
                </span>
                <span className="lib-name">{name}</span>
                <ChevronDown className="chev" strokeWidth={2} aria-hidden />
              </button>
            )}
          />
          <span key={changedAt?.getTime() ?? 0} className="fresh" role="img" aria-label={fresh} data-tip={fresh} data-down={down || undefined} data-pulse={(changedAt !== null && !down) || undefined} />
          {IN_SHELL ? null : toggle}
        </div>
        <button type="button" className="side-search" aria-label="搜索或前往" data-tip={rail ? '搜索或前往' : undefined} onClick={onSearch}>
          <Search strokeWidth={2} aria-hidden />
          <span>搜索或前往…</span>
          <Kbd keys={['⌘', 'K']} />
        </button>
        <nav ref={nav} aria-label="导航" className="side-nav" onKeyDown={onNavKey}>
          {groups.map((g, i) => (
            <div key={i} className="nav-group">
              {g.views.map(item)}
            </div>
          ))}
          {foot.length > 0 ? <div className="nav-group nav-foot">{foot.map(item)}</div> : null}
        </nav>
      </div>
    </div>
  )
}
