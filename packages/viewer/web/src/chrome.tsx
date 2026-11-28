// The parts around the blocks: icons, the modal layer, the action dialog.
import type { Action, ActionInput, Call, PassProgress } from '@pneuma-base/kernel'
import type { IconName } from '@pneuma-base/sdk'
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Bookmark,
  Box,
  ChartColumn,
  Check,
  CircleAlert,
  Clock,
  Cloud,
  CloudOff,
  CloudUpload,
  Code,
  Copy,
  CornerLeftUp,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  File,
  FileText,
  FlaskConical,
  Folder,
  FolderDot,
  FolderInput,
  FolderPlus,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  History,
  House,
  Image,
  Info,
  Key,
  Layers,
  LayoutGrid,
  Link,
  Link2,
  List,
  ListPlus,
  Lock,
  MessageSquarePlus,
  Package,
  Pencil,
  Plug,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  Rocket,
  Scale,
  ScanSearch,
  ScrollText,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, type CallReply } from './api'
import { FilterChoice, Segmented } from './controls'

/** The icon of each name in the sdk's `ICON_NAMES`, every one and no other. */
const ICONS: Record<IconName, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  'archive-restore': ArchiveRestore,
  'arrow-down-to-line': ArrowDownToLine,
  bookmark: Bookmark,
  box: Box,
  'chart-column': ChartColumn,
  check: Check,
  'circle-alert': CircleAlert,
  clock: Clock,
  cloud: Cloud,
  'cloud-off': CloudOff,
  'cloud-upload': CloudUpload,
  code: Code,
  copy: Copy,
  'corner-left-up': CornerLeftUp,
  database: Database,
  download: Download,
  ellipsis: Ellipsis,
  'external-link': ExternalLink,
  eye: Eye,
  file: File,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: Folder,
  'folder-dot': FolderDot,
  'folder-input': FolderInput,
  'folder-plus': FolderPlus,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  'hard-drive': HardDrive,
  history: History,
  house: House,
  image: Image,
  info: Info,
  key: Key,
  layers: Layers,
  'layout-grid': LayoutGrid,
  link: Link,
  'link-2': Link2,
  list: List,
  'list-plus': ListPlus,
  lock: Lock,
  'message-square-plus': MessageSquarePlus,
  package: Package,
  pencil: Pencil,
  plug: Plug,
  plus: Plus,
  power: Power,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  scale: Scale,
  'scan-search': ScanSearch,
  'scroll-text': ScrollText,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  tag: Tag,
  terminal: Terminal,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  unplug: Unplug,
  upload: Upload,
  users: Users,
}

