// The block renderer: one component per kind of block. It knows the kernel's block types and no plugin.
import type { Action, Block, Cell, Link, Tag, TableRow, Tone } from '@pneuma-base/kernel'
import { ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import { ViewIcon } from './chrome'
import { fullTime, shortTime } from './time'

/** What a block can do besides showing itself: follow a link, start an action, and know what the panel shows. */
export type BlockEnv = {
  onLink(link: Link): void
  onAction(action: Action): void
  selected(link: Link | null): boolean
  /** Changes whenever the library changed, so blocks that load on their own load again. */
  tick: number
}

export const BlockEnvContext = createContext<BlockEnv | null>(null)

function useEnv(): BlockEnv {
  const env = useContext(BlockEnvContext)
  if (!env) throw new Error('blocks rendered outside BlockEnvContext')
  return env
}

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

/** One cell. In a table it stays on one line, its text cut short with the whole of it on hover; elsewhere it wraps. */
export function CellView({ cell, line = false }: { cell: Cell; line?: boolean }) {
  const { onLink } = useEnv()
  const style = `${cell.mono ? 'font-mono text-[12.5px]' : ''} ${cell.muted ? 'text-ink-2' : ''}`
  // On one line, a path-like text is cut in its folders, so its last part stays readable.
  const cut = line && cell.mono ? cell.text.lastIndexOf('/') : -1
  const text = cell.at ? (
    <span className={`${style} ${line ? 'min-w-0 truncate' : ''}`}>
      <Moment at={cell.at} />
    </span>
  ) : cell.text === '' ? null : cut > 0 && cut < cell.text.length - 1 ? (
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
      <span className={`${style} ${line ? 'min-w-0 truncate' : 'break-words'}`}>{cell.text}</span>
    )
  const content = (
    <span className={`items-center gap-x-2 align-middle ${line ? 'flex max-w-full min-w-0' : 'inline-flex flex-wrap gap-y-1'}`} title={line && cell.text !== '' && !cell.at ? cell.text : undefined}>
      {cell.icon ? <ViewIcon name={cell.icon} className="size-4 shrink-0 text-ink-3" /> : null}
      {text}
      {cell.tag ? <TagView tag={cell.tag} /> : null}
    </span>
  )
  if (!cell.link) return content
  const link = cell.link
  return (
    <button
      type="button"
      className={`link ${line ? 'block max-w-full' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onLink(link)
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
      className={`btn ${action.tone === 'danger' ? 'btn-danger' : ''} ${small ? '!h-6 !px-2 !text-[12px]' : ''}`}
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
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((a, i) => (
        <ActionButton key={`${a.label}-${i}`} action={a} small={small} />
      ))}
    </div>
  )
}

function SectionView({ block }: { block: Extract<Block, { kind: 'section' }> }) {
  const [open, setOpen] = useState(block.collapse !== 'closed')
  const count = block.count !== null ? <span className="rounded-chip bg-inset px-1.5 text-[11.5px] font-medium tabular-nums text-ink-2 shadow-(--shadow-hairline)">{block.count}</span> : null
  const heading = block.collapse ? (
    <h3>
      <button type="button" className="-ml-1 flex items-center gap-1 rounded-chip px-1 text-[13px] font-semibold text-ink hover:bg-hover" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={`size-3.5 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} strokeWidth={2} aria-hidden />
        {block.title}
      </button>
    </h3>
  ) : (
    <h3 className="text-[13px] font-semibold text-ink">{block.title}</h3>
  )
  return (
    <section className="flex flex-col gap-2.5" aria-label={block.title}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        {heading}
        {count}
        <div className="ml-auto">
          <ActionRow actions={block.actions} />
        </div>
      </div>
      {open && block.note ? <p className="-mt-1 text-[12.5px] text-ink-2">{block.note}</p> : null}
      {open ? <Blocks blocks={block.blocks} /> : null}
    </section>
  )
}

/** How wide a text looks: a CJK character counts as two Latin ones. */
const visualLength = (text: string) => [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0)

/** Columns whose texts run longer than this share the width the others leave, cut short; the others keep their own width. */
const LONG_TEXT = 20

function TableView({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const { onLink, selected } = useEnv()
  const withActions = block.rows.some((r) => r.actions.length > 0)
  const longest = block.columns.map((c) => Math.max(0, ...block.rows.map((r) => visualLength(r.cells[c.key]?.text ?? ''))))
  const flexible = longest.map((n) => n > LONG_TEXT)
  // Monospaced columns, paths mostly, get more of the shared width: their texts lose meaning faster when cut.
  const weight = block.columns.map((c, i) => (longest[i] ?? 0) * (block.rows.some((r) => r.cells[c.key]?.mono) ? 2 : 1))
  const shared = weight.reduce((sum, n, i) => (flexible[i] ? sum + n : sum), 0)
  const rowClass = (row: TableRow) =>
    `${row.link ? 'cursor-pointer hover:bg-hover' : ''} ${selected(row.link) ? '!bg-accent-tint' : ''}`
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px] font-medium">
        <thead>
          <tr className="bg-inset">
            {block.columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={`h-[35px] border-b border-line px-2 text-[12.5px] font-medium whitespace-nowrap text-ink-2 first:pl-3 ${flexible[i] ? '' : 'w-px'}`}
                style={flexible[i] ? { width: `${Math.round(((weight[i] ?? 0) / shared) * 100)}%` } : undefined}
              >
                {c.label}
              </th>
            ))}
            {withActions ? <th scope="col" className="h-[35px] w-px border-b border-line px-2" aria-label="动作" /> : null}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr
              key={row.key}
              className={`transition-colors duration-[120ms] ease-out ${rowClass(row)}`}
              aria-selected={selected(row.link) || undefined}
              onClick={row.link ? () => onLink(row.link as Link) : undefined}
            >
              {block.columns.map((c, i) => {
                const cell = row.cells[c.key]
                return (
                  <td key={c.key} className={`h-[35px] border-b border-line-soft px-2 align-middle whitespace-nowrap first:pl-3 ${flexible[i] ? 'max-w-0' : ''}`}>
                    {cell ? <CellView cell={cell} line /> : null}
                  </td>
                )
              })}
              {withActions ? (
                <td className="h-[35px] border-b border-line-soft px-2 align-middle">
                  <div className="flex justify-end">
                    <ActionRow actions={row.actions} small />
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {block.rows.length === 0 ? <p className="px-3 py-6 text-center text-[13px] text-ink-2">{block.empty}</p> : null}
    </div>
  )
}

