// Things nobody registered, settled at once by the owner: the one ask the ledger raises about them,
// and the two owner commands that answer it, register them all as brought in by the owner or leave
// them as they are. A folder that already had files when it became a library starts here.
import { stat } from 'node:fs/promises'
import { abs, defineCommand, formOf, type Action, type LibraryPath, type OwnerAnswer, type OwnerCommand, type PluginAsk, type PluginContext } from '@pneuma-base/kernel'
import { onDisk, unownedNow } from './disk.js'
import { fact, newItemId, writeFacts, type Entered } from './facts.js'
import type { Ledger } from './fold.js'

/** How many things are read at once while registering: enough to keep the disk busy, few enough to keep open files low. */
const AT_ONCE = 32

/** The things nobody registered that the owner has not chosen to leave so. */
async function pileNow(ctx: PluginContext): Promise<{ ledger: Ledger; pile: LibraryPath[] }> {
  const { ledger, unowned } = await unownedNow(ctx)
  return { ledger, pile: unowned.filter((path) => !ledger.left.has(path)) }
}

async function eachAtMost<T, R>(list: readonly T[], limit: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) out[i] = await f(list[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return out
}

const done = (text: string, data: unknown): OwnerAnswer => ({ outcome: 'done', text, data })
const NOTHING = '没有还没登记的东西。'

export const REGISTER = defineCommand({
  name: 'ledger register',
  summary: '把还没登记的东西都记为主人带进来的，一次记下，不论多少',
  params: {},
  destructive: false,
  ownerOnly: true,
  async run(_values, ctx) {
    const { pile } = await pileNow(ctx)
    const found = await eachAtMost(pile, AT_ONCE, async (path): Promise<Entered | null> => {
      const disk = await onDisk(ctx.library.root, path)
      return disk ? { item: newItemId(), path, fingerprint: disk.fingerprint, size: disk.size, ...(disk.bundle ? { bundle: true as const } : {}) } : null
    })
    const items = found.filter((e) => e !== null)
    if (items.length === 0) return done(NOTHING, { registered: 0 })
    await writeFacts(ctx.dir, [fact(ctx, 'tool', { kind: 'items.enter', items, origin: { kind: 'brought', source: null, by: 'owner' } })])
    return done(`已把 ${items.length} 样东西记为主人带进来的。`, { registered: items.length })
  },
})

export const LEAVE = defineCommand({
  name: 'ledger leave',
  summary: '还没登记的东西照原样留着，不再为它们问主人',
  params: {},
  destructive: false,
  ownerOnly: true,
  async run(_values, ctx) {
    const { pile } = await pileNow(ctx)
    if (pile.length === 0) return done(NOTHING, { left: 0 })
    await writeFacts(ctx.dir, [fact(ctx, 'tool', { kind: 'unowned.left', paths: pile })])
    return done(`${pile.length} 样还没登记的东西照原样留着，不再为它们问主人；状况页仍列着它们，要登记时在那里补上来历。`, { left: pile.length })
  },
})

const answer = (label: string, command: OwnerCommand): Action => ({ label, tone: 'default', confirm: null, ...formOf(command) })

/** Whether every one of the things was last changed before the ledger's first record: they were there when the library began. */
async function wereThere(ctx: PluginContext, ledger: Ledger, paths: readonly LibraryPath[]): Promise<boolean> {
  const first = ledger.facts[0]
  if (first === undefined) return true
  const began = Date.parse(first.at)
  const times = await eachAtMost(paths, AT_ONCE, async (path) => (await stat(abs(ctx.library.root, path)).catch(() => null))?.mtimeMs ?? 0)
  return times.every((t) => t <= began)
}

/**
 * The one ask about things nobody registered, while any is left that the owner did not choose to
 * leave: register them all as brought in by the owner, the suggested answer, or leave them and stop asking.
 */
export async function unownedAsks(ctx: PluginContext): Promise<PluginAsk[]> {
  const { ledger, pile } = await pileNow(ctx)
  if (pile.length === 0) return []
  const there = await wereThere(ctx, ledger, pile)
  return [
    {
      key: 'ledger:unregistered',
      text: `这里${there ? '原来' : ''}有 ${pile.length} 样东西，还没登记。都记为你带进来的吗？`,
      about: null,
      actions: [answer('都记为我带进来的', REGISTER), answer('不登记，不再问', LEAVE)],
      suggested: 0,
    },
  ]
}
