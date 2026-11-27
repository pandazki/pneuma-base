// The shell: the sidebar on the page's ground, the view in a rounded panel, the detail in a second
// one with a tab for each thing open. It keeps no state of its own beyond what is open, which the
// address holds, and its widths; every view comes from the server, fetched again when the library
// changed, after an action, and every `refresh` seconds when its answer asks for that.
import type { Action, Block, Crumb, FilterOption, Link, ListedView, PluginProblem, SortKey, ViewDecl, ViewRequest, ViewResult } from '@pneuma-base/kernel'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, List, LoaderCircle, Unplug } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api, ApiError, type State, type Tone } from './api'
import { Blocks, sameLink, sortAfter } from './blocks'
import { ActionBar, useActionKeys } from './actions'
import { ActionDialog, fill, ViewIcon } from './chrome'
import { Choice, Menu, Resizer, TipLayer, usePresence } from './controls'
import { DetailPanel } from './detail'
import { BlockEnvContext, type BlockEnv, type Done } from './env'
import { pageActions, Palette } from './palette'
import { PANEL, SIDE, useFileLook, usePrefs, type FileLook } from './prefs'
import { activate, back, closeAll, closeTab, follow, retop, shownOf, useRoute } from './route'
import { IN_SHELL, type ShellCommand } from './shell'
import { entryOf, firstPage, navOrder, POLL_MS, Sidebar } from './sidebar'
import { localMoments } from './time'
import { Toaster, useToasts } from './toasts'

type Load<T> = { data: T | null; failed: boolean }

/** How many answers the page keeps to show again at once, while it asks anew. */
const KEPT = 24

/**
 * Loads `load()` whenever `key` or `tick` changes, and again `every(answer)` seconds after an answer
 * that asks for it. The last answer for a key stays on screen while it is asked for again, so a
 * refresh never empties the page; another key shows nothing until its own answer comes, but another
 * page of the same view, whose key differs only in where its lists start, keeps the page it turned
 * from on screen, so the keyboard stays where it was.
 */
function useLoad<T>(key: string | null, tick: number, load: () => Promise<T>, every: (answer: T) => number | undefined = () => undefined): Load<T> {
  const kept = useRef(new Map<string, T>())
  const lastShown = useRef<{ key: string; data: T } | null>(null)
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
  const own = key === null ? null : (kept.current.get(key) ?? null)
  if (own !== null && key !== null) lastShown.current = { key, data: own }
  const turned = own === null && key !== null && lastShown.current !== null && unpaged(lastShown.current.key) === unpaged(key) ? lastShown.current.data : null
  return { data: own ?? turned, failed: key !== null && failed === key }
}

/** A view's key without where its lists start: the same for every page of it. */
const unpaged = (key: string) => {
  const [view, params] = JSON.parse(key) as [string, [string, string][]]
  return JSON.stringify([view, params.filter(([name]) => !/(^|\.)(after|back)$/.test(name))])
}

/** A view's own pace: the seconds its answer gave as `refresh`, for state from outside the library. */
const refreshOf = (r: ViewResult) => (r.outcome === 'shown' ? r.refresh : undefined)

/** The view's parameters with each filter's default filled in, and the sort last chosen on this page when none is asked for. */
function withDefaults(req: ViewRequest, decl: ViewDecl | undefined, sort: string | null = null): ViewRequest {
  const defaults = Object.fromEntries((decl?.filters ?? []).map((f) => [f.name, f.default]))
  return { view: req.view, params: { ...defaults, ...(sort === null ? {} : { sort }), ...req.params } }
}

/** The first table of a page whose rows stand for places: a list of files, which the page's head shows as a list or as icons. */
const filesTable = (blocks: readonly Block[]) => blocks.find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table' && b.rows.some((r) => r.place !== undefined)) ?? null

/**
 * Where a page of folders stands: back and forward, as ⌘[ and ⌘] do, then each folder from the root,
 * the last being this one, the page's title.
 */
