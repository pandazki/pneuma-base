// Whether the page is shown inside the Mac app, which loads it with `?shell=mac`. The app draws the
// window around the page, keeps its server running and drags the window by the areas marked
// `data-drag`; the page leaves room for the window's buttons and drops what only a browser needs.
import type { Link } from '@pneuma-base/kernel'

export const IN_SHELL = new URLSearchParams(window.location.search).get('shell') === 'mac'

/** The menu bar panel's layout of the page, which the app loads with `?panel=tray` in its small window. */
export const IN_TRAY = IN_SHELL && new URLSearchParams(window.location.search).get('panel') === 'tray'

/**
 * What the page asks of the app: choose files or folders to put into the library folder `to`; open
 * the main window, on a link when one is given; show the menu of libraries; quit; and, from the
 * panel, how tall its content is and how many things wait for the owner, for the dot on the icon.
 */
export type ShellMessage =
  | { type: 'choose'; to: string }
  | { type: 'open'; link?: Link }
  | { type: 'libraries' }
  | { type: 'quit' }
  | { type: 'height'; height: number }
  | { type: 'waiting'; count: number }

type Webkit = { messageHandlers?: { shell?: { postMessage(message: unknown): void } } }

export function tellShell(message: ShellMessage): void {
  ;(window as unknown as { webkit?: Webkit }).webkit?.messageHandlers?.shell?.postMessage(message)
}

/**
 * The app tells the page when its window stops or starts being the one in front, by a
 * `pneuma-shell` event with `{ window: 'active' | 'inactive' }`; the page dims its chrome meanwhile.
 */
export function followWindow(): void {
  window.addEventListener('pneuma-shell', (e) => {
    const state = (e as CustomEvent<{ window?: unknown }>).detail?.window
    if (state === 'active' || state === 'inactive') document.documentElement.dataset.window = state
  })
}
