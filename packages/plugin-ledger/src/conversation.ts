// Where a scene's conversation is: the pointer its facts carry, and whether that file is on this
// machine now. Only whether the file is there is looked at, never what is in it.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SceneRecord } from './fold.js'

/** `machine`: where the pointer was recorded. `status`: the file is on this machine now, was and is gone, or is on another machine. */
export type Conversation = { path: string; resume: string | null; machine: string; status: 'here' | 'gone' | 'elsewhere' }

export function conversationOf(scene: SceneRecord, machine: string): Conversation | null {
  const pointer = scene.transcript
  if (pointer === null) return null
  const local = pointer.path.startsWith('~/') ? join(homedir(), pointer.path.slice(2)) : pointer.path
  return { ...pointer, status: pointer.machine !== machine ? 'elsewhere' : existsSync(local) ? 'here' : 'gone' }
}
