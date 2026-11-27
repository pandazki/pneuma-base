// The menu bar panel: the home page's content in the app's small window, compact. The library's
// name; what waits for the owner, three at most, decided right here as on the home page; the latest
// rows of what agents did since the owner last looked; then 打开窗口 and 退出. It draws the same blocks the home page answers and
// knows no view of any plugin: the asks are every asks block, the rows every feed block's, newest first.
import type { Action, Ask, Block, FeedRow, Link, ViewResult } from '@pneuma-base/kernel'
import { ChevronDown, ChevronRight, Power } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
const ROWS = 5

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
  const root = useRef<HTMLDivElement | null>(null)
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
  const quiet = feeds.find((b) => b.empty !== '')?.empty ?? '还没有谁做过什么。'
  const left = blocks.flatMap((b) => (b.kind === 'steps' ? b.steps : [])).filter((s) => !s.done).length

  useEffect(() => {
    if (home?.outcome === 'shown') tellShell({ type: 'waiting', count: asks.length })
  }, [home, asks.length])

  // The app sizes its window to the content.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const tell = () => tellShell({ type: 'height', height: Math.ceil(el.getBoundingClientRect().height) })
    const observer = new ResizeObserver(tell)
    observer.observe(el)
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
    }),
    [tick, run],
  )
  const dialog = usePresence(pending, 200)
  const open = () => tellShell({ type: 'open' })
  const openHome = () => tellShell({ type: 'open', link: HOME })

  return (
    <BlockEnvContext.Provider value={env}>
      <div ref={root} className="tray">
        <header className="tray-head">
          <button type="button" className="tray-library" onClick={() => tellShell({ type: 'libraries' })} aria-label={`库：${nameOf(state)}，换一个库`}>
            <span className="truncate">{nameOf(state)}</span>
            <ChevronDown strokeWidth={2} aria-hidden />
          </button>
          {asks.length > 0 ? <span className="tag tone-warn">{asks.length} 件等你</span> : null}
        </header>
        {down ? <p className="tray-note" role="alert">连不上服务，正在重新连接。</p> : null}
        {left > 0 ? (
          <button type="button" className="tray-start" onClick={openHome}>
            <span>开始：还有 {left} 步没做</span>
            <ChevronRight strokeWidth={2} aria-hidden />
          </button>
        ) : null}
        {/* Nothing to decide is not said; once something was, the part stays, so an answer's receipt is seen. */}
        {hadAsks.current ? (
          <section className="tray-part" aria-label="等你决定">
            <h2>等你决定</h2>
            <AsksView block={{ kind: 'asks', asks: asks.slice(0, ASKS), empty: '没有要你决定的事。' }} />
            {asks.length > ASKS ? (
              <button type="button" className="tray-more" onClick={openHome}>
                还有 {asks.length - ASKS} 件，在窗口里看
              </button>
            ) : null}
          </section>
        ) : null}
        <section className="tray-part" aria-label="自上次以来">
          <h2>自上次以来</h2>
          <FeedView block={{ kind: 'feed', groups: rows.length > 0 ? [{ title: '', count: null, rows: rows.slice(0, ROWS) }] : [], empty: quiet }} />
        </section>
        <footer className="tray-foot">
          <button type="button" className="btn btn-sm" onClick={open}>
            打开窗口
          </button>
          <button type="button" className="icon-btn" aria-label="退出" data-tip="退出" onClick={() => tellShell({ type: 'quit' })}>
            <Power strokeWidth={2} aria-hidden />
          </button>
        </footer>
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
