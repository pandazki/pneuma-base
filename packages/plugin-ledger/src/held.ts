// Held copies: content a new version replaced, kept under held/ until the owner drops it, and the
// owner commands over them. ledger-design.md section 5.
import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import {
  abs,
  copyBundle,
  defineCommand,
  enclosingBundle,
  fingerprintOf,
  parseLibraryPath,
  regionOf,
  thingAt,
  type Fingerprint,
  type LibraryPath,
  type OwnerAnswer,
  type OwnerCommand,
  type PluginContext,
} from '@pneuma-base/kernel'
import { itemNamed, load, onDisk } from './disk.js'
import { fact, newItemId, writeFacts, type ItemId } from './facts.js'

const HELD_DIR = 'held'

const fromRoot = (ctx: PluginContext, ...parts: string[]) => posix.join(relative(ctx.library.root, ctx.dir).split(sep).join('/'), ...parts)

/** Where the content `fingerprint` of `item` is kept, relative to the library root. */
export function heldPath(ctx: PluginContext, item: ItemId, fingerprint: Fingerprint, path: LibraryPath): string {
  return fromRoot(ctx, HELD_DIR, item, fingerprint, posix.basename(path))
}

/** Copies the file or the bundle at `from` to `to`, which must not exist. */
async function copyThing(from: string, to: string): Promise<void> {
  if ((await thingAt(from))?.kind === 'bundle') await copyBundle(from, to)
  else await copyFile(from, to)
}

/**
 * Copies the thing at `path`, a file or a whole bundle, into the held copy of `fingerprint`: to a
 * temporary name, then renamed. Null, and nothing kept, when what was copied is not that content
 * because it changed meanwhile. A copy already held is kept as it is.
 */
export async function keep(ctx: PluginContext, item: ItemId, path: LibraryPath, fingerprint: Fingerprint): Promise<string | null> {
  const held = heldPath(ctx, item, fingerprint, path)
  const target = join(ctx.library.root, held)
  if (await thingAt(target)) return held
  await mkdir(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.tmp-${randomBytes(4).toString('hex')}`)
  try {
    await copyThing(abs(ctx.library.root, path), tmp)
    if ((await fingerprintOf(tmp)) !== fingerprint) return null
    await rename(tmp, target)
    return held
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export type HeldCopy = { item: ItemId; fingerprint: Fingerprint; path: string; size: number; bundle: boolean }

const names = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).sort()

/** The held copies on disk, of one item or of all. `path` is relative to the library root. */
export async function heldCopies(ctx: PluginContext, only?: ItemId): Promise<HeldCopy[]> {
  const root = join(ctx.dir, HELD_DIR)
  const out: HeldCopy[] = []
  for (const item of only ? [only] : ((await names(root)) as ItemId[])) {
    for (const fingerprint of (await names(join(root, item))) as Fingerprint[]) {
      for (const name of await names(join(root, item, fingerprint))) {
        const thing = await thingAt(join(root, item, fingerprint, name))
        if (thing) out.push({ item, fingerprint, path: fromRoot(ctx, HELD_DIR, item, fingerprint, name), size: thing.size, bundle: thing.kind === 'bundle' })
      }
    }
  }
  return out
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
    const { root } = ctx.library
    const ledger = await load(ctx)
    const item = itemNamed(ledger, root, input)
    if (!item) return refused('no-such-item', `库里没有这样东西：${input}`)
    const copies = await heldCopies(ctx, item.id)
    // Without --fingerprint, the content most recently replaced.
    const latest = item.versions.flatMap((v) => (v.held ? [v.held] : [])).reverse().find((held) => copies.some((c) => c.path === held))
    const chosen = want === null ? copies.filter((c) => c.path === latest) : copies.filter((c) => c.fingerprint.startsWith(want))
    const copy = chosen[0]
    if (!copy || chosen.length > 1) return refused('no-such-held', `${item.path} 没有${want === null ? '' : `指纹以 ${want} 开头的唯一一份`}留存`)
    const target = parseLibraryPath(root, to)
    if (target === null || regionOf(target) !== 'content') return refused('outside-library', `${to} 不在库的内容里`)
    const bundle = await enclosingBundle(root, target)
    if (bundle !== null) return refused('inside-bundle', `${target} 在 ${bundle} 里面，${bundle} 是一样东西。换一个路径。`)
    const there = await onDisk(root, target)
    if (there?.fingerprint === copy.fingerprint) return done(`${target} 已经是这份内容，没有复制。`)
    if (there || (await stat(abs(root, target)).catch(() => null))) return refused('would-overwrite', `${target} 已有东西，没有动它。换一个路径。`)
    const tmp = join(ctx.dir, `.tmp-restore-${randomBytes(4).toString('hex')}`)
    await copyThing(join(root, copy.path), tmp)
    await mkdir(dirname(abs(root, target)), { recursive: true })
    try {
      // A file is linked, which fails rather than replace one that appeared meanwhile; a tree is renamed into place.
      if (copy.bundle) await rename(tmp, abs(root, target))
      else await link(tmp, abs(root, target))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
    const short = copy.fingerprint.slice(0, 8)
    const origin = { kind: 'brought' as const, source: `留存：${item.path} 换下的旧内容 ${short}`, by: 'owner' }
    const enter = { kind: 'item.enter' as const, item: newItemId(), path: target, fingerprint: copy.fingerprint, size: copy.size, origin, ...(copy.bundle ? { bundle: true as const } : {}) }
    await writeFacts(ctx, [fact(ctx, 'tool', enter)])
    return done(`已把 ${item.path} 换下的旧内容 ${short} 从留存取回到 ${target}。`, { item: item.id, fingerprint: copy.fingerprint, to: target })
  },
})

export const HELD_DROP = defineCommand({
  name: 'ledger held drop',
  summary: '清掉全部留存',
  params: {},
  destructive: true,
  ownerOnly: true,
  async run(_values, ctx) {
    const copies = await heldCopies(ctx)
    await rm(join(ctx.dir, HELD_DIR), { recursive: true, force: true })
    return done(`已清掉 ${copies.length} 份留存。`, { dropped: copies.length })
  },
})

/** `ledger held list`, `ledger held restore`, `ledger held drop`: the owner's commands over held copies. */
export const heldCommands: OwnerCommand[] = [
  defineCommand({
    name: 'ledger held list',
    summary: '列出留存：被新内容换下来的旧内容',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run(_values, ctx) {
      const ledger = await load(ctx)
      const copies = (await heldCopies(ctx)).map((c) => ({ ...c, current: ledger.items.get(c.item)?.path ?? null }))
      if (copies.length === 0) return done('没有留存。', { copies })
      const lines = copies.map((c) => `${c.current ?? c.item}  留存 ${c.fingerprint.slice(0, 8)}  ${c.size} 字节  ${c.path}`)
      return done(lines.join('\n'), { copies })
    },
  }),
  HELD_RESTORE,
  HELD_DROP,
]
