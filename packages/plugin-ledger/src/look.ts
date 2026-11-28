// How the library stands, on the sparse rules (ARCHITECTURE.md「怎么看库」): what
// changed is learned from storage's cursor, and only the registered things at or in those places and
// those open directories are looked at; when storage cannot say, storage compares every registered
// place and every open directory with what the rows expect there (`lookRows` over `tokens` and `seen`)
// and answers what differs, never a walk. A token that differs is decided by content only where the
// thing has a fingerprint to compare with; a directory nobody looked into stays one entry of the level
// above; noise is never mentioned, since storage leaves it out.
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isDescribed, isFailure, regionOf, type ContentAnswer, type Description, type Glanced, type LibraryPath, type Looked, type Place, type PluginContext } from '@pneuma-base/kernel'
import { FACT_PAGE, isFact, type ItemId } from './facts.js'
import { foldFacts, foldOut, type FoldOut } from './fold.js'
import { ancestors, expectations, live, nameOf, parentOf, putItem, putSeen, ROWS_VERSION, unlisted, type Entry, type ItemRow, type MarkRow, type SeenRow } from './model.js'
import { pagesOf, PUT_ROWS, Tx, wherePages } from './rows.js'
import { settle, settling, type Settling } from './settle.js'
import type { LastLook } from './views.js'

/** How many entries of a directory one look lists. */
export const OVERVIEW = 200
/** How many registered things one look asks storage about when it names them. */
const LOOK_PAGE = 500
/** More changed places than this are not worth following one by one: every registered place is compared. */
const PLACES_MAX = 1000
/** How many contents are read at once. */
const AT_ONCE = 8

const described = (g: Glanced | undefined): Description | null => (g === undefined || !isDescribed(g) || g.kind === 'none' ? null : g)
const entryOf = (d: Description): Entry => ({ name: nameOf(d.place), kind: d.kind, size: d.size ?? null, modified: d.modified ?? null, token: d.token ?? null, ...(d.held ? { held: true as const } : {}) })
const NOTHING_LOOKED: Looked = { same: 0, changed: [], gone: [], failed: [], held: [] }

/** What storage said differs among the places a look compared: what is there instead, gone, not readable, being written. */
type Differences = { changed: Map<Place, Description>; gone: Set<Place>; failed: Set<Place>; held: Set<Place> }
const differencesOf = (looked: Looked): Differences => ({
  changed: new Map(looked.changed.map((c) => [c.place, c.entry])),
  gone: new Set(looked.gone),
  failed: new Set(looked.failed.map((f) => f.place)),
  held: new Set(looked.held),
})

