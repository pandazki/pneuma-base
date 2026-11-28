// The small pieces every block draws with: a moment, a tag, a cell, an action's button.
import type { Cell, Tag, Tone } from '@pneuma-base/kernel'
import { Check, Copy, FolderSearch } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { outsideUrl } from './api'
import { ActorBadge } from './pieces/actor'
import { ViewIcon } from './chrome'
import { useEnv } from './env'
import { ReopenButton } from './files'
import { cellFont, fitMiddle } from './measure'
import { IN_SHELL, tellShell } from './shell'
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

/** A mark of a state; why it is there, when the tag says, in its tooltip and as its description to a screen reader. */
export function TagView({ tag }: { tag: Tag }) {
  return (
    <span className={`tag ${TONE_CLASS[tag.tone]}`} data-tip={tag.tip} aria-description={tag.tip}>
      {tag.text}
    </span>
  )
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

/** In the Mac app, shows a path of this machine selected in Finder. */
function RevealButton({ path }: { path: string }) {
  if (!IN_SHELL) return null
  return (
    <button
      type="button"
      className="copy"
      aria-label="在访达中显示"
      data-tip="在访达中显示"
      onClick={(e) => {
        e.stopPropagation()
        tellShell({ type: 'reveal-local', path })
      }}
    >
      <FolderSearch strokeWidth={2} aria-hidden />
    </button>
  )
}

/** A path of this machine by its last part, the whole of it in the tooltip and to a screen reader, with a way to copy it and, in the Mac app, to show it in Finder. */
function LocalPath({ cell }: { cell: Cell }) {
  const path = cell.text.replace(/\/+$/, '')
  const last = path.slice(path.lastIndexOf('/') + 1) || cell.text
  return (
    <span className="cell">
      {cell.icon ? <ViewIcon name={cell.icon} /> : null}
      <span className={`min-w-0 truncate ${cell.muted ? 'text-ink-2' : ''}`} data-tip={cell.text}>
        <span className="sr-only">{cell.text}</span>
        <span aria-hidden>{last}</span>
      </span>
      <CopyButton value={cell.text} />
      <RevealButton path={cell.text} />
      {cell.tag ? <TagView tag={cell.tag} /> : null}
    </span>
  )
}

/**
 * One cell. In a table it stays on one line, its text cut short with the whole of it on hover; elsewhere
 * it wraps. On one line and given `room`, its text is cut in the middle to fit. An outside address is a
 * link to a new tab. Muted text is one step quieter than the text around it. A cell that says who
 * starts with the mark. A path of this machine shows its last part.
 */
export function CellView({ cell, line = false, first = false, room }: { cell: Cell; line?: boolean; first?: boolean; room?: number }) {
  const { onLink } = useEnv()
  if (cell.local) return <LocalPath cell={cell} />
  const style = `${cell.mono ? 'font-mono text-[12.5px]' : ''} ${cell.muted ? (line ? 'text-ink-3' : 'text-ink-2') : ''}`
  const href = outsideUrl(cell.href)
  const middle = line && room !== undefined
  const fit = (text: string) => (middle ? fitMiddle(text, cellFont(cell, first), room) : text)
  const fitted = fit(cell.text)
  // In a table a cell that says who is the mark alone, its name in the tooltip: the marks tell the agents apart.
  const markOnly = line && cell.actor !== undefined
  const words = markOnly ? '' : cell.text === '' && cell.actor ? cell.actor.name : cell.text
  // On one line, a path-like text is cut in its folders, so its last part stays readable, unless it is cut in the middle.
  const cut = line && cell.mono && !middle ? words.lastIndexOf('/') : -1
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
  ) : middle && fit(words) !== words ? (
    <span className={`${style} min-w-0 overflow-hidden whitespace-nowrap`}>
      <span className="sr-only">{words}</span>
      <span aria-hidden>{fit(words)}</span>
    </span>
  ) : (
    <span className={`${style} min-w-0 ${line ? 'truncate' : '[overflow-wrap:anywhere]'}`}>{words}</span>
  )
  const content = (
    <span className="cell" data-line={line || undefined} title={line && words !== '' && !cell.at ? words : undefined}>
      {cell.actor ? markOnly ? <ActorBadge actor={cell.actor} titled /> : <ActorBadge actor={cell.actor} /> : null}
      {cell.icon ? <ViewIcon name={cell.icon} /> : null}
      {text}
      {cell.copy ? <CopyButton value={href ?? cell.text} /> : null}
      {cell.tag ? <TagView tag={cell.tag} /> : null}
      {cell.reopen ? <ReopenButton reopen={cell.reopen} /> : null}
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
