// The detail panel: a grey tray with a tab for each thing open, and the front one on white paper
// below. ← → Home End move between tabs, Delete closes one; Escape closes the front one (App).
import type { Action, ViewRequest, ViewResult } from '@pneuma-base/kernel'
import { ArrowLeft, PanelRightClose, X } from 'lucide-react'
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ActionBar, useActionKeys } from './actions'
import { ViewIcon } from './chrome'
import { topOf, type Tab } from './route'
import { localMoments } from './time'

/**
 * A tab's name, cut in the middle when it does not fit: a file keeps its extension and the last
 * letters before it, the start gives way at an ellipsis; any other name is cut at its end.
 */
function TabName({ label }: { label: string }) {
  const ext = /\.[\p{L}\p{N}]{1,8}$/u.exec(label)?.[0] ?? ''
  const stem = [...label.slice(0, label.length - ext.length)]
  const kept = ext === '' ? 0 : stem.length > 6 ? 3 : 0
  return (
    <span className="tab-name">
      <span className="tab-name-start">{stem.slice(0, stem.length - kept).join('')}</span>
      {ext === '' ? null : <span className="tab-name-end">{stem.slice(stem.length - kept).join('') + ext}</span>}
    </span>
  )
}

type Props = {
  tabs: Tab[]
  active: number
  /** A tab's name: its view's title once it was shown, else what the address says. */
  labelOf(req: ViewRequest): string
  /** The icon of a tab's view. */
  iconOf(req: ViewRequest): string
  result: ViewResult | null
  /** What can be done with what the front tab shows, drawn beside its title. */
  actions: Action[]
  children: ReactNode
  onActivate(i: number): void
  onClose(i: number): void
  onCloseAll(): void
  onBack(): void
}

/** A subtitle that ends with the title, as a path ends with its name, says only the folder before it; one that is the title says nothing. */
function subtitleOf(title: string, subtitle: string | null): string | null {
  if (subtitle === null || subtitle === title) return null
  return subtitle.endsWith(`/${title}`) ? subtitle.slice(0, subtitle.length - title.length) : subtitle
}

export function DetailPanel({ tabs, active, labelOf, iconOf, result, actions, children, onActivate, onClose, onCloseAll, onBack }: Props) {
  const strip = useRef<HTMLDivElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const shown = result?.outcome === 'shown' ? result : null
  useActionKeys(actions, panel)
  const subtitle = shown ? subtitleOf(shown.title, shown.subtitle) : null
  const front = tabs[active]
  const focusTab = (i: number) => strip.current?.querySelectorAll<HTMLElement>('[role=tab]')[i]?.focus()
  const onKeyDown = (e: KeyboardEvent) => {
    const n = tabs.length
    const to = e.key === 'ArrowRight' ? (active + 1) % n : e.key === 'ArrowLeft' ? (active - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (to !== null) {
      e.preventDefault()
      onActivate(to)
      requestAnimationFrame(() => focusTab(to))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && (e.target as HTMLElement).getAttribute('role') === 'tab') {
      e.preventDefault()
      onClose(active)
      requestAnimationFrame(() => focusTab(Math.max(0, active - 1)))
    }
  }
  return (
    <aside ref={panel} aria-label="详情" className="detail">
      <div className="detail-head" data-drag data-chrome>
        <div ref={strip} role="tablist" aria-label="打开的详情" className="tabs" onKeyDown={onKeyDown}>
          {tabs.map((tab, i) => {
            const label = i === active && shown ? shown.title : labelOf(topOf(tab))
            return (
              <div key={i} className="tab-wrap" data-selected={i === active || undefined}>
                <button
                  type="button"
                  role="tab"
                  id={`tab-${i}`}
                  aria-selected={i === active}
                  aria-controls="detail-body"
                  tabIndex={i === active ? 0 : -1}
                  className="tab"
                  title={label}
                  onClick={() => onActivate(i)}
                  onAuxClick={(e) => e.button === 1 && onClose(i)}
                >
                  <ViewIcon name={(i === active ? shown?.icon : undefined) ?? iconOf(topOf(tab))} />
                  <TabName label={label} />
                </button>
                <button type="button" className="tab-close" aria-label={`关闭 ${label}`} tabIndex={-1} onClick={() => onClose(i)}>
                  <X strokeWidth={2} aria-hidden />
                </button>
              </div>
            )
          })}
        </div>
        <button type="button" className="icon-btn" aria-label="关闭详情" data-tip="关闭详情 Esc" onClick={onCloseAll}>
          <PanelRightClose strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div id="detail-body" role="tabpanel" aria-labelledby={`tab-${active}`} className="detail-body">
        <div className="detail-title">
          {front && front.length > 1 ? (
            <button type="button" className="icon-btn" aria-label="返回" data-tip="返回" onClick={onBack}>
              <ArrowLeft strokeWidth={2} aria-hidden />
            </button>
          ) : null}
          {front ? (
            <span className="detail-tile" aria-hidden>
              <ViewIcon name={shown?.icon ?? iconOf(topOf(front))} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 data-testid="panel-title">{shown?.title ?? ''}</h2>
            {subtitle ? <p title={shown?.subtitle ?? undefined}>{localMoments(subtitle)}</p> : null}
          </div>
          <ActionBar actions={actions} small={false} className="head-actions" />
        </div>
        {children}
      </div>
    </aside>
  )
}
