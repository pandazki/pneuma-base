// The home page: what the owner opens on. The kernel's steps of getting started, what waits on the
// owner, and the parts plugins give it; each part asks storage only where its records point.
import { asksOf } from './asks.js'
import { callableIn } from './blocks.js'
import { pairingAsks } from './pairing.js'
import { pluginPage, pluginViews, shown, type KernelPage, type Shown } from './plugin-views.js'
import { requestAsks } from './requests.js'
import { kernelSteps, startPart } from './start.js'
import type { ViewerCall } from './viewer.js'
import type { ActorMark, Block } from '@pneuma-base/sdk'

/**
 * The page the owner opens on: 「开始」 while a step of getting started is left (start.ts); what waits
 * on the owner, the agents asking to be connected first, then the agents' pending requests, each
 * oldest first, then every plugin's `onAsks`; then
 * each plugin view declared `home`, its blocks as they are, in configuration order, but for the steps
 * they give, which join 「开始」. With no such view the page says so and shows the library's top
 * folder, the files page `bare`, so a library without plugins has a home too.
 */
export async function homePage(_params: Record<string, string>, call: ViewerCall, bare: KernelPage): Promise<Shown> {
  const { ctx } = call
  const asked = await asksOf(ctx, callableIn(ctx.library))
  const titleOf = (by: string | ActorMark) => (typeof by === 'string' ? (ctx.library.plugins.find((p) => p.name === by)?.cognition?.title ?? by) : by)
  const asks = [...(await pairingAsks(ctx.home, call.env, ctx.library, ctx.now)), ...(await requestAsks(ctx.library)), ...asked.asks.map((a) => ({ ...a, by: titleOf(a.by) }))]
  const decide: Block = {
    kind: 'section',
    title: '等你决定',
    note: null,
    count: asks.length > 0 ? asks.length : null,
    blocks: [{ kind: 'asks', asks, empty: '没有要你决定的事。' }],
    actions: [],
  }
  const parts = pluginViews(ctx.library).views.filter((v) => v.decl.home === true)
  const problems = [...asked.problems]
  const given: Block[] = []
  for (const { plugin, decl } of parts) {
    const part = await pluginPage(plugin, decl, { view: decl.id, params: Object.fromEntries(decl.filters.map((f) => [f.name, f.default])) }, ctx)
    given.push(...part.blocks)
    problems.push(...part.problems)
  }
  const { start, rest } = startPart(await kernelSteps(call), given)
  const blocks: Block[] = [...(start === null ? [] : [start]), decide, ...rest]
  if (parts.length === 0) {
    const files = await bare({}, call)
    const why = ctx.library.plugins.length === 0 ? '这个库没装插件：首页只有要你决定的事和库里的文件。装上插件，这里会有 agent 做了什么、哪些东西要留意。' : '装着的插件没有给首页添内容，下面是库里的文件。'
    blocks.push({ kind: 'text', tone: 'neutral', text: why }, { kind: 'section', title: '库里的文件', note: null, count: null, blocks: files.blocks, actions: [] })
  }
  return shown('首页', null, blocks, problems)
}
