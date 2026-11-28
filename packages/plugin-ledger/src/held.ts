// Held copies: content a new version replaced, kept in the ledger's own place under held/ until the
// owner drops it, and the owner commands over them. Every copy goes through storage: into the own place
// from the content, and back from the own place to a new path. ARCHITECTURE.md「存放和行」.
import { posix } from 'node:path'
import {
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

/** A place of the ledger's own as the facts name it: relative to the library root, where its record place is. */
const fromRoot = (_ctx: PluginContext, place: Place) => posix.join('.pneuma-base', 'ledger', place)

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

/** Marks a directory written back from a held copy as one thing; answers what it is then. */
async function marked(ctx: PluginContext, dir: LibraryPath): Promise<Description> {
  const store = ctx.tools.storage
  await ctx.tools.markBundle(dir)
  const [now] = await store.glance([dir])
  return now && isDescribed(now) ? now : { place: dir, kind: 'dir' }
}

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

export const HELD_RESTORE = defineCommand({
  name: 'ledger copies restore',
  act: { kind: 'restored', object: 'item' },
  summary: '将一个历史副本恢复到新路径',
  params: {
    positional: [{ name: 'item', hint: '库内路径或条目编号', required: true }],
    flags: [
      { name: 'fingerprint', hint: '内容哈希', kind: 'value' },
      { name: 'to', hint: '新路径', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: true,
  async run({ item: input, fingerprint: want, to }, ctx) {
    await stateOf(ctx)
    const store = ctx.tools.storage
    const item = await itemNamed(ctx, input)
    if (!item) return refused('no-such-item', `条目不存在：${input}`)
    const copies = await heldOf(store.records, item.id)
    // Without --fingerprint, the content most recently replaced.
    const latest = [...copies].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
    const chosen = want === null ? (latest ? [latest] : []) : copies.filter((c) => c.key.startsWith(want))
    const copy = chosen[0]
    if (!copy || chosen.length > 1) return refused('no-such-copy', `${item.path} 无${want === null ? '' : `内容哈希以 ${want} 开头的唯一`}历史副本`)
    const target = await ctx.tools.resolve(to)
    if (target === null || target.region !== 'content') return refused('outside-library', `${to} 不在资料库中`)
    if (target.bundle !== null) return refused('inside-bundle', `${target.path} 位于 ${target.bundle} 内，${target.bundle} 是一个条目。请使用其他路径。`)
    const [there] = await store.glance([target.path])
    if (there && (!isDescribed(there) || there.kind !== 'none')) {
      const now = copy.fingerprint === null ? null : await store.content(target.path)
      if (now !== null && !isFailure(now) && now.fingerprint === copy.fingerprint) return done(`${target.path} 已是此内容，未复制。`)
      return refused('would-overwrite', `${target.path} 已存在，未修改。请使用其他路径。`)
    }
    const written = await store.write(target.path, { place: copy.place, own: true }, 'empty')
    if (isFailure(written)) {
      if (written.reason === 'refused') return refused('would-overwrite', `${target.path} 已存在，未修改。请使用其他路径。`)
      return refused(written.reason, `恢复失败（${written.reason}）：${copy.place}`)
    }
    const short = copy.key.slice(0, 8)
    const origin = { kind: 'brought' as const, source: `历史副本：${item.path} 的旧内容 ${short}`, by: 'owner' }
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
    return done(`已将 ${item.path} 的历史副本 ${short} 恢复到 ${target.path}。`, { item: item.id, fingerprint: copy.fingerprint, key: copy.key, to: target.path })
  },
})

export const HELD_DROP = defineCommand({
  name: 'ledger copies drop',
  act: { kind: 'removed', name: '历史副本' },
  summary: '清除全部历史副本',
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
      if (isFailure(gone)) return refused(gone.reason, `清除历史副本失败（${gone.reason}），请稍后重试。`)
    }
    return done(`已清除 ${n} 个历史副本。`, { dropped: n })
  },
})

/** How many held copies `ledger copies list` and the held page name at most. */
export const HELD_SHOWN = 200

/** How many held copies `ledger copies list` names before it gives the total and the command for the rest. */
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

/** `ledger copies list`, `ledger copies restore`, `ledger copies drop`: the owner's commands over held copies. */
export const heldCommands: OwnerCommand[] = [
  defineCommand({
    name: 'ledger copies list',
    summary: '列出历史副本：条目内容被替换时保存的旧内容',
    params: { flags: [{ name: 'all', hint: '列出全部，不限前 20 个', kind: 'boolean' }] },
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run({ all }, ctx) {
      await stateOf(ctx)
      const { copies, total } = await heldCopies(ctx, all ? Number.MAX_SAFE_INTEGER : LISTED)
      const data = copies.map((c) => ({ item: c.item, key: c.key, fingerprint: c.fingerprint, path: c.path, current: c.current?.path ?? null }))
      if (copies.length === 0) return done('暂无历史副本。', { copies: data })
      const lines = copies.map((c) => `${c.current?.path ?? c.item}  历史副本 ${c.key.slice(0, 8)}  ${c.path}`)
      const more = total > copies.length ? [`……共 ${total} 个，查看全部：ledger copies list --all`] : []
      return done([...lines, ...more].join('\n'), { copies: data, total })
    },
  }),
  HELD_RESTORE,
  HELD_DROP,
]
