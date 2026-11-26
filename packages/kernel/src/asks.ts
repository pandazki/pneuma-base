// What only the owner can settle: each plugin's `onAsks`, read-only, gathered for check and for the
// home page. ARCHITECTURE.md section 6.
import { actionFault, askFault, type Callable } from './blocks.js'
import { eachPlugin } from './pipeline.js'
import type { Ask, Context, PluginAsk, PluginProblem } from '@pneuma-base/sdk'

/**
 * Every installed plugin's asks, in configuration order, each stamped with its plugin's name as
 * `by`. An answer that is no list, an ask of the wrong shape, or one with an action that calls
 * nothing the library runs is left out and listed as that plugin's problem (K8).
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
  return { asks, problems }
}
