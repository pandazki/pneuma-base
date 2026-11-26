// What changed in the library's content, learned from storage's cursor (STORAGE.md `changed`), never by
// a walk. The kernel keeps one cursor per library, in the rows of its own record place (the cache area:
// this machine's, and deleting it costs only a full comparison), and a short log of what each ask
// learned, numbered. Whoever needs change (the home page's poll, a plugin's check) keeps a mark, the
// number it last read up to, and reads the log after it.
//
// The cursor is kept young by use: every poll of an open page, every start, check and home page asks.
// A cursor older than OLD_MS is not replayed (storage would read every event of the volume since then)
// but replaced, and that ask says "cannot say": its readers compare every registered place's token.
import type { Changes, Place } from '@pneuma-base/sdk'
import type { Storage } from './storage.js'

/** The kernel's own record place. */
export const KERNEL_PLACE = 'kernel'
const OLD_MS = 10 * 60_000
/** How many asks the log keeps; a mark older than that reads as "cannot say". */
const KEEP = 512
/** More places than this from one ask are not worth listing: its readers compare everything. */
const MOST = 20_000

type Head = { cursor: string; at: string; seq: number }
type Learned = { places: Place[] | null }

const logKey = (seq: number) => `log:${String(seq).padStart(12, '0')}`

/** Asks storage what changed since the kept cursor and logs it; answers the newest number and whether storage could say. */
export async function learn(store: Storage, nowMs = Date.now()): Promise<{ seq: number; sure: boolean }> {
  const records = store.records(KERNEL_PLACE)
  for (let tries = 0; ; tries++) {
    const { rows, cursor: stamp } = await records.get<Head>('changes', ['head'])
    const head = rows[0]?.value ?? null
    let places: Place[] | null = []
    let cursor: string
    if (head === null || nowMs - Date.parse(head.at) > OLD_MS) {
      cursor = (await store.changed(null)).cursor
      places = null
    } else {
      cursor = head.cursor
      for (;;) {
        const answer = await store.changed(cursor, 10_000)
        cursor = answer.cursor
        if (answer.places === null) {
          places = null
          break
        }
        places.push(...answer.places)
        if (places.length > MOST) places = null
        if (places === null || !answer.more) break
      }
    }
    const quiet = places !== null && places.length === 0 && head !== null
    const seq = quiet ? head.seq : (head?.seq ?? 0) + 1
    const at = new Date(nowMs).toISOString()
    const changes = [{ key: 'head', value: { cursor, at, seq } satisfies Head }, ...(quiet ? [] : [{ key: logKey(seq), value: { places } satisfies Learned }, ...(seq > KEEP ? [{ key: logKey(seq - KEEP), value: null }] : [])])]
    const put = await records.put({ changes }, { cursor: `${seq}:${at}`, expect: stamp })
    if (put.written) return { seq, sure: places !== null }
    if (tries > 5) return { seq: head?.seq ?? 0, sure: false }
  }
}

/**
 * What changed since `mark` (a number this asker kept from an earlier answer): the places, or null when
 * storage could not say for some of that time, the mark is unknown or too old, or nothing was kept.
 */
export async function changesSince(store: Storage, mark: string | null): Promise<Changes> {
  const { seq } = await learn(store)
  const from = mark === null ? NaN : Number(mark)
  const next = String(seq)
  if (!Number.isInteger(from) || from > seq || seq - from >= KEEP) return { places: null, mark: next }
  if (from === seq) return { places: [], mark: next }
  const wanted = Array.from({ length: seq - from }, (_, i) => logKey(from + 1 + i))
  const { rows } = await store.records(KERNEL_PLACE).get<Learned>('changes', wanted)
  if (rows.length < wanted.length) return { places: null, mark: next }
  const places = new Set<Place>()
  for (const { value } of rows) {
    if (value.places === null) return { places: null, mark: next }
    for (const place of value.places) places.add(place)
  }
  return { places: [...places].sort(), mark: next }
}