/** An icon by name; a name outside `ICON_NAMES`, from a plugin written without the sdk's types, gets the puzzle piece. */
export function ViewIcon({ name, className }: { name: string; className?: string }) {
  const Icon = (ICONS as Partial<Record<string, LucideIcon>>)[name] ?? Puzzle
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

/**
 * Runs an action with its values, hearing the progress of a named whole pass it may run. One that writes
 * a file (`save`) hands the file over instead: its input for the file is left to the server.
 */
export async function perform(action: Action, values: Record<string, string>, confirmed: boolean, onProgress: (p: PassProgress, pass: string) => void): Promise<CallReply> {
  const { save } = action
  if (save === undefined) return api.pass(fill(action.call, values, action.inputs), confirmed, onProgress)
  const rest = Object.fromEntries(Object.entries(values).filter(([name]) => name !== save.input))
  const name = save.name.replace(/\{([^{}]+)\}/g, (whole, input: string) => rest[input] ?? whole)
  return (await api.save(fill(action.call, rest, action.inputs), confirmed, save.input, name)) ?? { tone: 'good', text: `已导出 ${name}`, result: null }
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

/**
 * The inputs hidden with these values: each whose `when` some named input's value fails, a hidden
 * input's value counting as empty, as it is sent.
 */
function hiddenInputs(inputs: readonly ActionInput[], values: Record<string, string>): Set<string> {
  let hidden = new Set<string>()
  // Each round hides by the last; a hidden input's empty value may hide the ones that name it.
  for (let round = 0; round <= inputs.length; round++) {
    const seen = (name: string) => (hidden.has(name) ? '' : (values[name] ?? ''))
    const next = new Set(inputs.filter((i) => !(i.when ?? []).every((w) => w.is.includes(seen(w.input)))).map((i) => i.name))
    if (next.size === hidden.size && [...next].every((n) => hidden.has(n))) break
    hidden = next
  }
  return hidden
}

/** Up to this many options are one choice side by side; more are a filter over a list. */
const FEW = 5

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * A modal layer over the page: the scrim, Tab kept inside, Escape or a press on the scrim dismisses.
 * Leaving, it gives the focus back at once and plays its way out, hidden from the keyboard and from
 * assistive technology meanwhile.
 */
export function Layer({ leaving, onDismiss, className = '', children }: { leaving: boolean; onDismiss(): void; className?: string; children: ReactNode }) {
  const layer = useRef<HTMLDivElement | null>(null)
  const [before] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const returned = useRef(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    const giveBack = () => {
      if (returned.current) return
      returned.current = true
      if (before?.isConnected) before.focus()
    }
    if (leaving) {
      giveBack()
      return
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      dismiss.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [leaving, before])
  useEffect(
    () => () => {
      if (!returned.current && before?.isConnected) before.focus()
    },
    [before],
  )
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !layer.current) return
    const all = [...layer.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const [first, last] = [all[0], all.at(-1)]
    if (!first || !last) return e.preventDefault()
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div
      ref={layer}
      className={`layer ${className}`}
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      inert={leaving}
      onKeyDown={trap}
      onMouseDown={(e) => e.target === e.currentTarget && dismiss.current()}
    >
      {children}
    </div>
  )
}

/**
 * The form an action opens when it has inputs or asks for confirmation. Submitting it is the
 * in-person confirmation. A question with nothing to fill in starts on 取消, the choice that changes
 * nothing. An input shows while its `when` holds, and is sent empty while it does not. The label's
 * 「…」, which says a button opens this form, is not part of its title or its button.
 */
export function ActionDialog({ action, preset = {}, leaving, onCancel, onSubmit }: { action: Action; preset?: Record<string, string>; leaving: boolean; onCancel(): void; onSubmit(values: Record<string, string>): void }) {
  const name = action.label.replace(/…$/, '')
  const [values, setValues] = useState(() => ({ ...initial(action.inputs), ...preset }))
  const form = useRef<HTMLFormElement | null>(null)
  const danger = action.tone === 'danger'
  const hidden = hiddenInputs(action.inputs, values)
  const shown = action.inputs.filter((i) => !hidden.has(i.name) && i.name !== action.save?.input)
  const wrong = new Set(shown.filter((i) => mismatched(i, values[i.name] ?? '')).map((i) => i.name))
  // A choice of many whose filter matches nothing has nothing chosen.
  const unchosen = shown.some((i) => i.options !== null && i.options.length > FEW && !i.options.some((o) => o.value === values[i.name]))
  useEffect(() => {
    const start = action.inputs.length > 0 ? form.current?.querySelector<HTMLElement>('input, textarea, select, [role=radio][tabindex="0"]') : form.current?.querySelector<HTMLElement>('[data-cancel]')
    start?.focus()
  }, [action])
  const set = (name: string, value: string) => setValues((all) => ({ ...all, [name]: value }))
  return (
    <Layer leaving={leaving} onDismiss={onCancel}>
      <form
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        aria-describedby={action.confirm ? 'dialog-confirm' : undefined}
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (wrong.size === 0 && !unchosen) onSubmit({ ...values, ...Object.fromEntries([...hidden].map((name) => [name, ''])) })
        }}
      >
        <div className="dialog-head">
          <div>
            <h2>{name}</h2>
            {action.confirm ? (
<p id="dialog-confirm">{action.confirm}</p>
            ) : null}
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" data-tip="关闭" onClick={onCancel}>
            <X strokeWidth={2} aria-hidden />
          </button>
        </div>
        {shown.length > 0 ? (
          <div className="dialog-body">
            {shown.map((input) => {
              const hint = wrong.has(input.name) && !input.hint ? '格式错误' : input.hint
              const hintId = hint ? `hint-${input.name}` : undefined
              // An input whose label is empty says itself, as a choice of named kinds does: no label is drawn, and the dialog's title names it.
              const label = input.label || name
              return input.options && input.options.length > FEW ? (
                <div key={input.name} className="form-field">
                  {input.label ? (
                    <label className="form-label" htmlFor={`input-${input.name}`}>
                      {input.label}
                    </label>
                  ) : null}
                  <FilterChoice id={`input-${input.name}`} label={label} placeholder={input.placeholder ?? undefined} options={input.options} value={values[input.name] ?? ''} onChange={(v) => set(input.name, v)} />
                </div>
              ) : input.options ? (
                <div key={input.name} className="form-field">
                  {input.label ? <span className="form-label">{input.label}</span> : null}
                  <Segmented label={label} options={input.options} value={values[input.name] ?? ''} onChange={(v) => set(input.name, v)} />
                </div>
              ) : (
                <div key={input.name} className="form-field">
                  <label className="form-label" htmlFor={`input-${input.name}`}>
                    {input.label}
                  </label>
                  {input.multiple ? (
                    <textarea
                      id={`input-${input.name}`}
                      className="field field-area"
                      name={input.name}
                      rows={3}
                      value={values[input.name] ?? ''}
                      placeholder={input.placeholder ?? undefined}
                      aria-invalid={wrong.has(input.name) || undefined}
                      aria-describedby={hintId}
                      onChange={(e) => set(input.name, e.target.value)}
                    />
                  ) : (
                    <input
                      id={`input-${input.name}`}
                      className="field"
                      name={input.name}
                      type={input.secret ? 'password' : 'text'}
                      autoComplete={input.secret ? 'off' : undefined}
                      value={values[input.name] ?? ''}
                      placeholder={input.placeholder ?? undefined}
                      aria-invalid={wrong.has(input.name) || undefined}
                      aria-describedby={hintId}
                      onChange={(e) => set(input.name, e.target.value)}
                    />
                  )}
                  {hint ? (
                    <span id={hintId} className="form-hint" data-wrong={wrong.has(input.name) || undefined}>
                      {hint}
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
        <div className="dialog-foot">
          <button type="button" className="btn" data-cancel onClick={onCancel}>
            取消
          </button>
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={wrong.size > 0 || unchosen}>
            {name}
          </button>
        </div>
      </form>
    </Layer>
  )
}
