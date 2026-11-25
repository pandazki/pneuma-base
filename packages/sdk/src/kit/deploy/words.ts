// The words agents and owners read: states, what each means, the one-line look, check's section,
// what a put or archive is told, and the cognition section. The plugin's name goes into every command.
import { usageOf } from '../../params.js'
import type { PluginContext, PluginNoteAnswer, Tag } from '../../types.js'
import type { Skipped } from '../records.js'
import { onlyTarget, type Kit, type Settled } from './reconcile.js'
import type { Look, Status, TargetAdapter } from './target.js'

/** Each state as the tag the kit's pages show, so a target's own blocks can say the same. */
export const STATUS: Record<Status, Tag> = {
  online: { text: '在线', tone: 'good' },
  pending: { text: '待发布', tone: 'warn' },
  offline: { text: '离线', tone: 'neutral' },
  retiring: { text: '待下线', tone: 'warn' },
  archived: { text: '已归档', tone: 'neutral' },
  missing: { text: '不在', tone: 'bad' },
  unknown: { text: '不知道', tone: 'bad' },
}

/** What a state means, for the states that need saying. */
export const MEANING: Record<Status, (l: Look) => string | null> = {
  online: () => null,
  offline: () => '上不上线由主人决定',
  pending: () => '开关开着，线上不是当前的内容',
  retiring: (l) => `它不该在线，目标上还有 ${[...l.held.keys()].join('、')}`,
  archived: (l) => (l.thing.on ? '开关开着，取回之后上线' : null),
  missing: () => '开关开着，但库里这个路径上没有东西',
  unknown: (l) => `读不到目标：${l.unreachable}`,
}

/** One line, most important first: the state, the address, the switch, the site name, then what the state means. */
export function lookText(l: Look): string {
  const parts = [STATUS[l.status].text, ...(l.url ? [l.url] : []), `开关${l.thing.on ? '开' : '关'}`, ...(l.site ? [`站点名 ${l.site}`] : [])]
  const meaning = MEANING[l.status](l)
  return `${parts.join(' · ')}${meaning ? `。${meaning}` : ''}`
}

const UNSETTLED: ReadonlySet<Status> = new Set(['pending', 'retiring', 'missing', 'unknown'])

/** check: the declared things whose target does not match their switch and content. */
export function unsettledText(kit: Kit, all: readonly Look[], targetSet: boolean): { body: string; data: unknown } | null {
  const off = all.filter((l) => UNSETTLED.has(l.status))
  if (off.length === 0) return null
  const lines = off.map((l) => `${l.thing.path}：${STATUS[l.status].text}，${MEANING[l.status](l)}`)
  const next = targetSet ? `可以运行 ${kit.name} sync 再对一遍；目标出了问题就告诉主人。` : `还没配部署目标，告诉主人：${kit.name} target set。`
  return { body: [...lines, next].join('\n'), data: off.map((l) => ({ path: l.thing.path, status: l.status, held: [...l.held.keys()] })) }
}

/** check: the lines of the records that are not records. They stay as they are and count for nothing. */
export function skippedText(kit: Kit, skipped: readonly Skipped[]): { body: string; data: unknown } | null {
  if (skipped.length === 0) return null
  const lines = skipped.map((s) => `.pneuma-base/${kit.name}/facts/${s.file} 第 ${s.line} 行：${s.reason}`)
  return { body: [...lines, '这些行原样留着，没有算进去。'].join('\n'), data: skipped }
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

export const noTarget = (kit: Kit) => `还没配部署目标：${targetSetHint(kit)}`

/**
 * What the caller whose put or archive moved the target is told. A target that failed is a problem
 * the kernel lists while the verb still succeeds (K8), worded so an agent whose sandbox cannot reach
 * the target reads that its work is in and going online waits for the owner; a missing target is a
 * note, as nothing is online anywhere then.
 */
export function followed(kit: Kit, r: Settled, ctx: PluginContext, done: '放入' | '挪动' | '归档' | '取回'): PluginNoteAnswer | null {
  const { path } = r.thing
  if (r.problem?.kind === 'failed') {
    const who = ctx.actor.kind === 'agent' ? `这不是你的${done}出了问题，你不用重做；上线要等主人在自己的终端里运行 ${kit.name} sync，需要时告诉主人。` : `目标好了之后运行 ${kit.name} sync。`
    const now = r.status === 'retiring' ? '它还在线上' : r.status === 'pending' ? '线上还不是库里现在的内容' : `现在是${STATUS[r.status].text}`
    return { note: null, problems: [`${done}本身已经成功，只是 ${path} 没能跟着上线：${r.problem.message}。${now}。${who}`] }
  }
  if (r.problem?.kind === 'no-target') return { text: `${path} 开着，但还没配部署目标，没有发布` }
  const published = r.done.find((d) => d.kind === 'publish')
  const dropped = r.done.filter((d) => d.kind === 'unpublish').map((d) => d.site)
  if (published) return { text: `${path} 在线，已重新发布${published.url ? `：${published.url}` : ''}${dropped.length > 0 ? `；旧的站点 ${dropped.join('、')} 已撤下` : ''}` }
  return dropped.length > 0 ? { text: `${path} 已从目标上撤下` } : null
}

/** What stays online when the plugin is removed anyway; null when nothing does. */
export function staysOnline(kit: Kit, all: readonly Look[]): string | null {
  const online = all.filter((l) => l.held.size > 0)
  if (online.length === 0) return null
  const names = online.map((l) => `${l.thing.path}${l.url ? `（${l.url}）` : ''}`)
  return `还有 ${online.length} 样在线：${names.join('、')}。卸下之后它们留在目标上，库里改了也不再跟着；要撤下，先用 ${kit.name} off 关上，再卸。`
}

/** The section the plugin adds to the description and skills: what an agent may do, and what is the owner's. */
export function cognitionText(kit: Kit, heading: string, more: string | null): string {
  return `## ${heading}

这个库装了**${kit.title}**插件。你做了能上线的东西，比如一个网站目录，放进库之后声明它可以部署：

\`\`\`sh
pneuma-base @{{授权的名字}} say deployable sites/shop
\`\`\`

声明不会让它上线。上不上线由主人用开关决定，你开不了；也不要自己把它部署到别处，要上线就告诉主人。开关开着的东西，线上跟着库里：新内容放到同一个路径，线上换成新的；挪了位置，换成新路径的站点；归档了，就下线。\`inspect\` 说它在线、离线还是待发布，地址是什么；\`check\` 列出线上还不是当前内容的，\`pneuma-base @{{授权的名字}} ${kit.name} sync\` 再对一遍。${more === null ? '' : `\n\n${more}`}
`
}
