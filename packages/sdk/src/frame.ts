// The frame kit, `@pneuma-base/sdk/frame`: what a plugin's own page in a `custom` block gets from the
// two files the viewer serves. `/plugin-kit/frame.js` gives `window.pneuma`; `/plugin-kit/frame.css`
// gives the management UI's fonts, base and component classes, coloured by the UI's tokens, which
// frame.js sets on the page's root, so the page follows light and dark with no colour of its own.
// For completions in the page's script: /// <reference types="@pneuma-base/sdk/frame" />
import type { ActionInput, Link } from './types.js'

/**
 * The classes /plugin-kit/frame.css gives, the ones the management UI draws with: `card` (a raised
 * surface); `glass` (a layer floating over the page's content, as the UI's menus and notices); `btn` (secondary), with `btn-primary` (near-black, the one main action), `btn-quiet` (no
 * ground until hovered), `btn-danger` (red as a tint) and `btn-sm` (24px high instead of 28);
 * `icon-btn` (an icon alone, named by `aria-label`); `field` (a text input), `field-area` (a
 * textarea); `select` (a wrapper around a `<select>`); `segmented` (buttons in a row, the checked one
 * `aria-checked="true"`, a count in a `<span class="count">`); `check` (a checkbox), `switch` (a
 * checkbox with `role="switch"`); `tag` (a small label) with a tone, `tone-good`, `tone-warn`,
 * `tone-bad`, `tone-info`; `kbd` (a key cap); `link`; `mono` (monospace), `muted` and `faint`
 * (quieter ink). Each draws its own hover, pressed, focus and disabled states.
 */
export const FRAME_CLASSES = [
  'card',
  'glass',
  'btn',
  'btn-primary',
  'btn-quiet',
  'btn-danger',
  'btn-sm',
  'icon-btn',
  'field',
  'field-area',
  'select',
  'segmented',
  'check',
  'switch',
  'tag',
  'tone-good',
  'tone-warn',
  'tone-bad',
  'tone-info',
  'kbd',
  'link',
  'mono',
  'muted',
  'faint',
] as const

/**
 * The UI's tokens, CSS custom properties set on the page's root, current for light or dark: ink,
 * strongest to faintest (`--ink-strong`, `--ink` … `--ink-4`); surfaces from the back (`--page`,
 * `--panel`, `--surface`, `--overlay`) and `--tray`, a grey layer inside one; washes for hover,
 * chips, the selected pill and a table row's hover; lines; shadows for cards, popovers and dialogs,
 * and a field's rings; the near-black `--primary` with its hover and the ink on it; `--focus`, the
 * keyboard ring, the only blue besides `--info`; the scrim; the four states, each with its soft
 * ground; `--chart`, for a chart's line or a heat map's shade; the tooltip's ground and ink; the glass
 * of floating layers (`--glass`, its `--glass-filter` for `backdrop-filter`, its `--glass-edge` to put
 * before a shadow, and `--glass-border`, opaque and bordered when transparency is reduced); seven
 * radii; the motion curves; and the two font stacks.
 */
export const FRAME_TOKENS = [
  '--ink-strong',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--ink-4',
  '--page',
  '--panel',
  '--surface',
  '--overlay',
  '--tray',
  '--wash',
  '--chip',
  '--select',
  '--row-hover',
  '--line',
  '--line-strong',
  '--shadow-card',
  '--shadow-card-hover',
  '--shadow-popover',
  '--shadow-dialog',
  '--ring-field',
  '--ring-field-hover',
  '--ring-field-focus',
  '--ring-field-error',
  '--primary',
  '--primary-hover',
  '--on-primary',
  '--focus',
  '--scrim',
  '--good',
  '--good-soft',
  '--warn',
  '--warn-soft',
  '--bad',
  '--bad-soft',
  '--bad-soft-hover',
  '--info',
  '--info-soft',
  '--chart',
  '--tip-bg',
  '--tip-ink',
  '--glass',
  '--glass-filter',
  '--glass-edge',
  '--glass-border',
  '--radius-tag',
  '--radius-control',
  '--radius-field',
  '--radius-item',
  '--radius-card',
  '--radius-panel',
  '--radius-dialog',
  '--ease',
  '--ease-glide',
  '--ease-pop',
  '--font-sans',
  '--font-mono',
] as const

export type FrameClass = (typeof FRAME_CLASSES)[number]
export type FrameToken = (typeof FRAME_TOKENS)[number]

/** One of the block's actions as the frame knows it: what its button says and asks for, never its call. */
export type FrameAction = { label: string; tone: 'default' | 'danger'; inputs: ActionInput[] }

/**
 * What `onData` gets beside the block's data: the colour scheme now, and the block's actions by name.
 * The scheme is all the page learns from the UI of the person looking; their time zone and language
 * are the browser's own, such as `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 */
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
