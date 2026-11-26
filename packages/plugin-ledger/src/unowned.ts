// Things nobody registered, asked about by place (tmp/run-7 architecture.md section 7). The loose files
// of an open directory: register them all as brought in by the owner, or leave them as they are and
// stop asking. A closed directory: register it as one thing, register every file in it (a named act
// over all of it, which says how much first and shows its progress), or leave it alone, which adds it
// to the library's noise so nothing mentions it again.
import {
  defineCommand,
  formOf,
  isDescribed,
  isFailure,
  KERNEL_ENTRIES,
  type Action,
  type LibraryPath,
  type OwnerAnswer,
  type OwnerCommand,
  type Place,
  type PluginAsk,
  type PluginContext,
} from '@pneuma-base/kernel'
import { fact, newItemId, writeFacts, type Entered } from './facts.js'
import { rebase, sparseStanding } from './sparse.js'
import { stateOf } from './state.js'

/** How many places one look at the home page or one check asks about. */
export const ASKS = 20
/** How many things one fact of a register-everything act enters, so an interrupted act keeps what it did. */
const BATCH = 500
/** How many things are fingerprinted at once while registering. */
const AT_ONCE = 32

const parentOf = (path: LibraryPath): Place => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const dirName = (dir: Place) => (dir === '' ? '库的根目录' : `${dir}/`)

async function eachAtMost<T, R>(list: readonly T[], limit: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) out[i] = await f(list[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return out
}

/** The loose files nobody registered and the owner did not leave, by the open directory they are in. */
async function looseByDir(ctx: PluginContext): Promise<Map<Place, LibraryPath[]>> {
  const { standing, state } = await sparseStanding(ctx)
  const byDir = new Map<Place, LibraryPath[]>()
  for (const path of standing.unowned) {
    if (state.left.has(path)) continue
    const dir = parentOf(path)
    byDir.set(dir, [...(byDir.get(dir) ?? []), path])
  }
  return byDir
}

/** Enters these files as brought in by the owner, BATCH to a fact; each one's fingerprint read on the way. Answers how many. */
async function enter(ctx: PluginContext, paths: readonly LibraryPath[], progress: (n: number) => void = () => undefined): Promise<number> {
  let entered = 0
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH)
    const found = await eachAtMost(batch, AT_ONCE, async (path): Promise<Entered | null> => {
      const [d] = await ctx.tools.storage.glance([path])
      const fingerprint = await ctx.tools.fingerprint(path)
      return d && isDescribed(d) && d.kind === 'file' && fingerprint !== null ? { item: newItemId(), path, fingerprint, size: d.size ?? 0 } : null
    })
    const items = found.filter((e) => e !== null)
    if (items.length > 0) {
      await writeFacts(ctx, [fact(ctx, 'tool', { kind: 'items.enter', items, origin: { kind: 'brought', source: null, by: 'owner' } })])
      await rebase(ctx, items.map((e) => e.path))
    }
    entered += items.length
    progress(entered)
  }
  return entered
}

/**
 * Every file below `dir` nobody registered, one level of one directory at a time, a page at a time:
 * storage leaves noise out, the kernel's own entries at the root are not the library's things, and
 * nothing below a registered directory-thing is a file of its own.
 */
async function filesBelow(ctx: PluginContext, dir: Place, registered: (path: LibraryPath) => boolean): Promise<LibraryPath[]> {
  const out: LibraryPath[] = []
  const queue: Place[] = [dir]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let after: string | undefined
    for (;;) {
      const page = await ctx.tools.storage.overview(next, { limit: 1000, ...(after === undefined ? {} : { after }) })
      if (isFailure(page)) break
      for (const e of page.entries) {
        if (registered(e.place as LibraryPath) || (next === '' && KERNEL_ENTRIES.has(e.place))) continue
        if (e.kind === 'file') out.push(e.place as LibraryPath)
        else if (e.kind === 'dir') queue.push(e.place)
      }
      if (page.more === null) break
      after = page.more.after
    }
  }
  return out
}

/** The directory an owner wrote: `.` for the root; null when it is not in the content or the archive. */
async function placeOf(ctx: PluginContext, input: string | null): Promise<Place | null> {
  if (input === null || input === '.' || input === '') return ''
  const resolved = await ctx.tools.resolve(input)
  return resolved === null || resolved.region === 'kernel' ? null : resolved.path
}

const done = (text: string, data: unknown): OwnerAnswer => ({ outcome: 'done', text, data })
const NOTHING = '没有还没登记的散文件。'

