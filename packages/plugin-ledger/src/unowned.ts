// Things nobody registered, asked about by place (tmp/run-7 architecture.md section 7). The loose files
// of an open directory: register them all as brought in by the owner, or leave them as they are and
// stop asking. A closed directory: register it as one thing, register every file in it (a named act
// over all of it, which says how much first, shows its progress and stops cleanly when interrupted), or
// leave it alone, which adds it to the library's noise so nothing mentions it again. Registering reads
// no content: each thing is entered with what one listing of its directory said of it.
import {
  defineCommand,
  formOf,
  isFailure,
  KERNEL_ENTRIES,
  type Action,
  type Description,
  type LibraryPath,
  type OwnerAnswer,
  type OwnerCommand,
  type Place,
  type PluginAsk,
  type PluginContext,
} from '@pneuma-base/kernel'
import { fact, newItemId, writeFacts, type Entered } from './facts.js'
import { refresh, stateOf } from './look.js'
import { nameOf, type SeenRow } from './model.js'
import { getAll, looseDirs, partialDirs, standingList } from './queries.js'

/** How many places one look at the home page or one check asks about. */
export const ASKS = 20
/** How many entries of a directory one listing brings while registering. */
const LISTING = 1000
/** How many things one fact of a register-everything act enters, so an interrupted act keeps what it did. */
const BATCH = 500

const dirName = (dir: Place) => (dir === '' ? '库的根目录' : `${dir}/`)

/** The entries of one listing nobody registered (and, with `skipLeft`, the owner did not leave): its files, and its directories that are no thing. */
async function strays(ctx: PluginContext, dir: Place, entries: readonly Description[], skipLeft: boolean): Promise<{ files: Description[]; dirs: Description[] }> {
  const records = ctx.tools.storage.records
  const own = entries.filter((e) => !e.held && !(dir === '' && KERNEL_ENTRIES.has(nameOf(e.place))))
  const places = own.map((e) => e.place)
  const [held, left] = await Promise.all([getAll(records, 'paths', places), skipLeft ? getAll(records, 'left', places) : new Map()])
  const free = own.filter((e) => !held.has(e.place) && !left.has(e.place))
  return { files: free.filter((e) => e.kind === 'file'), dirs: free.filter((e) => e.kind === 'dir') }
}

const entered = (e: Description): Entered => ({
  item: newItemId(),
  path: e.place as LibraryPath,
  fingerprint: null,
  size: e.size ?? 0,
  ...(e.token === undefined ? {} : { token: e.token }),
  ...(e.modified === undefined ? {} : { modified: e.modified }),
})

/** Enters these files as brought in by the owner, BATCH to a fact. */
async function enter(ctx: PluginContext, files: readonly Description[]): Promise<number> {
  for (let i = 0; i < files.length; i += BATCH) {
    const items = files.slice(i, i + BATCH).map(entered)
    await writeFacts(ctx, [fact(ctx, 'tool', { kind: 'items.enter', items, origin: { kind: 'brought', source: null, by: 'owner' } })])
  }
  return files.length
}

/** Each listing of one level of `dir`, a page at a time. */
async function* listings(ctx: PluginContext, dir: Place): AsyncGenerator<Description[]> {
  let after: string | undefined
  for (;;) {
    const page = await ctx.tools.storage.overview(dir, { limit: LISTING, ...(after === undefined ? {} : { after }) })
    if (isFailure(page)) return
    yield page.entries
    if (page.more === null) return
    after = page.more.after
  }
}

/** Does `act` with the loose files of one level of `dir`, a listing at a time; answers how many. */
async function eachLevel(ctx: PluginContext, dir: Place, act: (files: Description[]) => Promise<number>): Promise<number> {
  let n = 0
  for await (const entries of listings(ctx, dir)) n += await act((await strays(ctx, dir, entries, true)).files)
  return n
}

