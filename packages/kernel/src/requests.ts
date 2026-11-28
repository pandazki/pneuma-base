// Requests: an agent asks the owner to run one of the owner's commands, saying why, and the owner
// approves or declines with one act. They are the kernel's, so they work with no plugin, and travel with
// the folder and with sync: facts of the kernel's record place `requests`, only appended, which several
// writers share without conflict; each request's state is a row derived from them.
// ARCHITECTURE.md「请主人做」.
import { randomBytes } from 'node:crypto'
import type { OwnerCommandInfo } from './owner.js'
import { checkArgs } from './params.js'
import { storageOf } from './storage.js'
import {
  formOf,
  TEXT_ROWS,
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
  type Row,
} from '@pneuma-base/sdk'

/** How many requests one agent may have waiting on the owner at once. */
export const MAX_PENDING = 20

const REQUEST_ID = /^r-[0-9a-f]{8}$/

/** The kernel's record place for requests. */
export const PLACE = 'requests'
/** The shape of the rows; rows of another shape are derived again from the facts. */
const ROWS_VERSION = 1

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
  return ['pneuma-base', '--library', library === null ? '<资料库目录>' : quote(library.root), ...(actor.kind === 'agent' ? ['--as', quote(actor.name)] : [])].join(' ')
}

/** The line that asks the owner for this command, as the refusal of it in an agent's session ends. */
export function askLine(ctx: Pick<Context, 'actor'> & { library: Library | null }, name: string, args: OwnerArgs): string {
  return `${invocation(ctx)} ask "<原因>" ${commandLine(name, args)}`
}

// ---- reading ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'

