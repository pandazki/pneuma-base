// The shell: navigation on the left, the view in the middle, a detail panel on the right.
// It keeps no state of its own beyond which views are open; every view comes from the server.
import type { Action, Link, PluginProblem, ViewDecl, ViewRequest, ViewResult } from '@pneuma-base/kernel'
import { ArrowLeft, Database, LoaderCircle, Unplug, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type State } from './api'
import { BlockEnvContext, Blocks, sameLink, useWidth, type BlockEnv } from './blocks'
import { ActionDialog, fill, Toasts, useToasts, ViewIcon } from './chrome'
import { Choice } from './controls'
import { FONT, fitStart } from './measure'
import { clockTime } from './time'

/** How often the page asks whether the library changed. */
export const POLL_MS = 2000

type Load<T> = { data: T | null; failed: boolean }

/** Loads `load()` whenever `key` or `tick` changes, keeping the last answer on screen meanwhile. */
function useLoad<T>(key: string | null, tick: number, load: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, failed: false })
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    if (key === null) return
    let live = true
    loader.current().then(
      (data) => live && setState({ data, failed: false }),
      () => live && setState((s) => ({ ...s, failed: true })),
    )
    return () => {
      live = false
    }
  }, [key, tick])
  return state
}

/** The view's parameters with each filter's default filled in. */
function withDefaults(req: ViewRequest, decl: ViewDecl | undefined): ViewRequest {
  const defaults = Object.fromEntries((decl?.filters ?? []).map((f) => [f.name, f.default]))
  return { view: req.view, params: { ...defaults, ...req.params } }
}

const keyOf = (req: ViewRequest | null) => (req === null ? null : JSON.stringify([req.view, Object.entries(req.params).sort()]))

function Problems({ problems }: { problems: PluginProblem[] }) {
  if (problems.length === 0) return null
  return (
    <div className="flex flex-col gap-1 rounded-control bg-orange-tint px-3 py-2 text-[12.5px]" role="alert">
      {problems.map((p, i) => (
        <p key={i}>
          插件 <span className="font-mono">{p.plugin}</span> 出了问题：{p.message}
        </p>
      ))}
    </div>
  )
}

/** Whether the page keeps up with the library by itself, and when it last picked up a change. */
function Freshness({ down, changedAt }: { down: boolean; changedAt: Date | null }) {
  return (
    <div className="mt-auto flex items-center gap-2 px-4 py-3 text-[11.5px] text-ink-3" title={`每 ${POLL_MS / 1000} 秒看一次库有没有变；变了，这一页自己会更新。`}>
      <span key={changedAt?.getTime() ?? 0} className={`size-1.5 shrink-0 rounded-full ${down ? 'bg-red' : 'fresh-dot bg-green'}`} aria-hidden />
      <span className="truncate">{down ? '连不上服务' : changedAt ? `自动更新 · ${clockTime(changedAt)} 有变化` : '自动更新'}</span>
    </div>
  )
}

function Nav({ state, current, down, changedAt, onSelect }: { state: State; current: string | null; down: boolean; changedAt: Date | null; onSelect(view: string): void }) {
  const root = state.library?.root ?? state.dir
  const name = root.split('/').filter(Boolean).at(-1) ?? root
  const [measure, width] = useWidth()
  const shown = state.library?.shown ?? root
  return (
    <nav aria-label="导航" className="flex w-[208px] shrink-0 flex-col border-r border-line bg-canvas">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-surface shadow-(--shadow-btn)">
          <Database className="size-4 text-accent" strokeWidth={2} aria-hidden />
        </span>
        <div ref={measure} className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{name}</div>
          <div className="overflow-hidden font-mono text-[11px] whitespace-nowrap text-ink-3" title={root}>
            {width > 0 ? fitStart(shown, FONT.monoSmall, width) : ''}
          </div>
        </div>
      </div>
      <ul className="flex flex-col gap-0.5 px-2">
        {state.views
          .filter((v) => v.nav)
          .map((v) => (
            <li key={v.id}>
              <button
                type="button"
                aria-current={v.id === current ? 'page' : undefined}
                className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-(--shadow-btn)"
                onClick={() => onSelect(v.id)}
              >
                <ViewIcon name={v.icon} className="size-4 shrink-0" />
                <span className="truncate">{v.title}</span>
              </button>
            </li>
          ))}
      </ul>
      <Freshness down={down} changedAt={changedAt} />
    </nav>
  )
}

