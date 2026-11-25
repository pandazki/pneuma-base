// The frame kit, `@pneuma-base/sdk/frame`: what a plugin's own page in a `custom` block gets from the
// two files the viewer serves. `/plugin-kit/frame.js` gives `window.pneuma`; `/plugin-kit/frame.css`
// gives the management UI's fonts, base and component classes, coloured by the UI's tokens, which
// frame.js sets on the page's root, so the page follows light and dark with no colour of its own.
// For completions in the page's script: /// <reference types="@pneuma-base/sdk/frame" />
import type { ActionInput, Link } from './types.js'

/**
 * The classes /plugin-kit/frame.css gives, the ones the management UI draws with: `card` (a raised
 * surface); `btn`, with `btn-primary` and `btn-danger`; `field` (a text input), `field-area` (a
 * textarea); `tag` (a small label) with a tone, `tone-good`, `tone-warn`, `tone-bad`, `tone-info`;
 * `segmented` (buttons in a row, the checked one `aria-checked="true"`); `select` (a wrapper around a
 * `<select>`); `link`; `mono` (monospace), `muted` and `faint` (quieter ink).
 */
export const FRAME_CLASSES = [
  'card',
  'btn',
  'btn-primary',
  'btn-danger',
  'field',
  'field-area',
  'tag',
  'tone-good',
  'tone-warn',
  'tone-bad',
  'tone-info',
  'segmented',
  'select',
  'link',
  'mono',
  'muted',
  'faint',
] as const

/**
 * The UI's tokens, CSS custom properties set on the page's root, current for light or dark: surfaces
 * from the page back to the front (`--page`, `--canvas`, `--surface`, `--inset`, `--hover`,
 * `--hover-2`); ink, strong to faint (`--ink`, `--ink-2`, `--ink-3`); lines; `--field`; the accent and
 * the three tones with their tints (`--green` good, `--orange` warn, `--red` bad); the tooltip and the
 * scrim; a tag's fill and ring as percentages; shadows; radii; and the two font stacks.
 */
export const FRAME_TOKENS = [
  '--page',
  '--canvas',
  '--surface',
  '--inset',
  '--hover',
  '--hover-2',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--line',
  '--line-strong',
  '--line-soft',
  '--field',
  '--accent',
  '--accent-ink',
  '--accent-tint',
  '--green',
  '--green-tint',
  '--orange',
  '--orange-tint',
  '--red',
  '--red-tint',
  '--tooltip-bg',
  '--tooltip-fg',
  '--scrim',
  '--tag-fill',
  '--tag-ring',
  '--shadow-xs',
  '--shadow-sm',
  '--shadow-lg',
  '--shadow-hairline',
  '--shadow-btn',
  '--shadow-card',
  '--shadow-overlay',
  '--shadow-inset-field',
  '--radius-chip',
  '--radius-control',
  '--radius-card',
  '--radius-window',
  '--font-sans',
  '--font-mono',
] as const

export type FrameClass = (typeof FRAME_CLASSES)[number]
export type FrameToken = (typeof FRAME_TOKENS)[number]

/** One of the block's actions as the frame knows it: what its button says and asks for, never its call. */
export type FrameAction = { label: string; tone: 'default' | 'danger'; inputs: ActionInput[] }

/** What `onData` gets beside the block's data: the colour scheme now, and the block's actions by name. */
export type FrameInfo = { scheme: 'light' | 'dark'; actions: Record<string, FrameAction> }

/**
 * `window.pneuma`, from /plugin-kit/frame.js. The frame's height follows its content: frame.js
 * reports it whenever it changes, so the page sets no height of its own. A frame may ask for nothing
 * but these three.
 */
export interface PneumaFrame {
  /**
   * Calls `callback` with the block's `data` and the frame's info: now, if they came, and again each
   * time the view is fetched again or the colour scheme changes. `T` is the type of the block's data.
   */
  onData<T = unknown>(callback: (data: T, info: FrameInfo) => void): void
  /**
   * Asks the page to run the block's action `name`, with `values` for its inputs (only the inputs it
   * declares are taken). The page runs it as it runs a button: the same confirmation, form and
   * result, and the view is fetched again after it.
   */
  run(name: string, values?: Record<string, string>): void
  /** Opens a view, `{ view, params, target }`, or an outside http or https address in a new tab. */
  open(link: Link | string): void
}

declare global {
  interface Window {
    readonly pneuma: PneumaFrame
  }
  var pneuma: PneumaFrame
}
