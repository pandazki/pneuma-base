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

/** A group of pages under its label; the first has none. */
export type NavGroup = { label: string | null; views: ListedView[] }

/**
 * The pages in the navigation: the first plugin's on top, the other plugins' under 插件, the
 * kernel's under 库, and the configuration at the bottom, each in the order the server lists them.
 */
export function navGroups(views: ListedView[]): { groups: NavGroup[]; foot: ListedView[] } {
  const shown = views.filter((v) => v.nav)
  const foot = shown.filter((v) => v.by === 'kernel' && v.id === 'config')
  const rest = shown.filter((v) => !foot.includes(v))
  const first = rest[0]?.by
  const parts: [string | null, ListedView[]][] = [
    [null, rest.filter((v) => v.by === first)],
    ['插件', rest.filter((v) => v.by !== first && v.by !== 'kernel')],
    ['库', rest.filter((v) => v.by !== first && v.by === 'kernel')],
  ]
  return { groups: parts.filter(([, vs]) => vs.length > 0).map(([label, vs], i) => ({ label: i === 0 ? null : label, views: vs })), foot }
}

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
  const tabbable = listed.some((v) => v.id === current) ? current : (listed[0]?.id ?? null)
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
      aria-current={v.id === current ? 'page' : undefined}
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
            <div key={g.label ?? i} className="nav-group" role={g.label ? 'group' : undefined} aria-label={g.label ?? undefined}>
              {g.label ? (
                <div className="nav-label" aria-hidden>
                  {g.label}
                </div>
              ) : null}
              {g.views.map(item)}
            </div>
          ))}
          {foot.length > 0 ? <div className="nav-group nav-foot">{foot.map(item)}</div> : null}
        </nav>
      </div>
    </div>
  )
}
