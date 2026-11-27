// The foot of one page of a long list: which rows these are of how many, and the way to the pages
// before and after it. The page is in the address, so a reload or a pasted address opens the same
// one. The buttons are in the Tab order and answer Enter and Space; ← and → turn the page while the
// keyboard is on the foot.
import type { Paging } from '@pneuma-base/kernel'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useEnv } from '../env'

/** The range of rows a page shows and the whole list's count, in words: 51–100，共 523 项. */
export function rangeText(page: Paging): string {
  const last = page.first + page.shown - 1
  const range = page.shown === 0 ? '没有' : page.shown === 1 ? `第 ${page.first.toLocaleString()} 项` : `${page.first.toLocaleString()}–${last.toLocaleString()}`
  return `${range}，${page.atLeast ? '至少' : '共'} ${page.total.toLocaleString()} 项`
}

/** Whether a list has pages to turn to: one page that holds the whole list has none, and no foot. */
export const turns = (page: Paging | undefined): page is Paging => page !== undefined && (page.prev !== null || page.next !== null)

export function Pager({ page }: { page: Paging }) {
  const { onPage } = useEnv()
  if (!turns(page)) return null
  const turn = (to: Paging['prev']) => to && onPage(to)
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const to = e.key === 'ArrowLeft' ? page.prev : e.key === 'ArrowRight' ? page.next : undefined
    if (to === undefined) return
    e.preventDefault()
    turn(to)
  }
  return (
    <nav className="pager" aria-label="分页" onKeyDown={onKeyDown}>
      <span className="pager-range">{rangeText(page)}</span>
      <div className="pager-turns">
        <button type="button" className="icon-btn pager-turn" aria-label="上一页" aria-disabled={page.prev === null || undefined} onClick={() => turn(page.prev)}>
          <ChevronLeft strokeWidth={2} aria-hidden />
        </button>
        <button type="button" className="icon-btn pager-turn" aria-label="下一页" aria-disabled={page.next === null || undefined} onClick={() => turn(page.next)}>
          <ChevronRight strokeWidth={2} aria-hidden />
        </button>
      </div>
    </nav>
  )
}
