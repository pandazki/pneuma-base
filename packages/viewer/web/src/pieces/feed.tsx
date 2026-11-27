// What happened, in groups under a heading such as a day or a scene; a heading with a link opens what
// it names. A row is who (the mark, its name and grant in its tooltip), what, and when. When the row
// comes in parts, what is the act as an icon and the thing as its name, the folder grey beside it,
// and under it the note its actor wrote; else it is the row's sentence, with a grey line of whose act
// it was when the mark does not say it (one the owner approved, one only seen) and the row's cells
// but those in their usual state. The whole sentence is the row's tooltip. A folder or a moment the
// row above already showed is not shown again. The moment stands in a column at the left; where the
// feed is narrow, as in the panel, it opens the grey line instead. `dense`, for the menu bar panel:
// one line a row, the moment at its right. A row with a link opens it on a click or Enter, in a tab of
// its own with ⌘. At its right, one quiet action, or a grey word saying how it ended.
import type { Block, FeedAct, FeedGroup, FeedRow, Link } from '@pneuma-base/kernel'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ChevronRight,
  Flag,
  FolderInput,
  Link2,
  MessageCircleQuestion,
  MessageSquareText,
  Pencil,
  Play,
  Sparkles,
  Terminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { ActionButton } from '../actions'
import { CellView, Moment, wantsTab } from '../cells'
import { ReopenButton } from '../files'
import { useEnv } from '../env'
import { columnTime, shortTime, useNow } from '../time'
import { ActorBadge } from './actor'
import { Pager, turns } from './pager'

type Feed = Extract<Block, { kind: 'feed' }>

/** The words for whose act a row was; an agent's own and the owner's own say nothing more than the mark. */
const WHOSE: Record<NonNullable<FeedRow['whose']>, string | null> = { agent: null, owner: null, approved: '主人批准的', observed: '看到的' }

/** Each kind of act as the icon a row shows, and its word for a screen reader. */
const ACTS: Record<FeedAct, { icon: LucideIcon; word: string }> = {
  made: { icon: Sparkles, word: '放入' },
  brought: { icon: ArrowDownToLine, word: '带进来' },
  changed: { icon: Pencil, word: '改了' },
  moved: { icon: FolderInput, word: '挪到' },
  archived: { icon: Archive, word: '归档' },
  restored: { icon: ArchiveRestore, word: '取回' },
  note: { icon: MessageSquareText, word: '备注' },
  decision: { icon: Flag, word: '决定' },
  doing: { icon: Play, word: '在做' },
  basis: { icon: Link2, word: '补上依据' },
  removed: { icon: Trash2, word: '清掉' },
  command: { icon: Terminal, word: '执行' },
  request: { icon: MessageCircleQuestion, word: '请你做' },
}

/** What following a link takes from a click or a key: a tab of its own with ⌘ or Ctrl, or the middle button. */
function useOpen(link: Link | null | undefined) {
  const { onLink } = useEnv()
  if (!link) return null
  return {
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      onLink(link, wantsTab(e))
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      e.stopPropagation()
      onLink(link, true)
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      onLink(link, wantsTab(e))
    },
  }
}

function Head({ group }: { group: FeedGroup }) {
  const open = useOpen(group.link)
  const inner = (
    <>
      <span className="feed-head-title">{group.title}</span>
      {group.count !== null && (group.count > 1 || !group.link) ? <span className="feed-count">{group.count}</span> : null}
    </>
  )
  return (
    <h4 className="feed-head">
      {open ? (
        <button type="button" onClick={open.onClick} onAuxClick={open.onAuxClick}>
          {inner}
          <ChevronRight className="feed-head-chev" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span>{inner}</span>
      )}
      {group.reopen ? <ReopenButton reopen={group.reopen} /> : null}
    </h4>
  )
}

/** The folder of a library path, '' at the root, and its last part. */
const split = (path: string) => {
  const cut = path.lastIndexOf('/')
  return { folder: cut < 0 ? '' : path.slice(0, cut), name: cut < 0 ? path : path.slice(cut + 1) }
}

/** Acts whose words are the point: on one line their note stands in the folder's place. */
const SPOKEN: ReadonlySet<FeedAct> = new Set(['note', 'decision'])

/** What a row says in its first line: the act and the thing, else the note, else its sentence; on one line, a note or a decision's words in grey. */
function Line({ row, folder, dense }: { row: FeedRow; folder: string | null; dense: boolean }) {
  const act = row.act ? ACTS[row.act] : null
  if (!act) return <>{row.text}</>
  const Icon = act.icon
  const thing = row.path === undefined ? null : split(row.path)
  const grey = noteInPlace(row, dense) ? row.note : folder
  return (
    <>
      <Icon className="feed-act" strokeWidth={1.75} role="img" aria-label={act.word} />
      {thing ? (
        <>
          <span className="feed-name">{thing.name}</span>
          {grey ? <span className="feed-folder">{grey}</span> : null}
        </>
      ) : (
        <span className="feed-name" data-said="">
          {row.note ?? row.text}
        </span>
      )}
    </>
  )
}

