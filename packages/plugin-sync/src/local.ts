// The library as one side of a sync, reached only through `ctx.tools.storage`. What it holds is what
// sync's rows say it read last, corrected by storage's comparison of the tokens kept in them: content
// is read only where a token differs or nothing was read yet. It writes with expectations, holding the
// places it writes, and never through a put: the facts carried with the content say who registered it.
import { join } from 'node:path'
import { isDescribed, isFailure, type Expect, type Fingerprint, type Place, type PlaceReader, type PluginContext, type Row, type StorageFailure, type Written } from '@pneuma-base/kernel'
import type { SideIO } from './execute.js'
import { ownTable, THINGS, type Change, type OwnRow, type ThingRow } from './rows.js'
import { carried, inCache, ownKey, ownOf, type Key } from './scope.js'
import type { Staged, TargetDir } from './target.js'

/**
 * One side as the plan sees it: the fingerprint of each key it holds, the state each key was seen in
 * (a token, or `empty` for nothing there), which writes and removals expect, and the keys left out of
 * this run because storage could not say (held by a write under way, unreadable, noise).
 */
export type LocalMap = { files: Map<Key, Fingerprint>; expects: Map<Key, Expect>; skip: Set<Key>; tracked: Set<Key> }
export const localMap = (): LocalMap => ({ files: new Map(), expects: new Map(), skip: new Set(), tracked: new Set() })

/** How many reads of content go to storage at once. */
const AT_ONCE = 16
const LOOK_PAGE = 100000
/** How many places one look of things not compared yet names. */
const LOOK_AT_ONCE = 1000
const LEVEL_PAGE = 1000
const MANIFEST_PAGE = 10000

async function eachAtMost<T>(list: readonly T[], f: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) await f(list[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, worker))
}

/**
 * The places of a table whose kept token storage says is not what is there now, a page at a time. With
 * `deep`, a directory's every file's state is compared, and a changed one comes with its deep token; one
 * with more files than storage counts is changed, without one.
 */
async function differences(store: PlaceReader, table: string, deep = false) {
  const changed = new Map<Place, string | undefined>()
  const gone = new Set<Place>()
  const skip = new Set<Place>()
  let after: string | undefined
  for (;;) {
    const page = await store.lookRows(table, 'token', { limit: LOOK_PAGE, ...(after === undefined ? {} : { after }), ...(deep ? { deep: true } : {}) })
    for (const c of page.changed) changed.set(c.place, c.deep)
    for (const g of page.gone) gone.add(g)
    for (const f of page.failed) {
      if (deep && f.reason === 'too_many') changed.set(f.place, undefined)
      else skip.add(f.place)
    }
    for (const h of page.held) skip.add(h)
    if (page.more === null) return { changed, gone, skip }
    after = page.more.after
  }
}

/**
 * The registered things here, and the keys of the baseline that are no registered thing any more (moved
 * away, purged), into `map`. `rows` reads the things table, with the facts a status has not pulled
 * folded on top, whose things storage has not compared; `out` takes what was read, for the rows. A
 * directory thing is compared by the state of every file in it (its deep token, taken before its
 * content is read), so a change deep inside it is read even when its own level is as it was.
 */
export async function localThings(ctx: PluginContext, rows: Change, base: Iterable<Key>, out: Change, map: LocalMap): Promise<void> {
  const store = ctx.tools.storage
  const overlaid = new Set(rows.written(THINGS).keys())
  const known = new Map<Key, Row<ThingRow>>()
  for await (const r of rows.all<ThingRow>(THINGS)) if (carried(r.key as Key)) known.set(r.key as Key, r)
  for (const key of known.keys()) if (!overlaid.has(key)) map.tracked.add(key)
  const d = await differences(store, THINGS, true)
  const absent = (key: Key) => {
    map.expects.set(key, 'empty')
    const row = known.get(key)
    if (row !== undefined && map.tracked.has(key) && (row.fields?.token !== 'empty' || row.value.fp !== null)) out.set(THINGS, key, { fields: { token: 'empty' }, value: { fp: null } })
  }
  const toRead: Key[] = []
  for (const key of new Set([...known.keys(), ...[...base].filter((k) => ownOf(k) === null)])) {
    const row = known.get(key)
    const token = row?.fields?.token
    if (d.skip.has(key)) map.skip.add(key)
    else if (d.gone.has(key)) absent(key)
    else if (row === undefined || token === undefined || d.changed.has(key) || overlaid.has(key)) toRead.push(key)
    else if (row.value.fp === null) map.expects.set(key, 'empty')
    else {
      map.files.set(key, row.value.fp)
      map.expects.set(key, row.value.level ?? token)
    }
  }
  const deepOf = new Map<Key, string>()
  for (const [place, deep] of d.changed) if (deep !== undefined) deepOf.set(place as Key, deep)
  const unlooked = toRead.filter((key) => !d.changed.has(key))
  for (let i = 0; i < unlooked.length; i += LOOK_AT_ONCE) {
    const looked = await store.look(unlooked.slice(i, i + LOOK_AT_ONCE).map((place) => ({ place, token: 'empty' })), { deep: true })
    for (const c of looked.changed) if (c.deep !== undefined) deepOf.set(c.place as Key, c.deep)
  }
  await eachAtMost(toRead, async (key) => {
    const c = await store.content(key)
    if (isFailure(c)) {
      if (c.reason === 'no_such_place') absent(key)
      else map.skip.add(key)
      return
    }
    map.files.set(key, c.fingerprint)
    map.expects.set(key, c.token)
    const deep = c.kind === 'dir' ? deepOf.get(key) : undefined
    if (map.tracked.has(key)) out.set(THINGS, key, { fields: { token: deep ?? c.token }, value: { fp: c.fingerprint, ...(c.kind === 'dir' ? { level: c.token } : {}) } })
  })
}

