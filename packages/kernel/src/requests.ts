// Requests: an agent asks the owner to run one of the owner's commands, saying why, and the owner
// approves or declines with one act. They are the kernel's, in the library's record area, so they work
// with no plugin and travel with the folder and with sync: one file per request under
// `.pneuma-base/requests/`, lines only appended, which several writers can share. ARCHITECTURE.md
// section 4, 「请」.
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { alone } from './files.js'
import type { OwnerCommandInfo } from './owner.js'
import { checkArgs } from './params.js'
import { KERNEL_DIR, scratchDir } from './paths.js'
import {
  formOf,
  type Action,
  type Actor,
  type Ask,
  type AskRequest,
  type AskResult,
  type CheckResult,
  type Context,
  type Instant,
  type Library,
  type OwnerArgs,
  type OwnerRequest,
  type RequestId,
  type RequestOutcome,
} from '@pneuma-base/sdk'

/** How many requests one agent may have waiting on the owner at once. */
export const MAX_PENDING = 20

const REQUEST_ID = /^r-[0-9a-f]{8}$/

const dirOf = (root: string) => join(root, KERNEL_DIR, 'requests')

type Asker = OwnerRequest['by']

/** One line of a request's file. A decision stands over a withdrawal: the command may have run. */
type Line =
  | { kind: 'asked'; at: Instant; by: Asker; session: string; why: string; command: string; args: OwnerArgs }
  | { kind: 'withdrawn'; at: Instant }
  | { kind: 'decided'; at: Instant; decision: 'approved'; outcome: RequestOutcome }
  | { kind: 'decided'; at: Instant; decision: 'declined'; reason: string | null }
  | { kind: 'seen'; at: Instant }

// ---- the command as people type it ----

const SAFE = /^[\p{L}\p{N}_@%+=:,./~-]+$/u
/** A literal value as a shell takes it. */
export const quote = (v: string) => (SAFE.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`)

/** An owner command and its arguments as one command line, without `pneuma-base`. */
export function commandLine(name: string, args: OwnerArgs): string {
  const flags = Object.entries(args.flags).flatMap(([flag, v]) => (v === true ? [`--${flag}`] : [`--${flag}`, ...v.map(quote)]))
  return [name, ...args.positional.map(quote), ...flags].join(' ')
}

/** How this caller runs a verb: `pneuma-base @<grant>`, or with the library and its name when it has no grant. */
function invocation(ctx: Pick<Context, 'actor'> & { library: Library | null }): string {
  const { actor, library } = ctx
  const grant = actor.kind === 'agent' && actor.grant !== null ? library?.config.grants.find((g) => g.id === actor.grant) : undefined
  if (grant) return `pneuma-base @${grant.name}`
  return ['pneuma-base', '--library', library === null ? '<库的目录>' : quote(library.root), ...(actor.kind === 'agent' ? ['--as', quote(actor.name)] : [])].join(' ')
}

/** The line that asks the owner for this command, as the refusal of it in an agent's session ends. */
export function askLine(ctx: Pick<Context, 'actor'> & { library: Library | null }, name: string, args: OwnerArgs): string {
  return `${invocation(ctx)} ask "<为什么>" ${commandLine(name, args)}`
}

// ---- reading ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'

/** A line as written, or null for one that is not a line of a request, such as half a line a killed writer left. */
function parseLine(text: string): Line | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || !isString(raw.at)) return null
  switch (raw.kind) {
    case 'asked': {
      const { by, args } = raw
      const asker = isObject(by) && isString(by.name) && (by.grant === null || isString(by.grant))
      const written = isObject(args) && Array.isArray(args.positional) && isObject(args.flags)
      return asker && written && isString(raw.why) && isString(raw.command) ? (raw as Line) : null
    }
    case 'decided':
      return raw.decision === 'approved' ? (isObject(raw.outcome) ? (raw as Line) : null) : raw.decision === 'declined' ? (raw as Line) : null
    case 'withdrawn':
    case 'seen':
      return raw as Line
    default:
      return null
  }
}

function folded(id: RequestId, lines: readonly Line[]): OwnerRequest | null {
  const sorted = [...lines].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const asked = sorted.find((l) => l.kind === 'asked')
  if (asked === undefined) return null
  const decided = sorted.find((l) => l.kind === 'decided')
  const withdrawn = sorted.find((l) => l.kind === 'withdrawn')
  const status: OwnerRequest['status'] =
    decided !== undefined
      ? decided.decision === 'approved'
        ? { kind: 'approved', at: decided.at, outcome: decided.outcome }
        : { kind: 'declined', at: decided.at, reason: decided.reason ?? null }
      : withdrawn !== undefined
        ? { kind: 'withdrawn', at: withdrawn.at }
        : { kind: 'pending' }
  const { by, at, why, command: name, args } = asked
  return { id, by, at, why, command: name, args, line: commandLine(name, args), status, seen: status.kind !== 'pending' && sorted.some((l) => l.kind === 'seen') }
}

/**
 * Every request of the library, oldest first. A request's file may have copies a sync left beside it
 * (`<id>.conflict-…`): their lines are read as one.
 */
export async function readRequests(root: string): Promise<OwnerRequest[]> {
  const dir = dirOf(root)
  const lines = new Map<RequestId, Set<string>>()
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const id = name.slice(0, name.indexOf('.')) as RequestId
    if (!REQUEST_ID.test(id) || !name.endsWith('.jsonl')) continue
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    const seen = lines.get(id) ?? new Set<string>()
    lines.set(id, seen)
    for (const line of text.split('\n')) if (line.trim() !== '') seen.add(line)
  }
  const requests = [...lines].flatMap(([id, raw]) => folded(id, [...raw].flatMap((l) => parseLine(l) ?? [])) ?? [])
  return requests.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
}

/** The request a target names, if it is a request's id. */
export async function requestNamed(root: string, target: string): Promise<OwnerRequest | null> {
  if (!REQUEST_ID.test(target)) return null
  return (await readRequests(root)).find((r) => r.id === target) ?? null
}

// ---- writing ----

async function create(root: string, line: Extract<Line, { kind: 'asked' }>): Promise<RequestId> {
  const dir = dirOf(root)
  await mkdir(dir, { recursive: true })
  for (;;) {
    const id = `r-${randomBytes(4).toString('hex')}` as RequestId
    try {
      const handle = await open(join(dir, `${id}.jsonl`), 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(line)}\n`)
      } finally {
        await handle.close()
      }
      return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

