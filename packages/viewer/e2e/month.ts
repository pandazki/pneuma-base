// A library's ledger as weeks of real use would leave it, written straight into its facts folder: the
// command line always writes the present moment, and the statistics need days gone by. Three agents
// bring sources and make things from them, often from what another session or another agent left;
// they decide, note, ask the owner; the owner approves, declines, drops files in, archives; sources
// change and some made things go stale until they are made again; a few files are changed directly.
// The files on disk hold the content the facts record, so every other page agrees with it. The facts
// are laid out as storage writes them: a directory per day, a file per write named by its moment, its
// writer and a sequence number (core/README.md).
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type Actor = { kind: 'agent' | 'owner' | 'plugin'; name: string; grant: string | null }
type Fact = Record<string, unknown> & { id: string; at: string; scene: string; actor: Actor }
type Thing = { id: string; path: string; content: string; print: string; scene: string; agent: string; made: boolean; basis: { item: string; fingerprint: string }[]; archived: boolean; observed: boolean }

export type Shape = {
  /** How many days back the first one is; the last is today. */
  days: number
  /** Sessions each day, on average, all agents together. */
  sessions: number
  /** The notes and decisions a session says beyond its first sentence, on average. */
  talk?: number
  /** Facts in one file: 1 as the hooks write them; more makes a large ledger quicker to write. */
  batch?: number
  seed?: number
  now?: Date
}

const AGENTS = [
  { name: 'claude-code', grant: 'claude', weight: 0.5 },
  { name: 'codex', grant: 'codex', weight: 0.32 },
  { name: 'gemini', grant: 'gemini', weight: 0.18 },
]

const TOPICS = [
  { dir: 'payments', doing: ['给电子书小店选支付服务', '把 Paddle 接进小店', '核对欧洲增值税的算法', '写退款流程'], sources: ['stripe-pricing', 'paddle-pricing', 'lemonsqueezy-pricing', 'eu-vat-rules', 'refund-policy'], made: ['comparison', 'recommendation', 'integration-notes', 'tax-table', 'refund-flow'] },
  { dir: 'sites/landing', doing: ['做小店的落地页', '改落地页的文案', '给落地页加价格表'], sources: ['brand-guide', 'competitor-pages', 'customer-quotes'], made: ['index', 'pricing', 'copy-draft', 'faq'] },
  { dir: 'research/readers', doing: ['整理读者访谈', '找读者最常问的问题', '归纳读者画像'], sources: ['interview-01', 'interview-02', 'interview-03', 'survey-results', 'support-emails'], made: ['personas', 'top-questions', 'insights'] },
  { dir: 'reports', doing: ['写这周的周报', '汇总这个月的进展'], sources: ['metrics-export', 'meeting-notes'], made: ['weekly', 'monthly-summary'] },
]

const DECISIONS = ['用 Paddle，因为它替我们处理欧洲的税', '落地页只放三档价格', '先只卖电子书，不做订阅', '退款七天内无条件', '读者画像只保留三类']
const NOTES = ['税率表下季度要再核一遍', '价格页的截图是 11 月的', '访谈 02 的录音有一段听不清', '这份比较没算汇率损失', '周报的数字来自后台导出']

/** A small seeded generator, so the same shape gives the same library. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const compact = (at: string) => at.replace(/[^0-9]/g, '')

/**
 * Writes the ledger of `shape` into the library at `lib`, whose config has grants named claude,
 * codex and gemini, and the files it records. Answers how many things and facts it wrote.
 */