export async function eachAtMost<T>(list: readonly T[], limit: number, f: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) await f(list[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
}

// ---- the rows brought up to the facts ----

/**
 * Folds every fact after the rows' cursor, a page at a time, each page settled and saved with its
 * cursor; with no rows, rebuilds them (`rebuild`), or waits for the process that does. Answers the
 * cursor the rows stand at.
 */
export async function foldAll(ctx: PluginContext, out: FoldOut = foldOut()): Promise<string | null> {
  const records = ctx.tools.storage.records
  for (let tries = 0; ; tries++) {
    const { rows, cursor } = await records.get<unknown>('meta', ['version', 'build'])
    const meta = new Map(rows.map((r) => [r.key, r.value]))
    const build = meta.get('build') as Build | undefined
    if (build !== undefined) {
      // Another rebuild holds the rows: wait for it; one that stopped part way is started again.
      if (running(build)) await awaitBuild(ctx)
      else await records.reset()
      continue
    }
    if (cursor === null) {
      const built = await rebuild(ctx, out)
      if (built !== null) return built
      continue
    }
    if (meta.get('version') !== ROWS_VERSION) {
      await records.reset()
      continue
    }
    const page = await records.since(cursor, FACT_PAGE)
    if (page === null) {
      // The facts the rows came from are not there any more: derive everything again.
      await records.reset()
      continue
    }
    const facts = page.facts.flatMap(({ fact }) => (isFact(fact) ? [fact] : []))
    if (facts.length === 0 && page.cursor === cursor) return cursor
    const tx = new Tx(records)
    await foldFacts(tx, facts, out)
    await settle(tx, out)
    if (await tx.commit(page.cursor, cursor)) {
      if (!page.more) return page.cursor
    } else if (tries > 20) throw new Error('溯源索引持续被其他进程改写，无法读取一致的状态')
  }
}

// ---- the rows derived again from nothing ----

/** A rebuild under way, as its row `meta/build` says: its claim, which process on which machine, its last sign of life, how far. */
type Build = { claim: string; machine: string; pid: number; at: string; facts: number | null; done: number }

/** A rebuild that has given no sign of life for this long stopped. */
const BUILD_SILENT_MS = 60_000
/** How often a rebuild gives a sign of life, and how often a process waiting for one looks. */
const HEARTBEAT_MS = 2_000
const AWAIT_MS = 200
/** How many rows a rebuild keeps in memory; past that it saves them and reads them back from storage. */
const REBUILD_ROWS = 1_000_000
/** Rebuilds of fewer facts files than this pass without a word. */
const SAY_FROM = 5_000
/** How often a rebuild says how far it is. */
const SAY_EVERY_MS = 1_000
/** Tables the fold writes and never reads: a rebuild saves them while it reads on (they hold almost half the bytes). */
const WRITTEN_ONLY = ['log', 'acts', 'find', 'bytime', 'sceneOrder', 'hrev']

/** Whether the process holding a rebuild is still at it: a sign of life lately, and on this machine, the process is there. */
function running(build: Build): boolean {
  if (Date.now() - Date.parse(build.at) > BUILD_SILENT_MS) return false
  if (build.machine !== hostname()) return true
  try {
    process.kill(build.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What a rebuild says while it runs, on standard error; the one place a progress channel would take it from. */
const say = (text: string) => void process.stderr.write(`${text}\n`)
const howMany = (facts: number | null) => (facts === null ? '' : `：至少 ${facts} 条记录`)
const progressLine = (done: number, facts: number | null) => (facts !== null && done < facts ? `已处理 ${done} / ${facts}` : `已处理 ${done}`)

/** Waits while another process rebuilds the rows, saying what it says. */
async function awaitBuild(ctx: PluginContext): Promise<void> {
  const records = ctx.tools.storage.records
  let said = false
  let told = 0
  for (;;) {
    const { rows } = await records.get<Build>('meta', ['build'])
    const build = rows[0]?.value
    if (build === undefined || !running(build)) {
      if (said && build === undefined) say('溯源索引已重建。')
      return
    }
    if (!said && (build.facts ?? 0) >= SAY_FROM) {
      say(`另一个进程正在重建溯源索引${howMany(build.facts)}。`)
      said = true
    } else if (said && build.done > told) {
      told = build.done
      say(progressLine(build.done, build.facts))
    }
    await new Promise((resolve) => setTimeout(resolve, AWAIT_MS))
  }
}

/**
 * Derives the rows from every fact, with none to start from (another machine's library just synced
 * in, rows of another shape, the cache deleted). It first claims the rows: `meta/build`, saved over no
 * cursor, so of two processes one rebuilds and the other waits for it. Storage holds nothing else, so
 * the fold reads no row from it: every row is in memory until the end (or `REBUILD_ROWS`), and the
 * facts' next page is read while this one folds. The rows are saved in parts under the claim, the
 * last with the cursor and without the claim. Answers that cursor, or null when the claim was lost
 * or the facts changed under it: the caller looks again.
 */
async function rebuild(ctx: PluginContext, out: FoldOut): Promise<string | null> {
  const records = ctx.tools.storage.records
  const claim = `rebuild:${randomUUID()}`
  const lease = (done: number, facts: number | null): Build => ({ claim, machine: hostname(), pid: process.pid, at: new Date().toISOString(), facts, done })
  if (!(await records.put({ meta: [{ key: 'build', value: lease(0, null) }] }, { cursor: claim, expect: null })).written) return null
  const started = performance.now()
  let tx = new Tx(records, true)
  tx.set('meta', 'version', ROWS_VERSION)
  putSeen(tx, '', unlisted())
  let page = await records.since(null, FACT_PAGE)
  const facts = page?.files ?? null
  const telling = (facts ?? 0) >= SAY_FROM
  if (telling) {
    say(`正在重建溯源索引${howMany(facts)}。`)
    // A process that waits says the same at once.
    if (!(await records.put({ meta: [{ key: 'build', value: lease(0, facts) }] }, { cursor: claim, expect: claim })).written) return null
  }
  let done = 0
  let [beat, told] = [started, started]
  // Saving what the fold only writes, a put at a time, beside the reading and folding.
  let saving = Promise.resolve(true)
  const saveWrittenOnly = () => {
    const rows = tx.takeOut(WRITTEN_ONLY)
    saving = saving.then(async (ok) => ok && (await records.put(rows, { expect: claim })).written)
  }
  for (;;) {
    if (page === null) {
      // The facts changed under the read: start again from nothing.
      await records.reset()
      return null
    }
    const next = page.more ? records.since(page.cursor, FACT_PAGE) : null
    await foldFacts(tx, page.facts.flatMap(({ fact }) => (isFact(fact) ? [fact] : [])), out)
    await settle(tx, out)
    done += page.facts.length
    if (next === null) break
    if (tx.writtenTo(WRITTEN_ONLY) >= PUT_ROWS) saveWrittenOnly()
    if (tx.size > REBUILD_ROWS) {
      if (!(await saving) || !(await tx.commitInParts(claim, claim))) return null
      tx = new Tx(records)
    }
    const now = performance.now()
    if (now - beat >= HEARTBEAT_MS) {
      beat = now
      if (!(await records.put({ meta: [{ key: 'build', value: lease(done, facts) }] }, { cursor: claim, expect: claim })).written) return null
    }
    if (telling && now - told >= SAY_EVERY_MS) {
      told = now
      say(progressLine(done, facts))
    }
    page = await next
  }
  tx.set('meta', 'build', null)
  if (!(await saving) || !(await tx.commitInParts(page.cursor, claim))) return null
  if (telling) say(`溯源索引已重建：${done} 条记录，${((performance.now() - started) / 1000).toFixed(1)} 秒。`)
  return page.cursor
}

/** The rows brought up to the facts, nothing looked at. */
export async function stateOf(ctx: PluginContext): Promise<void> {
  await foldAll(ctx)
}

/**
 * Runs `work` on one change to the rows, after folding what came, and saves it with the facts that
 * landed meanwhile folded on top: what they name is judged by its record, whatever the work found.
 * Runs again when another process saved first. `mark`: storage's change mark to keep with it.
 */
export async function inTx(ctx: PluginContext, work: (tx: Tx, settling: Settling, out: FoldOut) => Promise<void>, mark?: string): Promise<void> {
  const records = ctx.tools.storage.records
  for (let tries = 0; ; tries++) {
    const out = foldOut()
    const cursor = await foldAll(ctx, out)
    const tx = new Tx(records)
    const touched = settling()
    await work(tx, touched, out)
    const page = await records.since(cursor, FACT_PAGE)
    if (page !== null && !page.more) {
      const landed = foldOut()
      await foldFacts(tx, page.facts.flatMap(({ fact }) => (isFact(fact) ? [fact] : [])), landed)
      for (const id of landed.remark) touched.remark.add(id)
      for (const dir of landed.restray) touched.restray.add(dir)
      for (const path of landed.released) touched.released.add(path)
      if (mark !== undefined) tx.set('meta', 'mark', mark)
      await settle(tx, touched)
      if (await tx.commit(page.cursor, cursor)) return
    }
    if (tries > 5) throw new Error('溯源索引持续被其他进程改写，无法保存本次检查结果')
  }
}

// ---- looking at places ----

type Store = PluginContext['tools']['storage']

/** A thing's state, setting free the stray a move had taken. */
function setState(tx: Tx, settling: Settling, item: ItemRow, state: ItemRow['state'], now: ItemRow['now'] = null, to: LibraryPath | null = null): void {
  if (item.state === 'moved' && item.to !== null && item.to !== to) {
    tx.set('taken', item.to, null)
    settling.restray.add(parentOf(item.to))
  }
  Object.assign(item, { state, now, to })
  putItem(tx, item)
  settling.remark.add(item.id)
}

/** A directory's first level as a directory-thing's record keeps it. */
async function levelOf(store: Store, path: LibraryPath): Promise<ItemRow['entries']> {
  const page = await store.overview(path, { limit: OVERVIEW })
  return isFailure(page) ? [] : page.entries.map((e) => ({ name: nameOf(e.place), token: e.token ?? '' }))
}

/** Takes what storage says is at the thing's place as what was recorded there: its token, moment and size, and a directory-thing's first level. */
export async function takeAsRecorded(store: Store, tx: Tx, settling: Settling, item: ItemRow, d: Description, read?: ContentAnswer): Promise<void> {
  Object.assign(item, { token: read?.token ?? d.token ?? item.token, modified: d.modified ?? item.modified })
  if (!item.bundle) item.size = read?.kind === 'file' ? read.size : (d.size ?? item.size)
  if (read && item.fingerprint === null) item.fingerprint = read.fingerprint
  if (item.bundle) item.entries = await levelOf(store, item.path)
  // The same version under a new token: the latest version is known by it from now on.
  item.last = { ...item.last, token: item.token, fingerprint: item.last.fingerprint ?? item.fingerprint }
  setState(tx, settling, item, 'consistent')
}

/** Whether a changed thing's content is worth reading: it has a fingerprint to compare with, or a made thing recorded one of it. */
async function wantsContent(tx: Tx, item: ItemRow): Promise<boolean> {
  if (item.fingerprint !== null) return true
  for (const d of (await tx.getMany<ItemRow>('items', item.dependents)).values()) if (d.basis.items.some((r) => r.item === item.id && r.fingerprint !== null)) return true
  return false
}

/** A thing whose token differs: decided by content when there is a fingerprint to decide by, else changed. */
async function judge(store: Store, tx: Tx, settling: Settling, item: ItemRow, d: Description): Promise<void> {
  if (d.kind !== (item.bundle ? 'dir' : 'file')) return setState(tx, settling, item, 'changed', { token: d.token ?? null, fingerprint: null })
  if (!item.bundle && item.token === null && item.fingerprint === null) return takeAsRecorded(store, tx, settling, item, d)
  if (!(await wantsContent(tx, item))) {
    if (item.token === null) return takeAsRecorded(store, tx, settling, item, d)
    return setState(tx, settling, item, 'changed', { token: d.token ?? null, fingerprint: null })
  }
  const read = await store.content(item.path)
  if (isFailure(read)) return setState(tx, settling, item, 'changed', { token: d.token ?? null, fingerprint: null })
  if (item.fingerprint !== null && read.fingerprint === item.fingerprint) return takeAsRecorded(store, tx, settling, item, d, read)
  if (item.fingerprint === null && item.token === null) return takeAsRecorded(store, tx, settling, item, d, read)
  setState(tx, settling, item, 'changed', { token: read.token, fingerprint: read.fingerprint })
}

/**
 * What storage says of these things against their records, asked with the tokens on record (a
 * directory-thing's first level with it): a thing whose token is unknown is glanced at, and differs.
 */
async function compareItems(store: Store, items: readonly ItemRow[]): Promise<Differences> {
  const looks: { place: Place; token: string }[] = []
  const glances: Place[] = []
  for (const item of items) {
    if (item.token === null) glances.push(item.path)
    else looks.push({ place: item.path, token: item.token }, ...(item.entries ?? []).map((e) => ({ place: `${item.path}/${e.name}`, token: e.token })))
  }
  const [looked, glanced] = await Promise.all([looks.length > 0 ? store.look(looks) : NOTHING_LOOKED, glances.length > 0 ? store.glance(glances) : ([] as Glanced[])])
  const out = differencesOf(looked)
  for (const g of glanced) {
    const d = described(g)
    if (!isDescribed(g)) out.failed.add(g.place)
    else if (d === null) out.gone.add(g.place)
    else {
      if (d.held) out.held.add(g.place)
      out.changed.set(g.place, d)
    }
  }
  return out
}

/**
 * Looks at these registered things: what storage said differs among their places (asked here with their
 * records when not given), a directory-thing's first level with it. A thing named in none of the
 * differences is as recorded; a thing being written now is judged by its record. `within`: the
 * directory-things the change log named a place deep inside, judged as changed whatever their level says.
 */
export async function lookItems(store: Store, tx: Tx, settling: Settling, items: readonly ItemRow[], given?: Differences, within: ReadonlySet<Place> = new Set()): Promise<void> {
  const diff = given ?? (await compareItems(store, items))
  const gone = (place: Place) => diff.gone.has(place) || diff.failed.has(place)
  const decide: { item: ItemRow; d: Description }[] = []
  for (const item of items) {
    if (diff.held.has(item.path)) continue
    if (gone(item.path)) {
      setState(tx, settling, item, 'missing')
      continue
    }
    const own = diff.changed.get(item.path)
    if (item.token === null) {
      // No token on record: storage described what is there.
      if (own === undefined) continue
      if (!item.bundle && own.kind === 'file' && item.fingerprint !== null && own.size !== item.size) setState(tx, settling, item, 'changed', { token: own.token ?? null, fingerprint: null })
      else decide.push({ item, d: own })
      continue
    }
    const inner = within.has(item.path) || (item.entries ?? []).some((e) => diff.changed.has(`${item.path}/${e.name}`) || gone(`${item.path}/${e.name}`))
    // A place whose row expected nothing in particular is always answered; its token on record says it is as recorded.
    if ((own === undefined || own.token === item.token) && !inner) {
      if (item.bundle && item.entries === null) item.entries = await levelOf(store, item.path)
      if (item.state !== 'consistent' || item.bundle) setState(tx, settling, item, 'consistent')
      continue
    }
    // Still the content a look found changed before: nothing new to decide.
    if (!inner && item.state === 'changed' && own?.token !== undefined && own.token === item.now?.token) continue
    const d = own ?? described((await store.glance([item.path]))[0])
    if (d === null) setState(tx, settling, item, 'missing')
    else decide.push({ item, d })
  }
  await eachAtMost(decide, AT_ONCE, ({ item, d }) => judge(store, tx, settling, item, d))
}

/** What storage says of these open directories' own levels against their listings; one never listed is glanced at, and differs. */
async function compareDirs(store: Store, dirs: readonly Place[], seen: ReadonlyMap<string, SeenRow>): Promise<Differences> {
  const looks = dirs.flatMap((d) => {
    const token = seen.get(d)?.token ?? ''
    return token === '' ? [] : [{ place: d, token }]
  })
  const glances = dirs.filter((d) => (seen.get(d)?.token ?? '') === '')
  const [looked, glanced] = await Promise.all([looks.length > 0 ? store.look(looks) : NOTHING_LOOKED, glances.length > 0 ? store.glance(glances) : ([] as Glanced[])])
  const out = differencesOf(looked)
  for (const g of glanced) {
    const d = described(g)
    if (!isDescribed(g)) out.failed.add(g.place)
    else if (d === null) out.gone.add(g.place)
    else out.changed.set(g.place, d)
  }
  return out
}

/**
 * Looks at these open directories: what storage said differs among their own levels (asked here when not
 * given). One whose level changed, or never listed, is listed again, one level, its first page; one gone
 * or no directory any more lists nothing.
 */
export async function lookDirs(store: Store, tx: Tx, settling: Settling, dirs: readonly Place[], given?: Differences): Promise<void> {
  if (dirs.length === 0) return
  const seen = await tx.getMany<SeenRow>('seen', dirs)
  const diff = given ?? (await compareDirs(store, dirs, seen))
  const relist: { dir: Place; token: string }[] = []
  for (const dir of dirs) {
    const now = diff.changed.get(dir)
    if (now?.kind === 'dir') {
      relist.push({ dir, token: now.token ?? '' })
      continue
    }
    if (now === undefined && !diff.gone.has(dir) && !diff.failed.has(dir)) continue
    // The directory is not there any more: nothing of it is listed; what was registered in it is missing.
    const was = seen.get(dir)
    if (!was) continue
    putSeen(tx, dir, { ...was, entries: [], more: 0, token: diff.gone.has(dir) ? 'empty' : '' })
    settling.restray.add(dir)
  }
  for (const { dir, token } of relist) {
    const page = await store.overview(dir, { limit: OVERVIEW })
    const was = seen.get(dir)
    const row: SeenRow = isFailure(page)
      ? { token, entries: [], more: 0, unreadable: true, strays: was?.strays ?? [], loose: [] }
      : { token, entries: page.entries.map(entryOf), more: page.more?.at_least ?? 0, strays: was?.strays ?? [], loose: was?.loose ?? [] }
    putSeen(tx, dir, row)
    settling.restray.add(dir)
  }
}

/** The registered things at these places, in them one level down when they are open directories, and above them (a directory-thing a change lies in). */
async function itemsAt(tx: Tx, places: readonly Place[], extra: Iterable<LibraryPath>): Promise<ItemRow[]> {
  const exact = new Set<string>(extra)
  for (const p of places) {
    exact.add(p)
    for (const a of ancestors(p)) exact.add(a)
  }
  const ids = new Set<ItemId>([...(await tx.getMany<{ id: ItemId }>('paths', exact)).values()].map((v) => v.id))
  const open = await tx.getMany<number>('dirs', places)
  for (const p of places.filter((p) => p === '' || open.has(p))) for await (const page of wherePages<{ id: ItemId }>(tx.records, 'paths', 'parent', p)) for (const r of page) ids.add(r.value.id)
  return [...(await tx.getMany<ItemRow>('items', ids)).values()].filter(live)
}

/** The look when storage named what changed: those places and the places the facts named, the open directories among them and their parents, and the directory-things a place lies deep inside (`within`). */
async function lookSome(store: Store, tx: Tx, settling: Settling, places: readonly Place[], named: ReadonlySet<LibraryPath>, within: ReadonlySet<Place>): Promise<void> {
  const dirs = new Set<Place>()
  for (const p of places) {
    dirs.add(p)
    dirs.add(parentOf(p))
  }
  for (const p of named) dirs.add(parentOf(p))
  const open = await tx.getMany<number>('dirs', dirs)
  await lookDirs(store, tx, settling, [...dirs].filter((d) => d === '' || open.has(d)))
  const items = await itemsAt(tx, places, named)
  for (let i = 0; i < items.length; i += LOOK_PAGE) await lookItems(store, tx, settling, items.slice(i, i + LOOK_PAGE), undefined, within)
}

/**
 * Every row of `table` compared by storage with what is there, a page at a time inside storage: what
 * differs. The rows are the look's own expectations (`tokens` for the registered places, `seen` for the
 * open directories' levels), so only the differences cross over.
 */
async function differing(store: Store, table: 'tokens' | 'seen'): Promise<Differences> {
  const out: Differences = { changed: new Map(), gone: new Set(), failed: new Set(), held: new Set() }
  for (let after: string | undefined; ; ) {
    const page = await store.lookRows(table, 'token', after === undefined ? {} : { after })
    const d = differencesOf(page)
    for (const [place, entry] of d.changed) out.changed.set(place, entry)
    for (const set of ['gone', 'failed', 'held'] as const) for (const place of d[set]) out[set].add(place)
    if (page.more === null) return out
    after = page.more.after
  }
}

/** The things whose places storage said differ, by the row of `tokens` that expected each; a row no thing expects any more is dropped. */
async function thingsDiffering(tx: Tx, diff: Differences): Promise<ItemRow[]> {
  const places = [...new Set([...diff.changed.keys(), ...diff.gone, ...diff.failed])]
  const owners = await tx.getMany<ItemId>('tokens', places)
  const items = await tx.getMany<ItemRow>('items', new Set(owners.values()))
  const out = new Map<ItemId, ItemRow>()
  for (const place of places) {
    const item = items.get(owners.get(place) ?? '')
    if (item && expectations(item).some(([p]) => p === place)) out.set(item.id, item)
    else tx.set('tokens', place, null)
  }
  return [...out.values()]
}

/** The look when storage could not say what changed: storage compares every open directory's level and every registered place with what the rows expect, and only what differs is looked at. */
async function lookAll(ctx: PluginContext, mark: string): Promise<void> {
  const store = ctx.tools.storage
  await inTx(
    ctx,
    async (tx, settling) => {
      const dirs = await differing(store, 'seen')
      await lookDirs(store, tx, settling, [...new Set([...dirs.changed.keys(), ...dirs.gone, ...dirs.failed])], dirs)
      const things = await differing(store, 'tokens')
      await lookItems(store, tx, settling, await thingsDiffering(tx, things), things)
      tx.set('meta', LOOKED, { how: 'level', at: ctx.now } satisfies LastLook)
    },
    mark,
  )
}

const LOOKED = 'looked'

/** The look of the operation under way, by library and moment: check and its asks, or the home page and its parts, look once. */
let lastLook: { key: string; answer: Promise<void> } | null = null

/** How the library stands now, in the rows: the facts folded, and what changed since the last look looked at. */
export function refresh(ctx: PluginContext): Promise<void> {
  const key = `${ctx.library.root}\0${ctx.now}\0${ctx.session.id}`
  if (lastLook?.key === key) return lastLook.answer
  const answer = lookNow(ctx)
  lastLook = { key, answer }
  answer.catch(() => {
    if (lastLook?.answer === answer) lastLook = null
  })
  return answer
}

async function lookNow(ctx: PluginContext): Promise<void> {
  const store = ctx.tools.storage
  const out = foldOut()
  await foldAll(ctx, out)
  const mark = (await store.records.get<string>('meta', ['mark'])).rows[0]?.value ?? null
  const changes = await store.changed(mark)
  const places = changes.places?.filter((p) => regionOf(p as LibraryPath) !== 'kernel') ?? null
  if (places === null || places.length > PLACES_MAX || out.overflow) return lookAll(ctx, changes.mark)
  await inTx(
    ctx,
    async (tx, settling, more) => {
      await lookSome(store, tx, settling, places, new Set([...out.voided, ...more.voided]), new Set(changes.within))
      tx.set('meta', LOOKED, { how: 'log', at: ctx.now } satisfies LastLook)
    },
    changes.mark,
  )
}

/** Takes what is at these places now as what was recorded there: after the ledger recorded a put, a claimed change or a move. */
export async function rebase(ctx: PluginContext, paths: readonly LibraryPath[]): Promise<void> {
  if (paths.length === 0) return
  const store = ctx.tools.storage
  await inTx(ctx, async (tx, settling) => {
    const ids = [...(await tx.getMany<{ id: ItemId }>('paths', paths)).values()].map((v) => v.id)
    const items = [...(await tx.getMany<ItemRow>('items', ids)).values()].filter(live)
    const glanced = new Map((await store.glance(items.map((i) => i.path))).map((g) => [g.place, described(g)]))
    for (const item of items) {
      const d = glanced.get(item.path)
      if (d) await takeAsRecorded(store, tx, settling, item, d)
    }
  })
}

/** A moved thing's new place as the look saw it, which check records. */
export type Moved = { item: ItemId; from: LibraryPath; to: LibraryPath; token: string | null; modified: string | null }

/** The things the look found moved, every one of them, a page at a time. */
export async function* movedThings(ctx: PluginContext): AsyncGenerator<Moved[]> {
  const store = ctx.tools.storage
  for (const flag of ['-', 'a']) {
    for await (const page of wherePages<MarkRow>(store.records, 'marks', 'kind', `moved:${flag}`)) {
      const taken = new Map((await store.records.get<{ token: string | null; modified: string | null }>('taken', page.flatMap((r) => (r.value.to ? [r.value.to] : [])))).rows.map((r) => [r.key, r.value]))
      yield page.flatMap(({ value: m }) => (m.item === null || !m.to ? [] : [{ item: m.item, from: m.path, to: m.to, token: taken.get(m.to)?.token ?? null, modified: taken.get(m.to)?.modified ?? null }]))
    }
  }
}

// ---- the named whole pass ----

/** What `check --deep` found: of how many registered things, how many it read before it ended or was stopped; which changed by content, which were only touched (taken as recorded), which it could not read. */
export type Deep = { dir: LibraryPath | null; scope: number; done: number; stopped: boolean; changed: Listed; touched: Listed; failed: Listed }
export type Listed = { count: number; first: LibraryPath[] }
const LISTED = 20
const DEEP_PAGE = 100

const listed = (): Listed => ({ count: 0, first: [] })
const add = (l: Listed, path: LibraryPath) => {
  l.count++
  if (l.first.length < LISTED) l.first.push(path)
}

/** How many registered things lie at or under `dir`, all of them when null. */
export async function scopeOf(ctx: PluginContext, dir: LibraryPath | null): Promise<number> {
  const records = ctx.tools.storage.records
  const counts = (await records.get<Record<string, number>>('meta', ['counts'])).rows[0]?.value ?? {}
  if (dir === null) return ['brought', 'made', 'adopted', 'archived'].reduce((n, c) => n + (counts[`class:${c}`] ?? 0), 0)
  const [below, at] = await Promise.all([records.get<number>('dirs', [dir]), records.get<{ id: ItemId }>('paths', [dir])])
  return (below.rows[0]?.value ?? 0) + at.rows.length
}

/**
 * The named whole pass: reads the content of every registered thing at or under `dir` (a file's bytes,
 * a directory-thing's by the content rule), a page at a time; only the registered things of an open
 * directory, never a directory nobody looked into, never noise. Says how much first (`progress` with
 * nothing done), how far it is after each page, and
 * stops after the page under way when `stop` says so, keeping what it found.
 */
export async function deepPass(ctx: PluginContext, dir: LibraryPath | null, progress: (done: number, scope: number) => void, stop: () => boolean): Promise<Deep> {
  const store = ctx.tools.storage
  await foldAll(ctx)
  const scope = await scopeOf(ctx, dir)
  progress(0, scope)
  const result: Deep = { dir, scope, done: 0, stopped: false, changed: listed(), touched: listed(), failed: listed() }
  const pages = async function* () {
    if (dir !== null) yield [{ key: dir, value: (await store.records.get<{ id: ItemId }>('paths', [dir])).rows[0]?.value }].filter((r) => r.value !== undefined) as { key: string; value: { id: ItemId } }[]
    yield* pagesOf<{ id: ItemId }>(store.records, 'paths', dir === null ? '' : `${dir}/`, DEEP_PAGE)
  }
  for await (const page of pages()) {
    if (page.length === 0) continue
    if (stop()) {
      result.stopped = true
      break
    }
    const found = { changed: [] as LibraryPath[], touched: [] as LibraryPath[], failed: [] as LibraryPath[], done: 0 }
    await inTx(ctx, async (tx, settling) => {
      Object.assign(found, { changed: [], touched: [], failed: [], done: 0 })
      const items = [...(await tx.getMany<ItemRow>('items', page.map((r) => r.value.id))).values()].filter(live)
      await eachAtMost(items, AT_ONCE, async (item) => {
        found.done++
        const read = await store.content(item.path)
        if (isFailure(read)) return void found.failed.push(item.path)
        const d: Description = { place: item.path, kind: item.bundle ? 'dir' : 'file', token: read.token, ...(read.kind === 'file' ? { size: read.size } : {}) }
        if (item.fingerprint !== null) {
          if (read.fingerprint !== item.fingerprint) {
            found.changed.push(item.path)
            return setState(tx, settling, item, 'changed', { token: read.token, fingerprint: read.fingerprint })
          }
          if (read.token !== item.token || item.state !== 'consistent') {
            found.touched.push(item.path)
            await takeAsRecorded(store, tx, settling, item, d, read)
          }
          return
        }
        // No fingerprint on record: the one read now is the record's when the token says nothing changed.
        if (item.token === null || read.token === item.token) await takeAsRecorded(store, tx, settling, item, d, read)
      })
    })
    for (const p of found.changed) add(result.changed, p)
    for (const p of found.touched) add(result.touched, p)
    for (const p of found.failed) add(result.failed, p)
    result.done += found.done
    progress(result.done, scope)
  }
  return result
}