function Filters({ decl, params, onChange }: { decl: ViewDecl | undefined; params: Record<string, string>; onChange(name: string, value: string): void }) {
  if (!decl || decl.filters.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" role="toolbar" aria-label="过滤">
      {decl.filters.map((f) => (
        <div key={f.name} className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-ink-3" aria-hidden>
            {f.label}
          </span>
          <Choice label={f.label} options={f.options} value={params[f.name] ?? f.default} onChange={(value) => onChange(f.name, value)} />
        </div>
      ))}
    </div>
  )
}

function Shown({ result, failed }: { result: ViewResult | null; failed: boolean }) {
  if (result === null) return failed ? <p className="text-[13px] text-red">这一页没能取到。</p> : <div className="h-32 animate-pulse rounded-card bg-inset" />
  if (result.outcome === 'no-such-view') return <p className="text-[13px] text-ink-2">没有这一页。</p>
  return (
    <div className="flex flex-col gap-4">
      <Problems problems={result.problems} />
      <Blocks blocks={result.blocks} />
    </div>
  )
}

function Panel({ result, failed, canGoBack, onBack, onClose }: { result: ViewResult | null; failed: boolean; canGoBack: boolean; onBack(): void; onClose(): void }) {
  const title = result?.outcome === 'shown' ? result.title : ''
  const subtitle = result?.outcome === 'shown' ? result.subtitle : null
  return (
    <aside aria-label="详情" className="flex w-[420px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        {canGoBack ? (
          <button type="button" className="flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-hover" aria-label="返回" onClick={onBack}>
            <ArrowLeft className="size-4" strokeWidth={2} />
          </button>
        ) : (
          <span className="w-1" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" data-testid="panel-title">
            {title}
          </div>
          {subtitle ? <div className="truncate font-mono text-[11px] text-ink-3">{subtitle}</div> : null}
        </div>
        <button type="button" className="flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-hover" aria-label="关闭详情" onClick={onClose}>
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Shown result={result} failed={failed} />
      </div>
    </aside>
  )
}

function Unreachable() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center" role="alert">
      <Unplug className="size-8 text-ink-3" strokeWidth={2} aria-hidden />
      <p className="text-[15px] font-semibold">连不上服务</p>
      <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
        <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2} aria-hidden />
        正在重试。服务是用 pneuma-base view 启动的，关掉了就再启动一次。
      </p>
    </div>
  )
}

function Denied() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center" role="alert">
      <p className="text-[15px] font-semibold">这个地址不对</p>
      <p className="max-w-[28rem] text-[13px] text-ink-2">地址里缺少令牌，或者服务已经换了一个令牌。用 pneuma-base view 打印出来的地址打开。</p>
    </div>
  )
}