const append = (root: string, id: RequestId, line: Line) => appendFile(join(dirOf(root), `${id}.jsonl`), `${JSON.stringify(line)}\n`)

/** Records the owner's decision on a request. */
export const recordDecision = (root: string, id: RequestId, at: Instant, decision: { decision: 'approved'; outcome: RequestOutcome } | { decision: 'declined'; reason: string | null }) =>
  append(root, id, { kind: 'decided', at, ...decision })

/**
 * The lock of one agent's asks on this machine, so two at once neither both add the same request nor
 * pass the cap together: a directory in the kernel's scratch area.
 */
const askingLock = (root: string, asker: Asker) => join(scratchDir(root), 'asking', createHash('sha256').update(`${asker.name}\0${asker.grant ?? ''}`).digest('hex').slice(0, 16))

// ---- in words ----

export const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
const oneLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('；')

/** Where a request stands, in one sentence: pending, withdrawn, declined and why, approved and what the command answered. */
export function endText(r: OwnerRequest): string {
  const s = r.status
  switch (s.kind) {
    case 'pending':
      return '在等主人决定'
    case 'withdrawn':
      return `已撤回（${when(s.at)}）`
    case 'declined':
      return `已拒绝（${when(s.at)}）${s.reason === null ? '' : `，理由：${s.reason}`}`
    case 'approved': {
      const o = s.outcome
      const answered = o.outcome === 'failed' ? `运行时出错：${o.message}` : o.outcome === 'refused' ? `命令被拒绝（${o.reason}）：${oneLine(o.text)}` : `运行的结果：${oneLine(o.text)}`
      return `已批准（${when(s.at)}），${answered}`
    }
  }
}

export const isPending = (r: OwnerRequest) => r.status.kind === 'pending'
const sameAsker = (a: Asker, b: Asker) => a.name === b.name && a.grant === b.grant
const askerOf = (actor: Actor): Asker | null => (actor.kind === 'agent' ? { name: actor.name, grant: actor.grant } : null)

// ---- the verb ----

type Refused = Extract<AskResult, { outcome: 'refused' }>
const refusal = (reason: Refused['reason'], text: string): Refused => ({ outcome: 'refused', reason, text, problems: [] })

/** Why `c` cannot be asked for, or null when it can: owner-only, losing no data, and not marked as the owner's in person. */
function notAskable(c: OwnerCommandInfo, ctx: Context): Refused | null {
  if (c.destructive) return refusal('red-line', `「${c.name}」会丢数据，是红线：只有主人能做，要主人当面确认，不能请主人代批。真需要的话直接告诉主人。`)
  if (!c.ownerOnly) return refusal('run-it-yourself', `「${c.name}」你自己就能运行，不用请主人：${invocation(ctx)} ${c.name}${c.usage === null ? '' : ` ${c.usage}`}`)
  if (!c.askable) return refusal('not-askable', `「${c.name}」不能请主人代批：它要主人自己在终端里做。真需要的话直接告诉主人。`)
  return null
}

/**
 * `ask`: a request recorded, the same pending one answered again, or one withdrawn; refused before
 * anything is written. `commands`: the owner commands of the library, as the owner face lists them.
 */
