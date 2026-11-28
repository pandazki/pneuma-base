// The words agents and owners read: states, what each means, the one-line look, check's section,
// what a put or archive is told, and the cognition section. The plugin's name goes into every command.
import { usageOf } from '../../params.js'
import type { PluginContext, PluginNoteAnswer, Tag } from '../../types.js'
import type { Skipped } from '../records.js'
import { onlyTarget, type Kit, type Settled } from './reconcile.js'
import type { Look, Status, TargetAdapter } from './target.js'

/** Each state as the tag the kit's pages show, so a target's own blocks can say the same. */
export const STATUS: Record<Status, Tag> = {
  published: { text: '已发布', tone: 'good' },
  pending: { text: '待发布', tone: 'warn' },
  unpublished: { text: '未发布', tone: 'neutral' },
  'pending-unpublish': { text: '待取消发布', tone: 'warn' },
  archived: { text: '已归档', tone: 'neutral' },
  missing: { text: '条目缺失', tone: 'bad' },
  unknown: { text: '状态未知', tone: 'bad' },
}

/** What a state means, for the states that need saying. */
export const MEANING: Record<Status, (l: Look) => string | null> = {
  published: () => null,
  unpublished: () => '由所有者决定是否发布',
  pending: () => '开关已开启，部署目标上不是当前内容',
  'pending-unpublish': (l) => `不应发布，部署目标上仍有 ${[...l.held.keys()].join('、')}`,
  archived: (l) => (l.thing.on ? '开关已开启，取消归档后发布' : null),
  missing: () => '开关已开启，资料库中该路径上的条目不存在',
  unknown: (l) => `无法读取部署目标：${l.unreachable}`,
}

/** One line, most important first: the state, the address, the switch, the site name, then what the state means. */
export function lookText(l: Look): string {
  const parts = [STATUS[l.status].text, ...(l.url ? [l.url] : []), `开关${l.thing.on ? '已开启' : '已关闭'}`, ...(l.site ? [`站点名称 ${l.site}`] : [])]
  const meaning = MEANING[l.status](l)
  return `${parts.join(' · ')}${meaning ? `。${meaning}` : ''}`
}

const UNSETTLED: ReadonlySet<Status> = new Set(['pending', 'pending-unpublish', 'missing', 'unknown'])

/** check: the declared things whose target does not match their switch and content. */
export function unsettledText(kit: Kit, all: readonly Look[], targetSet: boolean): { body: string; data: unknown } | null {
  const off = all.filter((l) => UNSETTLED.has(l.status))
  if (off.length === 0) return null
  const lines = off.map((l) => `${l.thing.path}：${STATUS[l.status].text}，${MEANING[l.status](l)}`)
  const next = targetSet ? `可运行 ${kit.name} sync 重新同步；部署目标出错时告知所有者。` : `未连接部署目标，请告知所有者：${kit.name} target set。`
  return { body: [...lines, next].join('\n'), data: off.map((l) => ({ path: l.thing.path, status: l.status, held: [...l.held.keys()] })) }
}

/** check: the facts of the records that are not records. They stay as they are and count for nothing. */
export function skippedText(kit: Kit, skipped: readonly Skipped[]): { body: string; data: unknown } | null {
  if (skipped.length === 0) return null
  return { body: skipped.map((s) => `${kit.name} 的记录 ${s.at}：${s.reason}`).join('\n'), data: skipped }
}

/** How the flags of one kind are written after `<name> target set`, with `--kind` when the kit has several; `required`: those alone. */
export function kindUsage(kit: Kit, t: TargetAdapter, required = false): string {
  const flags = required ? t.params.filter((f) => f.required) : t.params
  return [...(onlyTarget(kit) ? [] : [`--kind ${t.kind}`]), usageOf({ flags })].filter((s) => s !== '').join(' ')
}

/** The alternatives of `<name> target set`, required flags only: what the owner types to set a target. */
function targetSetHint(kit: Kit): string {
  return `${kit.name} target set ${kit.targets.map((t) => kindUsage(kit, t, true)).join('，或 ')}`.trimEnd()
}

export const noTarget = (kit: Kit) => `未连接部署目标：${targetSetHint(kit)}`

/**
 * What the caller whose put or archive moved the target is told. A target that failed is a problem
 * the kernel lists while the verb still succeeds (K8), worded so an agent whose sandbox cannot reach
 * the target reads that its work is in and publishing waits for the owner; a missing target is a
 * note, as nothing is published anywhere then.
 */
export function followed(kit: Kit, r: Settled, ctx: PluginContext, done: '添加' | '移动' | '归档' | '取消归档'): PluginNoteAnswer | null {
  const { path } = r.thing
  if (r.problem?.kind === 'failed') {
    // The owner reads this on the page too, where the row offers 重试: it names no command.
    const who = ctx.actor.kind === 'agent' ? `无需重做${done}；发布需等待所有者在终端中运行 ${kit.name} sync，必要时告知所有者。` : ''
    const now = r.status === 'pending-unpublish' ? '部署目标上仍有该条目' : r.status === 'pending' ? '部署目标上不是资料库的当前内容' : `当前状态：${STATUS[r.status].text}`
    return { note: null, problems: [`${done}已成功，${path} 同步到部署目标失败：${r.problem.message}。${now}。${who}`] }
  }
  if (r.problem?.kind === 'no-target') return { text: `${path} 开关已开启，未连接部署目标，未发布` }
  const published = r.done.find((d) => d.kind === 'publish')
  const dropped = r.done.filter((d) => d.kind === 'unpublish').map((d) => d.site)
  if (published) return { text: `${path} 已重新发布${published.url ? `：${published.url}` : ''}${dropped.length > 0 ? `；旧站点 ${dropped.join('、')} 已取消发布` : ''}` }
  return dropped.length > 0 ? { text: `${path} 已取消发布` } : null
}

/** What stays published when the plugin is disabled anyway; null when nothing does. */
export function staysPublished(kit: Kit, all: readonly Look[]): string | null {
  const published = all.filter((l) => l.held.size > 0)
  if (published.length === 0) return null
  const names = published.map((l) => `${l.thing.path}${l.url ? `（${l.url}）` : ''}`)
  return `仍有 ${published.length} 个已发布：${names.join('、')}。停用后它们保留在部署目标上，不再随资料库更新；如需取消发布，先运行 ${kit.name} unpublish，再停用。`
}

/** The section the plugin adds to the description and skills: what an agent may do, and what is the owner's. */
export function cognitionText(kit: Kit, heading: string, more: string | null): string {
  return `## ${heading}

此资料库已启用**${kit.title}**插件。可发布的成果（例如一个网站目录）添加到资料库后，声明其可部署：

\`\`\`sh
pneuma-base @{{授权的名字}} say deployable sites/shop
\`\`\`

声明不会发布条目。是否发布由所有者通过开关决定，Agent 无法开启；也不要自行部署到其他位置，需要发布时告知所有者。开关已开启的条目，部署目标随资料库更新：同一路径添加新内容，部署目标上更新为新内容；移动后，改用新路径的站点；归档后取消发布。\`inspect\` 显示条目已发布、未发布还是待发布，以及地址；\`check\` 列出部署目标上不是当前内容的条目，\`pneuma-base @{{授权的名字}} ${kit.name} sync\` 重新同步。${more === null ? '' : `\n\n${more}`}
`
}
