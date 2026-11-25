// The parts around the blocks: icons, the action dialog, toasts.
import type { Action, ActionInput, Call } from '@pneuma-base/kernel'
import {
  Activity,
  Archive,
  Bookmark,
  Box,
  CircleAlert,
  CircleCheck,
  Clock,
  Cloud,
  CloudUpload,
  Code,
  CornerLeftUp,
  Database,
  Download,
  Eye,
  File,
  FileText,
  FlaskConical,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  History,
  Image,
  Key,
  Layers,
  LayoutGrid,
  Link,
  List,
  Package,
  Puzzle,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  Shield,
  Tag,
  Terminal,
  TriangleAlert,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Tone } from './api'
import { Choice } from './controls'

/** The lucide icons a view or a cell may name. Plugins added later pick from these; another name gets the default. */
const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  bookmark: Bookmark,
  box: Box,
  clock: Clock,
  cloud: Cloud,
  'cloud-upload': CloudUpload,
  code: Code,
  'corner-left-up': CornerLeftUp,
  database: Database,
  download: Download,
  eye: Eye,
  file: File,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: Folder,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  history: History,
  image: Image,
  key: Key,
  layers: Layers,
  'layout-grid': LayoutGrid,
  link: Link,
  list: List,
  package: Package,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  'scroll-text': ScrollText,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  tag: Tag,
  terminal: Terminal,
  'triangle-alert': TriangleAlert,
  upload: Upload,
  users: Users,
}

/** A lucide icon by name; a name this page does not know gets the default icon. */
export function ViewIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Puzzle
  return <Icon className={className} strokeWidth={2} aria-hidden />
}

/** A `multiple` input's values: its lines, trimmed, empty ones left out. */
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '')

/**
 * The call with every `{input}` in its strings replaced by that input's value. A list element that is
 * exactly `{input}` of a `multiple` input becomes one element per line.
 */
export function fill(call: Call, values: Record<string, string>, inputs: ActionInput[] = []): Call {
  const multiple = new Set(inputs.filter((i) => i.multiple).map((i) => i.name))
  const placeholder = (v: unknown) => (typeof v === 'string' ? /^\{([^{}]+)\}$/.exec(v)?.[1] : undefined)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{([^{}]+)\}/g, (whole, name: string) => values[name] ?? whole)
    if (Array.isArray(v)) {
      return v.flatMap((x) => {
        const name = placeholder(x)
        return name !== undefined && multiple.has(name) ? lines(values[name] ?? '') : [walk(x)]
      })
    }
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(call) as Call
}

const initial = (inputs: ActionInput[]) => Object.fromEntries(inputs.map((i) => [i.name, i.value ?? i.options?.[0]?.value ?? '']))

/** Whether a filled value fails the input's pattern, matched whole; each line of a `multiple` input. An empty one never does. */
function mismatched(input: ActionInput, value: string): boolean {
  if (input.pattern === undefined || value.trim() === '') return false
  let re: RegExp
  try {
    re = new RegExp(`^(?:${input.pattern})$`, 'u')
  } catch {
    return false
  }
  return (input.multiple ? lines(value) : [value]).some((v) => !re.test(v))
}

const FOCUSABLE = 'button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The form an action opens when it has inputs or asks for confirmation. Submitting it is the
 * in-person confirmation. While it is open, Tab stays inside it and Escape cancels; closing gives
 * focus back to what had it.
 */
