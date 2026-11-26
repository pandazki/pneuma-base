// The block renderer: one component per kind of block. It knows the kernel's block types and no plugin.
import type { Action, Block, Cell, Link, Tag, TableRow, Tone } from '@pneuma-base/kernel'
import { Check, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Copy, ExternalLink, Inbox, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { api, outsideUrl } from './api'
import { ViewIcon } from './chrome'
import { useEnv } from './env'
import { CustomView } from './frame'
import { cellFont, fitColumns, fitMiddle, naturalColumns, textRoom } from './measure'
import { fullTime, shortTime } from './time'

export const sameLink = (a: Link | null, b: { view: string; params: Record<string, string> } | null) =>
  a !== null && b !== null && a.view === b.view && JSON.stringify(Object.entries(a.params).sort()) === JSON.stringify(Object.entries(b.params).sort())

/** A moment in the viewer's local time, short, the whole of it on hover. */
export function Moment({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fullTime(at)} className="tabular-nums">
      {shortTime(at)}
    </time>
  )
}

const TONE_CLASS: Record<Tone, string> = { neutral: '', good: 'tone-good', warn: 'tone-warn', bad: 'tone-bad', info: 'tone-info' }

export function TagView({ tag }: { tag: Tag }) {
  return <span className={`tag ${TONE_CLASS[tag.tone]}`}>{tag.text}</span>
}

const stop = (e: MouseEvent) => e.stopPropagation()
/** Whether a click asks for a tab of its own: ⌘ or Ctrl held, or the middle button. */
const wantsTab = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey || ('button' in e && e.button === 1)

/** Copies `value`, and says so for a moment. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const Icon = copied ? Check : Copy
  return (
    <button
      type="button"
      className="copy"
      data-done={copied || undefined}
      aria-label={copied ? '已复制' : '复制'}
      data-tip={copied ? '已复制' : '复制'}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(value).then(() => setCopied(true), () => undefined)
      }}
    >
      <Icon strokeWidth={2} aria-hidden />
    </button>
  )
}

/**
 * One cell. In a table it stays on one line, its text cut short with the whole of it on hover; elsewhere
 * it wraps. An outside address is a link to a new tab; given `room`, it is cut in the middle to fit.
 * Muted text is one step quieter than the text around it.
 */
export function CellView({ cell, line = false, first = false, room }: { cell: Cell; line?: boolean; first?: boolean; room?: number }) {
  const { onLink } = useEnv()
  const style = `${cell.mono ? 'font-mono text-[12.5px]' : ''} ${cell.muted ? (line ? 'text-ink-3' : 'text-ink-2') : ''}`
  const href = outsideUrl(cell.href)
  const fitted = href && line && room !== undefined ? fitMiddle(cell.text, cellFont(cell, first), room) : cell.text
  // On one line, a path-like text is cut in its folders, so its last part stays readable.
  const cut = line && cell.mono ? cell.text.lastIndexOf('/') : -1
  const text = cell.at ? (
    <span className={`${style} ${line ? 'min-w-0 truncate' : ''}`}>
      <Moment at={cell.at} />
    </span>
  ) : cell.text === '' ? null : href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`link ${style} min-w-0 ${line ? 'overflow-hidden whitespace-nowrap' : '[overflow-wrap:anywhere]'}`}
      title={cell.text}
      aria-label={fitted !== cell.text ? cell.text : undefined}
      onClick={stop}
    >
      {fitted}
    </a>
  ) : cut > 0 && cut < cell.text.length - 1 ? (
    <span className={`flex min-w-0 ${style}`}>
      <span className="sr-only">{cell.text}</span>
      <span className="min-w-0 truncate" aria-hidden>
        {cell.text.slice(0, cut + 1)}
      </span>
      <span className="max-w-full shrink-0 truncate" aria-hidden>
        {cell.text.slice(cut + 1)}
      </span>
    </span>
  ) : (
    <span className={`${style} min-w-0 ${line ? 'truncate' : '[overflow-wrap:anywhere]'}`}>{cell.text}</span>
  )
  const content = (
    <span className="cell" data-line={line || undefined} title={line && cell.text !== '' && !cell.at ? cell.text : undefined}>
      {cell.icon ? <ViewIcon name={cell.icon} /> : null}
      {text}
      {cell.copy ? <CopyButton value={href ?? cell.text} /> : null}
      {cell.tag ? <TagView tag={cell.tag} /> : null}
    </span>
  )
  if (!cell.link || href) return content
  const link = cell.link
  return (
    <button
      type="button"
      className={`link ${line ? 'block max-w-full' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onLink(link, wantsTab(e))
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.stopPropagation()
        onLink(link, true)
      }}
    >
      {content}
    </button>
  )
}

export function ActionButton({ action, small = false }: { action: Action; small?: boolean }) {
  const { onAction } = useEnv()
  return (
    <button
      type="button"
      className={`btn ${small ? 'btn-sm' : ''} ${action.tone === 'danger' ? 'btn-danger' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onAction(action)
      }}
    >
      {action.label}
    </button>
  )
}

