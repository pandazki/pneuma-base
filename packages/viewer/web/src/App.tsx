// The shell: the sidebar on the page's ground, the view in a rounded panel, the detail in a second
// one with a tab for each thing open. It keeps no state of its own beyond what is open, which the
// address holds, and its widths; every view comes from the server, fetched again when the library
// changed, after an action, and every `refresh` seconds when its answer asks for that.
import type { Action, FilterOption, Link, PluginProblem, ViewDecl, ViewRequest, ViewResult } from '@pneuma-base/kernel'
import { LoaderCircle, Unplug } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api, ApiError, type State } from './api'
import { Blocks, sameLink } from './blocks'
import { ActionDialog, fill } from './chrome'
import { Choice, Resizer, TipLayer, usePresence } from './controls'
import { DetailPanel } from './detail'
import { BlockEnvContext, type BlockEnv, type Done } from './env'
import { pageActions, Palette } from './palette'
import { PANEL, SIDE, usePrefs } from './prefs'
import { activate, back, closeAll, closeTab, follow, retop, shownOf, useRoute } from './route'
import { IN_SHELL } from './shell'
import { firstPage, navOrder, POLL_MS, Sidebar } from './sidebar'
import { localMoments } from './time'
import { Toaster, useToasts } from './toasts'

type Load<T> = { data: T | null; failed: boolean }

/** How many answers the page keeps to show again at once, while it asks anew. */
const KEPT = 24

/**
 * Loads `load()` whenever `key` or `tick` changes, and again `every(answer)` seconds after an answer
 * that asks for it. The last answer for a key stays on screen while it is asked for again, so a
 * refresh never empties the page; another key shows nothing until its own answer comes.
 */
