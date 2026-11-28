// The menu bar panel: the home page's content in the app's small window. Its head is the
// library's name, which opens the window on home, with how many things wait when any do; at the right
// an icon for the window and the 「···」 menu (the app's: appearance, libraries, settings, quit). Then
// what waits for the owner, three at most, decided right here as on the home page; then the latest
// rows of what agents did, one line each. It draws the same blocks the home page answers and knows no
// view of any plugin: the asks are every asks block, the rows every feed block's, newest first. The
// panel sizes to the content up to the room the app gives it, and scrolls inside past that.
import type { Action, Ask, Block, FeedRow, Link, ViewResult } from '@pneuma-base/kernel'
import { AppWindow, ChevronRight, CircleDashed, Ellipsis } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type State } from './api'
import { AsksView } from './pieces/asks'
import { FeedView } from './pieces/feed'
import { ActionDialog, fill } from './chrome'
import { usePresence } from './controls'
import { BlockEnvContext, type BlockEnv, type Done } from './env'
import { tellShell } from './shell'
import { POLL_MS } from './sidebar'
import { Toaster, useToasts } from './toasts'

/** How many asks the panel shows, and how many rows of what happened. */
const ASKS = 3
const ROWS = 8

const everyBlock = (blocks: readonly Block[]): Block[] =>
  blocks.flatMap((b) => [b, ...(b.kind === 'section' ? everyBlock(b.blocks) : b.kind === 'steps' ? b.steps.flatMap((s) => everyBlock(s.blocks)) : [])])

const HOME: Link = { view: 'home', params: {}, target: 'main' }

const nameOf = (state: State | null) => state?.library?.root.split('/').filter(Boolean).at(-1) ?? 'Pneuma Base'

