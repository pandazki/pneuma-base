// What happened, in groups under a heading such as a day or a scene; a heading with a link opens what
// it names. A row is two lines: one sentence, and under it a grey line of whose act it was when the
// mark does not say it (one the owner approved, one only seen), and the row's cells but those in their
// usual state. The mark says who, its name and grant in its tooltip. Its moment stands in a column at the left; where
// the feed is narrow, as in the panel, the moment opens the grey line instead and the sentence wraps
// rather than being cut. A row with a link opens it on a click or Enter, in a tab of its own with ⌘.
// At its right, one quiet action, or a grey word saying how it ended.
import type { Block, FeedGroup, FeedRow, Link } from '@pneuma-base/kernel'
import { ChevronRight } from 'lucide-react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { ActionButton } from '../actions'
import { CellView, Moment, wantsTab } from '../cells'
import { ReopenButton } from '../files'
import { useEnv } from '../env'
import { columnTime } from '../time'
import { ActorBadge } from './actor'
import { Pager, turns } from './pager'

type Feed = Extract<Block, { kind: 'feed' }>

/** The words for whose act a row was; an agent's own and the owner's own say nothing more than the mark. */
const WHOSE: Record<NonNullable<FeedRow['whose']>, string | null> = { agent: null, owner: null, approved: '主人批准的', observed: '看到的' }

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

function Row({ row }: { row: FeedRow }) {
  const { selected } = useEnv()
  const open = useOpen(row.link)
  const whose = row.whose ? WHOSE[row.whose] : null
  const current = selected(row.link)
  return (
    <li className="feed-row" data-link={open ? '' : undefined} data-current={current || undefined} onClick={open?.onClick} onAuxClick={open?.onAuxClick}>
      <span className="feed-time">
        <Moment at={row.at} format={columnTime} />
      </span>
      <ActorBadge actor={row.actor} size={24} titled />
      <div className="feed-main">
        {open ? (
          <span role="link" tabIndex={0} className="feed-line" aria-current={current || undefined} onKeyDown={open.onKeyDown}>
            {row.text}
          </span>
        ) : (
          <span className="feed-line">{row.text}</span>
        )}
        <span className="feed-meta">
          <span className="feed-meta-time">
            <Moment at={row.at} />
          </span>
          {whose ? (
            <span className="feed-whose" data-whose={row.whose}>
              {whose}
            </span>
          ) : null}
          {row.meta
            .filter((cell) => cell.normal !== true)
            .map((cell, i) => (
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
      ) : null}
    </li>
  )
}

function Rows({ rows }: { rows: FeedRow[] }) {
  return (
    <ul className="feed-rows">
      {rows.map((row) => (
        <Row key={row.key} row={row} />
      ))}
    </ul>
  )
}

/** A group with a heading is a region of the page by that name. */
export function FeedView({ block }: { block: Feed }) {
  if (block.groups.every((g) => g.rows.length === 0)) return <p className="feed-empty">{block.empty}</p>
  return (
    <div className="feed">
      {block.groups.map((group, i) =>
        group.title === '' ? (
          <div key={i} className="feed-group">
            <Rows rows={group.rows} />
          </div>
        ) : (
          <section key={`${group.title}-${i}`} className="feed-group" aria-label={group.title}>
            <Head group={group} />
            <Rows rows={group.rows} />
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
