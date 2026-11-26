// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Agent / Activity screen: days as grey strips with a count, a row of fixed
// height with the time, the actor's mark, the sentence over a grey line of who let it, and one slot
// at the end for the quiet action or the word that says it is settled.
import type { Block, FeedRow } from '@pneuma-base/kernel'
import { ChevronRight } from 'lucide-react'
import { ActionButton, CellView, Moment, wantsTab } from '../cells'
import { useEnv } from '../env'
import { clockOrAgo } from '../time'
import { ActorBadge } from './actor'

type Feed = Extract<Block, { kind: 'feed' }>

/**
 * Whose act it was, as a dot and two or three words, where it departs from the ordinary: an agent
 * acting on its own is what nearly every row is, so it goes unmarked; the text form says it on every row.
 */
const WHOSE: Partial<Record<NonNullable<FeedRow['whose']>, string>> = { owner: '主人做的', approved: '主人批准的', observed: '看到的' }

function Row({ row }: { row: FeedRow }) {
  const { onLink, selected } = useEnv()
  const name = typeof row.actor === 'string' ? row.actor : row.actor.name
  const open = (newTab: boolean) => row.link && onLink(row.link, newTab)
  const body = (
    <>
      <span className="aui-feed-time">
        <Moment at={row.at} format={clockOrAgo} />
      </span>
      <ActorBadge actor={row.actor} size={24} />
      <span className="aui-feed-text">
        <span className="aui-feed-line" title={row.text}>
          {row.text}
        </span>
        <span className="aui-feed-meta">
          {/* Where the time column has no room, as in the panel, the moment leads the grey line. */}
          <span className="aui-feed-meta-time">
            <Moment at={row.at} format={clockOrAgo} />
            <span aria-hidden>·</span>
          </span>
          <span className="aui-feed-who">{name}</span>
          {row.whose && WHOSE[row.whose] ? (
            <span className="aui-feed-whose" data-whose={row.whose}>
              <span className="aui-feed-dot" aria-hidden />
              {WHOSE[row.whose]}
            </span>
          ) : null}
          {row.meta.map((cell, i) => (
            <span key={i} className="aui-feed-meta-cell">
              <span aria-hidden>·</span>
              <CellView cell={cell} />
            </span>
          ))}
        </span>
      </span>
    </>
  )
  return (
    <li className="aui-feed-row" data-selected={selected(row.link) || undefined}>
      {row.link ? (
        <div
          role="link"
          tabIndex={0}
          className="aui-feed-main"
          onClick={(e) => open(wantsTab(e))}
          onAuxClick={(e) => e.button === 1 && open(true)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
            e.preventDefault()
            open(wantsTab(e))
          }}
        >
          {body}
        </div>
      ) : (
        <div className="aui-feed-main">{body}</div>
      )}
      <span className="aui-feed-end">
        {row.action ? <ActionButton action={row.action} small /> : row.settled ? <span className="aui-feed-settled">{row.settled}</span> : null}
      </span>
    </li>
  )
}

/** Rows under headings: a day, a scene. A heading that names something opens it. Nothing at all is one grey sentence. */
export function FeedView({ block }: { block: Feed }) {
  const { onLink } = useEnv()
  const groups = block.groups.filter((g) => g.rows.length > 0)
  if (groups.length === 0) return block.empty === '' ? null : <p className="aui-quiet">{block.empty}</p>
  return (
    <div className="aui-feed">
      {groups.map((g, i) => {
        const link = g.link
        const title = (
          <>
            <span className="aui-feed-title">{g.title}</span>
            {g.count !== null ? <span className="aui-feed-count">{g.count}</span> : null}
          </>
        )
        return (
          <section key={`${g.title}-${i}`} className="aui-feed-day" aria-label={g.title}>
            {link ? (
              <button type="button" className="aui-feed-head" onClick={(e) => onLink(link, wantsTab(e))}>
                {title}
                <ChevronRight className="aui-feed-chev" strokeWidth={2} aria-hidden />
              </button>
            ) : (
              <h3 className="aui-feed-head">{title}</h3>
            )}
            <ul className="aui-feed-rows">
              {g.rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
