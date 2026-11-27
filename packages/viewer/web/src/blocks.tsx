// One renderer per kind of block. A block draws itself from its data alone; links, actions and
// parameters go to the shell through the environment.
import type { Block, Cell, Link, ListItem, Paging, SortKey, TableRow, Tone } from '@pneuma-base/kernel'
import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, CircleCheck, CircleHelp, ExternalLink, Folder, Inbox, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, outsideUrl } from './api'
import { ActorBadge } from './pieces/actor'
import { AsksView } from './pieces/asks'
import { ChartView } from './pieces/chart'
import { FeedView } from './pieces/feed'
import { Pager, turns } from './pieces/pager'
import { StatsView } from './pieces/stats'
import { TreeView } from './pieces/tree'
import { ActionBar, InlineAction, placeActions } from './actions'
import { CellView, Moment, TagView, wantsTab } from './cells'
import { ViewIcon } from './chrome'
import { useEnv } from './env'
import { IconGrid, placed, RenameField, useFiles } from './files'
import { CustomView } from './frame'
import { fitColumns, naturalColumns, textRoom } from './measure'
import { DropView, StepsView } from './steps'
import { localMoments } from './time'

export const sameLink = (a: Link | null, b: { view: string; params: Record<string, string> } | null) =>
  a !== null && b !== null && a.view === b.view && JSON.stringify(Object.entries(a.params).sort()) === JSON.stringify(Object.entries(b.params).sort())

/** What a section is for, on demand: an ⓘ beside its title that says it in a tooltip, and to a screen reader as the section's description. */
function About({ text, title }: { text: string; title: string }) {
  return (
    <span className="about" role="img" tabIndex={0} aria-label={`${title}：${text}`} data-tip={text}>
      <Info strokeWidth={2} aria-hidden />
    </span>
  )
}

/**
 * A section: its title with its count and, on demand, what it is for; its actions in its head, but an
 * action of one sentence written in place, before its blocks. One that has nothing for the person now
 * is not drawn, unless it was on screen when it came to have nothing: what was just done there, such
 * as an answer folded into a receipt, stays in sight until the page is left.
 */
function SectionView({ block }: { block: Extract<Block, { kind: 'section' }> }) {
  const [open, setOpen] = useState(block.collapse !== 'closed')
  // The title it was last drawn with: the same place on another page is another section.
  const shownAs = useRef(block.normal ? null : block.title)
  if (!block.normal) shownAs.current = block.title
  if (block.normal && shownAs.current !== block.title) return null
  const count = block.count !== null ? <span className="count">{block.count}</span> : null
  const { inline } = placeActions(block.actions)
  const headed = block.actions.filter((a) => !inline.includes(a))
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
            {block.about ? <About text={block.about} title={block.title} /> : null}
          </h3>
        ) : (
          <h3>
            {block.title}
            {count}
            {block.about ? <About text={block.about} title={block.title} /> : null}
          </h3>
        )}
        <ActionBar actions={headed} />
      </div>
      {open && block.note ? <p className="section-note">{localMoments(block.note)}</p> : null}
      {open ? inline.map((a, i) => <InlineAction key={`${a.label}-${i}`} action={a} />) : null}
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

/** A cell with something to show: not empty, and not the usual state, which goes unsaid. */
const says = (cell: Cell | undefined) => cell !== undefined && cell.normal !== true && (cell.text !== '' || cell.tag !== undefined || cell.actor !== undefined || cell.at !== undefined || cell.icon !== undefined)

/**
 * The table as the page draws it: a cell in its usual state left empty, a column with nothing else in
 * it left out, and rows of a group brought together under it, in the order of each group's first row.
 */
function drawn(block: Extract<Block, { kind: 'table' }>): Extract<Block, { kind: 'table' }> {
  const columns = block.columns.filter((c) => block.rows.some((r) => says(r.cells[c.key])))
  const blank = (cell: Cell) => (cell.normal ? { text: '' } : cell)
  const rows = block.rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, blank(c)])) }))
  const order = [...new Set(rows.map((r) => r.group ?? ''))]
  const grouped = order.length > 1 || (order[0] ?? '') !== '' ? order.flatMap((g) => rows.filter((r) => (r.group ?? '') === g)) : rows
  return { ...block, columns: columns.length > 0 ? columns : block.columns.slice(0, 1), rows: grouped }
}

