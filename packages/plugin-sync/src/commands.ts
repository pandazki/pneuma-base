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
  summary: '设置同步目标：本机的一个目录',
  params: {
    flags: [
      { name: 'kind', hint: '类型', kind: 'value', required: true, options: [{ value: 'folder', label: '本地文件夹' }] },
      { name: 'to', hint: '目录', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ to }, ctx) {
    const root = ctx.library.root
    const wanted = resolve(ctx.session.cwd, to)
    if (overlaps(root, wanted)) return refused('target-overlaps', `${wanted} 与资料库目录互相包含，不能作为同步目标。请使用资料库之外的目录。`)
    // A disk that is not mounted, or a folder this user cannot write, is the owner's to fix, not a crash.
    const made = makeTarget(wanted)
    if ('error' in made) return refused('target-unreachable', `无法创建目录：${made.error}。请挂载所在磁盘，或使用可写入的目录。`)
    const { path } = made
    if (overlaps(root, path)) return refused('target-overlaps', `${path} 与资料库目录互相包含，不能作为同步目标。请使用资料库之外的目录。`)
    const machine = ctx.session.machine
    const mine = await machineTarget((await targetOf(ctx)).rows, machine)
    if (mine?.target.path === path) return done(`同步目标已是目录 ${path}，未更改。`, { target: mine.target })
    const fact: TargetFact = { ...envelope(ctx), kind: 'target.set', target: { kind: 'dir', path } }
    await writeFacts(ctx, [fact])
    return done(`已将本机（${machine}）的同步目标设为目录 ${path}。`, { target: fact.target })
  },
})

function runText(fact: RunFact): string[] {
  const { counts, conflicts, kept } = fact
  const moved = counts.pushed + counts.pulled + counts.removed + counts.deleted + counts.kept + counts.conflicts
  const head =
    fact.outcome === 'failed'
      ? `同步到 ${fact.target.path} 时中断：${fact.message}`
      : moved === 0 ? `已同步：两侧一致，无变更。目标：目录 ${fact.target.path}` : `已同步：本地 ⇄ 目录 ${fact.target.path}`
  return [
    head,
    ...(moved > 0 ? [countsText(counts)] : []),
    ...(conflicts.length > 0 ? ['冲突（保留双方：本地文件在原位置，另一侧的版本为冲突副本）：', ...conflicts.map((c) => `  ${c.path}  另一侧版本：${c.copy}`)] : []),
    ...(kept.length > 0 ? ['保留（另一侧删除或替换、且其他位置无副本的内容）：', ...kept.map((k) => `  ${k.to}`)] : []),
    ...(counts.skipped > 0 ? [`跳过 ${counts.skipped} 处：同步期间再次被修改，未变更，下次同步时处理。`] : []),
    ...(fact.outcome === 'failed' ? ['已完成的部分保留，未完成的部分下次同步时继续；内容未丢失。'] : []),
  ]
}

const now = defineCommand({
  name: 'sync now',
  act: { kind: 'synced', name: '同步' },
  summary: '立即同步：不合并内容，所有内容均可恢复',
  params: {},
  destructive: false,
  ownerOnly: false,
  async run(_values, ctx) {
    const prepared = await prepare(ctx, (await targetOf(ctx)).record, 'run')
    if (prepared.kind !== 'ready') return refused(prepared.kind, `${notReadyText(prepared, ctx.session.machine)}未做任何变更。`)
    const fact = await run(ctx, prepared)
    const text = runText(fact).join('\n')
    return fact.outcome === 'done' ? done(text, fact) : refused('target-failed', text, fact)
  },
})

const statusCommand = defineCommand({
  name: 'sync status',
  summary: '查看同步目标、上次同步、待同步数量和现存冲突副本',
  params: {},
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run(_values, ctx) {
    const { prepared, record, last, copies } = await status(ctx)
    const pending = prepared.kind === 'ready' ? pendingOf(prepared.plan) : null
    const lines = [
      ...(record ? [`目标：目录 ${record.target.path}（机器 ${record.machine}，设置时间 ${when(record.at)}）`] : []),
      ...(record ? [last ? `上次同步：${when(last.at)}，${last.outcome === 'done' ? countsText(last.counts) : `中断：${last.message}`}` : '上次同步：本机尚未同步'] : []),
      prepared.kind !== 'ready' ? notReadyText(prepared, ctx.session.machine) : prepared.plan.steps.length === 0 ? '待同步：无' : `待同步：${countsText(pendingOf(prepared.plan))}`,
      ...(copies.length > 0 ? ['现存冲突副本：', ...copies.map((c) => `  ${c.copy}（${c.original} 的另一侧版本）`)] : []),
    ]
    return done(lines.join('\n'), { target: record?.target ?? null, ready: prepared.kind, last, pending, conflicts: copies })
  },
})

export const syncCommands: readonly OwnerCommand[] = [TARGET_SET, now, statusCommand]
