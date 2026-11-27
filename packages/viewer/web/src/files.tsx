// The rows of a table that stand for places of the library, handled as a file manager handles files:
// selected by a click, ⌘-click and shift-click, a rectangle among the icons, ⌘A and a few typed
// letters; previewed with Space; opened with a double-click, ⌘O or ⌘↓; a context menu; dragged out of
// the window; renamed in place with F2. In the Mac app the system previews, opens, draws the menu and
// the thumbnails and carries the drag (shell.ts); in a browser the page previews images and text
// itself, and copies a path.
import type { Action, Block, Reopen, RowPlace, TableRow } from '@pneuma-base/kernel'
import { Cloud, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, MessageSquareShare, Package, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { BlockView } from './blocks'
import { Menu, type MenuEntry } from './controls'
import { useEnv } from './env'
import { IN_SHELL, tellShell, type MenuItem, type ShellCommand, type ShellFileEvent } from './shell'

type Table = Extract<Block, { kind: 'table' }>
export type Placed = TableRow & { place: RowPlace }
export const placed = (r: TableRow): r is Placed => r.place !== undefined
const isThing = (r: Placed) => r.place.kind === 'file' || r.place.kind === 'bundle'
const isFolder = (r: Placed) => r.place.kind === 'open' || r.place.kind === 'closed'
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** The folder a path is in, with its slash; empty at the root. */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

// ---- what the app says, to the list the person last worked in ----

type Handle = { command(c: ShellCommand): void; arrow(key: string, shift: boolean): void; previewing(on: boolean): void }
let active: Handle | null = null
const picks = new Map<string, () => void>()

const thumbs = new Map<string, string>()
const thumbSubs = new Set<() => void>()
const thumbKey = (path: string, token: string | null) => `${path}\u0000${token ?? ''}`

if (IN_SHELL) {
  window.addEventListener('pneuma-shell', (e) => {
    const d = (e as CustomEvent<ShellFileEvent | undefined>).detail
    if (typeof d !== 'object' || d === null) return
    if ('command' in d) active?.command(d.command)
    else if ('key' in d) active?.arrow(d.key, d.shift)
    else if ('previewing' in d) active?.previewing(d.previewing)
    else if ('menu' in d) picks.get(d.menu)?.()
    else if ('thumbnail' in d) {
      thumbs.set(thumbKey(d.thumbnail.path, d.thumbnail.token), d.thumbnail.src)
      for (const f of thumbSubs) f()
    }
  })
}

// ---- thumbnails: asked of the app for the tiles in view, at most 50 at a time ----

/** The longest side of a thumbnail in pixels: the tile's art, on this screen. */
const THUMB_PX = Math.round(96 * Math.min(2, window.devicePixelRatio || 1))
const asked = new Set<string>()
const queue: { path: string; token: string | null }[] = []
let flush = 0

function askThumbnail(path: string, token: string | null) {
  const key = thumbKey(path, token)
  if (asked.has(key) || thumbs.has(key)) return
  asked.add(key)
  queue.push({ path, token })
  if (flush === 0)
    flush = requestAnimationFrame(() => {
      flush = 0
      while (queue.length > 0) tellShell({ type: 'thumbnails', items: queue.splice(0, 50), px: THUMB_PX })
    })
}

const subscribe = (f: () => void) => {
  thumbSubs.add(f)
  return () => thumbSubs.delete(f)
}

/** Whether the element is in view, kept up to date. */
function useVisible(): [(el: Element | null) => void, boolean] {
  const [el, setEl] = useState<Element | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!el || seen) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '120px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el, seen])
  return [setEl, seen]
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i
const KINDS: [RegExp, typeof File][] = [
  [IMAGE, FileImage],
  [/\.(mp4|mov|m4v|webm|avi|mkv)$/i, FileVideo],
  [/\.(mp3|m4a|wav|aiff?|flac|ogg)$/i, FileAudio],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg)$/i, FileArchive],
  [/\.(csv|tsv|xlsx?|numbers)$/i, FileSpreadsheet],
  [/\.(md|markdown|txt|rtf|pdf|docx?|pages|key|pptx?)$/i, FileText],
  [/\.(js|mjs|ts|tsx|jsx|json|py|rs|go|swift|c|h|cpp|java|rb|sh|html?|css|ya?ml|toml|xml)$/i, FileCode],
]

