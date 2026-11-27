// The owner's side of requests: list them, approve one, decline one. ARCHITECTURE.md「请主人做」.
// `ownerFace` is read only inside `run`, so this module and the owner face may import each other.
import { command, done, refused, type KernelCommand } from './kernel-command.js'
import { ownerFace } from './owner.js'
import { APPROVE, DECLINE, endText, isPending, pendingLines, readRequests, recordDecision, requestNamed, when } from './requests.js'
import type { OwnerRequest } from '@pneuma-base/sdk'

/** How many settled requests `request list --all` shows, the latest. */
const SETTLED_SHOWN = 50

const notPending = (r: OwnerRequest) => refused('not-pending', `请求 ${r.id} ${endText(r)}，不能再决定。`)
const noSuch = (id: string) => refused('no-such-request', `没有请求 ${id}。request list 列出等你决定的。`)

export const REQUEST_COMMANDS: readonly KernelCommand[] = [
  command({
    name: 'request list',
    summary: `agent 请你做的事：每个请求为什么、要运行的命令，和批准、拒绝它的命令；--all 也列出最近 ${SETTLED_SHOWN} 个已经了结的，--older 连更早的一起列出`,
    params: {
      flags: [
        { name: 'all', hint: '也列出已经了结的', kind: 'boolean' },
        { name: 'older', hint: `已经了结的全部列出，不只最近 ${SETTLED_SHOWN} 个`, kind: 'boolean' },
      ],
    },
    destructive: false,
    ownerOnly: true,
    readOnly: true,
    askable: false,
    scope: 'library',
    async run({ all, older: every }, call) {
      const requests = await readRequests(call.ctx.library.root)
      const pending = requests.filter(isPending)
      const ended = requests.filter((r) => !isPending(r))
      // Every request stays on disk as the record; the list shows the latest unless asked for all.
      const shown = every ? ended : ended.slice(-SETTLED_SHOWN)
      const older = ended.length - shown.length
      const lines = pending.length === 0 ? ['没有等你决定的请求。'] : [`等你决定的请求（${pending.length}）：`, ...pending.flatMap(pendingLines)]
      if ((all || every) && ended.length > 0) {
        lines.push(older > 0 ? `已经了结的（最近 ${shown.length} 个；更早的 ${older} 个没有列出，加 --older 全部列出）：` : '已经了结的：')
        lines.push(...shown.map((r) => `- ${r.id} · ${r.by.name} · ${when(r.at)} · ${r.line} · ${endText(r)}`))
      }
      return done(lines.join('\n'), all || every ? { requests: [...pending, ...shown], older } : { requests: pending })
    },
  }),
  command({
    name: 'request approve',
    summary: '批准 agent 的一个请求：以主人的身份照原样运行它请的命令',
    params: APPROVE.params,
    destructive: false,
    ownerOnly: true,
    askable: false,
    scope: 'library',
    /**
     * Runs the command as the owner now, through the owner face, its event carrying the request. What
     * it answers, a refusal too, is the request's outcome and this command's answer.
     */
    async run({ id }, call) {
      const { root } = call.ctx.library
      const r = await requestNamed(root, id)
      if (r === null) return noSuch(id)
      if (!isPending(r)) return notPending(r)
      // A plugin may have changed since the ask: what turned destructive needs its own in-person confirmation, which approving does not give.
      const now = ownerFace.commands(call.ctx.library.plugins).find((c) => c.name === r.command)
      if (now !== undefined && (now.destructive || (now.ownerOnly && !now.askable))) {
        const text = `「${r.command}」现在${now.destructive ? '会丢数据，要你当面确认' : '不能被请'}，批准不运行它。要做就直接运行：${r.line}`
        await recordDecision(root, r.id, call.ctx.now, { decision: 'approved', outcome: { outcome: 'refused', reason: 'no-longer-askable', text } })
        return refused('no-longer-askable', text)
      }
      let result
      try {
        result = await ownerFace.dispatch({ ...call, request: { id: r.id, by: r.by } }, r.command, r.args)
      } catch (error) {
        await recordDecision(root, r.id, call.ctx.now, { decision: 'approved', outcome: { outcome: 'failed', message: error instanceof Error ? error.message : String(error) } })
        throw error
      }
      const { problems, ...answered } = result
      // The command's params changed since the request: that is no usage error of the owner's own call.
      const answer = answered.outcome === 'refused' && answered.reason === 'usage' ? { ...answered, reason: 'no-longer-fits', text: `「${r.command}」的参数表变了，请求里的参数不再合它：${answered.text}` } : answered
      const outcome = answer.outcome === 'done' ? { outcome: 'done' as const, text: answer.text } : { outcome: 'refused' as const, reason: answer.reason, text: answer.text }
      await recordDecision(root, r.id, call.ctx.now, { decision: 'approved', outcome })
      return { answer, problems }
    },
  }),
  command({
    name: 'request decline',
    act: { kind: 'declined', object: 'id' },
    summary: '拒绝 agent 的一个请求，可以说一句理由；它请的命令不运行',
    params: DECLINE.params,
    destructive: false,
    ownerOnly: true,
    askable: false,
    scope: 'library',
    async run({ id, reason }, call) {
      const { root } = call.ctx.library
      const r = await requestNamed(root, id)
      if (r === null) return noSuch(id)
      if (!isPending(r)) return notPending(r)
      await recordDecision(root, r.id, call.ctx.now, { decision: 'declined', reason })
      return done(`已拒绝 ${r.by.name} 的请求 ${r.id}：${r.line}${reason === null ? '' : `。理由：${reason}`}。${r.by.name} 下次 check 时会看到。`, { request: r.id })
    },
  }),
]
