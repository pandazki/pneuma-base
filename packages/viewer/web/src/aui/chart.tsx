// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Trend Chart (clean): a card with the sentence over the plot, three values
// up the side and three labels along the bottom, hairline grid, thin lines or bars rounded at the
// free end; hover, touch or the arrow keys mark one place and a small popover gives every series
// there. Bars may stack; each series takes the next colour of one palette (theme.css --series-n).
import type { Block } from '@pneuma-base/kernel'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

type Chart = Extract<Block, { kind: 'chart' }>

/** The plot's height in pixels; end labels closer than `LABEL_ROOM` pixels would overlap, so a legend is drawn instead. */
const PLOT_HEIGHT = 148
const LABEL_ROOM = 16

const color = (k: number) => `var(--series-${k + 1})`

/** A number as people read it: grouped digits, 万 from ten thousand. */
function figure(n: number): string {
  if (Math.abs(n) >= 10_000) return `${+(n / 10_000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}万`
  return Number.isInteger(n) ? n.toLocaleString('zh-CN') : (+n.toFixed(2)).toLocaleString('zh-CN')
}

/** The top of the axis: a value that halves cleanly, and to a whole number when every value is whole. */
function niceMax(max: number, whole: boolean): number {
  if (!(max > 0)) return whole ? 2 : 1
  const half = max / 2
  const pow = 10 ** Math.floor(Math.log10(half))
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * pow >= half) ?? 10
  const top = step * pow * 2
  return whole ? Math.max(2, Math.ceil(top / 2) * 2) : top
}

/** The scale: from zero, or from below it when a value is negative, to a round value above the highest. */
function scaleOf(block: Chart): { min: number; max: number } {
  const stacked = block.form === 'stacked'
  const tops = block.x.map((_, i) => (stacked ? block.series.reduce((n, s) => n + (s.values[i] ?? 0), 0) : Math.max(...block.series.map((s) => s.values[i] ?? 0))))
  const all = block.series.flatMap((s) => s.values)
  const whole = all.every((n) => Number.isInteger(n))
  const low = Math.min(0, ...all)
  const max = niceMax(Math.max(0, ...tops), whole)
  return { min: low < 0 ? -niceMax(-low, whole) : 0, max }
}

