// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Stat Card (clean): a label, the figure large with tabular digits, and a grey line under it.
import type { Block } from '@pneuma-base/kernel'
import { localMoments } from '../time'

type Stats = Extract<Block, { kind: 'stats' }>

/** A row of figures, as many to a line as fit, each a card of its own. */
export function StatsView({ block }: { block: Stats }) {
  return (
    <dl className="aui-stats">
      {block.stats.map((s, i) => (
        <div key={`${s.label}-${i}`} className="aui-stat">
          <dt className="aui-stat-label">{s.label}</dt>
          <dd className="aui-stat-value">{s.value}</dd>
          {s.note !== null ? (
            <dd className="aui-stat-note" title={s.note}>
              {localMoments(s.note)}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}
