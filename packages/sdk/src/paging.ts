// Pages of a long list. Storage and rows list forward from a cursor and never back, so a page's place
// is the cursor it starts after (`after`) and the cursors of the pages before it (`back`); both are
// parameters of the view, so the page is in the address and its links say where the pages around it
// start. Two lists on one view page apart under their own `name`, which prefixes both parameters.
import type { Link, Paging, ViewRequest } from './types.js'

/** How many rows a page of a long list holds on the management UI's page. */
export const PAGE_ROWS = 50
/** How many rows the text form of a page shows of a long list before the command for more. */
export const TEXT_ROWS = 20
const MOST_ROWS = 1000

/** Where a page stands in its view's parameters: the cursor it starts after, none on the first page, and those of the pages before it. */
export type PageAt = { after: string | undefined; back: string[] }

/** The rows a page holds, as the face asked: `PAGE_ROWS` unless it asked for another number. */
export const rowsOf = (req: Pick<ViewRequest, 'size'>): number => (req.size !== undefined && Number.isInteger(req.size) && req.size > 0 ? Math.min(req.size, MOST_ROWS) : PAGE_ROWS)

/** A cursor list written as `back`: a JSON list of strings, else none. */
function cursors(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string') ? parsed : []
  } catch {
    return []
  }
}

/** Where the page of the list `name` the parameters name stands. */
export function pageAt(params: Record<string, string>, name = ''): PageAt {
  const given = params[`${name}after`]
  const after = given === undefined || given === '' ? undefined : given
  return { after, back: after === undefined ? [] : cursors(params[`${name}back`]) }
}

/** The view's parameters for the page of the list `name` starting after `after`, with the pages before it. */
function paramsAt(params: Record<string, string>, name: string, after: string | undefined, back: readonly string[]): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(params).filter(([key]) => key !== `${name}after` && key !== `${name}back`))
  return { ...rest, ...(after === undefined ? {} : { [`${name}after`]: after }), ...(back.length === 0 ? {} : { [`${name}back`]: JSON.stringify(back) }) }
}

export type PageOf = {
  view: string
  params: Record<string, string>
  /** How many rows a page holds, and how many this one shows. */
  rows: number
  shown: number
  /** The cursor a listing gave for what follows this page; null when nothing does. */
  next: string | null
  /** How many rows the whole list has, or at least has. */
  total: number
  atLeast?: boolean
  target?: Link['target']
  name?: string
}

/** The paging of one page of a long list: where it starts, of how many, and the links to the pages before and after it. */
export function pagingOf(p: PageOf): Paging {
  const name = p.name ?? ''
  const at = pageAt(p.params, name)
  const before = at.back.length + (at.after === undefined ? 0 : 1)
  const link = (after: string | undefined, back: readonly string[]): Link => ({ view: p.view, params: paramsAt(p.params, name, after, back), target: p.target ?? 'main' })
  const first = before * p.rows + 1
  return {
    first,
    shown: p.shown,
    total: Math.max(p.total, first - 1 + p.shown),
    ...(p.atLeast ? { atLeast: true as const } : {}),
    prev: at.after === undefined ? null : link(at.back.at(-1), at.back.slice(0, -1)),
    next: p.next === null ? null : link(p.next, at.after === undefined ? [] : [...at.back, at.after]),
  }
}

/** One page of a list held whole, by position: its rows and the cursor of what follows, null at the end. */
export function pageOfList<T>(items: readonly T[], params: Record<string, string>, rows: number, name = ''): { rows: T[]; next: string | null } {
  const { after } = pageAt(params, name)
  const start = after === undefined ? 0 : Math.max(0, Number.parseInt(after, 10) || 0)
  return { rows: items.slice(start, start + rows), next: start + rows < items.length ? String(start + rows) : null }
}
