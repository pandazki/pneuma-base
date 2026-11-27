// What changed in the library's content, learned from storage's cursor (STORAGE.md `changed`), never by
// a walk. Whoever needs change (a plugin's check, the home page's poll) keeps a mark, the cursor its
// last answer carried, and asks storage what changed since it.
//
// Whoever stays listens; whoever runs once asks with a small budget (ARCHITECTURE.md「变化由谁来学」).
// A long-lived process (the management UI's server) subscribes through storage, which then keeps a
// log of what it hears; while it does, any process's ask is answered from that log at a cost that
// follows what changed. Otherwise storage cannot say within the budget, and the asker compares the
// state of what it looks after: the same answer at a different cost. Nothing replays the system's
// journal for one command.
import type { Changes } from '@pneuma-base/sdk'
import { storageOf, type Storage } from './storage.js'
import { enclosingBundles } from './things.js'

/**
 * How many milliseconds a command waits to learn what changed. Read from a live listener's log, an
 * answer takes about a millisecond; a replay of the system's journal takes at least 13 ms (making
 * a stream) and then follows the whole volume's events, so 5 ms admits the log and never a replay.
 */
export const CHANGED_BUDGET = 5
/** More places than this from one ask are not worth listing: its asker compares everything. */
const MOST = 10_000

/**
 * What changed since `mark` (a cursor this asker kept from an earlier answer): the places, or null
 * when storage cannot say, there was no mark, or too much changed to list.
 */
export async function changesSince(store: Storage, mark: string | null): Promise<Omit<Changes, 'within'>> {
  const answer = await store.changed(mark, { budget: CHANGED_BUDGET, limit: MOST })
  return { places: mark === null || answer.places === null || ('more' in answer && answer.more) ? null : answer.places, mark: answer.cursor }
}

/**
 * What changed since `mark`, as a plugin asks: the places, and the directory things they lie inside.
 * Storage hears a change at any depth, and a directory thing's own token and its first level's do not
 * show one deeper down, so the thing a changed place lies in is named as changed itself.
 */
export async function changesWithin(store: Storage, mark: string | null): Promise<Changes> {
  const changes = await changesSince(store, mark)
  return { ...changes, within: changes.places === null || changes.places.length === 0 ? [] : await enclosingBundles(store, changes.places) }
}

/** Makes this process listen to the library's changes until `stopListening` or until it ends: for the processes that stay. */
export const listenTo = (root: string): void => storageOf(root).listen()
export const stopListening = (root: string): void => storageOf(root).unlisten()
