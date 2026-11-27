// What needs looking at, kept as rows and settled after every change: the strays of an open directory
// (loose files and directories nobody looked into), each thing's state and the marks on what was made
// from it (stale, source gone, marked upstream), things nobody knows the origin of, and a missing thing
// found again where exactly one stray of its kind, size and moment is. Only the things a change touched
// and what was made from them are worked out again. ARCHITECTURE.md「怎么看库」.
import { KERNEL_ENTRIES, placeIn, type LibraryPath, type Place } from '@pneuma-base/kernel'
import type { Basis, ItemId } from './facts.js'
import { live, markKey, putItem, putMark, putSeen, sigOf, versionNow, type ItemRow, type MarkKind, type MarkRow, type Ref, type SeenRow } from './model.js'
import type { Tx } from './rows.js'

/** What a change touched: the things whose marks to settle, the open directories whose strays to work out again, and the places the tool emptied. */
export type Settling = { remark: Set<ItemId>; restray: Set<Place>; released: Set<LibraryPath> }
export const settling = (): Settling => ({ remark: new Set(), restray: new Set(), released: new Set() })

/** Settles what the change touched: strays first, since a thing found again takes one; then the marks. */
export async function settle(tx: Tx, touched: Settling): Promise<void> {
  const strays: Stray[] = []
  for (const dir of touched.restray) await restray(tx, dir, strays, touched.released)
  touched.restray.clear()
  touched.released.clear()
  const items = await remark(tx, touched.remark)
  touched.remark.clear()
  await findMoved(tx, items, strays)
}

type Stray = { key: string; place: LibraryPath; sig: string | null }

/** Deletes a row of `marks` only while it is still the one `owner` wrote: a thing's mark and a stray may come to share a key. */
async function dropMark(tx: Tx, key: string, owner: ItemId | null): Promise<void> {
  const mark = await tx.get<MarkRow>('marks', key)
  if (mark && mark.item === owner) putMark(tx, key, null)
}

/**
 * The strays of an open directory from its last listing: what nobody registered and is not open, and
 * the loose files the owner did not leave. A place the tool moved a thing away from since is no longer
 * as the listing says: it is dropped from the listing until the directory is listed again.
 */
async function restray(tx: Tx, dir: Place, found: Stray[], released: ReadonlySet<LibraryPath>): Promise<void> {
  const listed = await tx.get<SeenRow>('seen', dir)
  if (!listed) return
  const entries = listed.entries.filter((e) => !released.has(placeIn(dir, e.name) as LibraryPath))
  const seen = { ...listed, entries }
  const candidates = seen.entries
    .filter((e) => (e.kind === 'file' || e.kind === 'dir') && !e.held && !(dir === '' && KERNEL_ENTRIES.has(e.name)))
    .map((e) => ({ e, place: placeIn(dir, e.name) as LibraryPath }))
  const places = candidates.map((c) => c.place)
  const [held, open, taken, left] = [await tx.getMany('paths', places), await tx.getMany('dirs', places), await tx.getMany('taken', places), await tx.getMany('left', places)]
  const keys: string[] = []
  const loose: LibraryPath[] = []
  for (const { e, place } of candidates) {
    if (held.has(place) || open.has(place) || taken.has(place)) continue
    const kind: MarkKind = e.kind === 'file' ? 'unowned' : 'closed'
    const key = markKey(kind, place)
    const sig = sigOf(e.kind === 'file' ? 'file' : 'dir', e.size, e.modified)
    putMark(tx, key, { kind, item: null, path: place, token: e.token, size: e.size, modified: e.modified }, sig)
    keys.push(key)
    if (e.kind === 'file' && !left.has(place)) loose.push(place)
    found.push({ key, place, sig })
  }
  for (const key of seen.strays) if (!keys.includes(key)) await dropMark(tx, key, null)
  putSeen(tx, dir, { ...seen, strays: keys, loose })
}