export function writeHistory(lib: string, shape: Shape): { things: number; facts: number } {
  const rnd = random(shape.seed ?? 7)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T
  const now = shape.now ?? new Date()
  const config = JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')) as { grants: { id: string; name: string }[] }
  const grantOf = (name: string) => config.grants.find((g) => g.name === name)?.id ?? null
  const factsDir = join(lib, '.pneuma-base/ledger/facts')
  const writer = randomBytes(3).toString('hex')
  let seq = 0
  let written = 0
  const pending = new Map<string, Fact[]>()
  const fileWriter = randomBytes(6).toString('hex')
  let files = 0
  const flush = (scene: string) => {
    const list = pending.get(scene)
    if (!list || list.length === 0) return
    const at = list[0]?.at as string
    const dir = join(factsDir, at.slice(0, 10))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${compact(at)}-${fileWriter}-${String(files++).padStart(6, '0')}.jsonl`), list.map((f) => `${JSON.stringify(f)}\n`).join(''))
    pending.set(scene, [])
  }
  const emit = (at: Date, scene: string, actor: Actor, body: Record<string, unknown>, how = 'tool') => {
    const iso = at.toISOString()
    const fact: Fact = { id: `f_${compact(iso)}_${writer}_${(seq++).toString(36).padStart(4, '0')}`, at: iso, scene, actor, where: { cwd: `/Users/demo/work/${scene.slice(0, 4)}`, machine: 'demo-mac', sessionSource: actor.kind === 'agent' ? 'env' : 'minted', transcript: null }, how, ...body }
    pending.set(scene, [...(pending.get(scene) ?? []), fact])
    written++
    if ((pending.get(scene) as Fact[]).length >= (shape.batch ?? 1)) flush(scene)
  }

  const things: Thing[] = []
  const byPath = new Map<string, Thing>()
  const byId = new Map<string, Thing>()
  /** The things not archived, oldest first. */
  let live: Thing[] = []
  const owner: Actor = { kind: 'owner', name: 'owner', grant: null }
  const newPath = (dir: string, name: string, ext: string) => {
    for (let n = 1; ; n++) {
      const path = `${dir}/${name}${n === 1 ? '' : `-${n}`}.${ext}`
      if (!byPath.has(path)) return path
    }
  }
  const enter = (at: Date, scene: string, actor: Actor, path: string, origin: Record<string, unknown>, basis: Thing['basis'], made: boolean, how = 'tool') => {
    const content = `${path}\n${made ? '做出来的' : '带进来的'}，${at.toISOString()}，${rnd()}\n`
    const thing: Thing = { id: `i_${randomBytes(5).toString('hex')}`, path, content, print: sha(content), scene, agent: actor.name, made, basis, archived: false, observed: false }
    things.push(thing)
    live.push(thing)
    byPath.set(path, thing)
    byId.set(thing.id, thing)
    emit(at, scene, actor, { kind: 'item.enter', item: thing.id, path, fingerprint: thing.print, size: Buffer.byteLength(content), origin }, how)
    return thing
  }
  const revise = (at: Date, scene: string, actor: Actor, thing: Thing, extra: Record<string, unknown> = {}, how = 'tool') => {
    const base = thing.print
    thing.content = `${thing.content}改过一次，${at.toISOString()}\n`
    thing.print = sha(thing.content)
    emit(at, scene, actor, { kind: 'item.revise', item: thing.id, base, fingerprint: thing.print, size: Buffer.byteLength(thing.content), held: null, claimed: false, ...extra }, how)
  }

  const requests: { id: string; asked: Date; scene: string; agent: Actor; line: string }[] = []
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - shape.days)
  for (let d = 0; d <= shape.days; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d)
    const today = d === shape.days
    const count = Math.max(0, Math.round(shape.sessions * (0.5 + rnd()) * (day.getDay() === 0 || day.getDay() === 6 ? 0.4 : 1)))
    for (let k = 0; k < count; k++) {
      const roll = rnd()
      const agentDef = AGENTS.find((_, i) => roll < AGENTS.slice(0, i + 1).reduce((n, a) => n + a.weight, 0)) ?? (AGENTS[0] as (typeof AGENTS)[number])
      const actor: Actor = { kind: 'agent', name: agentDef.name, grant: grantOf(agentDef.grant) }
      const scene = randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')
      const topic = pick(TOPICS)
      let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9 + Math.floor(rnd() * 12), Math.floor(rnd() * 60))
      if (at > now) at = new Date(now.getTime() - (count - k) * 60_000)
      const tick = () => (at = new Date(at.getTime() + (2 + Math.floor(rnd() * 9)) * 60_000))
      emit(at, scene, actor, { kind: 'said', flavor: 'doing', text: pick(topic.doing), about: null }, 'reported')
      emit(tick(), scene, actor, { kind: 'checked' })
      const mine: Thing[] = []
      for (let b = Math.floor(rnd() * 3.2); b > 0; b--) mine.push(enter(tick(), scene, actor, newPath(`${topic.dir}/sources`, pick(topic.sources), 'md'), { kind: 'brought', source: `https://example.com/${pick(topic.sources)}`, by: null }, [], false))
      for (let m = 1 + Math.floor(rnd() * 2.4); m > 0; m--) {
        // Most made things rest on what is in the library: often this session's sources, often earlier work.
        const earlier = live.slice(-80).filter((t) => t.scene !== scene)
        const from = [...(mine.length > 0 && rnd() < 0.55 ? [pick(mine)] : []), ...(earlier.length > 0 && rnd() < 0.62 ? [pick(earlier)] : []), ...(earlier.length > 0 && rnd() < 0.25 ? [pick(earlier)] : [])]
        const basis = [...new Set(from)].map((t) => ({ item: t.id, fingerprint: t.print }))
        const outside = basis.length === 0 || rnd() < 0.2 ? ['主人在对话里说的要求'] : []
        const target = pick(topic.made)
        const again = byPath.get(`${topic.dir}/${target}.md`)
        if (again && !again.archived && rnd() < 0.3) {
          revise(tick(), scene, actor, again, { basis: { items: basis, outside } })
          again.basis = basis
          continue
        }
        mine.push(enter(tick(), scene, actor, newPath(topic.dir, target, 'md'), { kind: 'made', basis: { items: basis, outside } }, basis, true))
      }
      for (let n = Math.round((shape.talk ?? 1) * rnd() * 2); n > 0; n--) {
        const about = rnd() < 0.5 && mine.length > 0 ? (pick(mine).id as string) : null
        emit(tick(), scene, actor, rnd() < 0.4 ? { kind: 'said', flavor: 'decided', text: pick(DECISIONS), about } : { kind: 'said', flavor: 'note', text: pick(NOTES), about }, 'reported')
      }
      // A source changes now and then, and what was made from it may be out of date until made again.
      if (rnd() < 0.18) {
        const source = pick(live.slice(-120).filter((t) => !t.made))
        if (source) revise(tick(), scene, actor, source)
      }
      if (rnd() < 0.12) {
        const redo = live.slice(-400).find((t) => t.made && t.basis.some((row) => byId.get(row.item)?.print !== row.fingerprint))
        if (redo) {
          const basis = redo.basis.map((row) => ({ item: row.item, fingerprint: byId.get(row.item)?.print ?? row.fingerprint }))
          revise(tick(), scene, actor, redo, { basis: { items: basis, outside: [] } })
          redo.basis = basis
        }
      }
      // A direct change only seen: claimed later by the agent that made it.
      const unclaimed = live.slice(-200).find((t) => t.observed)
      if (unclaimed && unclaimed.agent === actor.name && rnd() < 0.6) {
        emit(tick(), scene, actor, { kind: 'item.revise', item: unclaimed.id, base: unclaimed.print, fingerprint: unclaimed.print, size: Buffer.byteLength(unclaimed.content), held: null, claimed: true }, 'reported')
        unclaimed.observed = false
      }
      if (rnd() < 0.08) {
        const id = `r-${randomBytes(4).toString('hex')}`
        const line = rnd() < 0.5 ? 'deploy online sites/landing' : 'plugin enable version'
        emit(tick(), scene, actor, { kind: 'request', act: 'asked', request: id, line, why: '要让主人在线上看到改好的页' })
        requests.push({ id, asked: at, scene, agent: actor, line })
      }
    }

    // The owner's day: decide what agents asked, drop a file in, archive what is done with.
    const ownerScene = `adhoc-owner-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 21, 30)
    if (at > now) at = new Date(now.getTime() - 5 * 60_000)
    const tick = () => (at = new Date(at.getTime() + 60_000))
    if (d === 0) {
      for (const g of AGENTS) emit(tick(), ownerScene, owner, { kind: 'owner.op', command: 'grant create', summary: `已发授权 ${g.grant}，给 ${g.name}`, destructive: false })
    }
    for (const r of requests.splice(0, today ? requests.length - 1 : requests.length)) {
      const fate = rnd()
      if (fate < 0.6) emit(tick(), ownerScene, owner, { kind: 'owner.op', command: r.line.split(' ').slice(0, 2).join(' '), summary: `已做：${r.line}`, destructive: false, request: { id: r.id, by: r.agent } })
      else if (fate < 0.85) emit(tick(), ownerScene, owner, { kind: 'owner.op', command: 'request decline', summary: `已拒绝 ${r.agent.name} 的请求 ${r.id}：${r.line}。${r.agent.name} 下次 check 时会看到。`, destructive: false, declined: { id: r.id, by: r.agent } })
      else emit(new Date(r.asked.getTime() + 30 * 60_000), r.scene, r.agent, { kind: 'request', act: 'withdrawn', request: r.id, line: r.line })
    }
    if (rnd() < 0.35) enter(tick(), ownerScene, owner, newPath('inbox', pick(['合同扫描', '截图', '会议纪要', '发票']), 'pdf'), { kind: 'brought', source: null, by: 'owner' }, [], false, 'observed')
    if (rnd() < 0.3) {
      const changed = pick(live.slice(-60).filter((t) => t.made))
      if (changed) {
        revise(tick(), ownerScene, owner, changed, { claimed: true }, 'observed')
        changed.observed = true
      }
    }
    if (rnd() < 0.15) enter(tick(), ownerScene, owner, newPath('inbox', '没人登记的文件', 'txt'), { kind: 'adopted' }, [], false)
    for (const old of live.filter((t) => t.scene !== ownerScene && rnd() < 0.015)) {
      const to = `_archive/${old.path}`
      if (byPath.has(to)) continue
      emit(tick(), ownerScene, owner, { kind: 'item.move', item: old.id, from: old.path, to, archive: 'in' })
      byPath.delete(old.path)
      old.path = to
      old.archived = true
      byPath.set(to, old)
    }
    live = live.filter((t) => !t.archived)
  }
  for (const scene of pending.keys()) flush(scene)
  for (const t of things) {
    mkdirSync(dirname(join(lib, t.path)), { recursive: true })
    writeFileSync(join(lib, t.path), t.content)
  }
  return { things: things.length, facts: written }
}
