// Notices at the bottom right. One that answers an action appears at once, saying the action is
// under way, and turns into its answer in place. They stack, the newest in front with the others
// peeking above it; the pointer or the keyboard (F8) fans them out and holds their timers.
import type { Action } from '@pneuma-base/kernel'
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Tone } from './api'

/** `busy`: the action is under way. `offer`: what a refusal offers to do instead, a button in the notice. */
export type Toast = { id: number; tone: Tone | 'busy'; text: string; offer: Action | null; settled: boolean; leaving: boolean }

export type Toasts = {
  list: Toast[]
  /** A finished notice. */
  push(tone: Tone, text: string, offer?: Action | null): number
  /** A notice that `label` is under way, to settle when it is done. */
  busy(label: string): number
  settle(id: number, tone: Tone, text: string, offer?: Action | null): void
  close(id: number): void
  /** While the person looks at the notices, none goes away by itself. */
  hold(held: boolean): void
}

/** How long a finished notice stays; a refusal or an error stays until it is closed. */
export const TOAST_MS = 4500
/** How long a closed notice takes to leave. */
const LEAVE_MS = 420
/** At most this many at once; a newer one pushes the oldest out. */
const MAX = 4

export function useToasts(): Toasts {
  const [list, setList] = useState<Toast[]>([])
  const next = useRef(0)
  // The time each finished notice has left, and its running timer while nothing holds them.
  const timers = useRef(new Map<number, { left: number; since: number; handle: number | undefined }>())
  const held = useRef(false)

  const close = useCallback((id: number) => {
    const timer = timers.current.get(id)
    window.clearTimeout(timer?.handle)
    timers.current.delete(id)
    setList((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    window.setTimeout(() => setList((all) => all.filter((t) => t.id !== id)), LEAVE_MS)
  }, [])

  const start = useCallback(
    (id: number) => {
      const timer = timers.current.get(id)
      if (!timer || held.current) return
      timer.since = Date.now()
      timer.handle = window.setTimeout(() => close(id), timer.left)
    },
    [close],
  )
  const time = useCallback(
    (id: number, tone: Toast['tone']) => {
      if (tone === 'bad' || tone === 'busy') return
      timers.current.set(id, { left: TOAST_MS, since: 0, handle: undefined })
      start(id)
    },
    [start],
  )

  const add = useCallback(
    (toast: Omit<Toast, 'id' | 'leaving'>) => {
      const id = next.current++
      setList((all) => {
        const shown = all.filter((t) => !t.leaving)
        for (const old of shown.slice(0, Math.max(0, shown.length - MAX + 1))) window.setTimeout(() => close(old.id), 0)
        return [...all, { ...toast, id, leaving: false }]
      })
      time(id, toast.tone)
      return id
    },
    [close, time],
  )

  const ops = useMemo<Omit<Toasts, 'list'>>(
    () => ({
      push: (tone, text, offer = null) => add({ tone, text, offer, settled: false }),
      busy: (label) => add({ tone: 'busy', text: `${label}\n正在进行…`, offer: null, settled: false }),
      settle: (id, tone, text, offer = null) => {
        setList((all) => all.map((t) => (t.id === id ? { ...t, tone, text, offer, settled: true } : t)))
        time(id, tone)
      },
      close,
      hold: (on) => {
        if (held.current === on) return
        held.current = on
        for (const [id, timer] of timers.current) {
          if (!on) start(id)
          else if (timer.handle !== undefined) {
            window.clearTimeout(timer.handle)
            timer.handle = undefined
            timer.left = Math.max(800, timer.left - (Date.now() - timer.since))
          }
        }
      },
    }),
    [add, close, time, start],
  )
  return useMemo(() => ({ ...ops, list }), [ops, list])
}

const ICON: Record<Tone, LucideIcon> = { good: CircleCheck, warn: TriangleAlert, bad: CircleAlert }
const GAP = 8
const PEEK = 10
/** How many show in the folded stack; the rest wait behind. */
const FOLDED = 3

/** `onAction` runs a notice's offer, as a button would; the notice closes when it is taken. */
export function Toaster({ toasts, onAction }: { toasts: Toasts; onAction?(action: Action): void }) {
  const region = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const { hold } = toasts
  useEffect(() => hold(open), [open, hold])

  // F8 takes the keyboard to the notices.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F8') return
      e.preventDefault()
      region.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const measured = useCallback((id: number, h: number) => setHeights((all) => (all[id] === h ? all : { ...all, [id]: h })), [])

  // Newest first: depth 0 is in front.
  const shown = toasts.list.filter((t) => !t.leaving).reverse()
  const depth = new Map(shown.map((t, i) => [t.id, i]))
  const front = heights[shown[0]?.id ?? -1] ?? 0
  const offsets: number[] = []
  shown.reduce((y, t, i) => ((offsets[i] = y), y + (heights[t.id] ?? 0) + GAP), 0)
  const height = shown.length === 0 ? 0 : open ? (offsets.at(-1) ?? 0) + (heights[shown.at(-1)?.id ?? -1] ?? 0) : front + Math.min(shown.length - 1, FOLDED - 1) * PEEK
  const last = useRef(new Map<number, { y: number; scale: number }>())

  return (
    <section
      ref={region}
      className="toaster"
      role="status"
      aria-live="polite"
      aria-label="通知"
      tabIndex={-1}
      data-chrome
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}
    >
      <ol style={{ height }}>
        {toasts.list.map((t) => {
          const d = depth.get(t.id)
          let place: { y: number; scale: number }
          if (d === undefined) {
            const was = last.current.get(t.id) ?? { y: 0, scale: 1 }
            place = { y: was.y + 10, scale: was.scale * 0.96 }
          } else {
            place = open ? { y: -(offsets[d] ?? 0), scale: 1 } : { y: -d * PEEK, scale: 1 - d * 0.05 }
            last.current.set(t.id, place)
          }
          return (
            <ToastItem
              key={t.id}
              toast={t}
              y={place.y}
              scale={place.scale}
              behind={!open && d !== undefined && d > 0}
              hidden={d === undefined || (!open && d >= FOLDED)}
              height={!open && d !== undefined && d > 0 ? front : undefined}
              z={d === undefined ? 0 : 100 - d}
              onMeasure={measured}
              onClose={() => toasts.close(t.id)}
              onOffer={
                t.offer && onAction
                  ? (offer) => {
                      toasts.close(t.id)
                      onAction(offer)
                    }
                  : undefined
              }
            />
          )
        })}
      </ol>
    </section>
  )
}

type ItemProps = {
  toast: Toast
  y: number
  scale: number
  behind: boolean
  hidden: boolean
  height: number | undefined
  z: number
  onMeasure(id: number, height: number): void
  onClose(): void
  onOffer?(offer: Action): void
}

function ToastItem({ toast, y, scale, behind, hidden, height, z, onMeasure, onClose, onOffer }: ItemProps) {
  const card = useRef<HTMLDivElement | null>(null)
  const [entered, setEntered] = useState(false)
  // Rises from below on its first frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const report = () => onMeasure(toast.id, el.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [toast.id, onMeasure])

  const [title = '', ...rest] = toast.text.split('\n')
  const Icon = toast.tone === 'busy' ? LoaderCircle : ICON[toast.tone]
  const { offer } = toast
  return (
    <li
      className="toast"
      data-behind={behind || undefined}
      data-leaving={toast.leaving || undefined}
      aria-hidden={toast.leaving || hidden || undefined}
      style={{
        transform: entered ? `translateY(${y}px) scale(${scale})` : 'translateY(100%)',
        opacity: entered && !toast.leaving && !hidden ? 1 : 0,
        height,
        zIndex: z,
      }}
    >
      <div className="toast-card">
        <div ref={card} className="toast-content">
          <span className="toast-icon" data-tone={toast.tone} data-settled={toast.settled || undefined} key={toast.tone}>
            <Icon className={toast.tone === 'busy' ? 'spinner' : undefined} strokeWidth={2} aria-hidden />
          </span>
          <p className="toast-text" key={toast.text}>
            <strong>{title}</strong>
            {rest.length > 0 ? <span>{rest.join('\n')}</span> : null}
          </p>
          {offer && onOffer ? (
            <button type="button" className={`btn btn-sm ${offer.tone === 'danger' ? 'btn-danger' : ''}`} onClick={() => onOffer(offer)}>
              {offer.label}
            </button>
          ) : null}
        </div>
        <button type="button" className="toast-close" aria-label="关闭" tabIndex={behind ? -1 : 0} onClick={onClose}>
          <X strokeWidth={2.5} aria-hidden />
        </button>
      </div>
    </li>
  )
}