/** The icon a page draws for a place by its kind and name, where no thumbnail is. */
function TypeIcon({ place }: { place: RowPlace }) {
  const Icon = place.kind === 'bundle' ? Package : isFolder({ place } as Placed) ? Folder : (KINDS.find(([re]) => re.test(place.path))?.[1] ?? File)
  return <Icon className="tile-icon" strokeWidth={1.25} aria-hidden />
}

/**
 * A tile's art: in the Mac app the system's thumbnail or the icon of its type, asked once the tile is
 * in view; in a browser an image itself, through the file route, and an icon by type for the rest. A
 * directory thing shows its mark; a placeholder never has its content read.
 */
function TileArt({ place }: { place: RowPlace }) {
  const [ref, visible] = useVisible()
  const key = thumbKey(place.path, place.token)
  const src = useSyncExternalStore(subscribe, () => thumbs.get(key) ?? null)
  useEffect(() => {
    if (IN_SHELL && visible && place.kind !== 'bundle') askThumbnail(place.path, place.token)
  }, [visible, place.kind, place.path, place.token])
  const image = !IN_SHELL && visible && place.kind === 'file' && !place.elsewhere && IMAGE.test(place.path) ? api.fileUrl(place.path) : null
  const shown = IN_SHELL ? src : image
  return (
    <span ref={ref} className="tile-art" data-kind={place.kind}>
      {shown ? <img src={shown} alt="" draggable={false} decoding="async" /> : <TypeIcon place={place} />}
    </span>
  )
}

// ---- opening a conversation again ----

/** 打开那次对话: in the Mac app, the scene's conversation opened again, the first way that works here. */
export function ReopenButton({ reopen }: { reopen: Reopen }) {
  if (!IN_SHELL) return null
  return (
    <button
      type="button"
      className="icon-btn reopen"
      aria-label="打开那次对话"
      data-tip="打开那次对话"
      onClick={(e) => {
        e.stopPropagation()
        tellShell({ type: 'reopen', url: reopen.url, run: reopen.run, reveal: reopen.reveal })
      }}
    >
      <MessageSquareShare strokeWidth={2} aria-hidden />
    </button>
  )
}

// ---- the browser's own preview ----

/** In a browser, Space shows the page's own preview of the file in front; arrows move on, Space or Escape close it. */
function QuickView({ row, onClose, onArrow }: { row: Placed; onClose(): void; onArrow(key: string, shift: boolean): void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Escape') onClose()
      else if (e.key.startsWith('Arrow')) onArrow(e.key, e.shiftKey)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onArrow])
  const name = baseName(row.place.path)
  return createPortal(
    <div className="quick-view" role="dialog" aria-label={name} onClick={onClose}>
      <div className="quick-view-card" onClick={(e) => e.stopPropagation()}>
        <div className="quick-view-head">
          <span className="truncate">{name}</span>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X strokeWidth={2} aria-hidden />
          </button>
        </div>
        <div className="quick-view-body">{row.place.kind === 'file' && !row.place.elsewhere ? <BlockView block={{ kind: 'preview', path: row.place.path }} /> : <TypeIcon place={row.place} />}</div>
      </div>
    </div>,
    document.body,
  )
}

// ---- renaming in place ----