/** Whether a row on one line shows its note where its folder would be. */
const noteInPlace = (row: FeedRow, dense: boolean) => dense && row.act !== undefined && SPOKEN.has(row.act) && row.note !== undefined

/** What the rows of one group show of their folders and moments: each only where it differs from the row above. */
function said(rows: FeedRow[], now: Date, dense: boolean): { folder: string | null; moment: boolean }[] {
  let folder: string | null = null
  let moment: string | null = null
  return rows.map((row) => {
    const own = row.act && row.path !== undefined && !noteInPlace(row, dense) ? split(row.path).folder : null
    const shown = own !== null && own !== '' && own !== folder ? own : null
    if (own !== null) folder = own
    const at = columnTime(row.at, now)
    const fresh = at !== moment
    moment = at
    return { folder: shown, moment: fresh }
  })
}

function Row({ row, folder, moment, dense }: { row: FeedRow; folder: string | null; moment: boolean; dense: boolean }) {
  const { selected } = useEnv()
  const open = useOpen(row.link)
  const whose = row.whose ? WHOSE[row.whose] : null
  const current = selected(row.link)
  const parts = row.act !== undefined
  // With parts, the note is the second line in place of the cells, which stay in the tooltip; a note that is the first line is not said twice.
  const note = parts && row.path !== undefined ? (row.note ?? null) : null
  const cells = row.meta.filter((cell) => cell.normal !== true)
  const drawn = note !== null || (parts && row.path === undefined && row.note !== undefined) ? [] : cells
  const tip = [row.text, ...(drawn === cells ? [] : cells.map((c) => c.text))].join('\n')
  const reopen = row.meta.find((c) => c.reopen !== undefined)?.reopen
  const line = open ? (
    <span role="link" tabIndex={0} className="feed-line" aria-current={current || undefined} onKeyDown={open.onKeyDown} title={tip}>
      <Line row={row} folder={folder} dense={dense} />
    </span>
  ) : (
    <span className="feed-line" title={tip}>
      <Line row={row} folder={folder} dense={dense} />
    </span>
  )
  if (dense)
    return (
      <li className="feed-row" data-dense="" data-link={open ? '' : undefined} onClick={open?.onClick} onAuxClick={open?.onAuxClick}>
        <ActorBadge actor={row.actor} size={18} titled />
        <div className="feed-main">{line}</div>
        <span className="feed-time">{moment ? <Moment at={row.at} format={shortTime} /> : null}</span>
      </li>
    )
  return (
    <li className="feed-row" data-link={open ? '' : undefined} data-current={current || undefined} onClick={open?.onClick} onAuxClick={open?.onAuxClick}>
      <span className="feed-time">{moment ? <Moment at={row.at} format={columnTime} /> : null}</span>
      <ActorBadge actor={row.actor} size={24} titled />
      <div className="feed-main">
        {line}
        <span className="feed-meta">
          {moment ? (
            <span className="feed-meta-time">
              <Moment at={row.at} />
            </span>
          ) : null}
          {whose ? (
            <span className="feed-whose" data-whose={row.whose}>
              {whose}
            </span>
          ) : null}
          {note !== null ? <span className="feed-cell feed-note">{note}</span> : null}
          {drawn.map((cell, i) => (
            <span key={i} className="feed-cell">
              <CellView cell={cell} />
            </span>
          ))}
        </span>
      </div>
      {row.action ? (
        <div className="feed-end">
          <ActionButton action={row.action} small />
        </div>
      ) : row.settled ? (
        <div className="feed-end">
          <span className="tag">{row.settled}</span>
        </div>
      ) : reopen && drawn !== cells ? (
        <div className="feed-end feed-hover">
          <ReopenButton reopen={reopen} />
        </div>
      ) : null}
    </li>
  )
}

function Rows({ rows, dense }: { rows: FeedRow[]; dense: boolean }) {
  const now = useNow()
  const shown = said(rows, now, dense)
  return (
    <ul className="feed-rows">
      {rows.map((row, i) => (
        <Row key={row.key} row={row} folder={shown[i]?.folder ?? null} moment={shown[i]?.moment ?? true} dense={dense} />
      ))}
    </ul>
  )
}

/** A group with a heading is a region of the page by that name. */
export function FeedView({ block, dense = false }: { block: Feed; dense?: boolean }) {
  if (block.groups.every((g) => g.rows.length === 0)) return <p className="feed-empty">{block.empty}</p>
  return (
    <div className="feed" data-dense={dense || undefined}>
      {block.groups.map((group, i) =>
        group.title === '' ? (
          <div key={i} className="feed-group">
            <Rows rows={group.rows} dense={dense} />
          </div>
        ) : (
          <section key={`${group.title}-${i}`} className="feed-group" aria-label={group.title}>
            <Head group={group} />
            <Rows rows={group.rows} dense={dense} />
          </section>
        ),
      )}
      {turns(block.page) ? (
        <div className="feed-pager">
          <Pager page={block.page} />
        </div>
      ) : null}
    </div>
  )
}
