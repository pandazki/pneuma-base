// Pairing: an agent that is not connected asks to be, the owner allows it with one click, and it is
// connected under its own name by `agent connect`. Pairings are machine state (an agent not yet
// connected has no identity in a library): `$PNEUMA_BASE_HOME/pairings/`, a file `<id>.json` for the
// request and `<id>.decided.json` for the owner's decision, each written once and never rewritten,
// every pairing kept as the record. ARCHITECTURE.md section 6.
import { randomBytes, randomInt } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NOTHING_WRITTEN, reachOf, titleOf, WAY_WORD, whereOf } from './agent-commands.js'
import { readConnection } from './connections.js'
import { endpointOf, sentenceFor } from './endpoint.js'
import { alone, writeOnce } from './files.js'
import { GRANT_NAME, readGrantFile } from './grants.js'
import { launcherPath } from './launcher.js'
import { openLibrary } from './library.js'
import { DESCRIPTION_FILE } from './paths.js'
import { CONNECTABLE, productNamed, waysOf, type Env, type Way } from './products.js'
import { commandLine, quote, when } from './requests.js'
import { formOf, type Action, type Ask, type Block, type Instant, type Library, type OwnerArgs } from '@pneuma-base/sdk'

/** `p-` and 8 hexadecimal digits. */
export type PairingId = string & { readonly __brand: 'PairingId' }

export type PairingDecision = { outcome: 'connected'; at: Instant; grant: string; way: Way } | { outcome: 'declined'; at: Instant; reason: string | null }

/** `code`: what the agent shows its user and the owner sees on the home page, `NNN-NNN`. `via`: which face it came in by. */
export type Pairing = {
  format: 1
  id: PairingId
  code: string
  product: string
  why: string
  library: string
  at: Instant
  expires: Instant
  via: 'http' | 'command-line'
  decision: PairingDecision | null
}

/** Derived, never stored: a waiting pairing past `expires` is expired. */
export type PairingState = 'waiting' | 'expired' | 'connected' | 'declined'

export type PairRequest = { home: string; library: string; product: string; why: string; via: Pairing['via']; now: Instant }

/** `again`: the same product already waits on the same library; its pairing is answered again, code unchanged. `text`: what to tell the agent. */
export type PairRequested =
  | { outcome: 'requested'; pairing: Pairing; again: boolean; text: string }
  | { outcome: 'refused'; reason: 'usage' | 'too-many' | 'not-a-library'; text: string }

/** What a connected agent is told: its grant, the command it runs, its MCP addresses, what to read next. */
export type Connected = {
  grant: string
  way: Way
  /** `<launcher> @<grant>`: the command every verb is run with. */
  command: string
  mcp: { url: string | null; stdio: string }
  /** `<library>/PNEUMA-BASE.md` */
  read: string
  next: string
}

/** What `GET /pair/<id>` and `pneuma-base pair status <id>` answer. `text`: the same in words, for the agent. */
export type PairingAnswer = {
  id: PairingId
  state: PairingState
  product: string
  code: string
  expires: Instant
  text: string
  connected: Connected | null
  declined: { reason: string | null } | null
}

/** How many pairings may wait on the owner at once on this machine. */
const MAX_WAITING = 5
const LIFETIME_MS = 10 * 60_000
const WHY_LIMIT = 200
const PAIRING_ID = /^p-[0-9a-f]{8}$/

const dirOf = (home: string) => join(home, 'pairings')
const requestFile = (home: string, id: string) => join(dirOf(home), `${id}.json`)
const decisionFile = (home: string, id: string) => join(dirOf(home), `${id}.decided.json`)

// ---- reading ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function parseDecision(raw: unknown): PairingDecision | null {
  if (!isObject(raw) || !isString(raw.at)) return null
  if (raw.outcome === 'connected') return isString(raw.grant) && (raw.way === 'skill' || raw.way === 'mcp' || raw.way === 'mcp-http') ? (raw as PairingDecision) : null
  return raw.outcome === 'declined' && (raw.reason === null || isString(raw.reason)) ? (raw as PairingDecision) : null
}