/** The name written in place: the part before the extension chosen, Return keeps it, Escape leaves it, leaving the field keeps it too. */
export function RenameField({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  const ref = useRef<HTMLInputElement | null>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [name])
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    onDone(value === null || value.trim() === '' || value === name ? null : value.trim())
  }
  return (
    <input
      ref={ref}
      className="rename-field"
      aria-label="新的名字"
      defaultValue={name}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        else if (e.key === 'Escape') finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

// ---- the selection and everything done with it ----

export type Files = {
  /** The rows that stand for places, in the order shown. */
  rows: Placed[]
  selected: ReadonlySet<string>
  focus: string | null
  renaming: string | null
  rename(name: string | null): void
  /** What a row or a tile takes from the list: selection, opening, the menu, the drag. */
  itemProps(row: Placed): {
    'aria-selected': boolean
    tabIndex: number
    'data-key': string
    draggable?: true
    onClick(e: MouseEvent): void
    onDoubleClick(e: MouseEvent): void
    onAuxClick(e: MouseEvent): void
    onContextMenu(e: MouseEvent): void
    onDragStart?(e: DragEvent): void
    onFocus(): void
  }
  /** The keyboard of the list, on the element that holds its rows or tiles; `across`, how many tiles a row of icons holds. */
  onKeyDown(e: KeyboardEvent, across?: number): void
  /** Selecting the keys a rectangle drawn among the tiles covers, on top of what was selected when it started with ⌘ or Shift held. */
  sweep(keys: string[], keep: boolean): void
  /** The list's popups: the browser's preview and context menu. */
  overlay: ReactNode
  /** Marks this list as the one the app's menus act on. */
  claim(): void
}

const nameOfRow = (r: Placed) => baseName(r.place.path)

/**
 * A table's places as files: what is selected and in front, and what Space, a double-click, ⌘O, F2,
 * the context menu and the drag do with them. Null for a table whose rows stand for no place.
 */
export function useFiles(block: Table): Files | null {
  const { onLink, onAction, selected: inPanel, root } = useEnv()
  const rows = useMemo(() => block.rows.filter(placed), [block.rows])
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const shownInPanel = rows.find((r) => inPanel(r.link))?.key ?? null
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(shownInPanel === null ? [] : [shownInPanel]))
  const [focus, setFocus] = useState<string | null>(shownInPanel)
  const anchor = useRef<string | null>(shownInPanel)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [quick, setQuick] = useState(false)
  const [menu, setMenu] = useState<{ at: { left: number; top: number }; entries: MenuEntry[] } | null>(null)
  const typed = useRef({ text: '', at: 0 })

  // What the panel comes to show from elsewhere, a link in it or the address, is what is selected here.
  useEffect(() => {
    if (shownInPanel === null) return
    setSelected((s) => (s.has(shownInPanel) ? s : new Set([shownInPanel])))
    setFocus(shownInPanel)
    anchor.current = shownInPanel
  }, [shownInPanel])

  // What left the list leaves the selection.
  useEffect(() => {
    setSelected((s) => (([...s].every((k) => keys.includes(k)) ? s : new Set([...s].filter((k) => keys.includes(k))))))
    setFocus((f) => (f !== null && keys.includes(f) ? f : null))
  }, [keys])

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.key)), [rows, selected])
  const front = rows.find((r) => r.key === focus) ?? chosen[0] ?? null

  const only = useCallback((key: string) => {
    setSelected(new Set([key]))
    setFocus(key)
    anchor.current = key
  }, [])
  const toggle = useCallback((key: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setFocus(key)
    anchor.current = key
  }, [])
  const range = useCallback(
    (key: string) => {
      const from = keys.indexOf(anchor.current ?? key)
      const to = keys.indexOf(key)
      const [a, b] = from <= to ? [from, to] : [to, from]
      setSelected(new Set(keys.slice(Math.max(0, a), b + 1)))
      setFocus(key)
    },
    [keys],
  )
  const focusItem = (key: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-files] [data-key="${CSS.escape(key)}"]`)?.focus())

  /** Moves the front by `step` places, or to an end; with Shift the selection reaches from where it started. */
  const move = useCallback(
    (step: number | 'first' | 'last', extend: boolean) => {
      if (keys.length === 0) return
      const at = focus === null ? -1 : keys.indexOf(focus)
      const to = step === 'first' ? 0 : step === 'last' ? keys.length - 1 : at < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, at + step))
      const key = keys[to] as string
      if (extend) range(key)
      else only(key)
      focusItem(key)
    },
    [keys, focus, range, only],
  )

  const preview = useCallback(
    (on: Placed[]) => {
      if (on.length === 0) return
      if (IN_SHELL) {
        const at = Math.max(0, on.findIndex((r) => r.key === focus))
        tellShell({ type: 'preview', paths: on.map((r) => r.place.path), at })
      } else setQuick(true)
    },
    [focus],
  )

  /** Opens what is selected: one folder in the page; files and directory things with their applications in the Mac app, else the panel. */
  const open = useCallback(
    (on: Placed[]) => {
      const folder = on.find(isFolder)
      if (on.length === 1 && folder?.link) return onLink(folder.link)
      const things = on.filter(isThing)
      if (things.length === 0) return
      if (IN_SHELL) tellShell({ type: 'launch', paths: things.map((r) => r.place.path) })
      else if (things[0]?.link) onLink(things[0].link)
    },
    [onLink],
  )

  const startRename = useCallback(
    (row: Placed | null) => {
      if (row && isThing(row) && block.each?.rename) setRenaming(row.key)
    },
    [block.each],
  )

  const given = (r: Placed) => ({ path: r.place.path, in: folderOf(r.place.path) })
  /** Runs one of the table's `each` actions on each place, one after another; one that asks for input runs on one place. */
  const runEach = useCallback(
    async (action: Action, on: Placed[]) => {
      for (const r of action.inputs.length > 0 ? on.slice(0, 1) : on) {
        const values = given(r)
        const filled = Object.fromEntries(action.inputs.filter((i) => i.value !== null).map((i) => [i.name, (i.value as string).replace(/\{(path|in)\}/g, (_, n: 'path' | 'in') => values[n])]))
        if ((await onAction(action, { ...values, ...filled }, action.inputs.length === 0)) === null) break
      }
    },
    [onAction],
  )

  const rename = useCallback(
    (name: string | null) => {
      const row = rows.find((r) => r.key === renaming)
      setRenaming(null)
      if (row) focusItem(row.key)
      const action = block.each?.rename
      if (row && action && name !== null) void onAction(action, { ...given(row), name }, true)
    },
    [rows, renaming, block.each, onAction],
  )

  const copyPaths = useCallback(
    (on: Placed[]) => {
      if (on.length === 0) return
      if (IN_SHELL) tellShell({ type: 'copy-path', paths: on.map((r) => r.place.path) })
      else void navigator.clipboard.writeText(on.map((r) => (root === null ? r.place.path : `${root}/${r.place.path}`)).join('\n'))
    },
    [root],
  )

  /** The library's own actions for these places: the table's for things, a row's own for one row; destructive ones last. */
  const libraryActions = useCallback(
    (on: Placed[]): { label: string; danger: boolean; run(): void }[] => {
      const each = block.each && on.length > 0 && on.every(isThing) ? block.each : null
      const fromEach = (each?.actions ?? []).filter((a) => a.inputs.length === 0 || on.length === 1).map((a) => ({ label: a.inputs.length > 0 ? `${a.label}…` : a.label, danger: a.tone === 'danger', run: () => void runEach(a, on) }))
      const renameIt = each?.rename && on.length === 1 ? [{ label: each.rename.label, danger: false, run: () => startRename(on[0] as Placed) }] : []
      const own = on.length === 1 ? (on[0] as Placed).actions.map((a) => ({ label: a.inputs.length > 0 || a.confirm !== null ? `${a.label}…` : a.label, danger: a.tone === 'danger', run: () => void onAction(a) })) : []
      const all = [...fromEach, ...renameIt, ...own]
      return [...all.filter((a) => !a.danger), ...all.filter((a) => a.danger)]
    },
    [block.each, runEach, startRename, onAction],
  )

  const openMenu = useCallback(
    (e: MouseEvent, row: Placed) => {
      e.preventDefault()
      const on = selected.has(row.key) ? chosen : [row]
      if (!selected.has(row.key)) only(row.key)
      const own = libraryActions(on)
      if (IN_SHELL) {
        picks.clear()
        const items: MenuItem[] = own.map((a, i) => {
          picks.set(`a${i}`, a.run)
          return { id: `a${i}`, label: a.label, ...(a.danger ? { danger: true as const } : {}) }
        })
        tellShell({ type: 'menu', paths: on.map((r) => r.place.path), x: e.clientX, y: e.clientY, items })
        return
      }
      const lead: MenuEntry[] = [
        ...(on.some((r) => r.place.kind === 'file') ? [{ label: '快速查看', keys: '空格', onSelect: () => preview(on) }] : []),
        { label: '拷贝路径', onSelect: () => copyPaths(on) },
      ]
      const safe = own.filter((a) => !a.danger).map((a) => ({ label: a.label, onSelect: a.run }))
      const danger = own.filter((a) => a.danger).map((a) => ({ label: a.label, danger: true, onSelect: a.run }))
      const entries: MenuEntry[] = [...lead, ...(safe.length > 0 ? ['separator' as const, ...safe] : []), ...(danger.length > 0 ? ['separator' as const, ...danger] : [])]
      setMenu({ at: { left: e.clientX, top: e.clientY }, entries })
    },
    [selected, chosen, only, libraryActions, preview, copyPaths],
  )

  const handle = useRef<Handle | null>(null)
  handle.current = {
    command(c) {
      if (c === 'open') open(chosen)
      else if (c === 'preview') preview(chosen)
      else if (c === 'reveal' && chosen.length > 0) tellShell({ type: 'reveal', paths: chosen.map((r) => r.place.path) })
      else if (c === 'copy-path') copyPaths(chosen)
      else if (c === 'rename') startRename(chosen.length === 1 ? (chosen[0] as Placed) : null)
    },
    arrow(key, shift) {
      move(key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1, shift)
    },
    previewing: setPreviewing,
  }
  const proxy = useMemo<Handle>(() => ({ command: (c) => handle.current?.command(c), arrow: (k, s) => handle.current?.arrow(k, s), previewing: (on) => handle.current?.previewing(on) }), [])
  const claim = useCallback(() => {
    active = proxy
  }, [proxy])
  useEffect(() => {
    if (active === null) active = proxy
    return () => {
      if (active === proxy) active = null
    }
  }, [proxy])

  // The app's menus act on a selection; Quick Look follows it while it is up.
  useEffect(() => {
    if (IN_SHELL && active === proxy) tellShell({ type: 'selection', count: chosen.length })
  }, [chosen.length, proxy])
  const followed = useRef('')
  useEffect(() => {
    const paths = chosen.map((r) => r.place.path).join('\n')
    if (IN_SHELL && previewing && paths !== followed.current && chosen.length > 0) preview(chosen)
    followed.current = paths
  }, [chosen, previewing, preview])

  if (rows.length === 0) return null

  const itemProps: Files['itemProps'] = (row) => ({
    'aria-selected': selected.has(row.key),
    tabIndex: row.key === (focus ?? rows[0]?.key) ? 0 : -1,
    'data-key': row.key,
    ...(IN_SHELL
      ? {
          draggable: true as const,
          onDragStart: (e: DragEvent) => {
            e.preventDefault()
            const on = selected.has(row.key) ? chosen : [row]
            if (!selected.has(row.key)) only(row.key)
            tellShell({ type: 'drag', paths: on.map((r) => r.place.path) })
          },
        }
      : {}),
    onClick: (e) => {
      claim()
      if (e.metaKey || e.ctrlKey) toggle(row.key)
      else if (e.shiftKey) range(row.key)
      else {
        only(row.key)
        if (row.link?.target === 'panel') onLink(row.link)
      }
    },
    onDoubleClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return
      open([row])
    },
    onAuxClick: (e) => {
      if (e.button === 1 && row.link?.target === 'panel') onLink(row.link, true)
    },
    onContextMenu: (e) => {
      claim()
      openMenu(e, row)
    },
    onFocus: () => {
      claim()
      setFocus(row.key)
    },
  })

  const onKeyDown: Files['onKeyDown'] = (e, across = 1) => {
    if (renaming !== null || (e.target as HTMLElement).closest('input, textarea, button:not([data-key])')) return
    const mod = e.metaKey || e.ctrlKey
    const down = e.key === 'ArrowDown' ? across : e.key === 'ArrowUp' ? -across : across > 1 && e.key === 'ArrowRight' ? 1 : across > 1 && e.key === 'ArrowLeft' ? -1 : 0
    if (mod && e.key === 'ArrowDown') open(chosen)
    else if (mod && !IN_SHELL && e.key.toLowerCase() === 'o') open(chosen)
    else if (mod && e.key.toLowerCase() === 'a') {
      setSelected(new Set(keys))
      anchor.current = keys[0] ?? null
    } else if (mod || e.altKey) return
    else if (e.key === ' ') {
      if (IN_SHELL && previewing) tellShell({ type: 'preview', paths: [], at: 0 })
      else preview(chosen.length > 0 ? chosen : front ? [front] : [])
    } else if (e.key === 'Enter') {
      if (front?.link) onLink(front.link)
    } else if (e.key === 'F2') startRename(chosen.length === 1 ? (chosen[0] as Placed) : null)
    else if (down !== 0) move(down, e.shiftKey)
    else if (e.key === 'Home' || e.key === 'End') move(e.key === 'Home' ? 'first' : 'last', e.shiftKey)
    else if (e.key.length === 1 && e.key.trim() !== '') {
      // A few letters typed in a row go to the first name that starts with them.
      const now = Date.now()
      const text = (now - typed.current.at < 1000 ? typed.current.text : '') + e.key.toLowerCase()
      typed.current = { text, at: now }
      const hit = rows.find((r) => nameOfRow(r).toLowerCase().startsWith(text))
      if (!hit) return
      only(hit.key)
      focusItem(hit.key)
    } else return
    e.preventDefault()
  }

  const sweep: Files['sweep'] = (hit, keep) => {
    claim()
    setSelected((s) => new Set([...(keep ? s : []), ...hit]))
    if (hit[0] !== undefined) setFocus(hit[0])
  }

  const quickRow = quick ? (front ?? null) : null
  const overlay = (
    <>
      {quickRow ? <QuickView row={quickRow} onClose={() => setQuick(false)} onArrow={(k, s) => move(k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 1, s)} /> : null}
      {menu ? <Menu label="对这些文件" entries={menu.entries} at={menu.at} onClose={() => setMenu(null)} /> : null}
    </>
  )

  return { rows, selected, focus, renaming, rename, itemProps, onKeyDown, sweep, overlay, claim }
}

// ---- the icons ----

/** A badge for a state that is not the usual one: the row's first tag, and a cloud for content kept elsewhere. */
function Badges({ row }: { row: Placed }) {
  const tag = Object.values(row.cells).find((c) => c.tag !== undefined && c.normal !== true)?.tag
  return (
    <>
      {tag ? <span className="tile-badge" data-tone={tag.tone} aria-label={tag.text} data-tip={tag.text} role="img" /> : null}
      {row.place.elsewhere ? (
        <span className="tile-cloud" aria-label="内容不在这台机器上" data-tip="内容不在这台机器上" role="img">
          <Cloud strokeWidth={2} aria-hidden />
        </span>
      ) : null}
    </>
  )
}

/** A tile's name: the row's first cell, a folder's slash left off. */
const tileName = (row: TableRow, first: string | undefined) => (first === undefined ? row.key : (row.cells[first]?.text ?? row.key)).replace(/\/$/, '')

/**
 * The table's places as a grid of tiles, each its art and its name, under the table's groups when it
 * has them. A rectangle drawn from an empty part of the grid selects what it covers. ←→↑↓ move by a
 * tile and by a row of them.
 */
export function IconGrid({ block, files, pager }: { block: Table; files: Files; pager: ReactNode }) {
  const grid = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const sweepStart = useRef<{ x: number; y: number; keep: boolean } | null>(null)
  const first = block.columns[0]?.key
  const groups = useMemo(() => {
    const order = [...new Set(block.rows.map((r) => r.group ?? ''))]
    return order.map((g) => ({ name: g, rows: block.rows.filter((r) => (r.group ?? '') === g) }))
  }, [block.rows])

  /** How many tiles one row of the grid holds, as it is laid out now. */
  const across = () => {
    const tiles = [...(grid.current?.querySelectorAll<HTMLElement>('.tile') ?? [])]
    const top = tiles[0]?.offsetTop
    return Math.max(1, tiles.filter((t) => t.offsetTop === top).length)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tile')) return
    const box = e.currentTarget.getBoundingClientRect()
    sweepStart.current = { x: e.clientX - box.left, y: e.clientY - box.top + e.currentTarget.scrollTop, keep: e.metaKey || e.shiftKey }
    e.currentTarget.setPointerCapture(e.pointerId)
    files.claim()
    if (!sweepStart.current.keep) files.sweep([], false)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = sweepStart.current
    if (!start) return
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top + e.currentTarget.scrollTop
    const r = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) }
    setRect(r)
    const hit = [...e.currentTarget.querySelectorAll<HTMLElement>('.tile[data-key]')]
      .filter((t) => {
        const b = t.getBoundingClientRect()
        const tx = b.left - box.left
        const ty = b.top - box.top + e.currentTarget.scrollTop
        return tx < r.x + r.w && tx + b.width > r.x && ty < r.y + r.h && ty + b.height > r.y
      })
      .map((t) => t.dataset.key as string)
    files.sweep(hit, start.keep)
  }
  const onPointerUp = () => {
    sweepStart.current = null
    setRect(null)
  }

  return (
    <div className="card icons-card">
      <div
        ref={grid}
        className="icons"
        data-files
        role="listbox"
        aria-multiselectable
        aria-label="文件"
        onKeyDown={(e) => files.onKeyDown(e, across())}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {groups.map((g) => (
          <div key={g.name} className="icons-group">
            {g.name !== '' ? (
              <p className="icons-group-name">
                <Folder strokeWidth={1.75} aria-hidden />
                <span className="truncate">{g.name}</span>
              </p>
            ) : null}
            <div className="icons-grid">
              {g.rows.map((row) => {
                const name = tileName(row, first)
                if (!placed(row))
                  return (
                    <div key={row.key} className="tile" data-inert>
                      <span className="tile-art">
                        <File className="tile-icon" strokeWidth={1.25} aria-hidden />
                      </span>
                      <span className="tile-name">{name}</span>
                    </div>
                  )
                return (
                  <div key={row.key} className="tile" role="option" title={name} {...files.itemProps(row)}>
                    <TileArt place={row.place} />
                    <Badges row={row} />
                    {files.renaming === row.key ? <RenameField name={baseName(row.place.path)} onDone={files.rename} /> : <span className="tile-name">{name}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {rect ? <div className="sweep" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} aria-hidden /> : null}
      </div>
      {pager}
      {files.overlay}
    </div>
  )
}