export function ActionDialog({ action, preset = {}, onCancel, onSubmit }: { action: Action; preset?: Record<string, string>; onCancel(): void; onSubmit(values: Record<string, string>): void }) {
  const [values, setValues] = useState(() => ({ ...initial(action.inputs), ...preset }))
  const form = useRef<HTMLFormElement | null>(null)
  const danger = action.tone === 'danger'
  const wrong = new Set(action.inputs.filter((i) => mismatched(i, values[i.name] ?? '')).map((i) => i.name))
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A question with nothing to fill in starts on 取消, the choice that changes nothing.
    const start = action.inputs.length > 0 ? form.current?.querySelector<HTMLElement>('input, textarea, select, [role=radio][tabindex="0"]') : form.current?.querySelector<HTMLElement>('[data-cancel]')
    start?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus()
    }
  }, [action, onCancel])
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !form.current) return
    const all = [...form.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const [first, last] = [all[0], all.at(-1)]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }
  const set = (name: string, value: string) => setValues((all) => ({ ...all, [name]: value }))
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-(--scrim) p-4" onMouseDown={onCancel}>
      <form
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-label={action.label}
        className="dialog-in w-full max-w-[440px] rounded-window bg-surface p-5 shadow-(--shadow-overlay)"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trap}
        onSubmit={(e) => {
          e.preventDefault()
          if (wrong.size === 0) onSubmit(values)
        }}
      >
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          {danger ? <TriangleAlert className="size-4 text-red" strokeWidth={2} aria-hidden /> : null}
          {action.label}
        </h2>
        {action.confirm ? <p className="mt-2 text-[13px] text-ink-2">{action.confirm}</p> : null}
        {action.inputs.length > 0 ? (
          <div className="mt-4 flex flex-col gap-3.5">
            {action.inputs.map((input) =>
              input.options ? (
                <div key={input.name} className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-medium text-ink-2">{input.label}</span>
                  <Choice label={input.label} options={input.options} value={values[input.name] ?? ''} onChange={(v) => set(input.name, v)} />
                </div>
              ) : (
                <div key={input.name} className="flex flex-col gap-1.5">
                  <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-ink-2">
                    {input.label}
                    {input.multiple ? (
                      <textarea
                        className="field field-area font-normal"
                        name={input.name}
                        rows={3}
                        value={values[input.name] ?? ''}
                        placeholder={input.placeholder ?? undefined}
                        aria-invalid={wrong.has(input.name) || undefined}
                        aria-describedby={input.hint ? `hint-${input.name}` : undefined}
                        onChange={(e) => set(input.name, e.target.value)}
                      />
                    ) : (
                      <input
                        className="field font-normal"
                        name={input.name}
                        type={input.secret ? 'password' : 'text'}
                        autoComplete={input.secret ? 'off' : undefined}
                        value={values[input.name] ?? ''}
                        placeholder={input.placeholder ?? undefined}
                        aria-invalid={wrong.has(input.name) || undefined}
                        aria-describedby={input.hint ? `hint-${input.name}` : undefined}
                        onChange={(e) => set(input.name, e.target.value)}
                      />
                    )}
                  </label>
                  {input.hint ? (
                    <span id={`hint-${input.name}`} className={`text-[12px] ${wrong.has(input.name) ? 'text-red' : 'text-ink-3'}`}>
                      {input.hint}
                    </span>
                  ) : wrong.has(input.name) ? (
                    <span className="text-[12px] text-red">格式不对。</span>
                  ) : null}
                </div>
              ),
            )}
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" data-cancel onClick={onCancel}>
            取消
          </button>
          <button type="submit" className={`btn btn-primary ${danger ? 'btn-danger' : ''}`} disabled={wrong.size > 0}>
            {action.label}
          </button>
        </div>
      </form>
    </div>
  )
}

/** `offer`: what a refusal offers the person to do instead, shown as a button in the toast. */
export type Toast = { id: number; tone: Tone; text: string; offer: Action | null }

const TOAST_MS = 4500

/** Toasts that go by themselves, except a refusal or an error, which stays until the person closes it. */
export function useToasts(): [Toast[], (tone: Tone, text: string, offer?: Action | null) => void, (id: number) => void] {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const close = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (tone: Tone, text: string, offer: Action | null = null) => {
      const id = next.current++
      setToasts((all) => [...all.slice(-3), { id, tone, text, offer }])
      if (tone !== 'bad') window.setTimeout(() => close(id), TOAST_MS)
    },
    [close],
  )
  return [toasts, push, close]
}

const TOAST_ICON: Record<Tone, LucideIcon> = { good: CircleCheck, warn: TriangleAlert, bad: CircleAlert }
const TOAST_COLOR: Record<Tone, string> = { good: 'text-green', warn: 'text-orange', bad: 'text-red' }

/** `onAction` runs a toast's offer, as a button would; the toast closes when it is taken. */
export function Toasts({ toasts, onClose, onAction }: { toasts: Toast[]; onClose(id: number): void; onAction?(action: Action): void }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.tone]
        const { offer } = t
        return (
          <div key={t.id} className="toast-in pointer-events-auto flex items-start gap-2 rounded-card bg-surface py-2.5 pr-2 pl-3 text-[13px] shadow-(--shadow-overlay)" data-tone={t.tone}>
            <Icon className={`mt-0.5 size-4 shrink-0 ${TOAST_COLOR[t.tone]}`} strokeWidth={2} aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <span className="break-words whitespace-pre-line">{t.text}</span>
              {offer && onAction ? (
                <button
                  type="button"
                  className={`btn !h-6 !px-2 !text-[12px] ${offer.tone === 'danger' ? 'btn-danger' : ''}`}
                  onClick={() => {
                    onClose(t.id)
                    onAction(offer)
                  }}
                >
                  {offer.label}
                </button>
              ) : null}
            </div>
            <button type="button" className="-my-0.5 flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 hover:bg-hover hover:text-ink" aria-label="关闭" onClick={() => onClose(t.id)}>
              <X className="size-3.5" strokeWidth={2} aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