/**
 * The own content of the record place `place` here, its directories under `caches` left out, into
 * `map`. The first time, every level of it is listed once; after that, a file whose token differs is
 * read again, and a directory whose token differs is listed again, that level only: what has no row in
 * it is new. `out` keeps a row per file and directory.
 */
export async function localOwn(ctx: PluginContext, place: string, caches: readonly string[], out: Change, map: LocalMap): Promise<void> {
  const store = ctx.tools.storage.recordPlace(place).own
  const table = ownTable(place)
  const rows = new Map<Place, Row<OwnRow>>()
  for await (const r of out.all<OwnRow>(table)) rows.set(r.key, r)
  const toRead: Place[] = []

  const list = async (dir: Place): Promise<void> => {
    const [g] = await store.glance([dir])
    if (g === undefined || !isDescribed(g) || g.kind !== 'dir' || g.token === undefined) return
    const entries = []
    for (let after: string | undefined; ; ) {
      const page = await store.overview(dir, { limit: LEVEL_PAGE, ...(after === undefined ? {} : { after }) })
      if (isFailure(page)) return
      entries.push(...page.entries)
      if (page.more === null) break
      after = page.more.after
    }
    const row = { fields: { token: g.token }, value: { dir: true as const } }
    out.set(table, dir, row)
    rows.set(dir, { key: dir, ...row })
    for (const e of entries) {
      if (rows.has(e.place) || inCache(e.place, caches)) continue
      if (e.kind === 'dir') await list(e.place)
      else if (e.kind === 'file') toRead.push(e.place)
    }
  }

  if (!rows.has('')) await list('')
  else {
    const d = await differences(store, table)
    for (const own of d.gone) {
      out.set(table, own, null)
      rows.delete(own)
    }
    for (const own of d.skip) map.skip.add(ownKey(place, own))
    for (const own of d.changed.keys()) {
      const row = rows.get(own)
      if (row !== undefined && 'dir' in row.value) await list(own)
      else toRead.push(own)
    }
  }
  await eachAtMost(toRead, async (own) => {
    const c = await store.content(own)
    if (isFailure(c) || c.kind !== 'file') {
      if (!isFailure(c) || c.reason === 'no_such_place') {
        out.set(table, own, null)
        rows.delete(own)
      } else map.skip.add(ownKey(place, own))
      return
    }
    const row = { fields: { token: c.token }, value: { fp: c.fingerprint } }
    out.set(table, own, row)
    rows.set(own, { key: own, ...row })
  })
  for (const [own, row] of rows) {
    if (!('fp' in row.value) || row.fields?.token === undefined) continue
    const key = ownKey(place, own)
    map.files.set(key, row.value.fp)
    map.expects.set(key, row.fields.token)
    map.tracked.add(key)
  }
}

/**
 * The library as a side the plan's steps use. A staged copy goes to the target's temporary folder
 * (`read` with `to`, a directory thing file by file from its manifest) and is checked against the
 * fingerprint the plan saw; a write expects the state the plan saw, holds the place while it writes,
 * and makes a directory thing one again with the kernel's marker. What it wrote goes to `out`.
 */