/** The sources of a basis as rows, with the bundles absorbed ones lie in. */
async function sourcesOf(tx: Tx, rows: Iterable<ItemRow>): Promise<void> {
  const ids = new Set<string>()
  for (const item of rows) for (const r of item.basis.items) ids.add(r.item)
  const sources = await tx.getMany<ItemRow>('items', ids)
  await tx.prefetch('items', [...sources.values()].flatMap((s) => (s.absorbedInto === null ? [] : [s.absorbedInto])))
}

/**
 * What a basis row says of its source now: gone; stale when the source holds another version (by token,
 * by fingerprint when both are known, unknown when only its token says it changed); null when it holds
 * the version the row recorded.
 */
export function rowMark(row: Basis['items'][number], source: ItemRow | undefined, bundle: ItemRow | undefined): 'gone' | 'stale' | null {
  const now = versionNow(source, bundle)
  if (now === null) return 'gone'
  if (now === 'unknown') return 'stale'
  if (row.token && now.token && row.token === now.token) return null
  if (row.fingerprint && now.fingerprint) return row.fingerprint === now.fingerprint ? null : 'stale'
  if (row.token && now.token) return 'stale'
  return null
}

/** The marks on an item's direct basis, judged by each source's row. */
export async function basisMarks(tx: Pick<Tx, 'get'>, item: ItemRow): Promise<{ item: ItemId; mark: 'gone' | 'stale' | null; source: ItemRow | undefined }[]> {
  const out = []
  for (const row of item.basis.items) {
    const source = await tx.get<ItemRow>('items', row.item)
    const bundle = source?.absorbedInto ? await tx.get<ItemRow>('items', source.absorbedInto) : undefined
    out.push({ item: row.item, mark: rowMark(row, source, bundle), source })
  }
  return out
}

const refOf = (id: ItemId, row: ItemRow | undefined): Ref => ({ item: id, path: row?.path ?? id })

/**
 * Settles the marks of these items and of what was made from them: each one's state, its stale and gone
 * sources, its origin nobody knows; then, where whether a thing carries a mark changed, what lies
 * downstream of it, marked upstream. Answers the rows it settled.
 */
async function remark(tx: Tx, ids: ReadonlySet<ItemId>): Promise<ItemRow[]> {
  if (ids.size === 0) return []
  const first = await tx.getMany<ItemRow>('items', ids)
  const wanted = new Set<ItemId>(ids)
  const absorbed = [...first.values()].flatMap((i) => (i.bundle ? i.absorbed : []))
  for (const item of [...first.values(), ...(await tx.getMany<ItemRow>('items', absorbed)).values()]) for (const d of item.dependents) wanted.add(d)
  const rows = await tx.getMany<ItemRow>('items', wanted)
  await sourcesOf(tx, rows.values())
  const own = new Map<ItemId, { stale: Ref[]; gone: Ref[] }>()
  const roots: ItemRow[] = []
  for (const item of rows.values()) {
    const marks = item.removed ? [] : await basisMarks(tx, item)
    const stale = marks.filter((m) => m.mark === 'stale').map((m) => refOf(m.item, m.source))
    const gone = marks.filter((m) => m.mark === 'gone').map((m) => refOf(m.item, m.source))
    own.set(item.id, { stale, gone })
    const marked = stale.length > 0 || gone.length > 0
    if (marked !== item.marked) roots.push(item)
    item.marked = marked
  }
  // Downstream of a thing whose being marked changed, the marks upstream change too.
  const all = new Map(rows)
  for (let frontier = roots.flatMap((r) => r.dependents); frontier.length > 0; ) {
    const next = await tx.getMany<ItemRow>('items', frontier.filter((id) => !all.has(id)))
    frontier = []
    for (const [id, item] of next) {
      all.set(id as ItemId, item)
      frontier.push(...item.dependents)
    }
  }
  for (const item of all.values()) await write(tx, item, own.get(item.id) ?? null)
  return [...all.values()]
}

