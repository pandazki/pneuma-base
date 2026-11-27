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

const STATE_WORD: Record<Exclude<PairingState, 'waiting'>, string> = { connected: '已接上', declined: '已拒绝', expired: '已过期' }

function settledText(p: Pairing, state: Exclude<PairingState, 'waiting'>): string {
  const d = p.decision
  const more = d?.outcome === 'connected' ? `，授权 ${d.grant}` : d?.outcome === 'declined' && d.reason !== null ? `，理由：${d.reason}` : ''
  return `${STATE_WORD[state]}${more}`
}

/** The pairing `id` of this library while it waits; or the refusal that says why it cannot be decided. */
async function waiting(id: string, call: LibraryCall): Promise<Pairing | Outcome> {
  const p = await readPairing(call.ctx.home, id)
  if (p === null) return refused('no-such-pairing', `没有配对 ${id}。pair list 列出等你决定的。`)
  if (p.library !== call.ctx.library.root) return refused('other-library', `配对 ${id} 请求接入的是 ${p.library}，不是这个库。`)
  const state = pairingState(p, call.ctx.now)
  if (state === 'expired') return refused('expired', `配对 ${id} 已经过期（10 分钟没人允许）。要接上，请那个 agent 重新请求一次。`)
  if (state !== 'waiting') return refused('not-pending', `配对 ${id} ${settledText(p, state)}，不能再决定。`)
  return p
}

export const PAIR_COMMANDS: readonly KernelCommand[] = [
  command({
    name: 'pair list',
    summary: `请求接入这个库的 agent：每个配对的配对码、为什么、允许会运行的命令；--all 也列出最近 ${SETTLED_SHOWN} 个已经了结或过期的`,
    params: { flags: [{ name: 'all', hint: '也列出已经了结或过期的', kind: 'boolean' }] },
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
      const lines = open.length === 0 ? ['没有等你决定的配对。'] : [`等你决定的配对（${open.length}）：`]
      for (const p of open) {
        const plan = await allowPlan(home, call.env, library, p.product, null)
        lines.push(`- ${askText(p, plan)}`, `    ${plan.line}`, `    $ pair allow ${p.id} [--area <子文件夹>] [--read-only]  # 允许`, `    $ pair decline ${p.id} [<理由>]  # 拒绝`)
      }
      if (all && settled.length > 0) {
        lines.push(`已经了结或过期的（最近 ${settled.length} 个）：`)
        lines.push(...settled.map((p) => `- ${p.id} · ${titleOf(p.product)} · ${p.code} · ${when(p.at)} · ${settledText(p, pairingState(p, now) as Exclude<PairingState, 'waiting'>)}`))
      }
      return done(lines.join('\n'), { pairings: all ? [...open, ...settled] : open })
    },
  }),
  command({
    name: 'pair allow',
    summary: '允许一个请求接入的 agent：以它的产品名发授权，照产品表接上（就是 agent connect）；可以限在一个区域、只读，或另起授权名',
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
        return refused('not-pending', `配对 ${p.id} 在这期间被决定了。${answer.text}`)
      }
      const text = `已允许 ${titleOf(p.product)} 接入（配对码 ${p.code}），它下次问的时候拿到授权名 ${plan.grant}。\n${answer.text}`
      return { answer: { ...answer, text }, problems }
    },
  }),
  command({
    name: 'pair decline',
    summary: '拒绝一个请求接入的 agent，可以说一句理由；它下次问的时候知道，不会再请求',
    params: PAIR_DECLINE.params,
    destructive: false,
    ownerOnly: true,
    askable: false,
    scope: 'library',
    async run({ id, reason }, call) {
      const p = await waiting(id, call)
      if (!('id' in p)) return p
      if (!(await decidePairing(call.ctx.home, p.id, { outcome: 'declined', at: call.ctx.now, reason }))) return refused('not-pending', `配对 ${p.id} 在这期间被决定了。`)
      return done(`已拒绝 ${titleOf(p.product)} 接入这个库（配对码 ${p.code}）${reason === null ? '' : `，理由：${reason}`}。它下次问的时候知道，不会再请求。`, { pairing: p.id })
    },
  }),
]