/**
 * A table whose columns take their natural width when it fits, so nothing is cut while there is
 * room; when the card is narrower, optional columns step aside and prose is cut before paths. A row
 * with a link opens it on click, Enter or Space, in a tab of its own with ⌘. ↑ ↓ Home End move
 * between those rows; only one of them is in the Tab order, the open one when it is here. Such a row
 * shows its actions while the pointer or the focus is on it. Grouped rows stand under their group's
 * heading, and read as a list, without the column headers.
 */
/** The keys a table of places sorts by from its column heads, and which way each goes first: names A to Z, the newest and the largest first. */
const SORTS: Record<string, { key: SortKey; desc: boolean }> = { name: { key: 'name', desc: false }, modified: { key: 'modified', desc: true }, kind: { key: 'kind', desc: false }, size: { key: 'size', desc: true } }

/** The value of the view's `sort` after a click on the head of column `key`: its own first way, or the other way when it sorts by it already. */
export function sortAfter(sorted: { by: SortKey; desc: boolean }, key: SortKey): string {
  const desc = sorted.by === key ? !sorted.desc : (SORTS[key]?.desc ?? false)
  return `${desc ? '-' : ''}${key}`
}

function TableView({ block: given }: { block: Extract<Block, { kind: 'table' }> }) {
  const { onLink, selected, look, onParam } = useEnv()
  const [measure, available] = useWidth()
  const fonts = useFontsReady()
  const [cursor, setCursor] = useState<string | null>(null)
  const block = useMemo(() => drawn(given), [given])
  const files = useFiles(block)
  const grouped = block.rows.some((r) => (r.group ?? '') !== '')
  const withActions = block.rows.some((r) => r.actions.length > 0)
  // `fonts` is a dependency so the columns are measured again once the fonts are in.
  const columns = useMemo(() => naturalColumns(block, withActions, !grouped), [block, withActions, grouped, fonts])
  const fitted = available > 0 ? fitColumns(columns, available) : null
  // The data columns shown, and every column's width in the same order, actions last.
  const shownColumns = block.columns.filter((_, i) => fitted?.[i] !== null)
  const widths = fitted?.filter((w) => w !== null) ?? null
  const span = shownColumns.length + (withActions ? 1 : 0)
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
  if (block.rows.length === 0) return <EmptyMessage text={block.empty} page={block.page} />
  if (files && look === 'icons') return <IconGrid block={block} files={files} pager={turns(block.page) ? <Pager page={block.page} /> : null} />
  const sorted = block.sorted
  return (
    <div className="card table-card" data-grouped={grouped || undefined} data-files-table={files ? '' : undefined}>
      <div ref={measure} className="table-scroll">
      <table style={widths ? { tableLayout: 'fixed', width: widths.reduce((a, b) => a + b, 0) } : { width: '100%' }}>
        {widths ? (
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        ) : null}
        <thead className={grouped ? 'sr-only' : undefined}>
          <tr>
            {shownColumns.map((c) => {
              const by = sorted && SORTS[c.key] ? (SORTS[c.key] as { key: SortKey }).key : null
              if (!sorted || by === null)
                return (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                )
              const on = sorted.by === by
              // By name from A, as storage lists a folder, is the usual order: no arrow says it.
              const usual = sorted.by === 'name' && !sorted.desc
              const Arrow = sorted.desc ? ArrowDown : ArrowUp
              return (
                <th key={c.key} scope="col" aria-sort={on ? (sorted.desc ? 'descending' : 'ascending') : undefined}>
                  <button type="button" className="sort-head" data-on={(on && !usual) || undefined} onClick={() => onParam('sort', sortAfter(sorted, by))}>
                    {c.label}
                    {on && !usual ? <Arrow strokeWidth={2} aria-hidden /> : null}
                  </button>
                </th>
              )
            })}
            {withActions ? <th scope="col" aria-label="动作" /> : null}
          </tr>
        </thead>
        <tbody onKeyDown={files ? (e) => files.onKeyDown(e) : onKeyDown} data-files={files ? '' : undefined}>
          {block.rows.map((row, r) => {
            const group = row.group ?? ''
            const heading =
              grouped && group !== (block.rows[r - 1]?.group ?? null) && group !== '' ? (
                <tr key={`group-${group}`} className="group-row">
                  <th colSpan={span} scope="colgroup">
                    <span className="group-name">
                      <Folder strokeWidth={1.75} aria-hidden />
                      <span className="truncate">{group}</span>
                    </span>
                  </th>
                </tr>
              ) : null
            const own = files && placed(row) ? files.itemProps(row) : null
            return [
              heading,
              own && placed(row) ? (
                <tr key={row.key} data-link={row.link ? '' : undefined} {...own} aria-selected={own['aria-selected'] || undefined}>
                  {shownColumns.map((c, i) => {
                    const cell = row.cells[c.key]
                    const width = widths?.[i]
                    if (i === 0 && files?.renaming === row.key)
                      return (
                        <td key={c.key}>
                          <RenameField name={row.place.path.slice(row.place.path.lastIndexOf('/') + 1)} onDone={files.rename} />
                        </td>
                      )
                    // The row opens on a double-click; its name is no link of its own.
                    const shown = cell && i === 0 ? { ...cell, link: undefined } : cell
                    return <td key={c.key}>{shown ? <CellView cell={shown} line first={i === 0} room={shown.href && width !== undefined ? textRoom(shown, width, i === 0) : undefined} /> : null}</td>
                  })}
                  {withActions ? (
                    <td>
                      <ActionBar actions={row.actions} className="row-actions" />
                    </td>
                  ) : null}
                </tr>
              ) : (
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
                        const card = e.currentTarget.closest('.table-scroll')
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
                    <ActionBar actions={row.actions} className={row.link ? 'row-actions' : 'justify-end'} />
                  </td>
                ) : null}
              </tr>
              ),
            ]
          })}
        </tbody>
      </table>
      </div>
      {turns(block.page) ? <Pager page={block.page} /> : null}
      {files?.overlay}
    </div>
  )
}