function ActionRow({ actions, small = false }: { actions: Action[]; small?: boolean }) {
  if (actions.length === 0) return null
  return (
    <div className="actions">
      {actions.map((a, i) => (
        <ActionButton key={`${a.label}-${i}`} action={a} small={small} />
      ))}
    </div>
  )
}

function SectionView({ block }: { block: Extract<Block, { kind: 'section' }> }) {
  const [open, setOpen] = useState(block.collapse !== 'closed')
  const count = block.count !== null ? <span className="count">{block.count}</span> : null
  return (
    <section className="section" aria-label={block.title}>
      <div className="section-head">
        {block.collapse ? (
          <h3>
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronRight className={open ? 'rotate-90' : ''} strokeWidth={2} aria-hidden />
              {block.title}
            </button>
            {count}
          </h3>
        ) : (
          <h3>
            {block.title}
            {count}
          </h3>
        )}
        <ActionRow actions={block.actions} small />
      </div>
      {open && block.note ? <p className="section-note">{block.note}</p> : null}
      {open ? <Blocks blocks={block.blocks} /> : null}
    </section>
  )
}

/** The element's inner width, kept up to date. */
export function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, width]
}

/** Becomes true once the page's fonts have loaded, so measured widths are measured again with them. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => document.fonts.status === 'loaded')
  useEffect(() => {
    if (!ready) void document.fonts.ready.then(() => setReady(true))
  }, [ready])
  return ready
}

/**
 * A table whose columns take their natural width when it fits, so nothing is cut while there is
 * room; when the card is narrower, optional columns step aside and prose is cut before paths. A row
 * with a link opens it on click, Enter or Space, in a tab of its own with ⌘. ↑ ↓ Home End move
 * between those rows; only one of them is in the Tab order, the open one when it is here.
 */