export function Tray() {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<State | null>(null)
  const [home, setHome] = useState<ViewResult | null>(null)
  const [down, setDown] = useState(false)
  const [pending, setPending] = useState<{ id: number; action: Action; resolve(done: Done | null): void } | null>(null)
  const asked = useRef(0)
  const head = useRef<HTMLElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const toasts = useToasts()
  const { busy, settle, report } = toasts
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  // The library changed, or the panel was shown again: ask anew. Asked only while the panel is on screen.
  useEffect(() => {
    let last: string | null = null
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const { rev } = await api.rev()
        if (last !== null && rev !== last) refresh()
        last = rev
        setDown(false)
      } catch {
        setDown(true)
      }
    }
    const shown = (e: Event) => (e as CustomEvent<{ panel?: unknown }>).detail?.panel === 'shown' && refresh()
    window.addEventListener('pneuma-shell', shown)
    const timer = window.setInterval(poll, POLL_MS)
    return () => {
      window.removeEventListener('pneuma-shell', shown)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    let live = true
    Promise.all([api.state(), api.view({ view: 'home', params: {} })]).then(
      ([s, h]) => {
        if (!live) return
        setState(s)
        setHome(h)
        setDown(false)
      },
      () => live && setDown(true),
    )
    return () => {
      live = false
    }
  }, [tick])

  const blocks = useMemo(() => everyBlock(home?.outcome === 'shown' ? home.blocks : []), [home])
  const asks: Ask[] = blocks.flatMap((b) => (b.kind === 'asks' ? b.asks : []))
  const hadAsks = useRef(false)
  if (asks.length > 0) hadAsks.current = true
  const feeds = blocks.filter((b) => b.kind === 'feed')
  const rows: FeedRow[] = feeds.flatMap((b) => b.groups.flatMap((g) => g.rows)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const quiet = feeds.find((b) => b.empty !== '')?.empty ?? '暂无新动态'
  const left = blocks.flatMap((b) => (b.kind === 'steps' ? b.steps : [])).filter((s) => !s.done).length

  useEffect(() => {
    if (home?.outcome === 'shown') tellShell({ type: 'waiting', count: asks.length })
  }, [home, asks.length])

  // The app sizes its window to the content: the head and everything under it, however much of it the
  // body now shows; past the room the app gives, the body scrolls.
  useLayoutEffect(() => {
    const parts = [head.current, content.current, body.current]
    if (parts.some((p) => p === null)) return
    const tell = () => {
      const [h, c, b] = parts as [HTMLElement, HTMLElement, HTMLElement]
      const style = getComputedStyle(b)
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      tellShell({ type: 'height', height: Math.ceil(h.getBoundingClientRect().height + c.getBoundingClientRect().height + padding) })
    }
    const observer = new ResizeObserver(tell)
    for (const p of parts) observer.observe(p as HTMLElement)
    tell()
    return () => observer.disconnect()
  }, [])

  const run = useCallback(
    async (action: Action, values: Record<string, string>, confirmed: boolean): Promise<Done> => {
      const id = busy(action.label)
      let done: Done
      try {
        const reply = await api.pass(fill(action.call, values, action.inputs), confirmed, (progress, pass) => report(id, progress, () => void api.stop(pass).catch(() => undefined)))
        settle(id, reply.tone, reply.text)
        done = { tone: reply.tone, text: reply.text }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        settle(id, 'bad', text)
        done = { tone: 'bad', text }
      }
      refresh()
      return done
    },
    [busy, settle, report, refresh],
  )
  const env: BlockEnv = useMemo(
    () => ({
      tick,
      onLink: (link: Link) => tellShell({ type: 'open', link }),
      onAction: (action: Action, values: Record<string, string> = {}, filled = false) =>
        (action.inputs.length > 0 && !filled) || action.confirm !== null ? new Promise((resolve) => setPending({ id: ++asked.current, action, resolve })) : run(action, values, false),
      onParam: () => undefined,
      onPage: (link: Link) => tellShell({ type: 'open', link }),
      selected: () => false,
      look: 'list' as const,
      root: null,
    }),
    [tick, run],
  )
  const dialog = usePresence(pending, 200)
  const openHome = () => tellShell({ type: 'open', link: HOME })
  const name = nameOf(state)

  return (
    <BlockEnvContext.Provider value={env}>
      <div className="tray">
        <header ref={head} className="tray-head">
          <span role="link" tabIndex={0} className="tray-library" onClick={openHome} onKeyDown={(e) => e.key === 'Enter' && openHome()} data-tip="打开主窗口">
            <span className="truncate">{name}</span>
          </span>
          {asks.length > 0 ? (
            <span className="tray-waiting" role="img" aria-label={`${asks.length} 项待处理`} data-tip={`${asks.length} 项待处理`}>
              {asks.length}
            </span>
          ) : null}
          <span className="tray-tools">
            <button type="button" className="icon-btn" aria-label="打开主窗口" data-tip="打开主窗口" onClick={() => tellShell({ type: 'open' })}>
              <AppWindow strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="更多"
              data-tip="更多"
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                tellShell({ type: 'panel-menu', x: Math.round(r.left), y: Math.round(r.bottom + 4) })
              }}
            >
              <Ellipsis strokeWidth={1.75} aria-hidden />
            </button>
          </span>
        </header>
        <div ref={body} className="tray-body">
          <div ref={content} className="tray-content">
            {down ? (
              <p className="tray-note" role="alert">
                无法连接服务，正在重新连接。
              </p>
            ) : null}
            {left > 0 ? (
              <span role="link" tabIndex={0} className="tray-row" onClick={openHome} onKeyDown={(e) => e.key === 'Enter' && openHome()}>
                <CircleDashed strokeWidth={1.75} aria-hidden />
                <span className="truncate">快速开始：剩余 {left} 步</span>
                <ChevronRight className="tray-row-chev" strokeWidth={2} aria-hidden />
              </span>
            ) : null}
            {/* Nothing to decide is not said; once something was, the part stays, so an answer's receipt is seen. */}
            {hadAsks.current ? (
              <section className="tray-part" aria-label="待处理">
                <AsksView block={{ kind: 'asks', asks: asks.slice(0, ASKS), empty: '暂无待处理事项' }} compact />
                {asks.length > ASKS ? (
                  <span role="link" tabIndex={0} className="tray-row" onClick={openHome} onKeyDown={(e) => e.key === 'Enter' && openHome()}>
                    <span className="truncate">另有 {asks.length - ASKS} 项，在主窗口中查看</span>
                    <ChevronRight className="tray-row-chev" strokeWidth={2} aria-hidden />
                  </span>
                ) : null}
              </section>
            ) : null}
            <section className="tray-part" aria-label="最近动态">
              <FeedView block={{ kind: 'feed', groups: rows.length > 0 ? [{ title: '', count: null, rows: rows.slice(0, ROWS) }] : [], empty: quiet }} dense />
            </section>
          </div>
        </div>
      </div>
      {dialog.shown ? (
        <ActionDialog
          key={dialog.shown.id}
          action={dialog.shown.action}
          leaving={dialog.leaving}
          onCancel={() =>
            setPending((p) => {
              p?.resolve(null)
              return null
            })
          }
          onSubmit={(values) => {
            if (!pending) return
            const { action, resolve } = pending
            setPending(null)
            void run(action, values, action.confirm !== null).then(resolve)
          }}
        />
      ) : null}
      <Toaster toasts={toasts} />
    </BlockEnvContext.Provider>
  )
}
