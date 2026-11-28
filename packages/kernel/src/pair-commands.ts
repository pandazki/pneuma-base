// The owner's side of pairing: list the pairings, allow one, decline one. ARCHITECTURE.md「配对」.
// `ownerFace` is read only inside `run`, so this module and the owner face may import each other.
import { titleOf } from './agent-commands.js'
import { command, done, refused, type KernelCommand, type Outcome } from './kernel-command.js'
import type { LibraryCall } from './owner.js'
import { ownerFace } from './owner.js'
import { allowPlan, askText, decidePairing, PAIR_ALLOW, PAIR_DECLINE, pairingsOf, pairingState, readPairing, type Pairing, type PairingState } from './pairing.js'
import { when } from './requests.js'

/** How many settled and expired pairings `pair list --all` shows, the latest. */
const SETTLED_SHOWN = 50

const STATE_WORD: Record<Exclude<PairingState, 'waiting'>, string> = { connected: '已连接', declined: '已拒绝', expired: '已过期' }

function settledText(p: Pairing, state: Exclude<PairingState, 'waiting'>): string {
  const d = p.decision
  const more = d?.outcome === 'connected' ? `，授权 ${d.grant}` : d?.outcome === 'declined' && d.reason !== null ? `，原因：${d.reason}` : ''
  return `${STATE_WORD[state]}${more}`
}

/** The pairing `id` of this library while it waits; or the refusal that says why it cannot be decided. */
async function waiting(id: string, call: LibraryCall): Promise<Pairing | Outcome> {
  const p = await readPairing(call.ctx.home, id)
  if (p === null) return refused('no-such-pairing', `配对 ${id} 不存在。pair list 列出待处理的配对。`)
  if (p.library !== call.ctx.library.root) return refused('other-library', `配对 ${id} 请求接入的是 ${p.library}，而非此资料库。`)
  const state = pairingState(p, call.ctx.now)
  if (state === 'expired') return refused('expired', `配对 ${id} 已过期（10 分钟内未获允许）。如需连接，请该 Agent 重新请求。`)
  if (state !== 'waiting') return refused('not-pending', `配对 ${id} ${settledText(p, state)}，无法再处理。`)
  return p
}

export const PAIR_COMMANDS: readonly KernelCommand[] = [
  command({
    name: 'pair list',
    summary: `请求接入此资料库的 Agent：每个配对的配对码、原因和允许后运行的命令；--all 同时列出最近 ${SETTLED_SHOWN} 个已处理或已过期的配对`,
    params: { flags: [{ name: 'all', hint: '包含已处理或已过期的', kind: 'boolean' }] },
    destructive: false,
    ownerOnly: true,
    readOnly: true,
    askable: false,
    scope: 'library',
    async run({ all }, call) {
      const { home, library, now } = call.ctx
      const mine = await pairingsOf(home, library.root)
      const open = mine.filter((p) => pairingState(p, now) === 'waiting')
      const settled = mine.filter((p) => pairingState(p, now) !== 'waiting').slice(-SETTLED_SHOWN)
      const lines = open.length === 0 ? ['暂无待处理的配对。'] : [`待处理的配对（${open.length}）：`]
      for (const p of open) {
        const plan = await allowPlan(home, call.env, library, p.product, null)
        lines.push(`- ${askText(p, plan)}`, `    ${plan.line}`, `    $ pair allow ${p.id} [--area <子文件夹>] [--read-only]  # 允许`, `    $ pair decline ${p.id} [<原因>]  # 拒绝`)
      }
      if (all && settled.length > 0) {
        lines.push(`已处理或已过期（最近 ${settled.length} 个）：`)
        lines.push(...settled.map((p) => `- ${p.id} · ${titleOf(p.product)} · ${p.code} · ${when(p.at)} · ${settledText(p, pairingState(p, now) as Exclude<PairingState, 'waiting'>)}`))
      }
      return done(lines.join('\n'), { pairings: all ? [...open, ...settled] : open })
    },
  }),
  command({
    name: 'pair allow',
    act: { kind: 'connected', object: 'name' },
    summary: '允许请求接入的 Agent：以其产品名称新建授权，按产品表连接（即 agent connect）；可限定区域、只读，或指定其他授权名称',
    params: PAIR_ALLOW.params,
    destructive: false,
    ownerOnly: true,
    askable: false,
    scope: 'library',
    /** Runs `agent connect` through the owner face; only when it connects is the pairing decided. A refusal is its answer, and the pairing keeps waiting. */
    async run({ id, area, 'read-only': readOnly, name }, call) {
      const p = await waiting(id, call)
      if (!('id' in p)) return p
      const plan = await allowPlan(call.ctx.home, call.env, call.ctx.library, p.product, name, { area, readOnly })
      const { problems, ...answer } = await ownerFace.dispatch(call, 'agent connect', plan.args)
      if (answer.outcome !== 'done') return { answer, problems }
      if (!(await decidePairing(call.ctx.home, p.id, { outcome: 'connected', at: call.ctx.now, grant: plan.grant, way: plan.way }))) {
        return refused('not-pending', `配对 ${p.id} 在此期间已被处理。${answer.text}`)
      }
      const text = `已允许 ${titleOf(p.product)} 接入（配对码 ${p.code}），该 Agent 下次查询时获得授权名称 ${plan.grant}。\n${answer.text}`
      return { answer: { ...answer, text }, problems }
    },
  }),
  command({
    name: 'pair decline',
    act: { kind: 'declined', object: 'id' },
    summary: '拒绝请求接入的 Agent，可附原因；该 Agent 下次查询时获知结果，不会再次请求',
    params: PAIR_DECLINE.params,
    destructive: false,
    ownerOnly: true,
    askable: false,
    scope: 'library',
    async run({ id, reason }, call) {
      const p = await waiting(id, call)
      if (!('id' in p)) return p
      if (!(await decidePairing(call.ctx.home, p.id, { outcome: 'declined', at: call.ctx.now, reason }))) return refused('not-pending', `配对 ${p.id} 在此期间已被处理。`)
      return done(`已拒绝 ${titleOf(p.product)} 接入此资料库（配对码 ${p.code}）${reason === null ? '' : `，原因：${reason}`}。该 Agent 下次查询时获知结果，不会再次请求。`, { pairing: p.id })
    },
  }),
]