export function ChartView({ block }: { block: Chart }) {
  const count = block.x.length
  const bars = block.form !== 'line'
  const stacked = block.form === 'stacked'
  const { min, max } = scaleOf(block)
  const y = (v: number) => ((max - v) / (max - min || 1)) * 100
  const zero = y(0)
  const x = (i: number) => (bars ? ((i + 0.5) / Math.max(1, count)) * 100 : count > 1 ? (i / (count - 1)) * 100 : 50)
  const flat = block.series.every((s) => s.values.every((v) => v === 0))

  const [active, setActive] = useState<number | null>(null)
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, Math.round(i)))
  const indexAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / (box.width || 1)))
    return bars ? Math.min(count - 1, Math.floor(ratio * count)) : clamp(ratio * (count - 1))
  }
  const onKey = (e: KeyboardEvent) => {
    if (count === 0) return
    const from = active ?? (e.key === 'ArrowLeft' ? count : -1)
    const to = e.key === 'ArrowRight' ? Math.min(count - 1, from + 1) : e.key === 'ArrowLeft' ? Math.max(0, from - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : e.key === 'Escape' ? null : undefined
    if (to === undefined) return
    e.preventDefault()
    setActive(to)
  }

  // The popover keeps its last place while it fades, and slides back inside the card when its side has no room.
  const [shown, setShown] = useState(0)
  if (active !== null && active !== shown) setShown(active)
  const cur = Math.min(shown, Math.max(0, count - 1))
  const flip = x(cur) > 50
  const rootRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [nudge, setNudge] = useState(0)
  useLayoutEffect(() => {
    const root = rootRef.current
    const plot = plotRef.current
    const tip = tipRef.current
    if (!root || !plot || !tip) return
    const edge = root.getBoundingClientRect()
    const box = plot.getBoundingClientRect()
    const anchor = box.left + (x(cur) / 100) * box.width
    const left = flip ? anchor - 12 - tip.offsetWidth : anchor + 12
    const lo = edge.left + 8
    const hi = edge.right - 8 - tip.offsetWidth
    const next = Math.round(left < lo ? lo - left : left > hi ? Math.max(lo, hi) - left : 0)
    if (next !== nudge) setNudge(next)
  })

  // A line's name sits at its end when every end is clear of the next; otherwise the names go to a legend.
  const ends = block.series.map((s, k) => ({ k, label: s.label, at: y(s.values[count - 1] ?? 0) })).sort((a, b) => a.at - b.at)
  const room = (LABEL_ROOM / PLOT_HEIGHT) * 100
  const direct = !bars && block.series.length > 1 && count > 1 && ends.every((e, i) => i === 0 || e.at - (ends[i - 1] as (typeof ends)[number]).at >= room)
  const legend = block.series.length > 1 && !direct
  const unit = block.unit === '' ? '' : ` ${block.unit}`
  const value = (n: number) => `${figure(n)}${unit}`

  const slot = 100 / Math.max(1, count)
  const width = `min(${slot * (count > 24 ? 0.66 : 0.56)}%, 24px)`
  const each = bars && !stacked ? `calc(${width} / ${block.series.length})` : width

  return (
    <figure ref={rootRef} className="aui-chart" data-form={block.form} style={{ ['--aui-chart-h' as string]: `${PLOT_HEIGHT}px` }}>
      <figcaption className="aui-chart-caption">{block.text}</figcaption>
      {legend ? (
        <ul className="aui-chart-legend" aria-hidden>
          {block.series.map((s, k) => (
            <li key={k}>
              <span className="aui-chart-swatch" style={{ background: color(k) }} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="aui-chart-frame" data-ends={direct || undefined}>
        <div className="aui-chart-yaxis" aria-hidden>
          <span>{figure(max)}</span>
          <span>{figure((max + min) / 2)}</span>
          <span>{figure(min)}</span>
        </div>
        <div
          ref={plotRef}
          className="aui-chart-plot"
          tabIndex={0}
          role="group"
          aria-label={`${block.text}（用左右键逐个读数）`}
          onPointerMove={(e) => setActive(indexAt(e))}
          onPointerDown={(e) => setActive(indexAt(e))}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          <span className="aui-chart-grid" style={{ top: '0%' }} />
          <span className="aui-chart-grid" style={{ top: '50%' }} />
          <span className="aui-chart-grid" style={{ top: '100%' }} />
          {min < 0 ? <span className="aui-chart-grid" data-zero="" style={{ top: `${zero}%` }} /> : null}
          {flat ? <p className="aui-chart-empty">都是 0</p> : null}
          {bars ? (
            <div className="aui-chart-bars" aria-hidden>
              {block.x.map((_, i) => {
                let base = 0
                return block.series.map((s, k) => {
                  const v = s.values[i] ?? 0
                  if (v === 0) return null
                  const from = stacked ? base : 0
                  const to = from + v
                  if (stacked) base = to
                  // The topmost piece of a stack is the one rounded at its free end.
                  const top = !stacked || block.series.slice(k + 1).every((o) => (o.values[i] ?? 0) === 0)
                  const left = stacked ? `calc(${x(i)}% - ${width} / 2)` : `calc(${x(i)}% - ${width} / 2 + ${k} * ${each})`
                  return (
                    <span
                      key={`${k}-${i}`}
                      className="aui-chart-bar"
                      data-top={top || undefined}
                      data-neg={to < from || undefined}
                      data-dim={(active !== null && active !== i) || undefined}
                      data-stacked={(stacked && from > 0) || undefined}
                      style={{ left, width: each, top: `${y(Math.max(from, to))}%`, height: `${Math.abs(y(from) - y(to))}%`, background: color(k) }}
                    />
                  )
                })
              })}
            </div>
          ) : (
            <svg className="aui-chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              {block.series.map((s, k) => (
                <path key={k} d={s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('')} stroke={color(k)} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          )}
          {!bars && count === 1
            ? block.series.map((s, k) => <span key={k} className="aui-chart-point" style={{ left: '50%', top: `${y(s.values[0] ?? 0)}%`, background: color(k) }} aria-hidden />)
            : null}
          {!bars ? (
            <div className="aui-chart-marker" data-open={active !== null || undefined} aria-hidden>
              <span className="aui-chart-guide" style={{ left: `${x(cur)}%` }} />
              {block.series.map((s, k) => (
                <span key={k} className="aui-chart-dot" style={{ left: `${x(cur)}%`, top: `${y(s.values[cur] ?? 0)}%`, background: color(k) }} />
              ))}
            </div>
          ) : null}
          <div ref={tipRef} className="aui-chart-tip" data-open={active !== null || undefined} data-side={flip ? 'left' : 'right'} style={{ left: `${x(cur)}%`, ['--aui-chart-nudge' as string]: `${nudge}px` }} role="status" aria-live="polite">
            <p className="aui-chart-tip-head">{block.x[cur]}</p>
            <ul>
              {block.series.map((s, k) => (
                <li key={k}>
                  <span className="aui-chart-swatch" style={{ background: color(k) }} />
                  <span className="aui-chart-tip-label">{s.label}</span>
                  <span className="aui-chart-tip-num">{value(s.values[cur] ?? 0)}</span>
                </li>
              ))}
              {stacked && block.series.length > 1 ? (
                <li data-total="">
                  <span />
                  <span className="aui-chart-tip-label">合计</span>
                  <span className="aui-chart-tip-num">{value(block.series.reduce((n, s) => n + (s.values[cur] ?? 0), 0))}</span>
                </li>
              ) : null}
            </ul>
          </div>
        </div>
        {direct ? (
          <div className="aui-chart-ends" aria-hidden>
            <div className="aui-chart-ends-measure">
              {block.series.map((s, k) => (
                <span key={k}>{s.label}</span>
              ))}
            </div>
            {ends.map((e) => (
              <span key={e.k} style={{ top: `${e.at}%` }}>
                {e.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="aui-chart-xaxis" aria-hidden>
          {[0, Math.round(count / 2 - 0.5), count - 1]
            .filter((v, i, a) => v >= 0 && a.indexOf(v) === i)
            .map((i) => (
              <span key={i} style={{ left: `${x(i)}%` }} data-edge={!bars && count > 1 ? (i === 0 ? 'start' : i === count - 1 ? 'end' : undefined) : undefined}>
                {block.x[i]}
              </span>
            ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>{block.text}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {block.series.map((s, k) => (
              <th key={k} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.x.map((label, i) => (
            <tr key={i}>
              <th scope="row">{label}</th>
              {block.series.map((s, k) => (
                <td key={k}>{value(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