/** The pairing `id`, or null when there is none or its file is not one. */
export async function readPairing(home: string, id: string): Promise<Pairing | null> {
  if (!PAIRING_ID.test(id)) return null
  const raw = await readJson(requestFile(home, id))
  if (!isObject(raw) || raw.format !== 1 || raw.id !== id) return null
  const written = ['code', 'product', 'why', 'library', 'at', 'expires'].every((k) => isString(raw[k])) && (raw.via === 'http' || raw.via === 'command-line')
  if (!written) return null
  return { ...(raw as Omit<Pairing, 'decision'>), decision: parseDecision(await readJson(decisionFile(home, id))) }
}

/** Every pairing on this machine, oldest first. */
export async function readPairings(home: string): Promise<Pairing[]> {
  const names = await readdir(dirOf(home)).catch(() => [] as string[])
  const all = await Promise.all(names.filter((n) => /^p-[0-9a-f]{8}\.json$/.test(n)).map((n) => readPairing(home, n.slice(0, -'.json'.length))))
  return all.filter((p): p is Pairing => p !== null).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
}

export const pairingState = (p: Pairing, now: Instant): PairingState => p.decision?.outcome ?? (now >= p.expires ? 'expired' : 'waiting')

/** Records the owner's decision once; false when the pairing was decided already. */
export const decidePairing = (home: string, id: PairingId, decision: PairingDecision): Promise<boolean> => writeOnce(decisionFile(home, id), `${JSON.stringify(decision, null, 2)}\n`)

// ---- what allowing does ----

/** What allowing a pairing runs: `agent connect` with this grant name and way, and what that writes, in words. */
export type AllowPlan = { grant: string; way: Way; where: string; args: OwnerArgs; line: string }

/**
 * The grant name allowing gives: the product's name, or `<product>-2`, `-3`, … when that name is a
 * connection of another product, library or way on this machine, a grant of this library given to
 * another agent, or this machine's grant for another library.
 */
async function freeName(home: string, library: Library, product: string, way: Way): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const name = `${product.slice(0, 41 - suffix.length)}${suffix}`
    const c = await readConnection(home, name)
    const g = library.config.grants.find((x) => x.name === name)
    const local = await readGrantFile(home, name)
    const free = (c === null || (c.product === product && c.library === library.root && c.way === way)) && (g === undefined || g.agent === product) && (local === null || local.library === library.root)
    if (free) return name
  }
}

export async function allowPlan(home: string, env: Env, library: Library, product: string, name: string | null, access: { area: string | null; readOnly: boolean } = { area: null, readOnly: false }): Promise<AllowPlan> {
  const known = CONNECTABLE.find((p) => p.name === product) ?? null
  const way: Way = known === null ? 'mcp-http' : (waysOf(known)[0] as Way)
  const grant = name ?? (await freeName(home, library, product, way))
  const args: OwnerArgs = {
    positional: [product],
    flags: { name: [grant], via: [way], ...(access.area === null ? {} : { area: [access.area] }), ...(access.readOnly ? { 'read-only': true as const } : {}) },
  }
  return { grant, way, where: known === null ? NOTHING_WRITTEN : `写在 ${whereOf(known, way, grant, env)}`, args, line: commandLine('agent connect', args) }
}

// ---- asking ----

const refusal = (reason: Extract<PairRequested, { outcome: 'refused' }>['reason'], text: string): PairRequested => ({ outcome: 'refused', reason, text })

const newCode = () => `${String(randomInt(1000)).padStart(3, '0')}-${String(randomInt(1000)).padStart(3, '0')}`

/** How the agent asks where its pairing stands: the endpoint's address when it came by HTTP and one runs, else the command. */
async function pollLine(home: string, p: Pairing): Promise<string> {
  const endpoint = p.via === 'http' ? await endpointOf(home, p.library) : null
  return endpoint === null ? `${quote(launcherPath(home))} pair status ${p.id}` : `GET ${endpoint.url}/pair/${p.id}`
}

