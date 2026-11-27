// The page's own conveniences that outlive a server: how wide the sidebar and the panel are, and
// whether the sidebar is a rail. Kept in a cookie, which belongs to the host and not to its port, so
// a server started again on another port finds them. Never anything of the library.
import { useCallback, useState } from 'react'

export type Prefs = { side: number; panel: number; rail: boolean }

export const SIDE = { min: 200, max: 360, initial: 240 }
export const PANEL = { min: 320, max: 640, initial: 384 }
const NAME = 'pneuma-ui'

const clamp = (n: unknown, { min, max, initial }: { min: number; max: number; initial: number }) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : initial

function read(): Prefs {
  try {
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${NAME}=`))
    const v = raw ? (JSON.parse(decodeURIComponent(raw.slice(NAME.length + 1))) as Record<string, unknown>) : {}
    return { side: clamp(v.side, SIDE), panel: clamp(v.panel, PANEL), rail: v.rail === true }
  } catch {
    return { side: SIDE.initial, panel: PANEL.initial, rail: false }
  }
}

function write(p: Prefs): void {
  try {
    document.cookie = `${NAME}=${encodeURIComponent(JSON.stringify(p))}; path=/; max-age=31536000; samesite=strict`
  } catch {
    // A page that cannot keep a cookie still works; it forgets the widths.
  }
}

/** The preferences, and a way to change some of them; each change is kept. */
export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(read)
  const change = useCallback((c: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { side: clamp(c.side ?? p.side, SIDE), panel: clamp(c.panel ?? p.panel, PANEL), rail: c.rail ?? p.rail }
      write(next)
      return next
    })
  }, [])
  return [prefs, change]
}

/** How a page that lists files shows them, as icons or a list, and the sort last chosen there. */
export type FileLook = { look: 'list' | 'icons'; sort: string | null }
type FileLooks = Record<string, Record<string, Partial<FileLook>>>
const LOOKS = 'pneuma-files'
/** The libraries whose looks are kept, the most recent last; a cookie holds little. */
const LOOKS_KEPT = 12

function readLooks(): FileLooks {
  try {
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${LOOKS}=`))
    const v: unknown = raw ? JSON.parse(decodeURIComponent(raw.slice(LOOKS.length + 1))) : {}
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FileLooks) : {}
  } catch {
    return {}
  }
}

/**
 * The look of a library's page on this machine, kept like the widths, in a cookie of the host that
 * outlives the server's port, and a way to change it.
 */
export function useFileLook(library: string | null, view: string | null): [FileLook, (change: Partial<FileLook>) => void] {
  const [looks, setLooks] = useState(readLooks)
  const kept = library !== null && view !== null ? looks[library]?.[view] : undefined
  const look: FileLook = { look: kept?.look === 'icons' ? 'icons' : 'list', sort: typeof kept?.sort === 'string' ? kept.sort : null }
  const change = useCallback(
    (c: Partial<FileLook>) => {
      if (library === null || view === null) return
      setLooks(() => {
        const all = readLooks()
        const { [library]: mine = {}, ...others } = all
        const next: FileLooks = Object.fromEntries([...Object.entries(others).slice(-(LOOKS_KEPT - 1)), [library, { ...mine, [view]: { ...mine[view], ...c } }]])
        try {
          document.cookie = `${LOOKS}=${encodeURIComponent(JSON.stringify(next))}; path=/; max-age=31536000; samesite=strict`
        } catch {
          // Without a cookie the page still works; it forgets the look.
        }
        return next
      })
    },
    [library, view],
  )
  return [look, change]
}
