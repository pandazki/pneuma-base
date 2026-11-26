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