/** The things above `item` in its basis, at any depth, that carry a mark of their own. */
async function upstreamOf(tx: Tx, item: ItemRow): Promise<Ref[]> {
  const seen = new Set<ItemId>([item.id])
  const found: Ref[] = []
  for (let level = item.basis.items.map((r) => r.item); level.length > 0; ) {
    const fresh = level.filter((id) => !seen.has(id))
    fresh.forEach((id) => seen.add(id))
    const rows = await tx.getMany<ItemRow>('items', fresh)
    level = []
    for (const id of fresh) {
      const row = rows.get(id)
      if (row?.marked) found.push(refOf(id, row))
      if (row) level.push(...row.basis.items.map((r) => r.item))
    }
  }
  return found
}

/** Writes an item's rows in `marks`: those it has now, the ones it had and has no longer taken away. */
async function write(tx: Tx, item: ItemRow, own: { stale: Ref[]; gone: Ref[] } | null): Promise<void> {
  const next = new Map<string, { mark: MarkRow; sig: string | null }>()
  if (live(item)) {
    const base = { item: item.id, path: item.path }
    if (item.state === 'changed' || item.state === 'missing' || item.state === 'moved') {
      const sig = item.state === 'missing' && !item.bundle ? sigOf('file', item.size, item.modified) : null
      next.set(markKey(item.state, item.path), { mark: { kind: item.state, ...base, ...(item.to === null ? {} : { to: item.to }) }, sig })
    }
    const marks = own ?? (await (async () => {
      const m = await basisMarks(tx, item)
      return { stale: m.filter((x) => x.mark === 'stale').map((x) => refOf(x.item, x.source)), gone: m.filter((x) => x.mark === 'gone').map((x) => refOf(x.item, x.source)) }
    })())
    if (marks.stale.length > 0) next.set(markKey('stale', item.path), { mark: { kind: 'stale', ...base, sources: marks.stale }, sig: null })
    if (marks.gone.length > 0) next.set(markKey('gone', item.path), { mark: { kind: 'gone', ...base, sources: marks.gone }, sig: null })
    if (!item.marked) {
      const via = await upstreamOf(tx, item)
      if (via.length > 0) next.set(markKey('upstream', item.path), { mark: { kind: 'upstream', ...base, sources: via }, sig: null })
    }
    if (item.unknownOrigin) next.set(markKey('unowned', item.path), { mark: { kind: 'unowned', ...base, adopted: true }, sig: null })
  }
  for (const key of item.marks) if (!next.has(key)) await dropMark(tx, key, item.id)
  for (const [key, { mark, sig }] of next) putMark(tx, key, mark, sig)
  item.marks = [...next.keys()]
  putItem(tx, item)
}

/**
 * A missing thing moved where exactly one stray of its kind, size and moment is, which no other missing
 * thing could be: the missing things these rows are, and the strays found now.
 */
async function findMoved(tx: Tx, items: readonly ItemRow[], strays: readonly Stray[]): Promise<void> {
  const sigs = new Set<string>()
  for (const item of items) if (live(item) && item.state === 'missing' && !item.bundle) {
    const sig = sigOf('file', item.size, item.modified)
    if (sig !== null) sigs.add(sig)
  }
  for (const s of strays) if (s.sig !== null) sigs.add(s.sig)
  for (const sig of sigs) {
    const rows = await tx.where<MarkRow>('marks', 'sig', sig)
    const loose = rows.filter((r) => r.value.item === null && r.value.kind === 'unowned')
    const missing = rows.filter((r) => r.value.item !== null && r.value.kind === 'missing')
    if (loose.length !== 1 || missing.length !== 1) continue
    const [stray, gone] = [loose[0] as (typeof rows)[number], missing[0] as (typeof rows)[number]]
    const item = await tx.get<ItemRow>('items', gone.value.item as ItemId)
    if (!item) continue
    Object.assign(item, { state: 'moved', to: stray.value.path })
    tx.set('taken', stray.value.path, { id: item.id, token: stray.value.token ?? null, size: stray.value.size ?? null, modified: stray.value.modified ?? null })
    putMark(tx, stray.key, null)
    await write(tx, item, null)
  }
}
