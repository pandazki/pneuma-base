// Held copies: content a new version replaced, kept in the ledger's own place under held/ until the
// owner drops it, and the owner commands over them. Every copy goes through storage: into the own place
// from the content, and back from the own place to a new path. ledger-design.md section 5.
import { posix, relative, sep } from 'node:path'
import {
  BUNDLE_MARKER,
  defineCommand,
  isDescribed,
  isFailure,
  type Description,
  type Fingerprint,
  type LibraryPath,
  type OwnerAnswer,
  type OwnerCommand,
  type Place,
  type PluginContext,
} from '@pneuma-base/kernel'
import { fact, newItemId, writeFacts, type ItemId } from './facts.js'
import { stateOf } from './look.js'
import { heldKey, type HeldRow, type ItemRow } from './model.js'
import { counters, getAll, heldOf, itemNamed } from './queries.js'
import { pagesOf } from './rows.js'

const HELD_DIR = 'held'

/** Where the held copy of a version of `item` lies in the ledger's own place. */
export const heldPlace = (item: ItemId, key: string, path: LibraryPath): Place => posix.join(HELD_DIR, item, key, posix.basename(path))

/** A place of the ledger's own as the facts name it: relative to the library root. */
const fromRoot = (ctx: PluginContext, place: Place) => posix.join(relative(ctx.library.root, ctx.dir).split(sep).join('/'), place)

/** The key of the version a token names: its fingerprint when given, else the item's on record when the token is the one recorded. */
export const keyOf = (item: ItemRow | undefined, token: string, fingerprint: Fingerprint | null) => heldKey(fingerprint ?? (item?.token === token ? item.fingerprint : null), token)

/** Where the held copy of the version `token` of `item` lies, relative to the library root, as the revise fact names it. */
export const heldPath = (ctx: PluginContext, item: ItemId, key: string, path: LibraryPath) => fromRoot(ctx, heldPlace(item, key, path))

/**
 * Copies the thing at `path`, a file or a whole directory-thing, into the held copy of its version,
 * through storage. Null, and nothing kept, when what was copied is not the content `fingerprint` says
 * because it changed meanwhile. A copy already held is kept as it is.
 */
export async function keep(ctx: PluginContext, item: ItemId, path: LibraryPath, key: string, fingerprint: Fingerprint | null): Promise<string | null> {
  const own = ctx.tools.storage.own
  const place = heldPlace(item, key, path)
  const [there] = await own.glance([place])
  if (there && isDescribed(there) && there.kind !== 'none') return fromRoot(ctx, place)
  const written = await own.write(place, { place: path }, 'empty')
  if (isFailure(written)) return null
  if (fingerprint !== null && written.fingerprint !== fingerprint) {
    await own.remove(place, written.entry.token ?? '')
    return null
  }
  return fromRoot(ctx, place)
}

/** The marker the kernel writes in a directory-thing (things.ts), whose content is not the thing's. */
const MARKER_TEXT = `${JSON.stringify({ format: 1 })}\n`

/** Marks a directory written back from a held copy as one thing; answers what it is then. */
async function marked(ctx: PluginContext, dir: LibraryPath): Promise<Description> {
  const store = ctx.tools.storage
  await store.write(`${dir}/${BUNDLE_MARKER}`, { data: MARKER_TEXT }, 'empty')
  const [now] = await store.glance([dir])
  return now && isDescribed(now) ? now : { place: dir, kind: 'dir' }
}

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

