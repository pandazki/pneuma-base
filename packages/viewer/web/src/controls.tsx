// The page's own controls: a segmented choice whose grey pill glides between options, a select for
// more options, key caps, a menu whose highlight glides between items, the one tooltip of the page,
// and keeping a leaving thing on screen while it animates out.
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type Option = { value: string; label: string; count?: number }

/** Up to this many options show side by side; more go in a select. */
const SEGMENTS = 4

type ChoiceProps = { label: string; options: Option[]; value: string; onChange(value: string): void }

function Segmented({ label, options, value, onChange }: ChoiceProps) {
  const group = useRef<HTMLDivElement | null>(null)
  const pill = useRef<HTMLSpanElement | null>(null)
  const current = Math.max(0, options.findIndex((o) => o.value === value))
  // The pill sits under the checked option: placed without moving the first time, gliding after.
  const placed = useRef(false)
  useLayoutEffect(() => {
    const el = group.current
    const p = pill.current
    if (!el || !p) return
    const place = () => {
      const target = el.querySelectorAll<HTMLButtonElement>('[role=radio]')[current]
      if (!target) return
      if (!placed.current) p.style.transition = 'none'
      p.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`
      p.style.width = `${target.offsetWidth}px`
      if (!placed.current) {
        void p.offsetWidth
        p.style.transition = ''
        placed.current = true
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => observer.disconnect()
  }, [current, options])
  // Arrow keys move the choice, as in a radio group.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : step === 0 ? -1 : (current + step + options.length) % options.length
    if (to < 0) return
    e.preventDefault()
    onChange(options[to]?.value ?? value)
    group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[to]?.focus()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} className="segmented" data-glide onKeyDown={onKeyDown}>
      <span ref={pill} className="pill" aria-hidden />
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={i === current} tabIndex={i === current ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

function SelectControl({ label, options, value, onChange }: ChoiceProps) {
  return (
    <span className="select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.count === undefined ? o.label : `${o.label}（${o.count}）`}
          </option>
        ))}
      </select>
      <ChevronDown strokeWidth={1.75} aria-hidden />
    </span>
  )
}

/** One choice among `options`, side by side when there are few of them. */
export function Choice(props: ChoiceProps) {
  return props.options.length <= SEGMENTS ? <Segmented {...props} /> : <SelectControl {...props} />
}

/** Whether the page runs on a Mac, where the command key is ⌘. */
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/** A key cap for `keys`, such as ['⌘', 'K']. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <kbd className="kbd" aria-hidden>
      {keys.map((k) => (MAC ? k : k === '⌘' ? 'Ctrl+' : k === '⌃' ? 'Ctrl+' : k)).join('')}
    </kbd>
  )
}

/**
 * Something that leaves with an animation: the last value stays for `ms` after it went away, marked
 * as leaving, so it can play its way out. Reduced motion takes it away at once.
 */
export function usePresence<T>(value: T | null, ms: number): { shown: T | null; leaving: boolean } {
  const [held, setHeld] = useState<T | null>(value)
  useEffect(() => {
    if (value !== null) {
      setHeld(value)
      return
    }
    const quick = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => setHeld(null), quick ? 0 : ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return value !== null ? { shown: value, leaving: false } : { shown: held, leaving: held !== null }
}

export type MenuEntry = { label: string; icon?: ReactNode; keys?: string; danger?: boolean; onSelect(): void } | 'separator'

/**
 * A menu under its trigger. Nothing is lit until the pointer or a key says so; a soft highlight glides
 * to the lit item. Arrow keys, Home and End move, Enter or Space chooses, Escape and Tab close and
 * give the focus back. It enters with a short scale from its corner and leaves at once.
 */
export function Menu({ label, entries, trigger }: { label: string; entries: MenuEntry[]; trigger(props: { ref(el: HTMLElement | null): void; open: boolean; toggle(): void; onKeyDown(e: KeyboardEvent): void }): ReactNode }) {
  const [open, setOpen] = useState(false)
  const [lit, setLit] = useState(-1)
  const anchor = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const glow = useRef<HTMLSpanElement | null>(null)
  const [at, setAt] = useState({ left: 0, top: 0 })
  const items = entries.filter((e): e is Exclude<MenuEntry, 'separator'> => e !== 'separator')

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setLit(-1)
    if (refocus) anchor.current?.focus()
  }, [])
  const show = (first: number) => {
    const r = anchor.current?.getBoundingClientRect()
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 240)), top: r.bottom + 6 })
    setOpen(true)
    setLit(first)
  }

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) close(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [open, close])

  useLayoutEffect(() => {
    const g = glow.current
    const el = panel.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[lit]
    if (!g) return
    if (!el) {
      g.style.opacity = '0'
      return
    }
    g.style.opacity = '1'
    g.style.transform = `translateY(${el.offsetTop}px)`
    g.style.height = `${el.offsetHeight}px`
  }, [lit, open])

  const choose = (i: number) => {
    const item = items[i]
    if (!item) return
    close(true)
    item.onSelect()
  }
  const onPanelKey = (e: KeyboardEvent) => {
    const n = items.length
    if (e.key === 'ArrowDown') setLit((l) => (l + 1) % n)
    else if (e.key === 'ArrowUp') setLit((l) => (l <= 0 ? n - 1 : l - 1))
    else if (e.key === 'Home') setLit(0)
    else if (e.key === 'End') setLit(n - 1)
    else if (e.key === 'Enter' || e.key === ' ') choose(lit)
    else if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') close(false)
    else return
    e.preventDefault()
  }
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      show(0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      show(items.length - 1)
    }
  }

  let index = -1
  return (
    <>
      {trigger({ ref: (el) => (anchor.current = el), open, toggle: () => (open ? close(false) : show(-1)), onKeyDown: onTriggerKey })}
      {open ? (
        <div ref={panel} role="menu" aria-label={label} tabIndex={-1} className="menu" style={at} onKeyDown={onPanelKey} data-chrome>
          <div className="menu-list" onPointerLeave={() => setLit(-1)}>
            <span ref={glow} className="menu-glow" aria-hidden />
            {entries.map((entry, k) => {
              if (entry === 'separator') return <div key={`sep-${k}`} className="menu-sep" role="separator" />
              const i = ++index
              return (
                <button
                  key={entry.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-item"
                  data-lit={i === lit || undefined}
                  data-danger={entry.danger || undefined}
                  onPointerMove={() => setLit(i)}
                  onClick={() => choose(i)}
                >
                  {entry.icon}
                  {entry.label}
                  {entry.keys ? <span className="keys">{entry.keys}</span> : null}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * The page's one tooltip, for anything with `data-tip`: after half a second under the pointer, at
 * once for keyboard focus, and at once for a neighbour while one was just shown. Escape hides it.
 */
export function TipLayer() {
  const [tip, setTip] = useState<{ text: string; left: number; top: number; instant: boolean } | null>(null)
  const el = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    let timer: number | undefined
    let warmUntil = 0
    let target: Element | null = null
    const place = (t: Element, instant: boolean) => {
      const text = t.getAttribute('data-tip')
      if (!text) return
      const r = t.getBoundingClientRect()
      setTip({ text, left: r.left + r.width / 2, top: r.top, instant })
    }
    const hide = () => {
      window.clearTimeout(timer)
      if (target) warmUntil = Date.now() + 300
      target = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      const t = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (t === target) return
      hide()
      if (!t) return
      target = t
      const warm = Date.now() < warmUntil
      timer = window.setTimeout(() => place(t, warm), warm ? 0 : 500)
    }
    const focus = (e: FocusEvent) => {
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (!t || !t.matches(':focus-visible')) return
      target = t
      place(t, false)
    }
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && hide()
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', key)
    document.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', hide)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('keydown', key)
      document.removeEventListener('scroll', hide, true)
    }
  }, [])
  // Above its target, or below when there is no room; inside the window either way.
  useLayoutEffect(() => {
    const t = el.current
    if (!t || !tip) return
    const w = t.offsetWidth
    const h = t.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, tip.left - w / 2))
    t.style.left = `${left}px`
    t.style.top = `${tip.top - h - 6 < 8 ? tip.top + 34 : tip.top - h - 6}px`
  }, [tip])
  if (!tip) return null
  return (
    <div ref={el} className="tip" role="tooltip" data-instant={tip.instant || undefined}>
      {tip.text}
    </div>
  )
}

type ResizerProps = {
  label: string
  value: number
  min: number
  max: number
  initial: number
  /** Which way a drag to the right moves the edge: the sidebar's edge follows the pointer, the panel's grows against it. */
  grows: 'right' | 'left'
  className: string
  onChange(value: number): void
  onDrag(dragging: boolean): void
}

/**
 * A handle between two panes: drag it, or focus it and use ← →, 16px a step and 48 with Shift, Home
 * and End for the narrowest and the widest; a double click puts the width back.
 */
export function Resizer({ label, value, min, max, initial, grows, className, onChange, onDrag }: ResizerProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  const sign = grows === 'right' ? 1 : -1
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`resizer ${className}`}
      data-chrome
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        el.dataset.active = ''
        const [x, from] = [e.clientX, value]
        onDrag(true)
        const move = (m: PointerEvent) => onChange(clamp(from + sign * (m.clientX - x)))
        const up = () => {
          delete el.dataset.active
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
          onDrag(false)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }}
      onDoubleClick={() => onChange(initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16
        const to = e.key === 'ArrowRight' ? value + sign * step : e.key === 'ArrowLeft' ? value - sign * step : e.key === 'Home' ? min : e.key === 'End' ? max : null
        if (to === null) return
        e.preventDefault()
        onChange(clamp(to))
      }}
    />
  )
}
