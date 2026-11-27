// A plugin's views and the page one of them gives, for the viewer face and the home page alike.
import { checkBlocks, checkFilters, checkOpen, checkRefresh, callableIn } from './blocks.js'
import { catchingUp, catchingUpCount } from './catch-up.js'
import { messageOf, pluginContext } from './pipeline.js'
import { kernelAction } from './view-parts.js'
import type { ViewerCall } from './viewer.js'
import type { Block, Context, IconName, Library, Plugin, PluginProblem, ViewAnswer, ViewDecl, ViewRequest } from '@pneuma-base/sdk'

export type Shown = ViewAnswer & { problems: PluginProblem[]; icon?: IconName }
/** A page of the kernel's own; `rows`, how many rows a page of a long list holds. */
export type KernelPage = (params: Record<string, string>, call: ViewerCall, rows: number) => Promise<Shown>

export const shown = (title: string, subtitle: string | null, blocks: Block[], problems: PluginProblem[] = []): Shown => ({ title, subtitle, blocks, problems })

/** A plugin's answer has at least a title and a list of blocks; anything else is the plugin failing. */
export const answered = (a: unknown): a is { title: string; blocks: Block[] } =>
  typeof a === 'object' && a !== null && typeof (a as { title?: unknown }).title === 'string' && Array.isArray((a as { blocks?: unknown }).blocks)

/** Each installed plugin's views, in configuration order. A view whose id does not start with `<plugin name>.` is left out as a problem. */
export function pluginViews(library: Library): { views: { plugin: Plugin; decl: ViewDecl }[]; problems: PluginProblem[] } {
  const views: { plugin: Plugin; decl: ViewDecl }[] = []
  const problems: PluginProblem[] = []
  for (const plugin of library.plugins) {
    for (const decl of plugin.views ?? []) {
      if (decl.id.startsWith(`${plugin.name}.`)) views.push({ plugin, decl })
      else problems.push({ plugin: plugin.name, message: `view ${decl.id} does not start with ${plugin.name}.` })
    }
  }
  return { views, problems }
}

/** A plugin's view. A plugin that throws or answers no view gets a page that says it failed, and the problem (K8). */
export async function pluginPage(plugin: Plugin, decl: ViewDecl, req: ViewRequest, ctx: Context): Promise<Shown> {
  try {
    if (!plugin.onView) throw new Error(`declares the view ${decl.id} but has no onView`)
    const answer = await plugin.onView(req, pluginContext(ctx, plugin.name))
    if (!answered(answer)) throw new Error(`onView answered something that is not a view for ${decl.id}`)
    const checked = checkBlocks(answer.blocks, plugin, callableIn(ctx.library))
    const { problems } = checked
    // A plugin still catching up says so first, with the command that goes on.
    const behind = (await catchingUp(ctx)).get(plugin.name)
    const blocks: Block[] =
      behind === undefined
        ? checked.blocks
        : [{ kind: 'section', title: '装上之前登记的', note: catchingUpCount(behind), count: null, blocks: [], actions: [kernelAction('plugin catch-up', '接着补', { fixed: { plugin: plugin.name } })] }, ...checked.blocks]
    const { refresh, problems: refreshProblems } = checkRefresh((answer as ViewAnswer).refresh, plugin)
    const { filters, problems: filterProblems } = checkFilters((answer as ViewAnswer).filters, decl, plugin)
    const { open, problems: openProblems } = checkOpen((answer as ViewAnswer).open, plugin)
    return {
      ...shown(answer.title, answer.subtitle ?? null, blocks, [...problems, ...refreshProblems, ...filterProblems, ...openProblems]),
      ...(refresh === undefined ? {} : { refresh }),
      ...(filters === undefined ? {} : { filters }),
      ...(open === undefined ? {} : { open }),
    }
  } catch (error) {
    const message = messageOf(error)
    return shown(decl.title, null, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出这一页`, hint: message }], [{ plugin: plugin.name, message }])
  }
}
