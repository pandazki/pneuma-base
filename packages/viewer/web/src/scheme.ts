// The page's colour scheme, on <html data-scheme>, which the stylesheets read. In a browser it is the
// owner's choice, kept in a cookie of the host as the widths are, or the system's; index.html sets it
// before the first frame and this keeps it. In the Mac app it is always what the web view reports,
// since the app's own 外观 setting decides that for the window, the panel and their pages at once.
import { useSyncExternalStore } from 'react'
import { IN_SHELL } from './shell'

export type SchemeChoice = 'system' | 'light' | 'dark'
export type Scheme = 'light' | 'dark'

const NAME = 'pneuma-scheme'
const DARK = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function readChoice(): SchemeChoice {
  if (IN_SHELL) return 'system'
  try {
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${NAME}=`))
    const v = raw?.slice(NAME.length + 1)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

let choice = readChoice()

const schemeOf = (c: SchemeChoice): Scheme => (c === 'system' ? (DARK.matches ? 'dark' : 'light') : c)

function apply() {
  document.documentElement.dataset.scheme = schemeOf(choice)
  for (const l of listeners) l()
}

DARK.addEventListener('change', apply)
apply()

/** The browser's choice, kept for the next visit; the page follows at once. */
export function chooseScheme(next: SchemeChoice): void {
  choice = next
  try {
    document.cookie = next === 'system' ? `${NAME}=; path=/; max-age=0; samesite=strict` : `${NAME}=${next}; path=/; max-age=31536000; samesite=strict`
  } catch {
    // A page that cannot keep a cookie still follows the choice until it is closed.
  }
  apply()
}

const subscribe = (change: () => void) => {
  listeners.add(change)
  return () => listeners.delete(change)
}

/** The scheme the page is drawn in now. */
export const useScheme = (): Scheme => useSyncExternalStore(subscribe, () => schemeOf(choice))

/** The browser's choice. */
export const useSchemeChoice = (): SchemeChoice => useSyncExternalStore(subscribe, () => choice)
