// What can be done in a region of the page (a head, a section, a row), drawn so that it says little:
// one main action, the frequent ones as icons with their name and key in a tooltip, the rest and the
// dangerous ones in a 「···」 menu, an action of one sentence as a field written in place. The text
// form of the page still names every one as its command.
import type { Action } from '@pneuma-base/kernel'
import { ArrowUp, Ellipsis } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { ViewIcon } from './chrome'
import { Menu, type MenuEntry } from './controls'
import { useEnv } from './env'

/** Where each action of a region stands. */
export type Placed = { main: Action | null; quiet: boolean; icons: Action[]; menu: Action[]; inline: Action[] }

/** Whether an action asks for one line of text and nothing else, so it can be written in place. */
const oneLine = (a: Action) => {
  const [input] = a.inputs
  return a.inputs.length === 1 && input !== undefined && input.options === null && input.multiple !== true && input.secret !== true
}

/**
 * The actions of a region in their places: the one marked primary, or else the first unmarked one as a
 * quiet button; icons; inline fields; the rest in the menu, the dangerous last.
 */
export function placeActions(actions: readonly Action[]): Placed {
  const primary = actions.find((a) => a.as === 'primary') ?? null
  let main: Action | null = primary
  const icons: Action[] = []
  const menu: Action[] = []
  const danger: Action[] = []
  const inline: Action[] = []
  for (const a of actions) {
    if (a === primary) continue
    if (a.as === 'inline' && oneLine(a)) inline.push(a)
    else if (a.as === 'icon' && a.icon !== undefined && a.tone !== 'danger') icons.push(a)
    else if (a.tone === 'danger') danger.push(a)
    else if (a.as === 'menu' || main !== null) menu.push(a)
    else main = a
  }
  return { main, quiet: primary === null, icons, menu: [...menu, ...danger], inline }
}

/** An action's name with its key, as a tooltip says it. */
const tipOf = (a: Action) => (a.key ? `${a.label} ${a.key.toUpperCase()}` : a.label)

/** A button for one action: its label, after its icon when it has one; `bare` draws the icon alone. */
export function ActionButton({ action, small = false, primary = false, bare = false }: { action: Action; small?: boolean; primary?: boolean; bare?: boolean }) {
  const { onAction } = useEnv()
  const run = (e: MouseEvent) => {
    e.stopPropagation()
    void onAction(action)
  }
  if (bare && action.icon)
    return (
      <button type="button" className="icon-btn" aria-label={action.label} aria-keyshortcuts={action.key?.toUpperCase()} data-tip={tipOf(action)} onClick={run}>
        <ViewIcon name={action.icon} />
      </button>
    )
  return (
    <button
      type="button"
      className={`btn ${small ? 'btn-sm' : ''} ${primary ? 'btn-primary' : ''} ${action.tone === 'danger' ? 'btn-danger' : ''}`}
      aria-keyshortcuts={action.key?.toUpperCase()}
      data-tip={action.key ? tipOf(action) : undefined}
      onClick={run}
    >
      {action.icon ? <ViewIcon name={action.icon} /> : null}
      {action.label}
    </button>
  )
}

/** The 「···」 of a region: its actions as menu entries, the dangerous ones after a line. */
export function MoreMenu({ actions, label = '更多' }: { actions: Action[]; label?: string }) {
  const { onAction } = useEnv()
  if (actions.length === 0) return null
  const entries: MenuEntry[] = []
  actions.forEach((a, i) => {
    if (a.tone === 'danger' && i > 0 && actions[i - 1]?.tone !== 'danger') entries.push('separator')
    entries.push({ label: a.label, icon: a.icon ? <ViewIcon name={a.icon} /> : undefined, keys: a.key?.toUpperCase(), danger: a.tone === 'danger', onSelect: () => void onAction(a) })
  })
  // The menu opens inside a row that may open something on a click: what is chosen in it stays in it.
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()} onAuxClick={(e) => e.stopPropagation()}>
    <Menu
      label={label}
      entries={entries}
      trigger={({ ref, open, toggle, onKeyDown }) => (
        <button
          ref={ref}
          type="button"
          className="icon-btn more"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          data-tip={label}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          onKeyDown={onKeyDown}
        >
          <Ellipsis strokeWidth={2} aria-hidden />
        </button>
      )}
    />
    </span>
  )
}

/** Whether a key press is meant for the page rather than for a field, a menu or a dialog. */
const forPage = (e: globalThis.KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role=menu], [role=dialog], [role=listbox]'))) return false
  // A dialog on its way out no longer holds the keys.
  return ![...document.querySelectorAll('[role=dialog][aria-modal=true]')].some((d) => d.closest('[data-leaving]') === null)
}

/**
 * Runs an action of `actions` by its key: anywhere on the page when `scope` is null, else while the
 * focus is inside `scope` or nowhere in particular.
 */
export function useActionKeys(actions: readonly Action[], scope: RefObject<HTMLElement | null> | null = null): void {
  const { onAction } = useEnv()
  const keyed = useRef(actions)
  keyed.current = actions
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!forPage(e)) return
      const active = document.activeElement
      if (scope && active && active !== document.body && !scope.current?.contains(active)) return
      const action = keyed.current.find((a) => a.key !== undefined && a.key.toLowerCase() === e.key.toLowerCase())
      if (!action) return
      e.preventDefault()
      void onAction(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAction, scope])
}

/**
 * The actions of one region in a row: icons, the 「···」, then the main action, filled when it is the
 * primary one. Inline actions are drawn by the region itself, where they are written.
 */
export function ActionBar({ actions, small = true, className = '' }: { actions: readonly Action[]; small?: boolean; className?: string }) {
  const placed = placeActions(actions)
  if (placed.icons.length === 0 && placed.menu.length === 0 && placed.main === null) return null
  return (
    <div className={`actions ${className}`}>
      {placed.icons.map((a, i) => (
        <ActionButton key={`${a.label}-${i}`} action={a} bare />
      ))}
      <MoreMenu actions={placed.menu} />
      {placed.main ? <ActionButton action={placed.main} small={small} primary={!placed.quiet} /> : null}
    </div>
  )
}

/**
 * An action of one sentence, written where it belongs: a field whose placeholder says what goes in;
 * Enter, or the arrow that shows once something is typed, runs it, and the field empties when it was done.
 */
export function InlineAction({ action }: { action: Action }) {
  const { onAction } = useEnv()
  const input = action.inputs[0]
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  if (!input) return null
  const send = async () => {
    const text = value.trim()
    if (text === '' || busy) return
    setBusy(true)
    const done = await onAction(action, { [input.name]: text }, true)
    setBusy(false)
    if (done?.tone === 'good') setValue('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && value !== '') {
      e.stopPropagation()
      setValue('')
    }
  }
  return (
    <div className="inline-action" data-busy={busy || undefined}>
      <input
        type="text"
        className="field"
        aria-label={action.label}
        placeholder={`${action.label}…`}
        title={input.placeholder ?? undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {value.trim() !== '' ? (
        <button type="button" className="icon-btn inline-send" aria-label={`${action.label}：记下`} data-tip="记下 ↵" onClick={() => void send()}>
          <ArrowUp strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  )
}
