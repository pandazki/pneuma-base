// What blocks can do besides showing themselves, given by the shell around them.
import type { Action, Link } from '@pneuma-base/kernel'
import { createContext, useContext } from 'react'

/**
 * What a block can do besides showing itself: follow a link, start an action, and know what the
 * panel shows. `values` fills an action's inputs before the person sees them, as a plugin's own page
 * asks. `newTab` opens a panel link in a tab of its own, as ⌘-click and a middle click ask.
 */
export type BlockEnv = {
  onLink(link: Link, newTab?: boolean): void
  onAction(action: Action, values?: Record<string, string>): void
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