export const HELD_RESTORE = defineCommand({
  name: 'ledger held restore',
  summary: '把一份留存取回到一个新路径',
  params: {
    positional: [{ name: 'item', hint: '库内路径或条目号', required: true }],
    flags: [
      { name: 'fingerprint', hint: '指纹', kind: 'value' },
      { name: 'to', hint: '新的库内路径', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: true,
  async run({ item: input, fingerprint: want, to }, ctx) {
    await stateOf(ctx)
    const store = ctx.tools.storage
    const item = await itemNamed(ctx, input)
    if (!item) return refused('no-such-item', `库里没有这样东西：${input}`)
    const copies = await heldOf(store.records, item.id)
    // Without --fingerprint, the content most recently replaced.
    const latest = [...copies].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
    const chosen = want === null ? (latest ? [latest] : []) : copies.filter((c) => c.key.startsWith(want))
    const copy = chosen[0]
    if (!copy || chosen.length > 1) return refused('no-such-held', `${item.path} 没有${want === null ? '' : `指纹以 ${want} 开头的唯一一份`}留存`)
    const target = await ctx.tools.resolve(to)
    if (target === null || target.region !== 'content') return refused('outside-library', `${to} 不在库的内容里`)
    if (target.bundle !== null) return refused('inside-bundle', `${target.path} 在 ${target.bundle} 里面，${target.bundle} 是一样东西。换一个路径。`)
    const [there] = await store.glance([target.path])
    if (there && (!isDescribed(there) || there.kind !== 'none')) {
      const now = copy.fingerprint === null ? null : await store.content(target.path)
      if (now !== null && !isFailure(now) && now.fingerprint === copy.fingerprint) return done(`${target.path} 已经是这份内容，没有复制。`)
      return refused('would-overwrite', `${target.path} 已有东西，没有动它。换一个路径。`)
    }
    const written = await store.write(target.path, { place: copy.place, own: true }, 'empty')
    if (isFailure(written)) {
      if (written.reason === 'refused') return refused('would-overwrite', `${target.path} 已有东西，没有动它。换一个路径。`)
      return refused(written.reason, `没能取回（${written.reason}）：${copy.place}`)
    }
    const short = copy.key.slice(0, 8)
    const origin = { kind: 'brought' as const, source: `留存：${item.path} 换下的旧内容 ${short}`, by: 'owner' }
    const bundle = written.entry.kind === 'dir'
    // A directory-thing's marker is no content, so the copy came without it: it is one thing again once marked.
    const entry = bundle ? await marked(ctx, target.path) : written.entry
    const enter = {
      kind: 'item.enter' as const,
      item: newItemId(),
      path: target.path,
      fingerprint: written.fingerprint,
      size: bundle ? written.bytes : (entry.size ?? written.bytes),
      ...(entry.token === undefined ? {} : { token: entry.token }),
      ...(entry.modified === undefined ? {} : { modified: entry.modified }),
      origin,
      ...(bundle ? { bundle: true as const } : {}),
    }
    await writeFacts(ctx, [fact(ctx, 'tool', enter)])
    return done(`已把 ${item.path} 换下的旧内容 ${short} 从留存取回到 ${target.path}。`, { item: item.id, fingerprint: copy.fingerprint, key: copy.key, to: target.path })
  },
})

export const HELD_DROP = defineCommand({
  name: 'ledger held drop',
  summary: '清掉全部留存',
  params: {},
  destructive: true,
  ownerOnly: true,
  async run(_values, ctx) {
    await stateOf(ctx)
    const own = ctx.tools.storage.own
    const n = (await counters(ctx.tools.storage.records)).held ?? 0
    const [there] = await own.glance([HELD_DIR])
    if (there && isDescribed(there) && there.kind !== 'none') {
      const gone = await own.remove(HELD_DIR, there.token ?? '')
      if (isFailure(gone)) return refused(gone.reason, `没能清掉留存（${gone.reason}），稍后再试。`)
    }
    return done(`已清掉 ${n} 份留存。`, { dropped: n })
  },
})

/** How many held copies `ledger held list` and the held page name at most. */
export const HELD_SHOWN = 200

/** How many held copies `ledger held list` names before it gives the total and the command for the rest. */
const LISTED = 20

/** The held copies, at most `limit` after `after`, with the items they are of, how many there are, and the cursor of the ones that follow. */
export async function heldCopies(ctx: PluginContext, limit = HELD_SHOWN, after?: string): Promise<{ copies: (HeldRow & { current: ItemRow | undefined })[]; total: number; next: string | null }> {
  const records = ctx.tools.storage.records
  const rows: HeldRow[] = []
  let next: string | null = null
  if (limit <= 1000) {
    const page = await records.under<HeldRow>('held', '', { limit, ...(after === undefined ? {} : { after }) })
    rows.push(...page.rows.map((r) => r.value))
    next = page.more?.after ?? null
  } else {
    for await (const page of pagesOf<HeldRow>(records, 'held', '', 1000, after)) {
      rows.push(...page.map((r) => r.value))
      if (rows.length >= limit) break
    }
  }
  const items = await getAll<ItemRow>(records, 'items', rows.map((r) => r.item))
  return { copies: rows.slice(0, limit).map((r) => ({ ...r, current: items.get(r.item) })), total: (await counters(records)).held ?? rows.length, next }
}

/** `ledger held list`, `ledger held restore`, `ledger held drop`: the owner's commands over held copies. */
export const heldCommands: OwnerCommand[] = [
  defineCommand({
    name: 'ledger held list',
    summary: '列出留存：被新内容换下来的旧内容',
    params: { flags: [{ name: 'all', hint: '全部列出，不只前 20 份', kind: 'boolean' }] },
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run({ all }, ctx) {
      await stateOf(ctx)
      const { copies, total } = await heldCopies(ctx, all ? Number.MAX_SAFE_INTEGER : LISTED)
      const data = copies.map((c) => ({ item: c.item, key: c.key, fingerprint: c.fingerprint, path: c.path, current: c.current?.path ?? null }))
      if (copies.length === 0) return done('没有留存。', { copies: data })
      const lines = copies.map((c) => `${c.current?.path ?? c.item}  留存 ${c.key.slice(0, 8)}  ${c.path}`)
      const more = total > copies.length ? [`……共 ${total} 份，看全部：ledger held list --all`] : []
      return done([...lines, ...more].join('\n'), { copies: data, total })
    },
  }),
  HELD_RESTORE,
  HELD_DROP,
]