/** Fields, each with its label; a field in its usual state left out; with `line`, the values in one line, each label in its tooltip. */
function FieldsView({ block }: { block: Extract<Block, { kind: 'fields' }> }) {
  const fields = block.fields.filter((f) => f.value.normal !== true)
  if (fields.length === 0) return null
  if (block.line)
    return (
      <p className="fields-line">
        {fields.map((f, i) => (
          <span key={`${f.label}-${i}`} className="fields-line-value" title={f.value.at ? undefined : f.label}>
            <CellView cell={f.value} />
          </span>
        ))}
      </p>
    )
  return (
    <dl className="fields">
      {fields.map((f, i) => (
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

type Toggle = NonNullable<ListItem['toggle']>

/**
 * A setting's switch. Turning it, by click, Space or Enter, runs its action through the same path as a
 * button, so a question and a notice come as they do there. It moves at once, goes back when the action
 * was cancelled or did not succeed, and otherwise stands as the page's next answer says.
 */
function SettingSwitch({ name, toggle }: { name: string; toggle: Toggle }) {
  const { onAction } = useEnv()
  // Where it was turned to, and on which answer of the page; a newer answer says where it stands.
  const [turned, setTurned] = useState<{ on: boolean; of: Toggle } | null>(null)
  const pending = turned !== null && turned.of === toggle
  const on = pending ? turned.on : toggle.on
  const turn = async () => {
    if (pending) return
    setTurned({ on: !toggle.on, of: toggle })
    const done = await onAction(toggle.action)
    if (done?.tone !== 'good') setTurned(null)
  }
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={on}
      aria-label={name}
      aria-busy={pending || undefined}
      data-tip={toggle.action.label}
      onClick={(e) => {
        e.stopPropagation()
        void turn()
      }}
    />
  )
}

/**
 * A list: rows of a cell, its long text behind an ⓘ, a grey note, its actions and, for a setting, its
 * switch at the end. Among several rows, a row whose actions are only icons and a 「···」 shows them while
 * the pointer or the focus is on it.
 */
function ListView({ block }: { block: Extract<Block, { kind: 'list' }> }) {
  const quiet = (item: ListItem) => block.items.length > 1 && item.toggle === undefined && placeActions(item.actions).main === null
  const items = (
    <ul className={turns(block.page) ? 'list' : 'card list'}>
      {block.items.map((item, i) => (
        <li key={`${item.cell.text}-${i}`} data-acts={item.toggle !== undefined || item.actions.length > 0 || undefined} data-lead={item.cell.actor ? 'mark' : item.cell.icon ? 'icon' : undefined}>
          <div className="min-w-0 flex-1">
            <div className="list-cell">
              {/* The ⓘ belongs to the name: a mark of the row's state comes after it. */}
              <CellView cell={item.about && item.cell.tag ? { ...item.cell, tag: undefined } : item.cell} />
              {item.about ? <About text={item.about} title={item.cell.text} /> : null}
              {item.about && item.cell.tag ? <TagView tag={item.cell.tag} /> : null}
            </div>
            {item.note ? <p className="list-note">{localMoments(item.note)}</p> : null}
          </div>
          <ActionBar actions={item.actions} className={quiet(item) ? 'row-actions' : ''} />
          {item.toggle ? <SettingSwitch name={item.cell.text} toggle={item.toggle} /> : null}
        </li>
      ))}
    </ul>
  )
  if (!turns(block.page)) return items
  return (
    <div className="card list-card">
      {items}
      <Pager page={block.page} />
    </div>
  )
}

function TimelineView({ block }: { block: Extract<Block, { kind: 'timeline' }> }) {
  if (!turns(block.page)) return <TimelineEntries block={block} />
  return (
    <div className="blocks">
      <TimelineEntries block={block} />
      <div className="card">
        <Pager page={block.page} />
      </div>
    </div>
  )
}

function TimelineEntries({ block }: { block: Extract<Block, { kind: 'timeline' }> }) {
  return (
    <ol className="timeline">
      {block.entries.map((e, i) => (
        <li key={`${e.at}-${i}`} data-actor={e.actor !== undefined || undefined}>
          {e.actor !== undefined ? (
            <span className="timeline-mark">
              <ActorBadge actor={e.actor} titled />
            </span>
          ) : null}
          <div className="timeline-head">
            <span className="timeline-title">
              <CellView cell={e.title} />
              {e.tag ? <TagView tag={e.tag} /> : null}
            </span>
            <span className="timeline-meta">
              <Moment at={e.at} />
            </span>
          </div>
          {e.lines.map((line, j) => (
            <p key={j} className="timeline-line">
              {localMoments(line)}
            </p>
          ))}
          {e.actions && e.actions.length > 0 ? <ActionBar actions={e.actions} className="mt-2" /> : null}
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
      <span>{localMoments(block.text)}</span>
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

/**
 * A table's message when it has no rows, as an empty state: its first sentence the title, the rest the
 * hint; on a page past the first, the way back under it.
 */
function EmptyMessage({ text, page }: { text: string; page?: Paging | undefined }) {
  const end = text.indexOf('。')
  const [title, hint] = end > 0 && end < text.length - 1 ? [text.slice(0, end + 1), text.slice(end + 1)] : [text, null]
  const empty = <EmptyView block={{ kind: 'empty', title, hint }} />
  if (!turns(page) || page.prev === null) return empty
  return (
    <div className="blocks">
      {empty}
      <div className="card">
        <Pager page={page} />
      </div>
    </div>
  )
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
      // Actions for the whole page stand in its head, which draws them.
      return block.head ? null : <ActionBar actions={block.actions} small={false} />
    case 'feed':
      return <FeedView block={block} />
    case 'stats':
      return <StatsView block={block} />
    case 'tree':
      return <TreeView block={block} />
    case 'asks':
      return <AsksView block={block} />
    case 'steps':
      return <StepsView block={block} />
    case 'drop':
      return <DropView block={block} />
    case 'chart':
      return <ChartView block={block} />
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

/** Blocks one under another. A tree that comes first stands at the left of the rest, as folders beside what is in them. */
export function Blocks({ blocks }: { blocks: Block[] }) {
  const [first, ...rest] = blocks
  if (first?.kind === 'tree' && rest.length > 0) {
    return (
      <div className="blocks-aside">
        <nav className="blocks-aside-tree" aria-label="文件夹">
          <TreeView block={first} />
        </nav>
        <Blocks blocks={rest} />
      </div>
    )
  }
  return (
    <div className="blocks">
      {runs(blocks).map((run, i) =>
        run.length > 1 ? (
          <div key={i} className="charts">
            {run.map((b, j) => (
              <BlockView key={j} block={b} />
            ))}
          </div>
        ) : (
          <BlockView key={i} block={run[0] as Block} />
        ),
      )}
    </div>
  )
}

/** The blocks one by one, except that charts next to each other go together, to stand side by side where there is room. */
function runs(blocks: Block[]): Block[][] {
  const out: Block[][] = []
  for (const b of blocks) {
    const last = out.at(-1)
    if (b.kind === 'chart' && last?.[0]?.kind === 'chart') last.push(b)
    else out.push([b])
  }
  return out
}
