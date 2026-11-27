// The owner commands: sync target set, sync now, sync status. None makes content unrecoverable on
// its own: sync now deletes on the other side only what the owner deleted with a destructive
// command, already confirmed in person. So none is destructive and an agent may run them.
import { resolve } from 'node:path'
import { defineCommand, type OwnerAnswer, type OwnerCommand } from '@pneuma-base/kernel'
import { envelope, writeFacts, type RunFact, type TargetFact } from './facts.js'
import { machineTarget } from './rows.js'
import { countsText, notReadyText, overlaps, pendingOf, prepare, run, status, targetOf, when } from './sync.js'
import { makeTarget } from './target.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string, data?: unknown): OwnerAnswer => ({ outcome: 'refused', reason, text, ...(data === undefined ? {} : { data }) })

export const TARGET_SET = defineCommand({
  name: 'sync target set',
  act: { kind: 'set', object: 'to', name: '同步目标' },
  summary: '设同步目标：本机上的一个目录',
  params: {
    flags: [
      { name: 'kind', hint: '种类', kind: 'value', required: true, options: [{ value: 'dir', label: 'dir：本机上的一个目录' }] },
      { name: 'to', hint: '目录', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ to }, ctx) {
    const root = ctx.library.root
    const wanted = resolve(ctx.session.cwd, to)
    if (overlaps(root, wanted)) return refused('target-overlaps', `${wanted} 和库的目录互相包含，不能当同步目标。换一个库外的目录。`)
    // A disk that is not mounted, or a folder this user cannot write, is the owner's to fix, not a crash.
    const made = makeTarget(wanted)
    if ('error' in made) return refused('target-unreachable', `建不了这个目录：${made.error}。盘没挂上就先挂上，或换一个能写的目录。`)
    const { path } = made
    if (overlaps(root, path)) return refused('target-overlaps', `${path} 和库的目录互相包含，不能当同步目标。换一个库外的目录。`)
    const machine = ctx.session.machine
    const mine = await machineTarget((await targetOf(ctx)).rows, machine)
    if (mine?.target.path === path) return done(`同步目标本来就是目录 ${path}，没有变。`, { target: mine.target })
    const fact: TargetFact = { ...envelope(ctx), kind: 'target.set', target: { kind: 'dir', path } }
    await writeFacts(ctx, [fact])
    return done(`已把这台机器（${machine}）的同步目标设为目录 ${path}。用 sync now 同步。`, { target: fact.target })
  },
})

function runText(fact: RunFact): string[] {
  const { counts, conflicts, kept } = fact
  const moved = counts.pushed + counts.pulled + counts.removed + counts.deleted + counts.kept + counts.conflicts
  const head =
    fact.outcome === 'failed'
      ? `同步到 ${fact.target.path} 时中断：${fact.message}`
      : moved === 0 ? `已同步：两边一样，什么都没动。目标：目录 ${fact.target.path}` : `已同步：本地 ⇄ 目录 ${fact.target.path}`
  return [
    head,
    ...(moved > 0 ? [countsText(counts)] : []),
    ...(conflicts.length > 0 ? ['冲突（两份都在：本地的在原处，另一边的那份是冲突副本）：', ...conflicts.map((c) => `  ${c.path}  另一份：${c.copy}`)] : []),
    ...(kept.length > 0 ? ['留下（另一边删掉或换掉、别处又没有副本的内容）：', ...kept.map((k) => `  ${k.to}`)] : []),
    ...(counts.skipped > 0 ? [`跳过 ${counts.skipped} 处：同步时又被改了，没有动，下次再同步。`] : []),
    ...(fact.outcome === 'failed' ? ['做完的留着，没做的下次再做；内容没有丢。'] : []),
  ]
}

const now = defineCommand({
  name: 'sync now',
  act: { kind: 'synced', name: '同步' },
  summary: '现在同步：不合并内容，不让任何内容找不回',
  params: {},
  destructive: false,
  ownerOnly: false,
  async run(_values, ctx) {
    const prepared = await prepare(ctx, (await targetOf(ctx)).record, 'run')
    if (prepared.kind !== 'ready') return refused(prepared.kind, `${notReadyText(prepared, ctx.session.machine)}什么都没动。`)
    const fact = await run(ctx, prepared)
    const text = runText(fact).join('\n')
    return fact.outcome === 'done' ? done(text, fact) : refused('target-failed', text, fact)
  },
})

const statusCommand = defineCommand({
  name: 'sync status',
  summary: '看同步目标、上次同步、待同步的数目和还在的冲突副本',
  params: {},
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run(_values, ctx) {
    const { prepared, record, last, copies } = await status(ctx)
    const pending = prepared.kind === 'ready' ? pendingOf(prepared.plan) : null
    const lines = [
      ...(record ? [`目标：目录 ${record.target.path}（机器 ${record.machine} 设于 ${when(record.at)}）`] : []),
      ...(record ? [last ? `上次同步：${when(last.at)}，${last.outcome === 'done' ? countsText(last.counts) : `中断：${last.message}`}` : '上次同步：这台机器还没同步过'] : []),
      prepared.kind !== 'ready' ? notReadyText(prepared, ctx.session.machine) : prepared.plan.steps.length === 0 ? '待同步：两边一样' : `待同步：${countsText(pendingOf(prepared.plan))}`,
      ...(copies.length > 0 ? ['还在的冲突副本：', ...copies.map((c) => `  ${c.copy}（${c.original} 的另一份）`)] : []),
    ]
    return done(lines.join('\n'), { target: record?.target ?? null, ready: prepared.kind, last, pending, conflicts: copies })
  },
})

export const syncCommands: readonly OwnerCommand[] = [TARGET_SET, now, statusCommand]