async function requestedText(home: string, p: Pairing, again: boolean): Promise<string> {
  const head = again ? `同一个请求已经在等主人决定，配对码不变：${p.code}。` : `已请求接入这个库，配对码 ${p.code}。`
  return [
    head,
    '把配对码给你的用户看：主人在 Pneuma Base 的首页上看到同一个码，核对后点「允许」。',
    `然后每隔几秒问一次，直到不再是 waiting：${await pollLine(home, p)}`,
    `到 ${when(p.expires)} 还没人允许就过期。`,
  ].join('\n')
}

/** The library at `dir`, as the endpoint and the command line name it: its real path. */
async function libraryRoot(dir: string): Promise<string | null> {
  try {
    return (await openLibrary(dir, new Map()))?.root ?? null
  } catch {
    return null
  }
}

export async function requestPairing(req: PairRequest): Promise<PairRequested> {
  const { home, product, via, now } = req
  if (!GRANT_NAME.test(product)) return refusal('usage', `不是一个产品名：${product}（小写字母或数字开头，只用小写字母、数字和连字符）`)
  const why = req.why.replace(/\p{Cc}/gu, ' ').trim()
  const length = [...why].length
  if (length === 0 || length > WHY_LIMIT) return refusal('usage', `要写为什么：一句话，1 到 ${WHY_LIMIT} 个字，主人据它决定允不允许。`)
  const library = await libraryRoot(req.library)
  if (library === null) return refusal('not-a-library', `${req.library} 不是一个库。`)
  return alone(join(dirOf(home), '.asking'), async () => {
    const waiting = (await readPairings(home)).filter((p) => pairingState(p, now) === 'waiting')
    const same = waiting.find((p) => p.product === product && p.library === library)
    if (same) return { outcome: 'requested', pairing: same, again: true, text: await requestedText(home, same, true) }
    if (waiting.length >= MAX_WAITING) return refusal('too-many', `这台机器上已经有 ${MAX_WAITING} 个配对在等主人决定。请你的用户先处理首页上等着的，或过几分钟再请求。`)
    let code = newCode()
    while (waiting.some((p) => p.code === code)) code = newCode()
    const expires = new Date(Date.parse(now) + LIFETIME_MS).toISOString() as Instant
    for (;;) {
      const stored: Omit<Pairing, 'decision'> = { format: 1, id: `p-${randomBytes(4).toString('hex')}` as PairingId, code, product, why, library, at: now, expires, via }
      const pairing: Pairing = { ...stored, decision: null }
      if (await writeOnce(requestFile(home, pairing.id), `${JSON.stringify(stored, null, 2)}\n`)) return { outcome: 'requested', pairing, again: false, text: await requestedText(home, pairing, false) }
    }
  })
}

// ---- answering ----

function connectedFacts(home: string, p: Pairing, d: Extract<PairingDecision, { outcome: 'connected' }>, url: string | null): Connected {
  const reach = reachOf(launcherPath(home), d.grant, url === null ? null : { url })
  const then = productNamed(p.product)?.next?.[d.way]
  return {
    grant: d.grant,
    way: d.way,
    command: reach.command,
    mcp: reach.mcp,
    read: join(p.library, DESCRIPTION_FILE),
    next: `每件事开始时运行：${reach.command} start "<一句话>"。${then ?? ''}`,
  }
}

function answerText(p: Pairing, state: PairingState, poll: string, connected: Connected | null): string {
  switch (state) {
    case 'waiting':
      return `在等主人决定。把配对码 ${p.code} 给你的用户看：主人在 Pneuma Base 的首页上核对后点「允许」。每隔几秒再问一次：${poll}。到 ${when(p.expires)} 还没人允许就过期。`
    case 'expired':
      return '这次配对已经过期（10 分钟没人允许）。要接上，重新请求一次。'
    case 'declined': {
      const reason = p.decision?.outcome === 'declined' && p.decision.reason !== null ? `，理由：${p.decision.reason}` : ''
      return `主人拒绝了这次接入${reason}。不要再请求。`
    }
    case 'connected': {
      const c = connected as Connected
      return [
        `已接上，授权名 ${c.grant}（${WAY_WORD[c.way]}）。`,
        `之后每条命令都这样运行：${c.command} <动词> …`,
        `先读 ${c.read}。`,
        `只能接 MCP 的应用：${c.mcp.url === null ? '' : `${c.mcp.url}，或者 `}${c.mcp.stdio}`,
        `接着：${c.next}`,
      ].join('\n')
    }
  }
}

