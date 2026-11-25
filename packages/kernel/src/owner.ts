import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { exists } from './files.js'
import { CONFIG_FILE, newConfig, saveConfig } from './library.js'
import { KERNEL_COMMANDS, type KernelCommand, type Outcome } from './owner-commands.js'
import { makeContext, performOwner, pluginContext } from './pipeline.js'
import { agentSessionSign, type Env } from './session.js'
import type { Actor, Context, OwnerArgs, OwnerCommand, OwnerResult, Plugin, PluginName, PluginTable, Session } from './types.js'

/** What every owner command needs besides its own arguments. This machine's home is `ctx.home`. */
export type OwnerCall = {
  ctx: Context
  table: PluginTable
  env: Env
  viaGrant: boolean
  confirm: (question: string) => Promise<boolean>
}

/** An owner command as the owner face lists it, and who provides it. */
export type OwnerCommandInfo = { name: string; summary: string; usage: string | null; destructive: boolean; ownerOnly: boolean; by: PluginName | 'kernel' }

/** How a command is gated: destructive ones lose data; owner-only ones decide for the owner. Read-only ones change nothing. */
type Gate = { destructive: boolean; ownerOnly: boolean; readOnly?: boolean }

/**
 * What shows the call comes from an agent: a grant or an agent session variable (the second line of
 * defence, K7), or an actor named an agent with `--as`. Null when nothing does.
 */
function agentSign(call: OwnerCall): string | null {
  const sign = agentSessionSign(call.env, call.viaGrant)
  if (sign !== null) return sign
  return call.ctx.actor.kind === 'agent' ? `调用者是 agent ${call.ctx.actor.name}` : null
}

/**
 * The one place owner commands pass through. In an agent session a destructive or owner-only
 * command is refused, naming what showed the session; a destructive one also needs a confirmation
 * the person gives in person (K7). Refused or not, it ends at the pipeline's single exit.
 */
async function gated(call: OwnerCall, name: string, gate: Gate, args: OwnerArgs, body: () => Promise<Outcome>): Promise<OwnerResult> {
  return performOwner(call.ctx, name, args, { destructive: gate.destructive, readOnly: gate.readOnly ?? false }, async () => {
    const sign = gate.destructive || gate.ownerOnly ? agentSign(call) : null
    if (sign !== null) {
      const why = gate.destructive ? '会丢数据' : '是替主人做的决定'
      const text = `「${name}」${why}，只有主人能做，不能在 agent 的会话里做（${sign}）。需要的话告诉主人；主人在自己的终端里做，或在自己的终端里运行 pneuma-base view 用界面做。`
      return { answer: { outcome: 'refused', reason: 'agent-session', text } }
    }
    if (gate.destructive && !(await call.confirm(`「${name}」会丢数据，不能撤回。确认要做吗？`))) {
      return { answer: { outcome: 'refused', reason: 'not-confirmed', text: '没有得到当面确认，什么都没做。' } }
    }
    return body()
  })
}

/** Makes `dir` a library. Refused before anything is written, so a refused init has no library to send an event to. */
export async function initLibrary(
  dir: string,
  opts: { plugins: string[]; table: PluginTable; actor: Actor; session: Session; home: string },
): Promise<OwnerResult> {
  if (await exists(join(dir, CONFIG_FILE))) {
    return { outcome: 'refused', reason: 'already-a-library', text: `${dir} 已经是一个库了`, problems: [] }
  }
  const unknown = opts.plugins.filter((name) => !opts.table.has(name))
  if (unknown.length > 0) {
    return { outcome: 'refused', reason: 'unknown-plugin', text: `没有这个插件：${unknown.join('、')}`, problems: [] }
  }
  await mkdir(dir, { recursive: true })
  const library = await saveConfig(await realpath(dir), newConfig(opts.plugins as PluginName[]), opts.table)
  const ctx = makeContext(library, opts.actor, opts.session, opts.home)
  const args: OwnerArgs = { positional: [library.root], flags: opts.plugins.length === 0 ? { bare: true } : {} }
  return performOwner(ctx, 'init', args, { destructive: false, readOnly: false }, async () => ({
    answer: { outcome: 'done', text: `已把 ${library.root} 建成库。说明在 PNEUMA-BASE.md。`, data: { root: library.root } },
  }))
}

export const ownerFace = {
  /** The owner commands with these plugins installed: the kernel's, then each plugin's in order. A name already taken is not listed again. */
  commands(plugins: readonly Plugin[]): OwnerCommandInfo[] {
    const info = (c: KernelCommand | OwnerCommand, by: OwnerCommandInfo['by']): OwnerCommandInfo => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage ?? null,
      destructive: c.destructive,
      ownerOnly: c.ownerOnly,
      by,
    })
    const all = [...KERNEL_COMMANDS.map((c) => info(c, 'kernel')), ...plugins.flatMap((p) => p.ownerCommands.map((c) => info(c, p.name)))]
    return all.filter((c, i) => all.findIndex((d) => d.name === c.name) === i)
  },

  /**
   * Runs the owner command `name`, the kernel's or an installed plugin's, through the gate. An
   * unknown name is refused before any operation begins, so it sends no event.
   */
  dispatch(call: OwnerCall, name: string, args: OwnerArgs): Promise<OwnerResult> {
    const kernel = KERNEL_COMMANDS.find((c) => c.name === name)
    if (kernel) return gated(call, name, kernel, args, () => kernel.run(args, call))
    for (const plugin of call.ctx.library.plugins) {
      const command = plugin.ownerCommands.find((c) => c.name === name)
      if (command) return gated(call, name, command, args, async () => ({ answer: await command.run(args, pluginContext(call.ctx, plugin.name)) }))
    }
    return Promise.resolve({ outcome: 'refused', reason: 'unknown-command', text: `没有这条主人命令：${name}`, problems: [] })
  },
}
