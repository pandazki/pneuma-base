// Whether the page is shown inside the Mac app, which loads it with `?shell=mac`. The app draws the
// window around the page, keeps its server running and drags the window by the areas marked
// `data-drag`; the page leaves room for the window's buttons and drops what only a browser needs.
import type { Link } from '@pneuma-base/kernel'

export const IN_SHELL = new URLSearchParams(window.location.search).get('shell') === 'mac'

/** The menu bar panel's layout of the page, which the app loads with `?panel=tray` in its small window. */
export const IN_TRAY = IN_SHELL && new URLSearchParams(window.location.search).get('panel') === 'tray'

/** An entry of the page's own in the system's context menu: what comes back as `{ menu: id }` when chosen. */
export type MenuItem = { id: string; label: string; danger?: true }

/**
 * What the page asks of the app: choose files or folders to put into the library folder `to`; open
 * the main window, on a link when one is given; show the menu of libraries; quit; and, from the
 * panel, how tall its content is and how many things wait for the owner, for the dot on the icon.
 *
 * Files of the library, named by their library paths, which the app turns into files of this machine
 * through storage: Quick Look on them as a set, showing the `at`-th (again while it is up, to follow
 * the selection; with no paths it closes); open each with its default application, a directory in
 * Finder; show them selected in Finder; copy their paths on this machine; the system's context menu
 * at a point of the page, the app's own entries first and `items` after; thumbnails of at most 50
 * places, each answered by itself; the system's drag of these files out of the window, from the
 * pointer, giving copies; how many places are selected, for the app's menus. A conversation opened
 * again: `url` when an application handles it, else `run` in the default terminal, else `reveal`.
 * A question before an act that cannot be undone, as the system's sheet (`confirmInShell`). A path of
 * this machine a cell names (`Cell.local`, such as the library's folder), shown selected in Finder.
 */
export type ShellMessage =
  | { type: 'choose'; to: string }
  | { type: 'open'; link?: Link }
  | { type: 'libraries' }
  | { type: 'quit' }
  | { type: 'height'; height: number }
  | { type: 'waiting'; count: number }
  | { type: 'preview'; paths: string[]; at: number }
  | { type: 'launch'; paths: string[] }
  | { type: 'reveal'; paths: string[] }
  | { type: 'copy-path'; paths: string[] }
  | { type: 'menu'; paths: string[]; x: number; y: number; items: MenuItem[] }
  | { type: 'thumbnails'; items: { path: string; token: string | null }[]; px: number }
  | { type: 'drag'; paths: string[] }
  | { type: 'selection'; count: number }
  | { type: 'reopen'; url: string | null; run: { command: string; cwd: string } | null; reveal: string }
  | { type: 'confirm'; id: number; text: string; act: string; danger: boolean }
  | { type: 'reveal-local'; path: string }

/** What the app's menus ask of the page's selection, and what the context menu's 打开 and 快速查看 hand back. */
export type ShellCommand = 'open' | 'preview' | 'reveal' | 'copy-path' | 'rename' | 'list' | 'icons' | 'up'

/**
 * What the app tells the page about files, by `pneuma-shell` events: Quick Look opened or closed; an
 * arrow pressed while Quick Look has the keyboard and shows one file; a command from its menus; an
 * entry of the page's chosen in the context menu; a thumbnail, as a `data:` URL.
 */
export type ShellFileEvent =
  | { previewing: boolean }
  | { key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'; shift: boolean }
  | { command: ShellCommand }
  | { menu: string }
  | { thumbnail: { path: string; token: string | null; src: string } }

type Webkit = { messageHandlers?: { shell?: { postMessage(message: unknown): void } } }

export function tellShell(message: ShellMessage): void {
  ;(window as unknown as { webkit?: Webkit }).webkit?.messageHandlers?.shell?.postMessage(message)
}

let asked = 0

/** Asks `text` as the system's sheet on the window, with `act` and 取消: whether the owner chose `act`. */
export function confirmInShell(text: string, act: string, danger: boolean): Promise<boolean> {
  const id = ++asked
  return new Promise((resolve) => {
    const answer = (e: Event) => {
      const confirmed = (e as CustomEvent<{ confirmed?: { id?: unknown; ok?: unknown } }>).detail?.confirmed
      if (confirmed?.id !== id) return
      window.removeEventListener('pneuma-shell', answer)
      resolve(confirmed.ok === true)
    }
    window.addEventListener('pneuma-shell', answer)
    tellShell({ type: 'confirm', id, text, act, danger })
  })
}

/**
 * The app tells the page, by `pneuma-shell` events, when its window stops or starts being the one in
 * front (`{ window: 'active' | 'inactive' }`; the page dims its chrome meanwhile), and whether the
 * system's glass is under the page (`{ transparency: 'glass' | 'reduced' }`; reduced when the owner's
 * settings reduce transparency or raise contrast). The app sets the first transparency on `<html>`
 * itself before the page loads, so the first frame is drawn right.
 */
export function followShell(): void {
  const root = document.documentElement
  window.addEventListener('pneuma-shell', (e) => {
    const { window: state, transparency } = (e as CustomEvent<{ window?: unknown; transparency?: unknown }>).detail ?? {}
    if (state === 'active' || state === 'inactive') root.dataset.window = state
    if (transparency === 'glass' || transparency === 'reduced') root.dataset.transparency = transparency
  })
}
