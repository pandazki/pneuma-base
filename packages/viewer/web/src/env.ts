// What blocks can do besides showing themselves, given by the shell around them.
import type { Action, Link } from '@pneuma-base/kernel'
import { createContext, useContext } from 'react'

/** What an action came to: the tone and the line the notice showed. */
export type Done = { tone: 'good' | 'warn' | 'bad'; text: string }

/**
 * What a block can do besides showing itself: follow a link, start an action, set a parameter of the
 * view it is in, and know what the panel shows. `values` fills an action's inputs before the person
 * sees them, as a plugin's own page asks. `newTab` opens a panel link in a tab of its own, as ⌘-click
 * and a middle click ask. `onAction` comes to what the action answered, or null when the person
 * cancelled its dialog.
 */
export type BlockEnv = {
  onLink(link: Link, newTab?: boolean): void
  onAction(action: Action, values?: Record<string, string>): Promise<Done | null>
  onParam(name: string, value: string): void
  /** Turns a long list to the page `link` names, in place of the one shown: in the main panel, or in the panel's front tab. */
  onPage(link: Link): void
  selected(link: Link | null): boolean
  /** Changes whenever the library changed, so blocks that load on their own load again. */
  tick: number
}

export const BlockEnvContext = createContext<BlockEnv | null>(null)

export function useEnv(): BlockEnv {
  const env = useContext(BlockEnvContext)
  if (!env) throw new Error('blocks rendered outside BlockEnvContext')
  return env
}