export function localSide(ctx: PluginContext, target: TargetDir, map: LocalMap, out: Change): SideIO {
  const storage = ctx.tools.storage
  type Where = {
    store: PlaceReader
    place: Place
    own: { place: string; own: Place } | null
    write(from: string, expect: Expect, hold: string | undefined): Promise<Written | StorageFailure>
    remove(expect: string, hold: string | undefined): Promise<{ removed: true } | StorageFailure>
  }
  // A thing is written as sync's own write in the content; a record place's own file is copied in through the carrier.
  const at = (key: Key): Where => {
    const own = ownOf(key)
    const opts = (hold: string | undefined) => (hold === undefined ? {} : { hold })
    if (own === null) {
      return { store: storage, place: key, own, write: (from, expect, hold) => storage.write(key, { path: from }, expect, opts(hold)), remove: (expect, hold) => storage.remove(key, expect, opts(hold)) }
    }
    const carrier = storage.carry(own.place)
    return { store: storage.recordPlace(own.place).own, place: own.own, own, write: (from, expect) => carrier.copy(own.own, from, expect), remove: (expect) => carrier.remove(own.own, expect) }
  }
  const settle = (key: Key, token: string | undefined, fp: Fingerprint | null) => {
    const own = ownOf(key)
    map.expects.set(key, token ?? 'empty')
    if (own !== null) out.set(ownTable(own.place), own.own, fp === null || token === undefined ? null : { fields: { token }, value: { fp } })
    else if (fp !== null || map.tracked.has(key)) {
      out.set(THINGS, key, { fields: token === undefined ? {} : { token }, value: { fp } })
      map.tracked.add(key)
    }
    return true
  }
  const holding = async <T>(key: Key, work: (hold: string | undefined) => Promise<T | false>): Promise<T | false> => {
    if (ownOf(key) !== null) return work(undefined)
    const held = await storage.hold([key])
    if (isFailure(held)) return false
    try {
      return await work(held.hold)
    } finally {
      await storage.release(held.hold)
    }
  }

  return {
    async stage(key, fp) {
      const { store, place, own } = at(key)
      const [g] = await store.glance([place])
      if (g === undefined || !isDescribed(g) || (g.kind !== 'file' && g.kind !== 'dir')) return null
      const staged: Staged = { path: target.scratch(), dir: g.kind === 'dir' }
      const taken = async (): Promise<boolean> => {
        if (!staged.dir) return !isFailure(await store.read(place, { to: staged.path }))
        for (let after: string | undefined; ; ) {
          const c = await store.content(place, { manifest: { limit: MANIFEST_PAGE, ...(after === undefined ? {} : { after }) } })
          if (isFailure(c) || c.kind !== 'dir' || c.fingerprint !== fp) return false
          for (const e of c.manifest?.entries ?? []) {
            const to = join(staged.path, ...e.path.split('/'))
            target.prepare(to)
            if (isFailure(await store.read(`${place}/${e.path}`, { to }))) return false
          }
          if (!c.manifest?.more) break
          after = c.manifest.more.after
        }
        if (own === null) target.mark(staged)
        return true
      }
      if ((await taken()) && target.fingerprintOf(staged) === fp) return staged
      target.discard(staged)
      return null
    },

    place: (key, staged, fp) =>
      holding(key, async (hold) => {
        const where = at(key)
        const { store, place, own } = where
        const written = await where.write(staged.path, map.expects.get(key) ?? 'empty', hold)
        if (isFailure(written)) {
          if (written.reason !== 'refused') return false
          const c = await store.content(place)
          return !isFailure(c) && c.fingerprint === fp && settle(key, c.token, c.fingerprint)
        }
        if (!staged.dir || own !== null) return settle(key, written.entry.token, written.fingerprint)
        if (isFailure(await ctx.tools.markBundle(key, hold === undefined ? {} : { hold }))) {
          // The content is in place without its marker: the next run reads it again.
          settle(key, undefined, written.fingerprint)
          return false
        }
        const [g] = await store.glance([place])
        return settle(key, g !== undefined && isDescribed(g) ? g.token : undefined, written.fingerprint)
      }),

    remove: (key) =>
      holding(key, async (hold) => {
        const expect = map.expects.get(key)
        if (expect === undefined || expect === 'empty') return false
        if (isFailure(await at(key).remove(expect, hold))) return false
        return settle(key, 'empty', null)
      }),
  }
}

/** The keys whose rows say something was there that storage now says is gone: things, and the own files of `places`. */
export async function goneKeys(ctx: PluginContext, places: Iterable<string>): Promise<Set<Key>> {
  const out = new Set<Key>((await differences(ctx.tools.storage, THINGS)).gone as Set<Key>)
  for (const place of places) for (const own of (await differences(ctx.tools.storage.recordPlace(place).own, ownTable(place))).gone) out.add(ownKey(place, own))
  return out
}