/** Null when no pairing has this id. */
export async function pairingAnswer(home: string, id: string, now: Instant): Promise<PairingAnswer | null> {
  const p = await readPairing(home, id)
  if (p === null) return null
  const state = pairingState(p, now)
  const url = (await endpointOf(home, p.library))?.url ?? null
  const connected = p.decision?.outcome === 'connected' ? connectedFacts(home, p, p.decision, url) : null
  const declined = p.decision?.outcome === 'declined' ? { reason: p.decision.reason } : null
  return { id: p.id, state, product: p.product, code: p.code, expires: p.expires, text: answerText(p, state, await pollLine(home, p), connected), connected, declined }
}

// ---- on the owner's pages ----

const ID = { name: 'id', hint: '配对号', required: true } as const
export const PAIR_ALLOW = {
  name: 'pair allow',
  params: {
    positional: [ID],
    flags: [
      { name: 'area', hint: '子文件夹', kind: 'value' },
      { name: 'read-only', hint: '只读', kind: 'boolean' },
      { name: 'name', hint: '授权名，缺省是产品名', kind: 'value', pattern: GRANT_NAME.source },
    ],
  },
} as const
export const PAIR_DECLINE = { name: 'pair decline', params: { positional: [ID, { name: 'reason', hint: '理由' }] } } as const

const allowAction = (id: PairingId): Action => ({ label: '允许', tone: 'default', confirm: null, ...formOf(PAIR_ALLOW, { fixed: { id, name: false } }) })
const declineAction = (id: PairingId): Action => ({ label: '拒绝', tone: 'default', confirm: null, ...formOf(PAIR_DECLINE, { fixed: { id } }) })
export const pairingActions = (id: PairingId): Action[] => [allowAction(id), declineAction(id)]

/** What a waiting pairing asks the owner, in one sentence: who, the code, why, and what allowing does. */
export const askText = (p: Pairing, plan: AllowPlan) =>
  `${titleOf(p.product)} 想接入这个库：允许吗？配对码 ${p.code}。为什么：${p.why}。允许就发授权 ${plan.grant}，以「${WAY_WORD[plan.way]}」接上，${plan.where}。`

/** The pairings of the library at `root`, oldest first. */
export const pairingsOf = async (home: string, root: string): Promise<Pairing[]> => (await readPairings(home)).filter((p) => p.library === root)

/** The waiting pairings of the library as asks of the home page, oldest first. No answer is suggested: the owner checks the code first. */
export async function pairingAsks(home: string, env: Env, library: Library, now: Instant): Promise<Ask[]> {
  const waiting = (await pairingsOf(home, library.root)).filter((p) => pairingState(p, now) === 'waiting')
  const asks: Ask[] = []
  for (const p of waiting) {
    const plan = await allowPlan(home, env, library, p.product, null)
    asks.push({ key: `pairing:${p.id}`, by: { kind: 'agent', name: p.product }, text: askText(p, plan), command: plan.line, about: null, actions: pairingActions(p.id) })
  }
  return asks
}

/** The one sentence the owner says to any agent, to copy, and how it goes on from there. `where`: where the owner allows it. */
export const sentenceBlock = (url: string, where: string): Block => ({
  kind: 'list',
  items: [{ cell: { text: sentenceFor(url), copy: true }, note: `任何 agent 都能这样自己接上：把这句话发给它，它读了说明会请求接入；你核对它给出的配对码，在${where}点「允许」。`, actions: [] }],
})
