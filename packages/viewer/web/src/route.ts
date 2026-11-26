// What is open, kept in the address's fragment, so a reload or a pasted address opens the same thing
// and the browser's back and forward step through it:
// `#view=<id>&view.<param>=…&panel=<id>&panel.<param>=…&panel2=<id>&panel2.<param>=…&tab=2`.
// `panel`, `panel2`, … are the panel's tabs in order, each with the view it shows now; `tab` is the
// active one, counted from 1, written when there is more than one.
import type { ViewRequest } from '@pneuma-base/kernel'
import { useCallback, useEffect, useRef, useState } from 'react'

/** One tab of the panel: the views it went through, the last one shown; 返回 steps back. Never empty. */
export type Tab = ViewRequest[]
/** The main view, null for the first in the navigation; the panel's tabs and which one is in front. */
export type Route = { main: ViewRequest | null; tabs: Tab[]; active: number }

const sameRequest = (a: ViewRequest | null | undefined, b: ViewRequest | null | undefined) =>
  a != null && b != null && a.view === b.view && JSON.stringify(Object.entries(a.params).sort()) === JSON.stringify(Object.entries(b.params).sort())

const tabKey = (i: number) => (i === 0 ? 'panel' : `panel${i + 1}`)

/** The tab's view on screen. */
export const topOf = (tab: Tab): ViewRequest => tab[tab.length - 1] as ViewRequest

/** The view the panel shows, or null when it is closed. */
export const shownOf = (route: Route): ViewRequest | null => {
  const tab = route.tabs[route.active]
  return tab ? topOf(tab) : null
}

export function encodeRoute({ main, tabs, active }: Route): string {
  const query = new URLSearchParams()
  const put = (prefix: string, req: ViewRequest) => {
    query.set(prefix, req.view)
    for (const [name, value] of Object.entries(req.params)) query.set(`${prefix}.${name}`, value)
  }
  if (main) put('view', main)
  tabs.forEach((tab, i) => put(tabKey(i), topOf(tab)))
  if (tabs.length > 1) query.set('tab', String(active + 1))
  return query.toString()
}

function decode(hash: string): { main: ViewRequest | null; tops: ViewRequest[]; active: number } {
  const query = new URLSearchParams(hash.replace(/^#/, ''))
  const take = (prefix: string): ViewRequest | null => {
    const view = query.get(prefix)
    if (!view) return null
    const params = Object.fromEntries([...query].filter(([name]) => name.startsWith(`${prefix}.`)).map(([name, value]) => [name.slice(prefix.length + 1), value]))
    return { view, params }
  }
  const tops: ViewRequest[] = []
  for (let top = take(tabKey(0)); top !== null; top = take(tabKey(tops.length))) tops.push(top)
  const asked = Number(query.get('tab') ?? '1') - 1
  return { main: take('view'), tops, active: Number.isInteger(asked) && asked >= 0 && asked < tops.length ? asked : 0 }
}

const isRequest = (v: unknown): v is ViewRequest =>
  typeof v === 'object' && v !== null && typeof (v as ViewRequest).view === 'string' && typeof (v as ViewRequest).params === 'object' && (v as ViewRequest).params !== null

/** The route of the current history entry: its fragment, and each tab's earlier views when this entry kept them. */
function current(): Route {
  const { main, tops, active } = decode(window.location.hash)
  const kept: unknown = (window.history.state as { tabs?: unknown } | null)?.tabs
  const stacks = Array.isArray(kept) ? kept : []
  const tabs = tops.map((top, i): Tab => {
    const stack: unknown = stacks[i]
    return Array.isArray(stack) && stack.length > 0 && stack.every(isRequest) && sameRequest(stack[stack.length - 1], top) ? stack : [top]
  })
  return { main, tabs, active }
}

/**
 * The panel following a link. Here: the front tab goes on to it, so 返回 comes back; with no tab yet,
 * it is the first. A new tab: the tab already showing it comes to the front, else it opens after the others.
 */
export function follow(route: Route, req: ViewRequest, newTab: boolean): Route {
  const front = route.tabs[route.active]
  if (newTab || !front) {
    const open = route.tabs.findIndex((tab) => sameRequest(topOf(tab), req))
    if (open >= 0) return { ...route, active: open }
    return { ...route, tabs: [...route.tabs, [req]], active: route.tabs.length }
  }
  if (sameRequest(topOf(front), req)) return route
  return { ...route, tabs: route.tabs.map((tab, i) => (i === route.active ? [...tab, req] : tab)) }
}

/** The front tab showing `req` in place of what it shows, as a filter changed there; no step to go back to. */
export function retop(route: Route, req: ViewRequest): Route {
  const front = route.tabs[route.active]
  if (!front) return route
  return { ...route, tabs: route.tabs.map((tab, i) => (i === route.active ? [...tab.slice(0, -1), req] : tab)) }
}

/** The front tab one view back. */
export function back(route: Route): Route {
  const front = route.tabs[route.active]
  if (!front || front.length < 2) return route
  return { ...route, tabs: route.tabs.map((tab, i) => (i === route.active ? tab.slice(0, -1) : tab)) }
}

/** Without tab `i`; the front stays, or its neighbour on the left takes its place. */
export function closeTab(route: Route, i: number): Route {
  if (i < 0 || i >= route.tabs.length) return route
  const tabs = route.tabs.filter((_, j) => j !== i)
  const active = i < route.active ? route.active - 1 : i === route.active ? Math.max(0, Math.min(i - 1, tabs.length - 1)) : route.active
  return { ...route, tabs, active: tabs.length === 0 ? 0 : active }
}

export const closeAll = (route: Route): Route => ({ ...route, tabs: [], active: 0 })
export const activate = (route: Route, i: number): Route => (i >= 0 && i < route.tabs.length ? { ...route, active: i } : route)

const sameRoute = (a: Route, b: Route) => encodeRoute(a) === encodeRoute(b) && JSON.stringify(a.tabs) === JSON.stringify(b.tabs)

/** The route, and a way to go to another, which adds a history entry when anything changed. */
export function useRoute(): [Route, (next: (route: Route) => Route) => void] {
  const [route, setRoute] = useState(current)
  const latest = useRef(route)
  latest.current = route
  useEffect(() => {
    const onPop = () => setRoute(current())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next: (route: Route) => Route) => {
    const before = latest.current
    const after = next(before)
    if (sameRoute(after, before)) return
    const fragment = encodeRoute(after)
    window.history.pushState({ tabs: after.tabs }, '', `${window.location.pathname}${window.location.search}${fragment === '' ? '' : `#${fragment}`}`)
    latest.current = after
    setRoute(after)
  }, [])
  return [route, go]
}

export { sameRequest }