function FieldsView({ block }: { block: Extract<Block, { kind: 'fields' }> }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
      {block.fields.map((f, i) => (
        <div key={`${f.label}-${i}`} className="contents">
          <dt className="text-ink-2">{f.label}</dt>
          <dd className="min-w-0 break-words">
            <CellView cell={f.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ListView({ block }: { block: Extract<Block, { kind: 'list' }> }) {
  return (
    <ul className="card divide-y divide-line-soft">
      {block.items.map((item, i) => (
        <li key={`${item.cell.text}-${i}`} className="flex items-start gap-3 px-3 py-2 text-[13px]">
          <div className="min-w-0 flex-1">
            <CellView cell={item.cell} />
            {item.note ? <p className="mt-0.5 text-[12px] text-ink-2">{item.note}</p> : null}
          </div>
          <ActionRow actions={item.actions} small />
        </li>
      ))}
    </ul>
  )
}

function TimelineView({ block }: { block: Extract<Block, { kind: 'timeline' }> }) {
  return (
    <ol className="ml-1.5 border-l border-line-strong">
      {block.entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative pb-3 pl-4 last:pb-0">
          <span className="absolute top-[7px] -left-[4.5px] size-2 rounded-full bg-ink-3 ring-2 ring-[var(--surface)]" aria-hidden />
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3 tabular-nums">
            <Moment at={e.at} />
            {e.tag ? <TagView tag={e.tag} /> : null}
          </div>
          <div className="text-[13px]">
            <CellView cell={e.title} />
          </div>
          {e.lines.map((line, j) => (
            <p key={j} className="text-[12.5px] text-ink-2">
              {line}
            </p>
          ))}
        </li>
      ))}
    </ol>
  )
}

const TEXT_TONE: Record<Tone, { box: string; icon: ReactNode }> = {
  neutral: { box: 'text-ink-2', icon: null },
  info: { box: 'bg-accent-tint text-ink', icon: <Info className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={2} /> },
  good: { box: 'bg-green-tint text-ink', icon: <CircleCheck className="mt-0.5 size-4 shrink-0 text-green" strokeWidth={2} /> },
  warn: { box: 'bg-orange-tint text-ink', icon: <TriangleAlert className="mt-0.5 size-4 shrink-0 text-orange" strokeWidth={2} /> },
  bad: { box: 'bg-red-tint text-ink', icon: <CircleAlert className="mt-0.5 size-4 shrink-0 text-red" strokeWidth={2} /> },
}

function TextView({ block }: { block: Extract<Block, { kind: 'text' }> }) {
  const tone = TEXT_TONE[block.tone]
  return (
    <p className={`flex items-start gap-2 rounded-control text-[13px] ${block.tone === 'neutral' ? '' : 'px-3 py-2'} ${tone.box}`}>
      {tone.icon}
      <span className="min-w-0 break-words whitespace-pre-line">{block.text}</span>
    </p>
  )
}

const TEXT_LIMIT = 200_000

type Loaded = { kind: 'image'; url: string } | { kind: 'text'; text: string; cut: boolean } | { kind: 'binary'; size: number } | { kind: 'missing' }

function PreviewView({ block }: { block: Extract<Block, { kind: 'preview' }> }) {
  const { tick } = useEnv()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    let live = true
    let url: string | null = null
    const show = (l: Loaded) => {
      if (live) setLoaded(l)
      else if (l.kind === 'image') URL.revokeObjectURL(l.url)
    }
    fetch(api.fileUrl(block.path))
      .then(async (res) => {
        if (!res.ok) return show({ kind: 'missing' })
        const type = res.headers.get('content-type') ?? ''
        if (type.startsWith('image/')) {
          url = URL.createObjectURL(await res.blob())
          return show({ kind: 'image', url })
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
      if (url) URL.revokeObjectURL(url)
    }
  }, [block.path, tick])

  if (loaded === null) return <div className="h-24 animate-pulse rounded-card bg-inset" aria-label="预览加载中" />
  if (loaded.kind === 'image')
    return (
      <figure className="card overflow-hidden p-2" aria-label="预览">
        <img src={loaded.url} alt={block.path} className="mx-auto max-h-[420px] max-w-full rounded-chip object-contain" />
      </figure>
    )
  if (loaded.kind === 'text')
    return (
      <figure aria-label="预览">
        <pre className="max-h-[320px] overflow-auto rounded-card bg-inset p-3 font-mono text-[12px] leading-[1.6] break-words whitespace-pre-wrap text-ink shadow-(--shadow-hairline)">
          {loaded.text}
        </pre>
        {loaded.cut ? <figcaption className="mt-1 text-[12px] text-ink-3">只显示了前 {TEXT_LIMIT.toLocaleString()} 个字符。</figcaption> : null}
      </figure>
    )
  if (loaded.kind === 'binary') return <p className="text-[12.5px] text-ink-2">这个文件不是文字或图片，不能预览。</p>
  return <p className="text-[12.5px] text-ink-2">没能读到这个文件。</p>
}

function EmptyView({ block }: { block: Extract<Block, { kind: 'empty' }> }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-ink">{block.title}</p>
      {block.hint ? <p className="mt-1 max-w-[36rem] text-[12.5px] break-words text-ink-2">{block.hint}</p> : null}
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
    default:
      return <p className="text-[12.5px] text-ink-3">这一块界面还不认识：{String((block as { kind?: unknown }).kind)}</p>
  }
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex flex-col gap-5">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}
