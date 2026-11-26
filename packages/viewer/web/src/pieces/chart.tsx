// A few numbers over time, as bars side by side, bars stacked, or lines, under the one sentence that
// says what they show. Each series takes the next of the theme's four colours. A legend names them
// when there are two or more, unless every line has room for its name at its end. Pointing at a
// place, or moving to it with ← → Home End, shows each series' value there with the unit, and a
// stack's total; screen readers get the same numbers as a table. No place, or no value but zero,
// leaves the sentence alone: there is no shape to draw.
import type { Block } from '@pneuma-base/kernel'
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { useWidth } from '../blocks'
import { pageFonts, textWidth } from '../measure'

type Chart = Extract<Block, { kind: 'chart' }>

/** The plot's height, the room above it for the top value's label, and below it for the places' labels. */
const PLOT = 148
const TOP = 8
const BELOW = 22
const HEIGHT = TOP + PLOT + BELOW
/** The widest a bar or a stack gets, however few places there are. */
const BAR = 24

const colour = (j: number) => `var(--series-${j + 1})`
const say = (v: number) => String(Number(v.toFixed(2)))
const withUnit = (v: number, unit: string) => (unit === '' ? say(v) : `${say(v)} ${unit}`)

/** The smallest of 1, 2, 2.5, 3, 4, 5, 6, 8 times a power of ten that is at least `raw`. */
function roundUp(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * power >= raw - 1e-9) ?? 10) * power
}

/** The values the gridlines stand at: from at most 0 to at least `hi`, in two or so even steps, whole steps for whole numbers. */
function ticksOf(lo: number, hi: number, whole: boolean): number[] {
  const step = Math.max(whole ? 1 : 0, roundUp((hi - lo) / 2))
  const from = Math.floor(lo / step) * step
  const to = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let t = from; t <= to + step / 2; t += step) ticks.push(t)
  return ticks
}

/** Which places name themselves under the plot: the first, the middle and the last. */
const labelled = (n: number) => [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0)

const hasShape = (b: Chart) => b.x.length > 0 && b.series.some((s) => s.values.some((v) => v !== 0))