function InitScreen({ state, onInit }: { state: State; onInit(plugins: string[]): Promise<void> }) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(state.available.some((p) => p.name === 'ledger') ? ['ledger'] : []))
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card w-full max-w-[420px] p-6">
        <h1 className="text-[17px] font-semibold">这个目录还不是库</h1>
        <p className="mt-1 font-mono text-[12px] break-all text-ink-2">{state.dir}</p>
        <p className="mt-3 text-[13px] text-ink-2">建成库之后，根目录多一份说明 PNEUMA-BASE.md 和一个 .pneuma-base/ 目录，里面的东西原样留着。</p>
        {state.available.length > 0 ? (
          <fieldset className="mt-4">
            <legend className="mb-2 text-[12.5px] font-medium text-ink-2">装上这些插件</legend>
            <div className="flex flex-col gap-1.5">
              {state.available.map((p) => (
                <label key={p.name} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={chosen.has(p.name)}
                    onChange={(e) => {
                      const next = new Set(chosen)
                      if (e.target.checked) next.add(p.name)
                      else next.delete(p.name)
                      setChosen(next)
                    }}
                  />
                  <span className="font-mono text-[12.5px]">{p.name}</span>
                  {p.title ? <span className="text-ink-2">{p.title}</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <button
          type="button"
          className="btn btn-primary mt-5"
          disabled={busy}
          onClick={async () => {
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

export function App() {
  const [tick, setTick] = useState(0)
  const [down, setDown] = useState(false)
  const [denied, setDenied] = useState(false)
  const [main, setMain] = useState<ViewRequest | null>(null)
  const [panel, setPanel] = useState<ViewRequest[]>([])
  const [pending, setPending] = useState<Action | null>(null)
  const [changedAt, setChangedAt] = useState<Date | null>(null)
  const [toasts, toast, closeToast] = useToasts()
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const cancel = useCallback(() => setPending(null), [])

  // Ask every two seconds whether anything changed; refetch when it did or when the server is back.
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
  const firstNav = views.find((v) => v.nav)?.id ?? null
  const current = main !== null && views.some((v) => v.id === main.view) ? main : firstNav === null ? null : { view: firstNav, params: {} }
  const decl = views.find((v) => v.id === current?.view)
  const request = current === null ? null : withDefaults(current, decl)
  const shown = useLoad(keyOf(request), tick, () => api.view(request as ViewRequest))
  const top = panel.at(-1) ?? null
  const detail = useLoad(keyOf(top), tick, () => api.view(top as ViewRequest))

  // Escape closes the panel; an open dialog takes Escape for itself first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPanel([])
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = useCallback(
    async (action: Action, values: Record<string, string>, confirmed: boolean) => {
      try {
        const reply = await api.call(fill(action.call, values, action.inputs), confirmed)
        toast(reply.tone, reply.text)
      } catch (error) {
        toast('bad', error instanceof Error ? error.message : String(error))
      }
      refresh()
    },
    [refresh, toast],
  )

  const env: BlockEnv = useMemo(
    () => ({
      tick,
      onLink: (link: Link) => {
        const req = { view: link.view, params: link.params }
        if (link.target === 'main') setMain(req)
        else setPanel((stack) => (sameLink(link, stack.at(-1) ?? null) ? stack : [...stack, req]))
      },
      onAction: (action: Action) => (action.inputs.length > 0 || action.confirm !== null ? setPending(action) : void run(action, {}, false)),
      selected: (link: Link | null) => link !== null && link.target === 'panel' && sameLink(link, top),
    }),
    [tick, run, top],
  )

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
              toast(reply.tone, reply.text)
            } catch (error) {
              toast('bad', error instanceof Error ? error.message : String(error))
            }
            refresh()
          }}
        />
        <Toasts toasts={toasts} onClose={closeToast} />
      </>
    )
  }

  const result = shown.data?.outcome === 'shown' ? shown.data : null
  return (
    <BlockEnvContext.Provider value={env}>
      <div className="flex h-full flex-col">
        {down ? (
          <div className="flex shrink-0 items-center justify-center gap-2 bg-red-tint px-4 py-1.5 text-[12.5px] text-ink" role="alert">
            <Unplug className="size-3.5 text-red" strokeWidth={2} aria-hidden />
            连不上服务，正在重试。下面是最后一次取到的内容。
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <Nav
            state={state.data}
            current={current?.view ?? null}
            down={down}
            changedAt={changedAt}
            onSelect={(view) => {
              setMain({ view, params: {} })
            }}
          />
          <main className="min-w-0 flex-1 overflow-auto bg-page">
            <header className="flex flex-col gap-3 px-6 pt-5 pb-4">
              <div className="min-w-0">
                <h1 className="text-[19px] font-semibold tracking-[-0.015em]">{result?.title ?? decl?.title ?? ''}</h1>
                {result?.subtitle ? <p className="truncate text-[12.5px] text-ink-2">{result.subtitle}</p> : null}
              </div>
              <Filters decl={decl} params={request?.params ?? {}} onChange={(name, value) => current && setMain({ view: current.view, params: { ...current.params, [name]: value } })} />
            </header>
            <div className="flex flex-col gap-4 px-6 pb-12">
              <Problems problems={state.data.problems} />
              <Shown result={shown.data} failed={shown.failed} />
            </div>
          </main>
          {top !== null ? (
            <Panel result={detail.data} failed={detail.failed} canGoBack={panel.length > 1} onBack={() => setPanel((s) => s.slice(0, -1))} onClose={() => setPanel([])} />
          ) : null}
        </div>
      </div>
      {pending ? (
        <ActionDialog
          action={pending}
          onCancel={cancel}
          onSubmit={(values) => {
            const action = pending
            setPending(null)
            void run(action, values, action.confirm !== null)
          }}
        />
      ) : null}
      <Toasts toasts={toasts} onClose={closeToast} />
    </BlockEnvContext.Provider>
  )
}
