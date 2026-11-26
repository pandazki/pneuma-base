// What only the owner can settle: each plugin's `onAsks`, read-only, gathered for check and for the
// home page. ARCHITECTURE.md section 6.
import { actionFault, askFault, type Callable } from './blocks.js'
import { eachPlugin } from './pipeline.js'
import { readRequests } from './requests.js'
import type { Ask, Context, OwnerArgs, OwnerRequest, PluginAsk, PluginProblem } from '@pneuma-base/sdk'

const argsKey = (args: OwnerArgs) => JSON.stringify([args.positional, Object.entries(args.flags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])

/**
 * Whether an agent's request settles a plugin's ask: it asks for the very owner command, with the same
 * arguments, that one of the ask's answers runs, and it waits or the owner declined it. One thing to
 * decide is then one row: the request, with its reason, while it waits; nothing once declined. An
 * approved one ran the command, and a plugin that still asks is asking something new.
 */
export function standsIn(r: OwnerRequest, ask: Pick<Ask, 'actions'>): boolean {
  if (r.status.kind !== 'pending' && r.status.kind !== 'declined') return false
  const key = argsKey(r.args)
  return ask.actions.some(({ call, inputs }) => call.face === 'owner' && inputs.length === 0 && call.command === r.command && argsKey(call.args) === key)
}

/**
 * Every installed plugin's asks, in configuration order, each stamped with its plugin's name as
 * `by`, but those an agent's request stands in for. An answer that is no list, an ask of the wrong
 * shape, or one with an action that calls nothing the library runs is left out and listed as that
 * plugin's problem (K8).
 */
export async function asksOf(ctx: Context, callable: Callable): Promise<{ asks: Ask[]; problems: PluginProblem[] }> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onAsks?.(pctx))
  const asks: Ask[] = []
  const problems = [...heard.problems]
  for (const { plugin, value } of heard.values) {
    if (!Array.isArray(value)) {
      problems.push({ plugin, message: 'onAsks 答的不是列表' })
      continue
    }
    for (const [i, raw] of (value as unknown[]).entries()) {
      const wrong = askFault(raw, `asks[${i}]`) ?? (raw as PluginAsk).actions.map((a) => actionFault(a, callable)).find((f) => f !== null) ?? null
      if (wrong !== null) problems.push({ plugin, message: `一个要主人决定的事没法给出：${wrong}` })
      else asks.push({ ...(raw as PluginAsk), by: plugin })
    }
  }
  if (asks.length === 0) return { asks, problems }
  const requests = await readRequests(ctx.library.root)
  return { asks: asks.filter((a) => !requests.some((r) => standsIn(r, a))), problems }
}