export const REGISTER = defineCommand({
  name: 'ledger register',
  summary: '把还没登记的散文件记为主人带进来的；写一个目录只登记它这一层的；加 --inside 登记这个目录里的全部文件，先说有多少，再一边登记一边报进度',
  params: {
    positional: [{ name: 'dir', hint: '库内的目录，. 是库的根目录；不写是所有看过的目录' }],
    flags: [{ name: 'inside', hint: '登记这个目录里任意深处的全部文件，噪音除外', kind: 'boolean' }],
  },
  destructive: false,
  ownerOnly: true,
  async run({ dir: input, inside }, ctx) {
    const dir = await placeOf(ctx, input)
    if (dir === null) return { outcome: 'refused', reason: 'not-in-library', text: `这不是库里的目录：${input}` }
    if (inside) {
      if (input === null) return { outcome: 'refused', reason: 'usage', text: '--inside 要写是哪个目录，整个库写 .：ledger register <目录> --inside' }
      const scope = await ctx.tools.storage.probe(dir, 5000)
      if (isFailure(scope)) return { outcome: 'refused', reason: scope.reason, text: `没能看这个目录（${scope.reason}）：${input}` }
      const say = (text: string) => void process.stderr.write(`${text}\n`)
      say(`要登记 ${dirName(dir)}里的全部文件：${scope.exceeded ? `至少 ${scope.files} 个` : `${scope.files} 个`}，不含噪音。可以随时打断，登记过的不会重来。`)
      const { state } = await stateOf(ctx)
      const files = await filesBelow(ctx, dir, (path) => state.paths.has(path))
      const n = await enter(ctx, files, (k) => say(`已登记 ${k} / ${files.length}`))
      return done(n === 0 ? `${dirName(dir)}里没有还没登记的文件。` : `已把 ${dirName(dir)}里的 ${n} 个文件记为主人带进来的。`, { registered: n })
    }
    const byDir = await looseByDir(ctx)
    const pile = input === null ? [...byDir.values()].flat() : (byDir.get(dir) ?? [])
    const n = await enter(ctx, pile)
    return done(n === 0 ? NOTHING : `已把 ${n} 样东西记为主人带进来的。`, { registered: n })
  },
})

export const LEAVE = defineCommand({
  name: 'ledger leave',
  summary: '还没登记的散文件照原样留着，不再为它们问主人；写一个目录只管它这一层的',
  params: { positional: [{ name: 'dir', hint: '库内的目录；不写是所有看过的目录' }] },
  destructive: false,
  ownerOnly: true,
  async run({ dir: input }, ctx) {
    const dir = await placeOf(ctx, input)
    if (dir === null) return { outcome: 'refused', reason: 'not-in-library', text: `这不是库里的目录：${input}` }
    const byDir = await looseByDir(ctx)
    const pile = input === null ? [...byDir.values()].flat() : (byDir.get(dir) ?? [])
    if (pile.length === 0) return done(NOTHING, { left: 0 })
    await writeFacts(ctx, [fact(ctx, 'tool', { kind: 'unowned.left', paths: pile })])
    return done(`${pile.length} 样还没登记的东西照原样留着，不再为它们问主人；状况页仍列着它们，要登记时在那里补上来历。`, { left: pile.length })
  },
})

const ownerAction = (label: string, command: OwnerCommand, fixed: Record<string, string | boolean>): Action => ({ label, tone: 'default', confirm: null, ...formOf(command, { fixed }) })

/** The three answers to a closed directory. */
export function closedActions(path: LibraryPath): Action[] {
  return [
    { label: '登记成一样东西', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'brought', source: null, by: 'owner' }, note: null } } },
    ownerAction('登记里面的文件', REGISTER, { dir: path, inside: true }),
    { label: '不用管', tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: 'noise add', args: { positional: [path], flags: {} } } },
  ]
}

/**
 * One ask for each place with things nobody registered, at most ASKS of them: the loose files of an
 * open directory, while the owner has not left them; a closed directory. Past that many, one more says
 * how many places are left and where they are all listed.
 */
export async function unownedAsks(ctx: PluginContext): Promise<PluginAsk[]> {
  const { standing, state } = await sparseStanding(ctx)
  const loose = new Map<Place, LibraryPath[]>()
  for (const path of standing.unowned) if (!state.left.has(path)) loose.set(parentOf(path), [...(loose.get(parentOf(path)) ?? []), path])
  const partial = new Set((standing.more ?? []).map((m) => m.dir))
  const asks: PluginAsk[] = []
  for (const [dir, paths] of loose) {
    const n = partial.has(dir as LibraryPath | '') ? `至少 ${paths.length}` : `${paths.length}`
    asks.push({
      key: `ledger:unregistered:${dir}`,
      text: `${dirName(dir)}有 ${n} 个文件还没登记。都记为你带进来的吗？`,
      about: dir === '' ? null : (dir as LibraryPath),
      actions: [ownerAction('都记为我带进来的', REGISTER, { dir: dir === '' ? '.' : dir, inside: false }), ownerAction('不登记，不再问', LEAVE, { dir: dir === '' ? '.' : dir })],
      suggested: 0,
    })
  }
  for (const path of standing.closed ?? []) {
    asks.push({ key: `ledger:closed:${path}`, text: `${path}/ 还没看过，里面的东西都没登记。登记成一样东西、登记里面的文件，还是不用管？`, about: path, actions: closedActions(path) })
  }
  if (asks.length <= ASKS) return asks
  const rest = asks.length - (ASKS - 1)
  return [...asks.slice(0, ASKS - 1), { key: 'ledger:unregistered:more', text: `还有 ${rest} 个地方有没登记的东西，都在状况页上：pneuma-base show ledger.standing --kind unowned`, about: null, actions: [] }]
}
