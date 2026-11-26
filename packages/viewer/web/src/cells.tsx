// The small pieces every block draws with: a moment, a tag, a cell, an action's button.
import type { Action, Cell, Tag, Tone } from '@pneuma-base/kernel'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { outsideUrl } from './api'
import { ActorBadge } from './pieces/actor'
import { ViewIcon } from './chrome'
import { useEnv } from './env'
import { cellFont, fitMiddle } from './measure'
import { fullTime, shortTime, useNow } from './time'

/** A moment in the viewer's local time, short and relative for the recent past, the whole of it on hover. */
export function Moment({ at, format = shortTime }: { at: string; format?: (iso: string, now: Date) => string }) {
  const now = useNow()
  return (
    <time dateTime={at} title={fullTime(at)} className="tabular-nums">
      {format(at, now)}
    </time>
  )
}

const TONE_CLASS: Record<Tone, string> = { neutral: '', good: 'tone-good', warn: 'tone-warn', bad: 'tone-bad', info: 'tone-info' }

export function TagView({ tag }: { tag: Tag }) {
  return <span className={`tag ${TONE_CLASS[tag.tone]}`}>{tag.text}</span>
}

export const stop = (e: MouseEvent) => e.stopPropagation()
/** Whether a click asks for a tab of its own: ⌘ or Ctrl held, or the middle button. */
export const wantsTab = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey || ('button' in e && e.button === 1)

/** Copies `value`, and says so for a moment. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const Icon = copied ? Check : Copy
  return (
    <button
      type="button"
      className="copy"
      data-done={copied || undefined}
      aria-label={copied ? '已复制' : '复制'}
      data-tip={copied ? '已复制' : '复制'}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(value).then(() => setCopied(true), () => undefined)
      }}
    >
      <Icon strokeWidth={2} aria-hidden />
    </button>
  )
}

/**
 * One cell. In a table it stays on one line, its text cut short with the whole of it on hover; elsewhere
 * it wraps. An outside address is a link to a new tab; given `room`, it is cut in the middle to fit.
 * Muted text is one step quieter than the text around it. A cell that says who starts with the mark.
 */
export function CellView({ cell, line = false, first = false, room }: { cell: Cell; line?: boolean; first?: boolean; room?: number }) {
  const { onLink } = useEnv()
  const style = `${cell.mono ? 'font-mono text-[12.5px]' : ''} ${cell.muted ? (line ? 'text-ink-3' : 'text-ink-2') : ''}`
  const href = outsideUrl(cell.href)
  const fitted = href && line && room !== undefined ? fitMiddle(cell.text, cellFont(cell, first), room) : cell.text
  const words = cell.text === '' && cell.actor ? cell.actor.name : cell.text
  // On one line, a path-like text is cut in its folders, so its last part stays readable.
  const cut = line && cell.mono ? words.lastIndexOf('/') : -1
  const text = cell.at ? (
    <span className={`${style} ${line ? 'min-w-0 truncate' : ''}`}>
      <Moment at={cell.at} />
    </span>
  ) : words === '' ? null : href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`link ${style} min-w-0 ${line ? 'overflow-hidden whitespace-nowrap' : '[overflow-wrap:anywhere]'}`}
      title={cell.text}
      aria-label={fitted !== cell.text ? cell.text : undefined}
      onClick={stop}
    >
      {fitted}
    </a>
  ) : cut > 0 && cut < words.length - 1 ? (
    <span className={`flex min-w-0 ${style}`}>
      <span className="sr-only">{words}</span>
      <span className="min-w-0 truncate" aria-hidden>
        {words.slice(0, cut + 1)}
      </span>
      <span className="max-w-full shrink-0 truncate" aria-hidden>
        {words.slice(cut + 1)}
      </span>
    </span>
  ) : (
    <span className={`${style} min-w-0 ${line ? 'truncate' : '[overflow-wrap:anywhere]'}`}>{words}</span>
  )
  const content = (
    <span className="cell" data-line={line || undefined} title={line && words !== '' && !cell.at ? words : undefined}>
      {cell.actor ? <ActorBadge actor={cell.actor} /> : null}
      {cell.icon ? <ViewIcon name={cell.icon} /> : null}
      {text}
      {cell.copy ? <CopyButton value={href ?? cell.text} /> : null}
      {cell.tag ? <TagView tag={cell.tag} /> : null}
    </span>
  )
  if (!cell.link || href) return content
  const link = cell.link
  return (
    <button
      type="button"
      className={`link ${line ? 'block max-w-full' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onLink(link, wantsTab(e))
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.stopPropagation()
        onLink(link, true)
      }}
    >
      {content}
    </button>
  )
}

export function ActionButton({ action, small = false }: { action: Action; small?: boolean }) {
  const { onAction } = useEnv()
  return (
    <button
      type="button"
      className={`btn ${small ? 'btn-sm' : ''} ${action.tone === 'danger' ? 'btn-danger' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        void onAction(action)
      }}
    >
      {action.label}
    </button>
  )
}