export async function ask(req: AskRequest, ctx: Context, commands: readonly OwnerCommandInfo[]): Promise<AskResult> {
  const by = askerOf(ctx.actor)
  if (by === null) return refusal('not-an-agent', 'ask 是 agent 请主人做事用的；你是主人，直接运行那条命令就行。')
  const { root } = ctx.library
  if (req.kind === 'withdraw') return withdraw(root, req.id, by, ctx.now)
  const c = commands.find((x) => x.name === req.command)
  if (c === undefined) return refusal('unknown-command', `没有这条主人命令：${req.command}。${invocation(ctx)} --help 列出这个库能用的。`)
  const why = req.why.trim()
  const wrong = notAskable(c, ctx) ?? (why === '' ? refusal('usage', 'ask 要写为什么：一句话，主人据它决定批不批。') : null)
  if (wrong !== null) return wrong
  const checked = checkArgs(c.name, c.params, req.args)
  if ('usage' in checked) return refusal('usage', checked.usage)
  const line = commandLine(c.name, req.args)
  return alone(askingLock(root, by), async () => {
    const mine = (await readRequests(root)).filter((r) => isPending(r) && sameAsker(r.by, by))
    const same = mine.find((r) => r.line === line)
    if (same) return { outcome: 'asked', request: same, again: true, problems: [] }
    if (mine.length >= MAX_PENDING) return refusal('too-many', `你已经有 ${MAX_PENDING} 个请求在等主人决定。等主人处理，或用 ask --withdraw <请求号> 撤回不再需要的。`)
    const asked = { kind: 'asked' as const, at: ctx.now, by, session: ctx.session.id, why, command: c.name, args: req.args }
    const id = await create(root, asked)
    return { outcome: 'asked', request: folded(id, [asked]) as OwnerRequest, again: false, problems: [] }
  })
}

async function withdraw(root: string, id: string, by: Asker, now: Instant): Promise<AskResult> {
  const r = await requestNamed(root, id)
  if (r === null) return refusal('no-such-request', `没有请求 ${id}。`)
  if (!sameAsker(r.by, by)) return refusal('not-yours', `请求 ${id} 是 ${r.by.name} 提的，只有提的那个 agent 能撤回。`)
  if (!isPending(r)) return refusal('not-pending', `请求 ${id} ${endText(r)}，不能再撤回。`)
  await append(root, r.id, { kind: 'withdrawn', at: now })
  return { outcome: 'withdrawn', request: { ...r, status: { kind: 'withdrawn', at: now } }, problems: [] }
}

/**
 * The caller's part of check: its requests the owner decided that it has not seen yet, now marked
 * seen, and how many still wait. Nothing for the owner, who asks nobody.
 */
export async function requestsFor(ctx: Context): Promise<CheckResult['requests']> {
  const by = askerOf(ctx.actor)
  if (by === null) return { ended: [], pending: 0 }
  const mine = (await readRequests(ctx.library.root)).filter((r) => sameAsker(r.by, by))
  const ended = mine.filter((r) => (r.status.kind === 'approved' || r.status.kind === 'declined') && !r.seen)
  for (const r of ended) await append(ctx.library.root, r.id, { kind: 'seen', at: ctx.now })
  return { ended, pending: mine.filter(isPending).length }
}

// ---- the owner's side ----

const ID = { name: 'id', hint: '请求号', required: true } as const
export const APPROVE = { name: 'request approve', params: { positional: [ID] } } as const
export const DECLINE = { name: 'request decline', params: { positional: [ID, { name: 'reason', hint: '理由' }] } } as const

const approveAction = (id: RequestId): Action => ({ label: '批准', tone: 'default', confirm: null, ...formOf(APPROVE, { fixed: { id } }) })
const declineAction = (id: RequestId): Action => ({ label: '拒绝', tone: 'default', confirm: null, ...formOf(DECLINE, { fixed: { id } }) })

/** A pending request as an ask of the home page: raised by the agent, its reason the sentence, the command under it. */
export async function requestAsks(library: Library): Promise<Ask[]> {
  return (await readRequests(library.root)).filter(isPending).map((r) => {
    const grant = r.by.grant === null ? undefined : library.config.grants.find((g) => g.id === r.by.grant)?.name
    return { key: `request:${r.id}`, by: { kind: 'agent', name: r.by.name, ...(grant === undefined ? {} : { grant }) }, text: r.why, command: r.line, about: null, actions: [approveAction(r.id), declineAction(r.id)], suggested: 0 }
  })
}

/** A pending request in the lines `show home` prints for its ask. */
export const pendingLines = (r: OwnerRequest) => [
  `- ${r.why}（${r.by.name}）`,
  `    ${r.line}`,
  `    $ request approve ${r.id}  # 批准（只给主人）（推荐）`,
  `    $ request decline ${r.id} [<理由>]  # 拒绝（只给主人）`,
]
