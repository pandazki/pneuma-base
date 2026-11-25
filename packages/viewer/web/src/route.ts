// What is open, kept in the address's fragment, so a reload or a pasted address opens the same thing
// and the browser's back and forward step through it: `#view=<id>&view.<param>=…&panel=<id>&panel.<param>=…`.
import type { ViewRequest } from '@pneuma-base/kernel'
import { useCallback, useEffect, useRef, useState } from 'react'

/** The main view, null for the first in the navigation, and the panel's views, the top one shown. */
export type Route = { main: ViewRequest | null; panel: ViewRequest[] }

export function encodeRoute({ main, panel }: Route): string {
  const query = new URLSearchParams()
  const put = (prefix: string, req: ViewRequest) => {
    query.set(prefix, req.view)
    for (const [name, value] of Object.entries(req.params)) query.set(`${prefix}.${name}`, value)
  }
  if (main) put('view', main)
  const top = panel.at(-1)
  if (top) put('panel', top)
  return query.toString()
}

function decode(hash: string): { main: ViewRequest | null; top: ViewRequest | null } {
  const query = new URLSearchParams(hash.replace(/^#/, ''))
  const take = (prefix: string): ViewRequest | null => {
    const view = query.get(prefix)
    if (!view) return null
    const params = Object.fromEntries([...query].filter(([name]) => name.startsWith(`${prefix}.`)).map(([name, value]) => [name.slice(prefix.length + 1), value]))
    return { view, params }
  }
  return { main: take('view'), top: take('panel') }
}

const isRequest = (v: unknown): v is ViewRequest =>
  typeof v === 'object' && v !== null && typeof (v as ViewRequest).view === 'string' && typeof (v as ViewRequest).params === 'object' && (v as ViewRequest).params !== null

/** The route of the current history entry: its fragment, and the panel's views behind the top one when this entry kept them. */
function current(): Route {
  const { main, top } = decode(window.location.hash)
  const kept: unknown = (window.history.state as { panel?: unknown } | null)?.panel
  const stack = Array.isArray(kept) && kept.every(isRequest) ? kept : []
  const panel = top === null ? [] : stack.length > 0 && encodeRoute({ main: null, panel: stack }) === encodeRoute({ main: null, panel: [top] }) ? stack : [top]
  return { main, panel }
}

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
    if (encodeRoute(after) === encodeRoute(before) && after.panel.length === before.panel.length) return
    const fragment = encodeRoute(after)
    window.history.pushState({ panel: after.panel }, '', `${window.location.pathname}${window.location.search}${fragment === '' ? '' : `#${fragment}`}`)
    latest.current = after
    setRoute(after)
  }, [])
  return [route, go]
}