function useLoad<T>(key: string | null, tick: number, load: () => Promise<T>, every: (answer: T) => number | undefined = () => undefined): Load<T> {
  const kept = useRef(new Map<string, T>())
  const [failed, setFailed] = useState<string | null>(null)
  const [, setAnswers] = useState(0)
  const [again, setAgain] = useState(0)
  const loader = useRef({ load, every })
  loader.current = { load, every }
  useEffect(() => {
    if (key === null) return
    let live = true
    let timer: number | undefined
    loader.current.load().then(
      (data) => {
        if (!live) return
        kept.current.delete(key)
        kept.current.set(key, data)
        for (const old of [...kept.current.keys()].slice(0, Math.max(0, kept.current.size - KEPT))) kept.current.delete(old)
        setFailed(null)
        setAnswers((n) => n + 1)
        const seconds = loader.current.every(data)
        if (seconds !== undefined) timer = window.setTimeout(() => setAgain((n) => n + 1), seconds * 1000)
      },
      () => live && setFailed(key),
    )
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [key, tick, again])
  return { data: key === null ? null : (kept.current.get(key) ?? null), failed: key !== null && failed === key }
}

/** A view's own pace: the seconds its answer gave as `refresh`, for state from outside the library. */
const refreshOf = (r: ViewResult) => (r.outcome === 'shown' ? r.refresh : undefined)

/** The view's parameters with each filter's default filled in. */
function withDefaults(req: ViewRequest, decl: ViewDecl | undefined): ViewRequest {
  const defaults = Object.fromEntries((decl?.filters ?? []).map((f) => [f.name, f.default]))
  return { view: req.view, params: { ...defaults, ...req.params } }
}

const keyOf = (req: ViewRequest | null) => (req === null ? null : JSON.stringify([req.view, Object.entries(req.params).sort()]))

/** The main panel never gets narrower than this while the sidebar can step aside. */
const MAIN_MIN = 520
/** The folded sidebar; inside the Mac app it leaves room for the window's buttons above it. */
const RAIL = IN_SHELL ? 76 : 48

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

function Problems({ problems }: { problems: PluginProblem[] }) {
  if (problems.length === 0) return null
  return (
    <div className="problems" role="alert">
      {problems.map((p, i) => (
        <p key={i}>
          插件 <span className="font-mono">{p.plugin}</span> 出了问题：{p.message}
        </p>
      ))}
    </div>
  )
}

/** Shown only when loading takes longer than a moment; the rows hold the place of what comes. */
function Loading() {
  return (
    <div className="loading" aria-hidden>
      <div className="skeleton h-5 w-40" />
      <div className="skeleton h-36" />
      <div className="skeleton h-5 w-64" />
    </div>
  )
}

/**
 * The view's filters, each with the options the answer saw, with their counts, when it gave them; a
 * filter with one option or none has nothing to choose and is left out.
 */
function Filters({ decl, answered, params, onChange }: { decl: ViewDecl | undefined; answered: { name: string; options: FilterOption[] }[] | undefined; params: Record<string, string>; onChange(name: string, value: string): void }) {
  const filters = (decl?.filters ?? []).map((f) => ({ ...f, options: answered?.find((a) => a.name === f.name)?.options ?? f.options })).filter((f) => f.options.length > 1)
  if (filters.length === 0) return null
  return (
    <div className="filters" role="toolbar" aria-label="过滤">
      {filters.map((f) => (
        <div key={f.name} className="filter">
          <span aria-hidden>{f.label}</span>
          <Choice label={f.label} options={f.options} value={params[f.name] ?? f.default} onChange={(value) => onChange(f.name, value)} />
        </div>
      ))}
    </div>
  )
}

function Shown({ result, failed }: { result: ViewResult | null; failed: boolean }) {
  if (result === null) return failed ? <p className="note" data-tone="bad">这一页没能取到。</p> : <Loading />
  if (result.outcome === 'no-such-view') return <p className="note">没有这一页。</p>
  if (result.outcome === 'refused') return <p className="note" data-tone="bad">{result.text}</p>
  return (
    <>
      <Problems problems={result.problems} />
      <Blocks blocks={result.blocks} />
    </>
  )
}

function Unreachable() {
  return (
    <div className="screen" role="alert">
      <div className="empty max-w-[480px]">
        <span className="empty-icon">
          <Unplug strokeWidth={1.75} aria-hidden />
        </span>
        <p className="empty-title">连不上服务</p>
        <p className="empty-hint flex items-center justify-center gap-1.5">
          <LoaderCircle className="spinner" strokeWidth={2} aria-hidden />
          {IN_SHELL ? '正在重新连接。' : '正在重试。服务是用 pneuma-base view 启动的，关掉了就再启动一次。'}
        </p>
      </div>
    </div>
  )
}

function Denied() {
  return (
    <div className="screen" role="alert">
      <div className="empty max-w-[480px]">
        <p className="empty-title">这个地址不对</p>
        <p className="empty-hint">{IN_SHELL ? '服务换了一个令牌。按 ⌘R 重新载入。' : '地址里缺少令牌，或者服务已经换了一个令牌。用 pneuma-base view 打印出来的地址打开。'}</p>
      </div>
    </div>
  )
}

function InitScreen({ state, onInit }: { state: State; onInit(plugins: string[]): Promise<void> }) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(state.available.some((p) => p.name === 'ledger') ? ['ledger'] : []))
  const [busy, setBusy] = useState(false)
  return (
    <div className="screen">
      <div className="card init">
        <h1>这个目录还不是库</h1>
        <p className="init-dir">{state.dir}</p>
        <p className="init-about">建成库之后，根目录多一份说明 PNEUMA-BASE.md 和一个 .pneuma-base/ 目录，里面的东西原样留着。</p>
        {state.available.length > 0 ? (
          <fieldset>
            <legend>装上这些插件</legend>
            {state.available.map((p) => (
              <label key={p.name}>
                <input
                  type="checkbox"
                  className="check"
                  checked={chosen.has(p.name)}
                  onChange={(e) => {
                    const next = new Set(chosen)
                    if (e.target.checked) next.add(p.name)
                    else next.delete(p.name)
                    setChosen(next)
                  }}
                />
                <span className="font-mono text-[12.5px]">{p.name}</span>
                {p.title ? <span className="text-ink-3">{p.title}</span> : null}
              </label>
            ))}
          </fieldset>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          aria-busy={busy || undefined}
          onClick={async () => {
            if (busy) return
            setBusy(true)
            await onInit([...chosen])
            setBusy(false)
          }}
        >
          把它建成库
        </button>
      </div>
    </div>
  )
}

/** The action an owner command's refusal offers instead, such as removing a plugin that refused anyway. */
function offerOf(result: unknown): Action | null {
  const offer = (result as { offer?: unknown } | null)?.offer
  return typeof offer === 'object' && offer !== null && 'call' in offer ? (offer as Action) : null
}

/** A tab's name before its view was shown: the file of a `path`, else the view's title. */
const fallbackLabel = (req: ViewRequest, decl: ViewDecl | undefined) => req.params.path?.split('/').filter(Boolean).at(-1) ?? decl?.title ?? req.view

export function App() {
  const [tick, setTick] = useState(0)
  const [down, setDown] = useState(false)
  const [denied, setDenied] = useState(false)
  const [route, go] = useRoute()
  const [pending, setPending] = useState<{ id: number; action: Action; values: Record<string, string>; resolve(done: Done | null): void } | null>(null)
  const [palette, setPalette] = useState(false)
  const [changedAt, setChangedAt] = useState<Date | null>(null)
  const toasts = useToasts()
  const { busy, settle } = toasts
  const [prefs, setPrefs] = usePrefs()
  const [resizing, setResizing] = useState(false)
  const [keepSide, setKeepSide] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const width = useWindowWidth()
  const titles = useRef(new Map<string, string>())
  const asked = useRef(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const cancel = useCallback(
    () =>
      setPending((p) => {
        p?.resolve(null)
        return null
      }),
    [],
  )
  const closePalette = useCallback(() => setPalette(false), [])

  // Ask every two seconds whether the library changed; refetch when it did or when the server is back.
  useEffect(() => {
    let last: string | null = null
    let wasDown = false
    const poll = async () => {
      try {
        const { rev } = await api.rev()
        if (last !== null && rev !== last) setChangedAt(new Date())
        if ((last !== null && rev !== last) || wasDown) refresh()
        last = rev
        wasDown = false
        setDown(false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setDenied(true)
        wasDown = true
        setDown(true)
      }
    }
    void poll()
    const timer = window.setInterval(poll, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const state = useLoad('state', tick, api.state)
  const views = useMemo(() => state.data?.views ?? [], [state.data])
  const firstNav = firstPage(views)
  const current = route.main !== null && views.some((v) => v.id === route.main?.view) ? route.main : firstNav === null ? null : { view: firstNav, params: {} }
  const decl = views.find((v) => v.id === current?.view)
  const request = current === null ? null : withDefaults(current, decl)
  const shown = useLoad(keyOf(request), tick, () => api.view(request as ViewRequest), refreshOf)
  const top = shownOf(route)
  const detail = useLoad(keyOf(top), tick, () => api.view(top as ViewRequest), refreshOf)
  const hasTabs = route.tabs.length > 0

  useEffect(() => {
    if (top && detail.data?.outcome === 'shown') titles.current.set(keyOf(top) as string, detail.data.title)
  }, [top, detail.data])
  useEffect(() => setKeepSide(false), [hasTabs])

  // The sidebar steps aside to a rail when it would leave the main panel too narrow, unless asked to stay.
  const tight = width < prefs.side + (hasTabs ? prefs.panel : 0) + MAIN_MIN + 24
  const crowded = tight && !keepSide
  const rail = prefs.rail || crowded
  const panelWidth = Math.max(PANEL.min, Math.min(prefs.panel, width - (rail ? RAIL : prefs.side) - MAIN_MIN))
  const toggleSide = useCallback(() => {
    if (prefs.rail) {
      setPrefs({ rail: false })
      setKeepSide(true)
    } else if (crowded) setKeepSide(true)
    else if (tight) setKeepSide(false)
    else setPrefs({ rail: true })
  }, [prefs.rail, crowded, tight, setPrefs])

  // Escape closes the front tab; ⌘K opens the palette; ⌃⌘S folds the sidebar. A dialog or the palette takes Escape first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') go((r) => closeTab(r, r.active))
      else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (pending === null) setPalette((open) => !open)
      } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        toggleSide()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, pending, toggleSide])

  const run = useCallback(
    async (action: Action, values: Record<string, string>, confirmed: boolean): Promise<Done> => {
      const id = busy(action.label)
      let done: Done
      try {
        const reply = await api.call(fill(action.call, values, action.inputs), confirmed)
        settle(id, reply.tone, reply.text, offerOf(reply.result))
        done = { tone: reply.tone, text: reply.text }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        settle(id, 'bad', text)
        done = { tone: 'bad', text }
      }
      refresh()
      return done
    },
    [refresh, busy, settle],
  )

  const onLink = useCallback(
    (link: Link, newTab = false) => {
      const req = { view: link.view, params: link.params }
      if (link.target === 'main') go((r) => ({ ...r, main: req }))
      else go((r) => follow(r, req, newTab))
    },
    [go],
  )
  const onAction = useCallback(
    (action: Action, values: Record<string, string> = {}): Promise<Done | null> =>
      action.inputs.length > 0 || action.confirm !== null ? new Promise((resolve) => setPending({ id: ++asked.current, action, values, resolve })) : run(action, values, false),
    [run],
  )
  const selected = useCallback((link: Link | null) => link !== null && link.target === 'panel' && sameLink(link, top), [top])
  // A parameter set from a block, such as a folder chosen in a tree, changes the view the block is in.
  const onMainParam = useCallback(
    (name: string, value: string) => current && go((r) => ({ ...r, main: { view: current.view, params: { ...current.params, [name]: value } } })),
    [current, go],
  )
  const onPanelParam = useCallback((name: string, value: string) => top && go((r) => retop(r, { view: top.view, params: { ...top.params, [name]: value } })), [top, go])
  const env: BlockEnv = useMemo(() => ({ tick, onLink, onAction, onParam: onMainParam, selected }), [tick, onLink, onAction, onMainParam, selected])
  const panelEnv: BlockEnv = useMemo(() => ({ ...env, onParam: onPanelParam }), [env, onPanelParam])
  const dialog = usePresence(pending, 200)
  const paletteShown = usePresence(palette ? true : null, 150)

  if (denied) return <Denied />
  if (state.data === null) return down || state.failed ? <Unreachable /> : null
  if (state.data.library === null) {
    return (
      <>
        <InitScreen
          state={state.data}
          onInit={async (plugins) => {
            try {
              const reply = await api.init(plugins)
              toasts.push(reply.tone, reply.text)
            } catch (error) {
              toasts.push('bad', error instanceof Error ? error.message : String(error))
            }
            refresh()
          }}
        />
        <Toaster toasts={toasts} />
      </>
    )
  }

  const data = state.data
  const result = shown.data?.outcome === 'shown' ? shown.data : null
  const groupOf = (v: (typeof views)[number]) => (v.by === 'kernel' ? (v.id === 'home' ? null : '库') : (data.available.find((p) => p.name === v.by)?.title ?? v.by))
  const style = { '--side-w': `${prefs.side}px`, '--panel-w': `${panelWidth}px`, '--rail': `${RAIL}px` } as CSSProperties
  return (
    <BlockEnvContext.Provider value={env}>
      <div className="shell" data-side={rail ? 'rail' : 'full'} data-resizing={resizing || undefined} style={style}>
        <Sidebar
          state={data}
          current={current?.view ?? null}
          rail={rail}
          down={down}
          changedAt={changedAt}
          onSelect={(view) => go((r) => ({ ...r, main: { view, params: {} } }))}
          onSearch={() => setPalette(true)}
          onToggle={toggleSide}
        />
        {rail ? null : (
          <Resizer label="侧栏的宽度" className="resizer-side" value={prefs.side} min={SIDE.min} max={SIDE.max} initial={SIDE.initial} grows="right" onChange={(side) => setPrefs({ side })} onDrag={setResizing} />
        )}
        <div className="work">
          <main className="main" data-scrolled={scrolled || undefined} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
            {down ? (
              <div className="down" role="alert">
                <Unplug strokeWidth={2} aria-hidden />
                连不上服务，正在重试。下面是最后一次取到的内容。
              </div>
            ) : null}
            <header className="page-head" data-drag>
              <h1>{result?.title ?? decl?.title ?? ''}</h1>
              {result?.subtitle ? <p>{localMoments(result.subtitle)}</p> : null}
              <Filters decl={decl} answered={result?.filters} params={request?.params ?? {}} onChange={onMainParam} />
            </header>
            <div className="page-body">
              <Problems problems={data.problems} />
              <Shown result={shown.data} failed={shown.failed} />
            </div>
          </main>
          {hasTabs ? (
            <div className="detail-col">
              <Resizer label="详情的宽度" className="resizer-panel" value={panelWidth} min={PANEL.min} max={PANEL.max} initial={PANEL.initial} grows="left" onChange={(panel) => setPrefs({ panel })} onDrag={setResizing} />
              <DetailPanel
                tabs={route.tabs}
                active={route.active}
                labelOf={(req) => titles.current.get(keyOf(req) as string) ?? fallbackLabel(req, views.find((v) => v.id === req.view))}
                iconOf={(req) => views.find((v) => v.id === req.view)?.icon ?? 'file'}
                result={detail.data}
                onActivate={(i) => go((r) => activate(r, i))}
                onClose={(i) => go((r) => closeTab(r, i))}
                onCloseAll={() => go(closeAll)}
                onBack={() => go(back)}
              >
                <BlockEnvContext.Provider value={panelEnv}>
                  <div className="blocks">
                    <Shown result={detail.data} failed={detail.failed} />
                  </div>
                </BlockEnvContext.Provider>
              </DetailPanel>
            </div>
          ) : null}
        </div>
      </div>
      {dialog.shown ? (
        <ActionDialog
          key={dialog.shown.id}
          action={dialog.shown.action}
          preset={dialog.shown.values}
          leaving={dialog.leaving}
          onCancel={cancel}
          onSubmit={(values) => {
            if (!pending) return
            const { action, resolve } = pending
            setPending(null)
            void run(action, values, action.confirm !== null).then(resolve)
          }}
        />
      ) : null}
      {paletteShown.shown ? (
        <Palette
          leaving={paletteShown.leaving}
          views={navOrder(views)}
          groupOf={groupOf}
          actions={result ? pageActions(result.blocks) : []}
          onClose={closePalette}
          onPage={(view) => go((r) => ({ ...r, main: { view, params: {} } }))}
          onOpen={(link) => onLink(link, true)}
          onAction={onAction}
        />
      ) : null}
      <Toaster toasts={toasts} onAction={onAction} />
      <TipLayer />
    </BlockEnvContext.Provider>
  )
}