/** A fact as written, or null for one that is not a line of a request. */
function parseLine(raw: unknown): { id: RequestId; line: Line } | null {
  if (!isObject(raw) || !isString(raw.at) || !isString(raw.request) || !REQUEST_ID.test(raw.request)) return null
  const { request, ...rest } = raw
  const line = rest as Line
  const id = request as RequestId
  switch (raw.kind) {
    case 'asked': {
      const { by, args } = raw
      const asker = isObject(by) && isString(by.name) && (by.grant === null || isString(by.grant))
      const written = isObject(args) && Array.isArray(args.positional) && isObject(args.flags)
      return asker && written && isString(raw.why) && isString(raw.command) ? { id, line } : null
    }
    case 'decided':
      return (raw.decision === 'approved' && isObject(raw.outcome)) || raw.decision === 'declined' ? { id, line } : null
    case 'withdrawn':
    case 'seen':
      return { id, line }
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
 * A request's row: its lines, and, when its `asked` came while the same asker already waited on the same
 * line (`same`) or on as many requests as one may (`over`), that it is none of its own: two asks at
 * once from two processes are settled here, in the order storage gives the facts, and both see it.
 */
type RequestRow = { id: RequestId; lines: Line[]; same?: RequestId; over?: true }

const askerKey = (by: Asker) => `${by.name}\0${by.grant ?? ''}`
const fieldsOf = (row: RequestRow) => {
  const r = folded(row.id, row.lines)
  const pending = r !== null && row.same === undefined && row.over === undefined && isPending(r)
  return { asker: r === null ? '' : askerKey(r.by), pending: pending ? '1' : '0' }
}

/** The rows, with the facts after their cursor folded in and saved; answers nothing, the rows are read by query after. */
async function caughtUp(root: string): Promise<void> {
  const records = storageOf(root).records(PLACE)
  for (let tries = 0; ; tries++) {
    const { rows: meta, cursor } = await records.get<number>('meta', ['version'])
    if (cursor !== null && meta[0]?.value !== ROWS_VERSION) {
      await records.reset()
      continue
    }
    const batch = await records.since(cursor, 10_000)
    if (batch === null) {
      await records.reset()
      continue
    }
    if (batch.facts.length === 0) return
    const parsed = batch.facts.flatMap((f) => parseLine(f.fact) ?? [])
    const ids = [...new Set(parsed.map((p) => p.id))]
    const known = new Map((await records.get<RequestRow>('requests', ids)).rows.map((r) => [r.key, r.value]))
    const touched = new Map<RequestId, RequestRow>()
    for (const { id, line } of parsed) {
      const row = touched.get(id) ?? known.get(id) ?? { id, lines: [] }
      if (line.kind === 'asked' && row.lines.every((l) => l.kind !== 'asked')) {
        const waiting = (await records.where<RequestRow>('requests', 'asker', askerKey(line.by), { limit: 10_000 })).rows.map((r) => touched.get(r.value.id) ?? r.value)
        for (const t of touched.values()) if (!waiting.some((w) => w.id === t.id) && fieldsOf(t).asker === askerKey(line.by)) waiting.push(t)
        const pending = waiting.filter((w) => w.id !== id && fieldsOf(w).pending === '1')
        const same = pending.find((w) => folded(w.id, w.lines)?.line === commandLine(line.command, line.args))
        if (same !== undefined) row.same = same.id
        else if (pending.length >= MAX_PENDING) row.over = true
      }
      row.lines = [...row.lines, line]
      touched.set(id, row)
    }
    const rows: Row[] = [...touched.values()].map((row) => ({ key: row.id, fields: fieldsOf(row), value: row }))
    const put = await records.put({ requests: rows, ...(cursor === null ? { meta: [{ key: 'version', value: ROWS_VERSION }] } : {}) }, { cursor: batch.cursor, expect: cursor })
    if (put.written && !batch.more) return
    if (tries > 50) throw new Error('请求记录持续被其他进程改写')
  }
}

const requestOf = (row: RequestRow): OwnerRequest | null => (row.same !== undefined || row.over !== undefined ? null : folded(row.id, row.lines))

/** Every request of the library, oldest first. */
export async function readRequests(root: string): Promise<OwnerRequest[]> {
  await caughtUp(root)
  const records = storageOf(root).records(PLACE)
  const out: OwnerRequest[] = []
  let after: string | undefined
  for (;;) {
    const page = await records.under<RequestRow>('requests', '', { limit: 10_000, ...(after === undefined ? {} : { after }) })
    for (const { value } of page.rows) {
      const r = requestOf(value)
      if (r !== null) out.push(r)
    }
    if (page.more === null) break
    after = page.more.after
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
}

/** The pending requests: all of them, or one asker's. */
async function pendingRequests(root: string, by?: Asker): Promise<OwnerRequest[]> {
  await caughtUp(root)
  const records = storageOf(root).records(PLACE)
  const rows = by === undefined ? (await records.where<RequestRow>('requests', 'pending', '1', { limit: 10_000 })).rows : (await records.where<RequestRow>('requests', 'asker', askerKey(by), { limit: 10_000 })).rows
  return rows.flatMap(({ value }) => requestOf(value) ?? []).filter(isPending).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** The request a target names, if it is a request's id. */
export async function requestNamed(root: string, target: string): Promise<OwnerRequest | null> {
  if (!REQUEST_ID.test(target)) return null
  await caughtUp(root)
  const [row] = (await storageOf(root).records(PLACE).get<RequestRow>('requests', [target])).rows
  return row === undefined ? null : requestOf(row.value)
}

// ---- writing ----

const append = (root: string, id: RequestId, line: Line) => storageOf(root).records(PLACE).append([{ request: id, ...line }])

/** Records the owner's decision on a request. */
export const recordDecision = (root: string, id: RequestId, at: Instant, decision: { decision: 'approved'; outcome: RequestOutcome } | { decision: 'declined'; reason: string | null }) =>
  append(root, id, { kind: 'decided', at, ...decision })

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
      return '待处理'
    case 'withdrawn':
      return `已撤回（${when(s.at)}）`
    case 'declined':
      return `已拒绝（${when(s.at)}）${s.reason === null ? '' : `，原因：${s.reason}`}`
    case 'approved': {
      const o = s.outcome
      const answered = o.outcome === 'failed' ? `运行时出错：${o.message}` : o.outcome === 'refused' ? `命令被拒绝（${o.reason}）：${oneLine(o.text)}` : `运行结果：${oneLine(o.text)}`
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
  if (c.destructive) return refusal('red-line', `「${c.name}」将丢失数据，属于限制操作：仅所有者可执行，需当面确认，不能提交请求代批。如确有需要，请直接告知所有者。`)
  if (!c.ownerOnly) return refusal('run-it-yourself', `「${c.name}」可直接执行，无需请求所有者：${invocation(ctx)} ${c.name}${c.usage === null ? '' : ` ${c.usage}`}`)
  if (!c.askable) return refusal('not-askable', `「${c.name}」不能提交请求代批：须由所有者在自己的终端中执行。如确有需要，请直接告知所有者。`)
  return null
}

/**
 * `ask`: a request recorded, the same pending one answered again, or one withdrawn; refused before
 * anything is written. `commands`: the owner commands of the library, as the owner face lists them.
 */
export async function ask(req: AskRequest, ctx: Context, commands: readonly OwnerCommandInfo[]): Promise<AskResult> {
  const by = askerOf(ctx.actor)
  if (by === null) return refusal('not-an-agent', 'ask 用于 Agent 向所有者提交请求；所有者可直接运行该命令。')
  const { root } = ctx.library
  if (req.kind === 'withdraw') return withdraw(root, req.id, by, ctx.now)
  const c = commands.find((x) => x.name === req.command)
  if (c === undefined) return refusal('unknown-command', `所有者命令 ${req.command} 不存在。${invocation(ctx)} --help 列出此资料库可用的命令。`)
  const why = req.why.trim()
  const wrong = notAskable(c, ctx) ?? (why === '' ? refusal('usage', 'ask 须写明原因，所有者据此决定是否批准。') : null)
  if (wrong !== null) return wrong
  const checked = checkArgs(c.name, c.params, req.args)
  if ('usage' in checked) return refusal('usage', checked.usage)
  const line = commandLine(c.name, req.args)
  const mine = await pendingRequests(root, by)
  const same = mine.find((r) => r.line === line)
  if (same) return { outcome: 'asked', request: same, again: true, problems: [] }
  const tooMany = refusal('too-many', `已有 ${MAX_PENDING} 个请求等待所有者处理。请等待处理，或用 ask --withdraw <请求编号> 撤回不再需要的请求。`)
  if (mine.length >= MAX_PENDING) return tooMany
  const asked = { kind: 'asked' as const, at: ctx.now, by, session: ctx.session.id, why, command: c.name, args: req.args }
  const id = `r-${randomBytes(4).toString('hex')}` as RequestId
  await append(root, id, asked)
  // Another ask of the same agent may have come at the same moment: the rows settle which one stands.
  await caughtUp(root)
  const [row] = (await storageOf(root).records(PLACE).get<RequestRow>('requests', [id])).rows
  if (row?.value.same !== undefined) {
    const first = await requestNamed(root, row.value.same)
    if (first !== null) return { outcome: 'asked', request: first, again: true, problems: [] }
  }
  if (row?.value.over) return tooMany
  return { outcome: 'asked', request: folded(id, [asked]) as OwnerRequest, again: false, problems: [] }
}

async function withdraw(root: string, id: string, by: Asker, now: Instant): Promise<AskResult> {
  const r = await requestNamed(root, id)
  if (r === null) return refusal('no-such-request', `请求 ${id} 不存在。`)
  if (!sameAsker(r.by, by)) return refusal('not-yours', `请求 ${id} 由 ${r.by.name} 提交，仅提交该请求的 Agent 可撤回。`)
  if (!isPending(r)) return refusal('not-pending', `请求 ${id} ${endText(r)}，无法撤回。`)
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
  await caughtUp(ctx.library.root)
  const rows = (await storageOf(ctx.library.root).records(PLACE).where<RequestRow>('requests', 'asker', askerKey(by), { limit: 10_000 })).rows
  const mine = rows.flatMap(({ value }) => requestOf(value) ?? []).filter((r) => sameAsker(r.by, by))
  const decided = mine.filter((r) => (r.status.kind === 'approved' || r.status.kind === 'declined') && !r.seen)
  // Only the ones told are seen; the rest wait for the next check.
  const ended = decided.slice(0, TEXT_ROWS)
  if (ended.length > 0) await storageOf(ctx.library.root).records(PLACE).append(ended.map((r) => ({ request: r.id, kind: 'seen', at: ctx.now })))
  return { ended, pending: mine.filter(isPending).length, ...(decided.length > ended.length ? { more: decided.length - ended.length } : {}) }
}

// ---- the owner's side ----

const ID = { name: 'id', hint: '请求编号', required: true } as const
export const APPROVE = { name: 'request approve', params: { positional: [ID] } } as const
export const DECLINE = { name: 'request decline', params: { positional: [ID, { name: 'reason', hint: '原因' }] } } as const

const approveAction = (id: RequestId): Action => ({ label: '批准', tone: 'default', confirm: null, ...formOf(APPROVE, { fixed: { id } }) })
const declineAction = (id: RequestId): Action => ({ label: '拒绝', tone: 'default', confirm: null, ...formOf(DECLINE, { fixed: { id } }) })

/** A pending request as an ask of the home page: raised by the agent, its reason the sentence, the command under it. */
export async function requestAsks(library: Library): Promise<Ask[]> {
  return (await pendingRequests(library.root)).map((r) => {
    const grant = r.by.grant === null ? undefined : library.config.grants.find((g) => g.id === r.by.grant)?.name
    return { key: `request:${r.id}`, by: { kind: 'agent', name: r.by.name, ...(grant === undefined ? {} : { grant }) }, text: r.why, command: r.line, about: null, actions: [approveAction(r.id), declineAction(r.id)], suggested: 0 }
  })
}

/** A pending request in the lines `show home` prints for its ask. */
export const pendingLines = (r: OwnerRequest) => [
  `- ${r.why}（${r.by.name}）`,
  `    ${r.line}`,
  `    $ request approve ${r.id}  # 批准（仅所有者）（推荐）`,
  `    $ request decline ${r.id} [<原因>]  # 拒绝（仅所有者）`,
]
