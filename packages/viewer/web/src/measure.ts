// How wide texts and table columns are. A column gets its natural width when the table has room;
// when it has not, prose gives way before paths, and short columns never shrink.
import type { Block, Cell } from '@pneuma-base/kernel'
import { shortTime } from './time'

type Table = Extract<Block, { kind: 'table' }>

type Fonts = { cell: string; first: string; mono: string; monoFirst: string; small: string; head: string }
let fonts: Fonts | null = null
/**
 * The fonts the page's CSS sets, in its font stacks (the Mac app's are the system's): a table's
 * first column 500 13px, its other cells 400 13px, monospaced 12.5px at the same weights, headers,
 * tags and small buttons 500 12px. Read once the page's styles apply.
 */
export function pageFonts(): Fonts {
  if (fonts) return fonts
  const style = getComputedStyle(document.documentElement)
  const sans = style.getPropertyValue('--font-sans').trim() || 'ui-sans-serif, system-ui, sans-serif'
  const mono = style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'
  fonts = { cell: `400 13px ${sans}`, first: `500 13px ${sans}`, mono: `400 12.5px ${mono}`, monoFirst: `500 12.5px ${mono}`, small: `500 12px ${sans}`, head: `500 12px ${sans}` }
  return fonts
}

/** The font of a cell's text, in the first column or another. */
export const cellFont = (cell: Cell, first: boolean) => (cell.mono ? (first ? pageFonts().monoFirst : pageFonts().mono) : first ? pageFonts().first : pageFonts().cell)

let canvas: CanvasRenderingContext2D | null = null
export function textWidth(text: string, font: string): number {
  canvas ??= document.createElement('canvas').getContext('2d')
  if (!canvas) return [...text].length * 8
  canvas.font = font
  return canvas.measureText(text).width
}

/** The text with its start cut away, after a …, until it fits `width`. Paths keep their last parts this way. */
export function fitStart(text: string, font: string, width: number): string {
  if (textWidth(text, font) <= width) return text
  const chars = [...text]
  let from = 1
  while (from < chars.length - 1 && textWidth(`…${chars.slice(from).join('')}`, font) > width) from++
  return `…${chars.slice(from).join('')}`
}

/** The text with its middle cut away, at a …, until it fits `width`: both ends of an address stay readable. */
export function fitMiddle(text: string, font: string, width: number): string {
  if (textWidth(text, font) <= width) return text
  const chars = [...text]
  const cut = (keep: number) => `${chars.slice(0, Math.ceil(keep / 2)).join('')}…${chars.slice(chars.length - Math.floor(keep / 2)).join('')}`
  let [low, high] = [0, chars.length - 1]
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (textWidth(cut(mid), font) <= width) low = mid
    else high = mid - 1
  }
  return cut(low)
}

const ICON = 16
const GAP = 8
const TAG_PADDING = 12 // a tag's 6px each side
const COPY = 20 // the copy button
const PADDING = 24 // a cell's 12px each side
const FIRST_PADDING = 28 // the first cell's 16px on the left
const BUTTON_PADDING = 16 // a small button's 8px each side
const SLACK = 4 // rounding and font fallback

/** What a cell draws besides its text: its icon, its tag and its copy button, with their gaps. */
function extras(cell: Cell, text: boolean): number {
  let w = cell.icon ? ICON + (text ? GAP : 0) : 0
  if (cell.copy) w += (text || w > 0 ? GAP : 0) + COPY
  if (cell.tag) w += (text || w > 0 ? GAP : 0) + textWidth(cell.tag.text, pageFonts().small) + TAG_PADDING
  return w
}

/** How wide the text of a cell may be in a column `width` wide, the first column with its wider padding. */
export function textRoom(cell: Cell, width: number, first: boolean): number {
  return width - (first ? FIRST_PADDING : PADDING) - extras(cell, true)
}

let probe: HTMLSpanElement | null = null
/**
 * A moment's width as the page draws it, with tabular figures. A canvas cannot be asked for those,
 * and proportional figures are narrower: 11:11 would be cut short. Every figure is as wide as 0, so
 * a text is measured by its shape.
 */