/** The open directories with loose files nobody registered or left, as the last looks saw them. */
async function looseDirsNow(ctx: PluginContext): Promise<Place[]> {
  await refresh(ctx)
  const out: Place[] = []
  for await (const page of looseDirs(ctx.tools.storage.records)) out.push(...page.map((r) => r.key))
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

/**
 * The named whole act: every file below `dir` nobody registered, one listing at a time, each listing
 * entered as one fact before the next is read. Storage leaves noise out; the kernel's own entries at
 * the root are not the library's things; nothing below a registered directory-thing is a file of its
 * own. Says how far it is after each listing, and stops after the one under way when interrupted.
 */
async function registerInside(ctx: PluginContext, dir: Place, input: string): Promise<OwnerAnswer> {
  const scope = await ctx.tools.storage.probe(dir, 5000)
  if (isFailure(scope)) return { outcome: 'refused', reason: scope.reason, text: `没能看这个目录（${scope.reason}）：${input}` }
  const total = scope.exceeded ? `至少 ${scope.files}` : `${scope.files}`
  const say = (text: string) => void process.stderr.write(`${text}\n`)
  say(`要登记 ${dirName(dir)}里的全部文件：${total} 个，不含噪音。可以随时打断（Ctrl-C），登记过的不会重来。`)
  await stateOf(ctx)
  let stop = false
  const interrupt = () => {
    stop = true
  }
  process.on('SIGINT', interrupt)
  let n = 0
  // What was listed and not entered yet, across directories: entered BATCH at a time.
  let pending: Description[] = []
  const flush = async (all: boolean) => {
    while (pending.length >= BATCH || (all && pending.length > 0)) {
      n += await enter(ctx, pending.slice(0, BATCH))
      pending = pending.slice(BATCH)
      // Past what the probe counted there is no total to give: the probe stopped at its budget.
      say(scope.exceeded && n >= scope.files ? `已登记 ${n}` : `已登记 ${n} / ${total}`)
      if (stop) return
    }
  }
  try {
    const queue: Place[] = [dir]
    walk: for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for await (const entries of listings(ctx, next)) {
        if (stop) break walk
        const found = await strays(ctx, next, entries, false)
        queue.push(...found.dirs.map((d) => d.place))
        pending.push(...found.files)
        await flush(false)
      }
    }
    await flush(true)
  } finally {
    process.off('SIGINT', interrupt)
  }
  if (stop) return done(`停下了：已把 ${dirName(dir)}里的 ${n} 个文件记为主人带进来的${scope.exceeded && n >= scope.files ? '' : `，共 ${total} 个`}。登记过的都留着，再运行同一条命令接着登记剩下的。`, { registered: n, of: scope.files, stopped: true })
  return done(n === 0 ? `${dirName(dir)}里没有还没登记的文件。` : `已把 ${dirName(dir)}里的 ${n} 个文件记为主人带进来的。`, { registered: n })
}

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
      return registerInside(ctx, dir, input)
    }
    await stateOf(ctx)
    let n = 0
    for (const at of input === null ? await looseDirsNow(ctx) : [dir]) n += await eachLevel(ctx, at, (files) => enter(ctx, files))
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
    await stateOf(ctx)
    const leave = async (files: Description[]) => {
      if (files.length > 0) await writeFacts(ctx, [fact(ctx, 'tool', { kind: 'unowned.left', paths: files.map((f) => f.place as LibraryPath) })])
      return files.length
    }
    let n = 0
    for (const at of input === null ? await looseDirsNow(ctx) : [dir]) n += await eachLevel(ctx, at, leave)
    if (n === 0) return done(NOTHING, { left: 0 })
    return done(`${n} 样还没登记的东西照原样留着，不再为它们问主人；状况页仍列着它们，要登记时在那里补上来历。`, { left: n })
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
 * how many places are left and where they are all listed. Each place is asked about until it is
 * answered: registered, left, or made noise.
 */
export async function unownedAsks(ctx: PluginContext): Promise<PluginAsk[]> {
  await refresh(ctx)
  const records = ctx.tools.storage.records
  const page = await records.where<SeenRow>('seen', 'loose', 'y', { limit: ASKS })
  const partial = new Set((await partialDirs(records)).map((m) => m.dir))
  const asks: PluginAsk[] = page.rows.map(({ key: dir, value }) => ({
    key: `ledger:unregistered:${dir}`,
    text: `${dirName(dir)}有 ${partial.has(dir) ? `至少 ${value.loose.length}` : value.loose.length} 个文件还没登记。都记为你带进来的吗？`,
    about: dir === '' ? null : (dir as LibraryPath),
    actions: [ownerAction('都记为我带进来的', REGISTER, { dir: dir === '' ? '.' : dir, inside: false }), ownerAction('不登记，不再问', LEAVE, { dir: dir === '' ? '.' : dir })],
    suggested: 0,
  }))
  const closed = await standingList(records, 'closed', false, ASKS)
  for (const m of closed.rows) asks.push({ key: `ledger:closed:${m.path}`, text: `${m.path}/ 没登记。`, about: m.path, actions: closedActions(m.path) })
  const places = (page.more === null ? page.rows.length : await records.count('seen', 'loose', 'y')) + closed.count
  if (places <= ASKS) return asks
  return [...asks.slice(0, ASKS - 1), { key: 'ledger:unregistered:more', text: `还有 ${places - (ASKS - 1)} 个地方有没登记的东西，都在状况页上：pneuma-base show ledger.standing --kind unowned`, about: null, actions: [] }]
}