function TableView({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const { onLink, selected } = useEnv()
  const [measure, available] = useWidth()
  const fonts = useFontsReady()
  const [cursor, setCursor] = useState<string | null>(null)
  const withActions = block.rows.some((r) => r.actions.length > 0)
  // `fonts` is a dependency so the columns are measured again once the fonts are in.
  const columns = useMemo(() => naturalColumns(block, withActions), [block, withActions, fonts])
  const fitted = available > 0 ? fitColumns(columns, available) : null
  // The data columns shown, and every column's width in the same order, actions last.
  const shownColumns = block.columns.filter((_, i) => fitted?.[i] !== null)
  const widths = fitted?.filter((w) => w !== null) ?? null
  const linked = block.rows.filter((r) => r.link)
  const roving = linked.find((r) => r.key === cursor)?.key ?? linked.find((r) => selected(r.link))?.key ?? linked[0]?.key
  const open = (row: TableRow, newTab: boolean) => row.link && onLink(row.link, newTab)
  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLTableRowElement>('tr[data-link]')]
    const at = rows.indexOf(e.target as HTMLTableRowElement)
    if (at < 0) return
    const to = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : e.key === 'ArrowUp' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const row = rows[to]
    setCursor(row?.dataset.key ?? null)
    row?.focus()
  }
  // An empty table is its message alone: headers over nothing say less than the message does.
  if (block.rows.length === 0) return <EmptyMessage text={block.empty} />
  return (
    <div ref={measure} className="card table-card">
      <table style={widths ? { tableLayout: 'fixed', width: widths.reduce((a, b) => a + b, 0) } : { width: '100%' }}>
        {widths ? (
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {shownColumns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
            {withActions ? <th scope="col" aria-label="动作" /> : null}
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {block.rows.map((row) => (
            <tr
              key={row.key}
              data-key={row.key}
              data-link={row.link ? '' : undefined}
              aria-selected={selected(row.link) || undefined}
              tabIndex={row.link ? (row.key === roving ? 0 : -1) : undefined}
              onFocus={row.link ? () => setCursor(row.key) : undefined}
              onMouseDown={
                row.link
                  ? (e) => {
                      // A press focuses the row; the card stays where it was rather than scrolling sideways to it.
                      const card = e.currentTarget.closest('.table-card')
                      const left = card?.scrollLeft ?? 0
                      requestAnimationFrame(() => card && (card.scrollLeft = left))
                    }
                  : undefined
              }
              onClick={row.link ? (e) => open(row, wantsTab(e)) : undefined}
              onAuxClick={row.link ? (e) => e.button === 1 && open(row, true) : undefined}
              onKeyDown={
                row.link
                  ? (e) => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                      e.preventDefault()
                      open(row, wantsTab(e))
                    }
                  : undefined
              }
            >
              {shownColumns.map((c, i) => {
                const cell = row.cells[c.key]
                const width = widths?.[i]
                return <td key={c.key}>{cell ? <CellView cell={cell} line first={i === 0} room={cell.href && width !== undefined ? textRoom(cell, width, i === 0) : undefined} /> : null}</td>
              })}
              {withActions ? (
                <td>
                  <div className="flex flex-nowrap justify-end gap-2">
                    {row.actions.map((a, i) => (
                      <ActionButton key={`${a.label}-${i}`} action={a} small />
                    ))}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FieldsView({ block }: { block: Extract<Block, { kind: 'fields' }> }) {
  return (
    <dl className="fields">
      {block.fields.map((f, i) => (
        <div key={`${f.label}-${i}`} className="contents">
          <dt>{f.label}</dt>
          <dd>
            <CellView cell={f.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ListView({ block }: { block: Extract<Block, { kind: 'list' }> }) {
  return (
    <ul className="card list">
      {block.items.map((item, i) => (
        <li key={`${item.cell.text}-${i}`}>
          <div className="min-w-0 flex-1">
            <CellView cell={item.cell} />
            {item.note ? <p className="list-note">{item.note}</p> : null}
          </div>
          <ActionRow actions={item.actions} small />
        </li>
      ))}
    </ul>
  )
}

function TimelineView({ block }: { block: Extract<Block, { kind: 'timeline' }> }) {
  return (
    <ol className="timeline">
      {block.entries.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <div className="timeline-meta">
            <Moment at={e.at} />
            {e.tag ? <TagView tag={e.tag} /> : null}
          </div>
          <div>
            <CellView cell={e.title} />
          </div>
          {e.lines.map((line, j) => (
            <p key={j} className="timeline-line">
              {line}
            </p>
          ))}
          {e.actions && e.actions.length > 0 ? (
            <div className="mt-2">
              <ActionRow actions={e.actions} small />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

const TONE_ICON: Record<Tone, LucideIcon | null> = { neutral: null, info: Info, good: CircleCheck, warn: TriangleAlert, bad: CircleAlert }

function TextView({ block }: { block: Extract<Block, { kind: 'text' }> }) {
  const Icon = TONE_ICON[block.tone]
  return (
    <p className="note" data-tone={block.tone === 'neutral' ? undefined : block.tone}>
      {Icon ? <Icon strokeWidth={2} aria-hidden /> : null}
      <span>{block.text}</span>
    </p>
  )
}

const TEXT_LIMIT = 200_000

type Loaded = { kind: 'image'; url: string } | { kind: 'text'; text: string; cut: boolean } | { kind: 'binary'; size: number } | { kind: 'missing' }

function PreviewView({ block }: { block: Extract<Block, { kind: 'preview' }> }) {
  const { tick } = useEnv()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const shownUrl = useRef<string | null>(null)
  // A new answer replaces the old one in place, so a refresh never empties the preview.
  useEffect(() => {
    let live = true
    const show = (l: Loaded) => {
      if (!live) return l.kind === 'image' && URL.revokeObjectURL(l.url)
      const before = shownUrl.current
      shownUrl.current = l.kind === 'image' ? l.url : null
      setLoaded(l)
      if (before) window.setTimeout(() => URL.revokeObjectURL(before), 0)
    }
    fetch(api.fileUrl(block.path))
      .then(async (res) => {
        if (!res.ok) return show({ kind: 'missing' })
        const type = res.headers.get('content-type') ?? ''
        if (type.startsWith('image/')) {
          return show({ kind: 'image', url: URL.createObjectURL(await res.blob()) })
        }
        if (type.startsWith('text/')) {
          const text = await res.text()
          return show({ kind: 'text', text: text.slice(0, TEXT_LIMIT), cut: text.length > TEXT_LIMIT })
        }
        return show({ kind: 'binary', size: Number(res.headers.get('content-length') ?? 0) })
      })
      .catch(() => show({ kind: 'missing' }))
    return () => {
      live = false
    }
  }, [block.path, tick])
  useEffect(
    () => () => {
      if (shownUrl.current) URL.revokeObjectURL(shownUrl.current)
    },
    [],
  )

  if (loaded === null) return <div className="loading skeleton h-24" aria-label="预览加载中" />
  if (loaded.kind === 'image')
    return (
      <figure className="card preview-image" aria-label="预览">
        <img src={loaded.url} alt={block.path} />
      </figure>
    )
  if (loaded.kind === 'text')
    return (
      <figure aria-label="预览">
        <pre className="preview-text">{loaded.text}</pre>
        {loaded.cut ? <figcaption className="caption">只显示了前 {TEXT_LIMIT.toLocaleString()} 个字符。</figcaption> : null}
      </figure>
    )
  if (loaded.kind === 'binary') return <p className="note">这个文件不是文字或图片，不能预览。</p>
  return <p className="note">没能读到这个文件。</p>
}

/**
 * An outside page in a frame that runs its scripts but never shares the viewer's origin, with a way
 * to open it in a new tab. A page of another origin keeps its own, so its storage works.
 */
function EmbedView({ block }: { block: Extract<Block, { kind: 'embed' }> }) {
  const href = outsideUrl(block.url)
  if (href === null) return <p className="note">这一块要显示的不是 http 或 https 的地址：{block.url}</p>
  const sandbox = new URL(href).origin === window.location.origin ? 'allow-scripts' : 'allow-scripts allow-same-origin'
  return (
    <figure className="card embed" aria-label={block.title}>
      <figcaption className="embed-bar">
        <ViewIcon name="globe" />
        <span className="min-w-0 truncate font-medium">{block.title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-3" title={href}>
          {href}
        </span>
        <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-quiet">
          在新标签页打开
          <ExternalLink strokeWidth={2} aria-hidden />
        </a>
      </figcaption>
      <iframe src={href} title={block.title} sandbox={sandbox} referrerPolicy="no-referrer" className="block w-full border-0 bg-white" style={{ height: block.height }} />
    </figure>
  )
}

/** A table's message when it has no rows, as an empty state: its first sentence the title, the rest the hint. */
function EmptyMessage({ text }: { text: string }) {
  const end = text.indexOf('。')
  const [title, hint] = end > 0 && end < text.length - 1 ? [text.slice(0, end + 1), text.slice(end + 1)] : [text, null]
  return <EmptyView block={{ kind: 'empty', title, hint }} />
}

function EmptyView({ block }: { block: Extract<Block, { kind: 'empty' }> }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox strokeWidth={1.75} aria-hidden />
      </span>
      <p className="empty-title">{block.title}</p>
      {block.hint ? <p className="empty-hint">{block.hint}</p> : null}
    </div>
  )
}

/** One block. A kind this page does not know shows as one muted line, so a newer kernel never blanks the page. */
export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'section':
      return <SectionView block={block} />
    case 'table':
      return <TableView block={block} />
    case 'fields':
      return <FieldsView block={block} />
    case 'list':
      return <ListView block={block} />
    case 'timeline':
      return <TimelineView block={block} />
    case 'text':
      return <TextView block={block} />
    case 'preview':
      return <PreviewView block={block} />
    case 'actions':
      return <ActionRow actions={block.actions} />
    case 'empty':
      return <EmptyView block={block} />
    case 'embed':
      return <EmbedView block={block} />
    case 'custom':
      return <CustomView block={block} />
    default:
      return (
        <p className="unknown">
          <CircleHelp strokeWidth={2} aria-hidden />
          这一块界面还不认识：{String((block as { kind?: unknown }).kind)}
        </p>
      )
  }
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="blocks">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}