function momentWidth(text: string, font: string, seen: Map<string, number>): number {
  const shape = text.replace(/\d/g, '0')
  const known = seen.get(shape)
  if (known !== undefined) return known
  if (!probe) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', top: '0', left: '0' })
    document.body.append(probe)
  }
  probe.style.font = font
  probe.style.fontVariantNumeric = 'tabular-nums'
  probe.textContent = shape
  const width = probe.getBoundingClientRect().width
  seen.set(shape, width)
  return width
}

function cellWidth(cell: Cell, first: boolean, moments: Map<string, number>): number {
  const text = cell.at ? shortTime(cell.at) : cell.text
  const font = cellFont(cell, first)
  const w = text === '' ? 0 : cell.at ? momentWidth(text, font, moments) : textWidth(text, font)
  return w + extras(cell, text !== '')
}

/** How a column may give: prose and paths down to a minimum, prose first; anything else not at all. */
type Give = 'text' | 'mono' | 'fixed'
export type Column = { natural: number; give: Give; optional: boolean }

/** The narrowest a shrinking column gets: a path keeps more, as it loses its meaning faster when cut. */
const MIN: Record<Exclude<Give, 'fixed'>, number> = { text: 120, mono: 180 }

/** Each column's natural width and how it may give, the actions column last when there is one. */
export function naturalColumns(block: Table, withActions: boolean): Column[] {
  // Measured anew each time: the fonts may have come in since.
  const moments = new Map<string, number>()
  const columns = block.columns.map((c, i): Column => {
    const cells = block.rows.flatMap((r) => r.cells[c.key] ?? [])
    const content = Math.max(textWidth(c.label, pageFonts().head), ...cells.map((cell) => cellWidth(cell, i === 0, moments)))
    const natural = Math.ceil(content) + SLACK + (i === 0 ? FIRST_PADDING : PADDING)
    const give: Give = cells.some((cell) => cell.mono && cell.text !== '') ? 'mono' : cells.some((cell) => cell.text !== '' && !cell.at) ? 'text' : 'fixed'
    return { natural, give, optional: c.optional === true }
  })
  if (!withActions) return columns
  const buttons = Math.max(0, ...block.rows.map((r) => r.actions.reduce((sum, a, i) => sum + textWidth(a.label, pageFonts().small) + BUTTON_PADDING + (i > 0 ? GAP : 0), 0)))
  return [...columns, { natural: Math.ceil(buttons) + SLACK + PADDING, give: 'fixed', optional: false }]
}

/**
 * The columns' widths in `available` pixels, `null` for a column left out. While the columns shown
 * do not fit whole, optional ones step aside, the last one first; only then is anything cut.
 */
export function fitColumns(columns: Column[], available: number): (number | null)[] {
  const shown = columns.map(() => true)
  const whole = () => columns.reduce((sum, c, i) => sum + (shown[i] ? c.natural : 0), 0)
  while (whole() > available) {
    const last = columns.findLastIndex((c, i) => shown[i] && c.optional)
    if (last < 0) break
    shown[last] = false
  }
  const widths = fit(columns.filter((_, i) => shown[i]), available)
  let next = 0
  return columns.map((_, i) => (shown[i] ? (widths[next++] ?? 0) : null))
}

/**
 * The widths of columns all shown. Too wide: prose shrinks toward its minimum, then paths, each in
 * proportion to what it can give. Room to spare goes to the widest column of prose or paths, as a
 * name column takes it in a file manager, so the table fills its card.
 */
function fit(columns: Column[], available: number): number[] {
  const widths = columns.map((c) => c.natural)
  let excess = widths.reduce((a, b) => a + b, 0) - available
  for (const give of ['text', 'mono'] as const) {
    if (excess <= 0) break
    const room = columns.map((c, i) => (c.give === give ? Math.max(0, (widths[i] ?? 0) - MIN[give]) : 0))
    const total = room.reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const take = Math.min(excess, total)
    room.forEach((r, i) => (widths[i] = (widths[i] ?? 0) - (take * r) / total))
    excess -= take
  }
  if (excess < 0 && columns.length > 0) {
    const candidates = columns.map((c, i) => ({ i, w: c.give === 'fixed' ? -1 : c.natural }))
    const widest = candidates.reduce((best, c) => (c.w > best.w ? c : best)).i
    const at = (columns[widest]?.give ?? 'fixed') === 'fixed' ? 0 : widest
    widths[at] = (widths[at] ?? 0) - excess
  }
  return widths.map((w) => Math.floor(w))
}
