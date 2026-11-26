// The command palette, ⌘K or the sidebar's search field. With nothing typed it lists the pages to go
// to and the actions of the page on screen; typed text finds in the library through the same call a
// button makes, the agent face's `find`, read-only, and lists the hits grouped as find answers them.
import type { Action, Block, Call, FindResult, Hit, LibraryPath, Link, ListedView } from '@pneuma-base/kernel'
import { File, LoaderCircle, Play, Search } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api } from './api'
import { Layer, ViewIcon } from './chrome'
import { Kbd } from './controls'
import { localMoments } from './time'

/** A found thing: its path or title, the kernel's marks (目录, 已归档), what plugins said of it. */
export type Found = { key: string; path: LibraryPath | null; marks: string[]; details: string[]; group: string | null }
/** Found things under a heading; `about` says what the group is, from its entries without a path. */
export type FoundGroup = { heading: string | null; about: string[]; items: Found[] }

/**
 * The hits as `pneuma-base find` prints them: one entry per path, or per title without one; the
 * kernel's details are marks, a plugin's are details; entries sharing a group sit under it at the
 * first one's place, and an entry of a group without a path says what the group is.
 */
export function groupFound(hits: Hit[]): FoundGroup[] {
  const entries = new Map<string, Found>()
  for (const h of hits) {
    const key = h.path ?? h.title
    const entry = entries.get(key) ?? { key, path: h.path, marks: [], details: [], group: null }
    entries.set(key, entry)
    entry.group ??= h.group
    if (h.detail !== null) (h.by === 'kernel' ? entry.marks : entry.details).push(h.detail)
  }
  const groups: FoundGroup[] = []
  const byHeading = new Map<string | null, FoundGroup>()
  for (const e of entries.values()) {
    let g = byHeading.get(e.group)
    if (!g) {
      g = { heading: e.group, about: [], items: [] }
      byHeading.set(e.group, g)
      groups.push(g)
    }
    if (e.path !== null) g.items.push(e)
    else if (e.group === null) g.about.push([e.key, ...e.details].join(' · '))
    else if (e.details.length > 0) g.about.push(e.details.join(' · '))
  }
  return groups
}

/** The actions a page offers for itself: its action rows and its sections' buttons, not a row's or an entry's. */
export function pageActions(blocks: Block[]): Action[] {
  const all = blocks.flatMap((b): Action[] => (b.kind === 'actions' ? b.actions : b.kind === 'section' ? [...b.actions, ...pageActions(b.blocks)] : []))
  return all.filter((a, i) => all.findIndex((o) => o.label === a.label) === i)
}

type Entry = { id: string; icon: ReactNode; name: string; hint?: string; choose(): void }
type Group = { label: string; about: string[]; entries: Entry[] }

/** How long typing pauses before the library is asked. */
const TYPE_MS = 120

type Props = {
  leaving: boolean
  views: ListedView[]
  /** A group's label by plugin: the cognition's title, else the name. */
  groupOf(view: ListedView): string | null
  actions: Action[]
  onClose(): void
  onPage(view: string): void
  onOpen(link: Link): void
  onAction(action: Action): void
}

