// A row of figures, each a small card: its label, its value, and a grey sentence about it when there is one.
import type { Block } from '@pneuma-base/kernel'
import { localMoments } from '../time'

type Stats = Extract<Block, { kind: 'stats' }>

export function StatsView({ block }: { block: Stats }) {
  return (
    <dl className="stats">
      {block.stats.map((stat, i) => {
        const note = stat.note === null ? null : localMoments(stat.note)
        return (
          <div key={`${stat.label}-${i}`} className="card stat">
            <dt className="stat-label">{stat.label}</dt>
            <dd className="stat-value">{stat.value}</dd>
            {note ? (
              <dd className="stat-note" title={note}>
                {note}
              </dd>
            ) : null}
          </div>
        )
      })}
    </dl>
  )
}
