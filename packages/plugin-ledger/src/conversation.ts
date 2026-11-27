// Where a scene's conversation is: the pointer its facts carry, and whether that file is on this
// machine now. Only whether the file is there is looked at, never what is in it.
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { reopenOf, type Reopen } from '@pneuma-base/kernel'
import type { SceneRow } from './model.js'

/** `machine`: where the pointer was recorded. `status`: the file is on this machine now, was and is gone, or is on another machine. */
export type Conversation = { path: string; resume: string | null; machine: string; status: 'here' | 'gone' | 'elsewhere' }

export function conversationOf(scene: Pick<SceneRow, 'transcript' | 'cwds'>, machine: string): Conversation | null {
  const pointer = scene.transcript
  if (pointer === null) return null
  const local = pointer.path.startsWith('~/') ? join(homedir(), pointer.path.slice(2)) : pointer.path
  const status = pointer.machine !== machine ? 'elsewhere' : existsSync(local) ? 'here' : 'gone'
  return { ...pointer, status }
}

/**
 * How the Mac app opens a scene's conversation again: only one recorded on this machine, as sessions
 * name it, and still here. Only the page's cells carry it, never a verb's answer: it is the shell's.
 */
export function reopenFor(scene: Pick<SceneRow, 'transcript' | 'cwds'>): Reopen | null {
  const conversation = conversationOf(scene, hostname())
  return conversation?.status === 'here' ? reopenOf(conversation.path, scene.cwds, homedir()) : null
}
