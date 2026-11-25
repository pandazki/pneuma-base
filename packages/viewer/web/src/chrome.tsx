// The parts around the blocks: icons, the action dialog, toasts.
import type { Action, ActionInput, Call } from '@pneuma-base/kernel'
import {
  Activity,
  Archive,
  Box,
  CircleAlert,
  CircleCheck,
  Clock,
  File,
  Folder,
  GitBranch,
  Globe,
  History,
  Layers,
  LayoutGrid,
  List,
  Puzzle,
  ScrollText,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Tone } from './api'

const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  box: Box,
  clock: Clock,
  file: File,
  folder: Folder,
  'git-branch': GitBranch,
  globe: Globe,
  history: History,
  layers: Layers,
  'layout-grid': LayoutGrid,
  list: List,
  'scroll-text': ScrollText,
  settings: Settings,
  'triangle-alert': TriangleAlert,
}

/** A lucide icon by name; a name this page does not know gets the default icon. */
export function ViewIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Puzzle
  return <Icon className={className} strokeWidth={2} aria-hidden />
}

/** The call with every `{input}` in its strings replaced by that input's value. */
export function fill(call: Call, values: Record<string, string>): Call {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{([^{}]+)\}/g, (whole, name: string) => values[name] ?? whole)
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(call) as Call
}

const initial = (inputs: ActionInput[]) => Object.fromEntries(inputs.map((i) => [i.name, i.value ?? i.options?.[0]?.value ?? '']))

/** The form an action opens when it has inputs or asks for confirmation. Submitting it is the in-person confirmation. */
export function ActionDialog({ action, onCancel, onSubmit }: { action: Action; onCancel(): void; onSubmit(values: Record<string, string>): void }) {
  const [values, setValues] = useState(() => initial(action.inputs))
  const first = useRef<HTMLInputElement | HTMLSelectElement | null>(null)
  const submit = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    ;(first.current ?? submit.current)?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const danger = action.tone === 'danger'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[oklch(20%_0.01_264/0.32)] p-4" onMouseDown={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={action.label}
        className="w-full max-w-[420px] rounded-window bg-surface p-5 shadow-(--shadow-overlay)"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(values)
        }}
      >
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          {danger ? <TriangleAlert className="size-4 text-red" strokeWidth={2} aria-hidden /> : null}
          {action.label}
        </h2>
        {action.confirm ? <p className="mt-2 text-[13px] text-ink-2">{action.confirm}</p> : null}
        {action.inputs.length > 0 ? (
          <div className="mt-4 flex flex-col gap-3">
            {action.inputs.map((input, i) => (
              <label key={input.name} className="flex flex-col gap-1 text-[12.5px] font-medium text-ink-2">
                {input.label}
                {input.options ? (
                  <select
                    ref={i === 0 ? (el) => void (first.current = el) : undefined}
                    className="field"
                    value={values[input.name] ?? ''}
                    onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
                  >
                    {input.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    ref={i === 0 ? (el) => void (first.current = el) : undefined}
                    className="field font-normal"
                    name={input.name}
                    value={values[input.name] ?? ''}
                    placeholder={input.placeholder ?? undefined}
                    onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
                  />
                )}
              </label>
            ))}
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button ref={submit} type="submit" className={`btn btn-primary ${danger ? 'btn-danger' : ''}`}>
            {action.label}
          </button>
        </div>
      </form>
    </div>
  )
}

export type Toast = { id: number; tone: Tone; text: string }

const TOAST_MS = 4500

export function useToasts(): [Toast[], (tone: Tone, text: string) => void] {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const push = useCallback((tone: Tone, text: string) => {
    const id = next.current++
    setToasts((all) => [...all.slice(-3), { id, tone, text }])
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), TOAST_MS)
  }, [])
  return [toasts, push]
}

const TOAST_ICON: Record<Tone, LucideIcon> = { good: CircleCheck, warn: TriangleAlert, bad: CircleAlert }
const TOAST_COLOR: Record<Tone, string> = { good: 'text-green', warn: 'text-orange', bad: 'text-red' }

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.tone]
        return (
          <div key={t.id} className="pointer-events-auto flex items-start gap-2 rounded-card bg-surface px-3 py-2.5 text-[13px] shadow-(--shadow-overlay)" data-tone={t.tone}>
            <Icon className={`mt-0.5 size-4 shrink-0 ${TOAST_COLOR[t.tone]}`} strokeWidth={2} aria-hidden />
            <span className="min-w-0 break-words whitespace-pre-line">{t.text}</span>
          </div>
        )
      })}
    </div>
  )
}