function PathBar({ trail, onGo }: { trail: Crumb[]; onGo(link: Link): void }) {
  const nav = (window as unknown as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation
  const last = trail.length - 1
  return (
    <nav className="path-bar" aria-label="位置">
      <span className="path-steps">
        <button type="button" className="icon-btn" aria-label="后退" data-tip="后退 ⌘[" disabled={nav?.canGoBack === false} onClick={() => window.history.back()}>
          <ChevronLeft strokeWidth={2} aria-hidden />
        </button>
        <button type="button" className="icon-btn" aria-label="前进" data-tip="前进 ⌘]" disabled={nav?.canGoForward === false} onClick={() => window.history.forward()}>
          <ChevronRight strokeWidth={2} aria-hidden />
        </button>
      </span>
      <ol className="path-crumbs">
        {trail.map((c, i) =>
          i === last ? (
            <li key={i}>
              <h1 aria-current="page">{c.label}</h1>
            </li>
          ) : (
            <li key={i}>
              <button type="button" className="path-crumb" onClick={() => onGo(c.link)}>
                {c.label}
              </button>
              <ChevronRight className="path-sep" strokeWidth={2} aria-hidden />
            </li>
          ),
        )}
      </ol>
    </nav>
  )
}

const SORT_LABELS: Record<SortKey, string> = { name: '名字', modified: '修改时间', kind: '种类', size: '大小' }

/** A page of files: list or icons (⌘1, ⌘2), and the sort, as a small menu whose current key, chosen again, turns it round. */
function LookTools({ look, sorted, onLook, onSort }: { look: FileLook['look']; sorted: { by: SortKey; desc: boolean } | undefined; onLook(look: FileLook['look']): void; onSort(sort: string): void }) {
  const looks = [
    { value: 'list' as const, label: '列表', keys: '⌘1', Icon: List },
    { value: 'icons' as const, label: '图标', keys: '⌘2', Icon: LayoutGrid },
  ]
  return (
    <div className="look-tools">
      {sorted ? (
        <Menu
          label="排序"
          entries={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
            label: SORT_LABELS[key],
            icon: sorted.by === key ? sorted.desc ? <ArrowDown strokeWidth={2} /> : <ArrowUp strokeWidth={2} /> : <span className="menu-blank" />,
            onSelect: () => onSort(sortAfter(sorted, key)),
          }))}
          trigger={({ ref, open, toggle, onKeyDown }) => (
            <button ref={ref} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`排序：${SORT_LABELS[sorted.by]}`} data-tip={`排序：${SORT_LABELS[sorted.by]}`} onClick={toggle} onKeyDown={onKeyDown}>
              <ArrowUpDown strokeWidth={2} aria-hidden />
            </button>
          )}
        />
      ) : null}
      <div className="look-switch" role="radiogroup" aria-label="显示方式">
        {looks.map(({ value, label, keys, Icon }) => (
          <button key={value} type="button" role="radio" className="icon-btn" aria-checked={look === value} aria-label={label} data-tip={`${label} ${keys}`} aria-keyshortcuts={value === 'list' ? 'Meta+1' : 'Meta+2'} onClick={() => onLook(value)}>
            <Icon strokeWidth={2} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  )
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

/** A filter of many options as one button: the option in effect, and a menu of all of them with their counts. */
function FilterMenu({ label, options, value, onChange }: { label: string; options: FilterOption[]; value: string; onChange(value: string): void }) {
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <Menu
      label={label}
      entries={options.map((o) => ({ label: o.label, icon: o.value === value ? <Check strokeWidth={2} /> : <span className="menu-blank" />, keys: o.count === undefined ? undefined : String(o.count), onSelect: () => onChange(o.value) }))}
      trigger={({ ref, open, toggle, onKeyDown }) => (
        <button ref={ref} type="button" className="btn btn-quiet filter-menu" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}：${current?.label ?? ''}`} onClick={toggle} onKeyDown={onKeyDown}>
          {current?.label}
          <ChevronDown strokeWidth={2} aria-hidden />
        </button>
      )}
    />
  )
}

/**
 * The view's filters, each with the options the answer saw, with their counts, when it gave them. An
 * option counted 0 is left out unless it is the one in effect; a filter left with one option or none
 * has nothing to choose and is left out. Their labels are for screen readers: the options say it.
 */
function Filters({ decl, answered, params, onChange }: { decl: ViewDecl | undefined; answered: { name: string; options: FilterOption[] }[] | undefined; params: Record<string, string>; onChange(name: string, value: string): void }) {
  const filters = (decl?.filters ?? [])
    .map((f) => {
      const value = params[f.name] ?? f.default
      const options = (answered?.find((a) => a.name === f.name)?.options ?? f.options).filter((o) => o.count !== 0 || o.value === value)
      return { ...f, value, options }
    })
    .filter((f) => f.options.length > 1)
  if (filters.length === 0) return null
  return (
    <div className="filters" role="toolbar" aria-label="过滤">
      {filters.map((f) =>
        f.as === 'menu' ? (
          <FilterMenu key={f.name} label={f.label} options={f.options} value={f.value} onChange={(value) => onChange(f.name, value)} />
        ) : (
          <Choice key={f.name} label={f.label} options={f.options} value={f.value} onChange={(value) => onChange(f.name, value)} />
        ),
      )}
    </div>
  )
}

/** The views that share one entry of the navigation, as icons at the right of the page's head, the one shown pressed. */
function ViewSwitch({ entry, current, onSelect }: { entry: ListedView[]; current: string; onSelect(view: string): void }) {
  if (entry.length < 2) return null
  return (
    <nav className="view-switch" aria-label="这一组的页">
      {entry.map((v) => (
        <button key={v.id} type="button" className="icon-btn" aria-label={v.title} aria-current={v.id === current ? 'page' : undefined} data-tip={v.title} onClick={() => onSelect(v.id)}>
          <ViewIcon name={v.icon} />
        </button>
      ))}
    </nav>
  )
}

/** The actions a page gives for the whole of what it shows: its `head` action blocks, at the top level. */
export const headActions = (blocks: readonly Block[]): Action[] => blocks.flatMap((b) => (b.kind === 'actions' && b.head ? b.actions : []))

/** The page's head actions, with their keys while nothing else has the focus. */
function HeadActions({ actions }: { actions: Action[] }) {
  useActionKeys(actions)
  return <ActionBar actions={actions} small={false} className="head-actions" />
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
  const { busy, settle, report } = toasts
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
  const [fileLook, setFileLook] = useFileLook(state.data?.library?.id ?? null, current?.view ?? null)
  const request = current === null ? null : withDefaults(current, decl, fileLook.sort)
  const shown = useLoad(keyOf(request), tick, () => api.view(request as ViewRequest), refreshOf)
  const top = shownOf(route)
  const detail = useLoad(keyOf(top), tick, () => api.view(top as ViewRequest), refreshOf)
  const hasTabs = route.tabs.length > 0

  useEffect(() => {
    if (top && detail.data?.outcome === 'shown') titles.current.set(keyOf(top) as string, detail.data.title)
  }, [top, detail.data])

  // A page that names what its panel shows opens it, once each time the page is opened, when no panel
  // is open and the window has room for both without folding the sidebar.
  const arrival = useRef<{ key: string | null; settled: boolean }>({ key: null, settled: false })
  const mainKey = keyOf(request)
  const opens = shown.data?.outcome === 'shown' ? shown.data.open : undefined
  const panelRoom = (prefs.rail ? RAIL : prefs.side) + prefs.panel + MAIN_MIN + 24
  useEffect(() => {
    if (arrival.current.key !== mainKey) arrival.current = { key: mainKey, settled: false }
    if (arrival.current.settled || mainKey === null || shown.data === null) return
    arrival.current.settled = true
    // The window as it is now: a resize may not have reached the page's state yet.
    if (opens === undefined || hasTabs || window.innerWidth < panelRoom) return
    go((r) => follow(r, { view: opens.view, params: opens.params }, false), { replace: true })
  }, [mainKey, shown.data, opens, hasTabs, panelRoom, go])
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

  // A page of files: list or icons, and up to the folder above, from the app's menus or, in a browser, ⌘1, ⌘2 and ⌘↑.
  const shownResult = shown.data?.outcome === 'shown' ? shown.data : null
  const trail = shownResult?.trail
  const lookCommand = useCallback(
    (c: ShellCommand) => {
      if (c === 'list' || c === 'icons') setFileLook({ look: c })
      else if (c === 'up' && trail && trail.length > 1) onLinkRef.current?.((trail[trail.length - 2] as Crumb).link)
    },
    [setFileLook, trail],
  )
  const onLinkRef = useRef<((link: Link) => void) | null>(null)
  useEffect(() => {
    if (!IN_SHELL) return
    const heard = (e: Event) => {
      const c = (e as CustomEvent<{ command?: ShellCommand }>).detail?.command
      if (c) lookCommand(c)
    }
    window.addEventListener('pneuma-shell', heard)
    return () => window.removeEventListener('pneuma-shell', heard)
  }, [lookCommand])

  // Escape closes the front tab; ⌘K opens the palette; ⌃⌘S folds the sidebar. A dialog or the palette takes Escape first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')
      if (!IN_SHELL && e.metaKey && !typing && (e.key === '1' || e.key === '2' || e.key === 'ArrowUp')) {
        e.preventDefault()
        lookCommand(e.key === '1' ? 'list' : e.key === '2' ? 'icons' : 'up')
      } else if (e.key === 'Escape') go((r) => closeTab(r, r.active))
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
  }, [go, pending, toggleSide, lookCommand])

  const run = useCallback(
    async (action: Action, values: Record<string, string>, confirmed: boolean): Promise<Done> => {
      const id = busy(action.label)
      let done: Done
      try {
        const reply = await api.pass(fill(action.call, values, action.inputs), confirmed, (progress, pass) => report(id, progress, () => void api.stop(pass).catch(() => undefined)))
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
    [refresh, busy, settle, report],
  )

  const onLink = useCallback(
    (link: Link, newTab = false) => {
      const req = { view: link.view, params: link.params }
      if (link.target === 'main') go((r) => ({ ...r, main: req }))
      else go((r) => follow(r, req, newTab))
    },
    [go],
  )
  onLinkRef.current = onLink
  const onAction = useCallback(
    (action: Action, values: Record<string, string> = {}, filled = false): Promise<Done | null> =>
      (action.inputs.length > 0 && !filled) || action.confirm !== null ? new Promise((resolve) => setPending({ id: ++asked.current, action, values, resolve })) : run(action, values, false),
    [run],
  )
  const selected = useCallback((link: Link | null) => link !== null && link.target === 'panel' && sameLink(link, top), [top])
  // A parameter set from a block, such as a folder chosen in a tree, changes the view the block is in.
  // The sort chosen on a page is remembered for the page, on this machine.
  const onMainParam = useCallback(
    (name: string, value: string) => {
      if (name === 'sort') setFileLook({ sort: value })
      if (current) go((r) => ({ ...r, main: { view: current.view, params: { ...current.params, [name]: value } } }))
    },
    [current, go, setFileLook],
  )
  const onPanelParam = useCallback((name: string, value: string) => top && go((r) => retop(r, { view: top.view, params: { ...top.params, [name]: value } })), [top, go])
  // The app opens a link it was given, from the menu bar panel, and says what a drop or its watcher did.
  const { push } = toasts
  useEffect(() => {
    if (!IN_SHELL) return
    const heard = (e: Event) => {
      const detail = (e as CustomEvent<{ link?: Link; notice?: { tone: Tone; text: string } }>).detail
      if (detail?.link) onLink(detail.link)
      if (detail?.notice) {
        push(detail.notice.tone, detail.notice.text)
        refresh()
      }
    }
    window.addEventListener('pneuma-shell', heard)
    return () => window.removeEventListener('pneuma-shell', heard)
  }, [onLink, push, refresh])
  const onPage = useCallback(
    (link: Link) => {
      const req = { view: link.view, params: link.params }
      if (link.target === 'main') go((r) => ({ ...r, main: req }))
      else go((r) => retop(r, req))
    },
    [go],
  )
  const root = state.data?.library?.root ?? null
  const env: BlockEnv = useMemo(() => ({ tick, onLink, onAction, onParam: onMainParam, onPage, selected, look: fileLook.look, root }), [tick, onLink, onAction, onMainParam, onPage, selected, fileLook.look, root])
  const panelEnv: BlockEnv = useMemo(() => ({ ...env, onParam: onPanelParam, look: 'list' as const }), [env, onPanelParam])
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
  const groupOf = (v: (typeof views)[number]) => {
    const root = entryOf(views, v.id)[0]
    return root !== undefined && root.id !== v.id ? root.title : null
  }
  const entry = entryOf(views, current?.view ?? null)
  const detailShown = detail.data?.outcome === 'shown' ? detail.data : null
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
              {result?.trail && result.trail.length > 0 ? (
                <PathBar trail={result.trail} onGo={onLink} />
              ) : (
                <>
                  <h1>{result?.title ?? decl?.title ?? ''}</h1>
                  {result?.subtitle ? <p>{localMoments(result.subtitle)}</p> : null}
                </>
              )}
              <Filters decl={decl} answered={result?.filters} params={request?.params ?? {}} onChange={onMainParam} />
              <div className="page-tools">
                {result && filesTable(result.blocks) ? <LookTools look={fileLook.look} sorted={filesTable(result.blocks)?.sorted} onLook={(look) => setFileLook({ look })} onSort={(sort) => onMainParam('sort', sort)} /> : null}
                {result ? <HeadActions actions={headActions(result.blocks)} /> : null}
                <ViewSwitch entry={entry} current={current?.view ?? ''} onSelect={(view) => go((r) => ({ ...r, main: { view, params: {} } }))} />
              </div>
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
                actions={detailShown ? headActions(detailShown.blocks) : []}
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