export function ChartView({ block }: { block: Chart }) {
  if (!hasShape(block)) {
    return (
      <p className="note">
        <span>{block.text}</span>
      </p>
    )
  }
  return (
    <figure className="card chart-card">
      <figcaption className="chart-text">{block.text}</figcaption>
      <Plot block={block} />
      <table className="sr-only">
        <thead>
          <tr>
            <td />
            {block.series.map((s) => (
              <th key={s.label} scope="col">
                {block.unit === '' ? s.label : `${s.label}（${block.unit}）`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.x.map((label, i) => (
            <tr key={`${label}-${i}`}>
              <th scope="row">{label}</th>
              {block.series.map((s) => (
                <td key={s.label}>{say(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function Plot({ block }: { block: Chart }) {
  const [measure, width] = useWidth()
  const [at, setAt] = useState<number | null>(null)
  const { form, x, series, unit } = block
  const n = x.length
  const value = (j: number, i: number) => series[j]?.values[i] ?? 0
  const totals = x.map((_, i) => series.reduce((sum, _s, j) => sum + value(j, i), 0))
  const all = series.flatMap((s) => s.values)
  const hi = form === 'stacked' ? Math.max(0, ...totals) : Math.max(0, ...all)
  const lo = form === 'stacked' ? 0 : Math.min(0, ...all)
  const ticks = ticksOf(lo, hi, all.every(Number.isInteger))
  const bottom = ticks[0] as number
  const top = ticks.at(-1) as number
  const y = (v: number) => TOP + PLOT * (1 - (v - bottom) / (top - bottom || 1))

  const small = pageFonts().small
  const left = Math.ceil(Math.max(...ticks.map((t) => textWidth(say(t), small)))) + 8
  // A line's name at its end, where the names fit one under another and leave the plot most of the width.
  const ends = form === 'line' && series.length > 1 ? series.map((s, j) => ({ label: s.label, j, y: y(value(j, n - 1)) })).sort((a, b) => a.y - b.y) : []
  const endRoom = ends.length > 0 ? Math.ceil(Math.max(...ends.map((e) => textWidth(e.label, small)))) + 10 : 0
  const named = ends.length > 0 && endRoom <= width * 0.3 && ends.every((e, k) => k === 0 || e.y - (ends[k - 1] as { y: number }).y >= 14)
  const right = named ? endRoom : 4
  const span = Math.max(0, width - left - right)
  const slot = span / n
  // Bars stand in the middle of their place; a line's points run from one edge of the plot to the other.
  const xAt = (i: number) => (form === 'line' ? left + (n === 1 ? span / 2 : (span * i) / (n - 1)) : left + slot * (i + 0.5))
  const placeAt = (px: number) => Math.min(n - 1, Math.max(0, form === 'line' && n > 1 ? Math.round(((px - left) / span) * (n - 1)) : Math.floor((px - left) / slot)))

  const onKeyDown = (e: KeyboardEvent) => {
    const to = e.key === 'ArrowRight' ? Math.min(n - 1, (at ?? -1) + 1) : e.key === 'ArrowLeft' ? Math.max(0, (at ?? n) - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (e.key === 'Escape') setAt(null)
    if (to === null) return
    e.preventDefault()
    setAt(to)
  }
  const onPointerMove = (e: PointerEvent) => setAt(placeAt(e.clientX - e.currentTarget.getBoundingClientRect().left))

  const legend = series.length > 1 && !named
  return (
    <>
      {legend ? (
        <div className="chart-legend" aria-hidden>
          {series.map((s, j) => (
            <span key={s.label}>
              <i style={{ background: colour(j) }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={measure} className="chart" role="group" aria-label={block.text} tabIndex={0} onKeyDown={onKeyDown} onPointerMove={onPointerMove} onPointerLeave={() => setAt(null)} onBlur={() => setAt(null)}>
        {width > 0 ? (
          <svg width={width} height={HEIGHT} aria-hidden>
            {at !== null && form !== 'line' ? <rect className="chart-hover" x={left + slot * at} y={TOP} width={slot} height={PLOT} rx={4} /> : null}
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={left} x2={width - right} y1={y(t)} y2={y(t)} />
                <text className="chart-axis" x={0} y={y(t) + 4}>
                  {say(t)}
                </text>
              </g>
            ))}
            {form === 'line' ? <Lines series={series.map((s) => s.values)} xAt={xAt} y={y} at={at} /> : <Bars form={form} values={value} count={series.length} n={n} xAt={xAt} slot={slot} y={y} />}
            {named
              ? ends.map((e) => (
                  <text key={e.label} className="chart-end" x={xAt(n - 1) + 8} y={e.y + 4}>
                    {e.label}
                  </text>
                ))
              : null}
            {labelled(n).map((i, k, list) => {
              const anchor = list.length > 1 && k === 0 ? 'start' : k === list.length - 1 && list.length > 1 ? 'end' : 'middle'
              const edge = form === 'line' ? xAt(i) : anchor === 'start' ? left + slot * i : anchor === 'end' ? left + slot * (i + 1) : xAt(i)
              return (
                <text key={i} className="chart-axis" x={edge} y={TOP + PLOT + 16} textAnchor={anchor}>
                  {x[i]}
                </text>
              )
            })}
          </svg>
        ) : null}
        {at !== null && width > 0 ? (
          <div role="status" className="chart-tip" style={tipPlace(xAt(at), width)}>
            <p className="chart-tip-head">{x[at]}</p>
            {series.map((s, j) => (
              <p key={s.label} className="chart-tip-row">
                <i style={{ background: colour(j) }} />
                <span className="chart-tip-label">{s.label}</span>
                <span className="chart-tip-value">{withUnit(value(j, at), unit)}</span>
              </p>
            ))}
            {form === 'stacked' && series.length > 1 ? (
              <p className="chart-tip-row chart-tip-total">
                <span className="chart-tip-label">合计</span>
                <span className="chart-tip-value">{withUnit(totals[at] ?? 0, unit)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}

/** The tip beside the place it tells about: to its right in the left third of the chart, else to its left. */
const tipPlace = (px: number, width: number): CSSProperties => (px < width / 3 ? { left: px + 12 } : { right: width - px + 12 })

function Bars({ form, values, count, n, xAt, slot, y }: { form: 'bars' | 'stacked'; values(j: number, i: number): number; count: number; n: number; xAt(i: number): number; slot: number; y(v: number): number }) {
  const rects: { key: string; x: number; top: number; bottom: number; width: number; j: number }[] = []
  for (let i = 0; i < n; i++) {
    if (form === 'stacked') {
      const width = Math.min(BAR, slot * 0.6)
      let base = 0
      for (let j = 0; j < count; j++) {
        const v = values(j, i)
        if (v <= 0) continue
        // A hairline of the card's ground between one part of a stack and the part under it.
        rects.push({ key: `${i}-${j}`, x: xAt(i) - width / 2, top: y(base + v), bottom: y(base) - (base > 0 ? 1 : 0), width, j })
        base += v
      }
    } else {
      const group = Math.min(BAR * count, slot * 0.7)
      const width = (group - (count - 1) * 2) / count
      for (let j = 0; j < count; j++) {
        const v = values(j, i)
        if (v === 0) continue
        rects.push({ key: `${i}-${j}`, x: xAt(i) - group / 2 + j * (width + 2), top: y(Math.max(v, 0)), bottom: y(Math.min(v, 0)), width, j })
      }
    }
  }
  return (
    <g>
      {rects.map((r) => (
        <rect key={r.key} x={r.x} y={r.top} width={Math.max(1, r.width)} height={Math.max(1, r.bottom - r.top)} rx={1.5} style={{ fill: colour(r.j) }} />
      ))}
    </g>
  )
}

function Lines({ series, xAt, y, at }: { series: number[][]; xAt(i: number): number; y(v: number): number; at: number | null }) {
  return (
    <g>
      {at !== null ? <line className="chart-rule" x1={xAt(at)} x2={xAt(at)} y1={TOP} y2={TOP + PLOT} /> : null}
      {series.map((values, j) => (
        <path key={j} className="chart-line" d={values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)} ${y(v)}`).join(' ')} style={{ stroke: colour(j) }} />
      ))}
      {/* One place makes no line: its points stand alone. */}
      {at !== null || series[0]?.length === 1 ? series.map((values, j) => <circle key={j} className="chart-dot" cx={xAt(at ?? 0)} cy={y(values[at ?? 0] ?? 0)} r={3.5} style={{ fill: colour(j) }} />) : null}
    </g>
  )
}