export function Palette({ leaving, views, groupOf, actions, onClose, onPage, onOpen, onAction }: Props) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<{ text: string; result: FindResult | null; failed: boolean } | null>(null)
  const [active, setActive] = useState(0)
  const ids = useId()
  const input = useRef<HTMLInputElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  const pill = useRef<HTMLSpanElement | null>(null)
  const [listHeight, setListHeight] = useState<number | undefined>(undefined)
  const query = text.trim()

  useEffect(() => input.current?.focus(), [])

  // Ask the library after a short pause; an answer to an older text is dropped.
  useEffect(() => {
    if (query === '') return
    let live = true
    const timer = window.setTimeout(() => {
      const call = { face: 'agent', verb: 'find', request: { text: query, match: 'terms', filters: {}, includeArchived: false, skipOwnSession: false } } as Call
      api.call(call, false).then(
        (reply) => live && setFound({ text: query, result: reply.result as FindResult, failed: false }),
        () => live && setFound({ text: query, result: null, failed: true }),
      )
    }, TYPE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query])

  const groups = useMemo((): Group[] => {
    const close = (then: () => void) => () => {
      onClose()
      then()
    }
    const lower = query.toLowerCase()
    const pages: Entry[] = views
      .filter((v) => v.nav && (lower === '' || v.title.toLowerCase().includes(lower)))
      .map((v) => ({ id: `page-${v.id}`, icon: <ViewIcon name={v.icon} />, name: v.title, hint: groupOf(v) ?? undefined, choose: close(() => onPage(v.id)) }))
    const own: Entry[] = actions
      .filter((a) => lower === '' || a.label.toLowerCase().includes(lower))
      .map((a, i) => ({ id: `action-${i}`, icon: <Play />, name: a.label, choose: close(() => onAction(a)) }))
    const local: Group[] = [
      { label: '前往', about: [], entries: pages },
      { label: '这一页的动作', about: [], entries: own },
    ]
    if (query === '' || found?.text !== query || found.result === null) return local.filter((g) => g.entries.length > 0)
    const hits = groupFound(found.result.hits).map(
      (g, k): Group => ({
        label: g.heading ?? '条目',
        about: g.about.map((line) => localMoments(line)),
        entries: g.items.map((f, i) => ({
          id: `hit-${k}-${i}`,
          icon: <File />,
          name: `${f.key}${f.marks.map((m) => `（${m}）`).join('')}`,
          // A plugin's words carry moments as the command line writes them; here they read in local time.
          hint: localMoments(f.details.join(' · ')) || undefined,
          choose: close(() => onOpen({ view: 'item', params: { path: f.path as string }, target: 'panel' })),
        })),
      }),
    )
    const problems = found.result.problems.map((p) => `插件 ${p.plugin} 出了问题：${p.message}`)
    return [...local, ...hits, ...(problems.length > 0 ? [{ label: '没能找的', about: problems, entries: [] }] : [])].filter((g) => g.entries.length > 0 || g.about.length > 0)
  }, [query, found, views, actions, groupOf, onClose, onPage, onAction, onOpen])

  const flat = groups.flatMap((g) => g.entries)
  const current = Math.min(active, Math.max(0, flat.length - 1))
  const waiting = query !== '' && found?.text !== query
  const answered = query !== '' && found?.text === query

  useEffect(() => setActive(0), [query, found])

  // The pill glides to the highlighted row; the list grows and shrinks to what it holds.
  useLayoutEffect(() => {
    const el = inner.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)
    const p = pill.current
    if (!p) return
    if (!el) {
      p.style.opacity = '0'
      return
    }
    p.style.opacity = '1'
    p.style.transform = `translateY(${el.offsetTop}px)`
    p.style.height = `${el.offsetHeight}px`
    el.scrollIntoView({ block: 'nearest' })
  }, [current, groups])
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setListHeight(Math.min(360, el.offsetHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[current]?.choose()
    }
  }

  let index = -1
  return (
    <Layer leaving={leaving} onDismiss={onClose} className="palette-layer">
      <div role="dialog" aria-modal="true" aria-label="命令面板" className="palette">
        <div className="palette-search">
          {waiting ? <LoaderCircle className="spinner" strokeWidth={2} aria-hidden /> : <Search strokeWidth={2} aria-hidden />}
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${ids}-list`}
            aria-activedescendant={flat.length > 0 ? `${ids}-${current}` : undefined}
            aria-autocomplete="list"
            aria-label="搜索或前往"
            placeholder="找库里的东西，或前往一页…"
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd keys={['esc']} />
        </div>
        <div className="palette-list" style={{ height: listHeight }}>
          <div ref={inner} id={`${ids}-list`} role="listbox" aria-label="结果">
            <span ref={pill} className="palette-pill" aria-hidden />
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="palette-label" aria-hidden>
                  {g.label}
                </div>
                {g.about.map((line, i) => (
                  <p key={i} className="palette-about">
                    {line}
                  </p>
                ))}
                {g.entries.map((entry) => {
                  const i = ++index
                  return (
                    <div
                      key={entry.id}
                      id={`${ids}-${i}`}
                      role="option"
                      aria-selected={i === current}
                      data-index={i}
                      className="palette-item"
                      onPointerMove={() => i !== current && setActive(i)}
                      onClick={entry.choose}
                    >
                      <span className="palette-tile">{entry.icon}</span>
                      <span className="name">{entry.name}</span>
                      {entry.hint ? <span className="hint">{entry.hint}</span> : null}
                    </div>
                  )
                })}
              </div>
            ))}
            {answered && found?.failed ? <p className="palette-none">没能问到库。</p> : null}
            {answered && !found?.failed && flat.length === 0 && groups.length === 0 ? <p className="palette-none">没有找到。</p> : null}
            {waiting && flat.length === 0 ? <p className="palette-none">正在找…</p> : null}
          </div>
        </div>
        <div className="palette-foot" aria-hidden>
          <Kbd keys={['↑']} />
          <Kbd keys={['↓']} />
          <span>选择</span>
          <Kbd keys={['↵']} />
          <span>打开</span>
          <span className="spacer" />
          <span>找到的东西在详情里打开</span>
        </div>
      </div>
    </Layer>
  )
}
