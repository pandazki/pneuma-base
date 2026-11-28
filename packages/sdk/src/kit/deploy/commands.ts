// The owner commands of a deploy plugin, named after it. None loses anything, so none is
// destructive. Publishing faces outward, so publishing, unpublishing and the target are owner-only: the kernel
// refuses them in an agent session. Every command declares its arguments; `target set` takes them
// from the kinds of target.
import { defineCommand } from '../../params.js'
import type { FlagParam, LibraryPath, OwnerAnswer, OwnerCommand, OwnerValues, PluginTools, SecretDecl, SecretParam } from '../../types.js'
import { foundAll, setCommand, targetRemoveName, targetSetName } from './connect.js'
import { newThingId, type TargetKey } from './facts.js'
import { siteName } from './model.js'
import { closeTarget, declaredAt, looks, onlyTarget, openTarget, record, setSecret, settle, sweep, targetFile, thingPath, withRun, type Done, type Given, type Kit, type Run, type Settled } from './reconcile.js'
import type { Target, TargetAdapter } from './target.js'
import { kindUsage, lookText, noTarget, STATUS } from './words.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

function doneText(path: string, d: Done): string {
  return d.kind === 'publish' ? `已发布 ${path}${d.url ? ` → ${d.url}` : ''}` : `已取消发布 ${path} 的站点 ${d.site}`
}

/** `<plugin> publish` switches a thing on, `<plugin> unpublish` off. */
export const switchName = (plugin: string, on: boolean) => `${plugin} ${on ? 'publish' : 'unpublish'}`
export const SWITCH_PARAMS = { positional: [{ name: 'path', hint: '库内路径', required: true }] } as const

/** The thing an input names, as one that can be declared deployable: in the content, there now. `then`: what may follow once it is unarchived. */
export async function declarable(tools: PluginTools, input: string, then: string): Promise<{ path: LibraryPath } | { refused: string }> {
  const path = await thingPath(tools, input)
  if (path === null) return { refused: `${input} 不在资料库中` }
  const archivedText = { refused: `${path} 已归档；取消归档后再${then}` }
  if (tools.regionOf(path) === 'archive') return archivedText
  const [here, archived] = await tools.what([path, tools.archivedPath(path)])
  const thing = (at: typeof here) => at?.kind === 'file' || at?.kind === 'bundle'
  if (!thing(here) && thing(archived)) return archivedText
  // Something there that is no thing, such as a folder without the marker, is in the folder and not registered.
  if (!thing(here)) return { refused: here === undefined || here.kind === 'none' ? `${input} 不存在` : `${input} 未登记` }
  return { path }
}

/** What the owner is told after the switch: the address once published, the fact once unpublished, else the state. */
function switchedText(r: Settled, on: boolean): string {
  const { path } = r.thing
  if (on && r.status === 'published') return `已发布 ${path}${r.url ? ` → ${r.url}` : ''}`
  if (!on && r.status === 'unpublished') return `已取消发布 ${path}。`
  return `已${on ? '开启' : '关闭'} ${path} 的开关：${lookText(r)}`
}

function switchCommand(kit: Kit, on: boolean): OwnerCommand {
  const [verb, effect] = on ? ['开启', '发布'] : ['关闭', '取消发布']
  return defineCommand({
    name: switchName(kit.name, on),
    act: { kind: on ? 'on' : 'off', object: 'path' },
    summary: on ? '发布条目，之后部署目标随其内容更新；未声明的条目，所有者发布即声明' : '取消发布条目',
    params: SWITCH_PARAMS,
    destructive: false,
    ownerOnly: true,
    async run({ path: input }, ctx) {
      return withRun(kit, ctx, async (run) => {
        let id = await declaredAt(run, input)
        if (id === null) {
          if (!on) return refused('not-declared', `${input} 未声明可部署。`)
          // The owner publishing a thing declares it: one act, in the owner's name.
          const thing = await declarable(ctx.tools, input, '发布')
          if ('refused' in thing) return refused('not-declared', thing.refused)
          id = newThingId()
          record(run, { kind: 'declare', thing: id, path: thing.path, note: null })
        }
        // Switching off what was never switched still records the owner's decision, so nobody asks again.
        const thing = run.d.things.get(id)
        if (thing?.on !== on || !thing.decided) record(run, { kind: 'switch', thing: id, on })
        const r = await settle(run, id)
        const path = r.thing.path
        if (r.problem?.kind === 'no-target') return refused('no-target', `已${verb} ${path} 的开关；未连接部署目标，未${effect}。`)
        if (r.problem?.kind === 'failed') return refused(on ? 'publish-failed' : 'unpublish-failed', `已${verb} ${path} 的开关，${effect}失败：${r.problem.message}。`)
        return done(switchedText(r, on), { path, status: r.status, site: r.site, url: r.url })
      })
    },
  })
}

function syncCommand(kit: Kit): OwnerCommand {
  return defineCommand({
    name: `${kit.name} sync`,
    act: { kind: 'synced', name: '部署' },
    summary: '同步全部可部署的条目：该发布的发布，该取消发布的取消发布；重复执行结果相同',
    params: {},
    destructive: false,
    ownerOnly: false,
    async run(_values, ctx) {
      return withRun(kit, ctx, async (run) => {
        const results: Settled[] = []
        for (const thing of [...run.d.things.values()].sort((x, y) => (x.path < y.path ? -1 : 1))) results.push(await settle(run, thing.id))
        const swept = await sweep(run)
        const changed = results.reduce((n, r) => n + r.done.length, 0) + swept.done.length
        const counts = (Object.keys(STATUS) as (keyof typeof STATUS)[]).flatMap((s) => {
          const n = results.filter((r) => r.status === s).length
          return n > 0 ? [`${n} 个${STATUS[s].text}`] : []
        })
        const lines = [
          ...results.flatMap((r) => r.done.map((d) => doneText(r.thing.path, d))),
          ...swept.done.map((d) => `已取消发布未声明的站点 ${d.site}`),
          ...results.flatMap((r) => (r.problem?.kind === 'failed' ? [`${r.thing.path} 同步失败：${r.problem.message}`] : [])),
          ...swept.failed.map((f) => `站点 ${f.site} 取消发布失败：${f.message}`),
        ]
        if (results.length === 0 && swept.done.length === 0) return done('暂无可部署的条目。', { changed })
        const quiet = lines.length === 0 && results.every((r) => r.problem === null)
        const head = quiet ? `已同步，无变更：${counts.join('，')}。` : `已同步：${counts.join('，')}。`
        const text = [head, ...lines].join('\n')
        if (results.some((r) => r.problem?.kind === 'no-target')) return refused('no-target', `${text}\n${noTarget(kit)}`)
        if (results.some((r) => r.problem?.kind === 'failed') || swept.failed.length > 0) return refused('publish-failed', text)
        return done(text, { changed, things: results.map((r) => ({ path: r.thing.path, status: r.status, url: r.url, done: r.done })) })
      })
    },
  })
}

function listCommand(kit: Kit): OwnerCommand {
  return defineCommand({
    name: `${kit.name} list`,
    summary: '列出可部署的条目、状态和地址',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run(_values, ctx) {
      return withRun(kit, ctx, async (run) => {
        const all = await looks(run)
        const head = run.target ? `部署目标：${run.target.label}` : noTarget(kit)
        const rows = all.map((l) => `${l.thing.path}  ${STATUS[l.status].text}${l.url ? `  ${l.url}` : ''}`)
        return done([head, ...(rows.length > 0 ? rows : ['暂无可部署的条目。'])].join('\n'), all.map((l) => ({ path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url })))
      })
    },
  })
}

/** `--kind`, a choice of the kit's kinds; required unless it has only one. */
export function kindFlag(kit: Kit): FlagParam {
  return { name: 'kind', hint: '类型', kind: 'value', ...(onlyTarget(kit) ? {} : { required: true }), options: kit.targets.map((t) => ({ value: t.kind, label: t.label })) }
}

/** A flag as several kinds share it: which flags are required depends on the kind chosen, so none is. */
function shared(f: FlagParam): FlagParam {
  return { name: f.name, hint: f.hint, kind: f.kind, ...(f.pattern === undefined ? {} : { pattern: f.pattern }), ...(f.options === undefined ? {} : { options: f.options }) }
}

/**
 * The flags of `<name> target set`: `--kind` and every kind's own. With one kind they are its flags as
 * declared; with several, a flag two kinds declare must mean the same in both. Throws on a kit no
 * command line could read.
 */
function targetFlags(kit: Kit): FlagParam[] {
  const flags = new Map<string, FlagParam>([['kind', kindFlag(kit)]])
  for (const t of kit.targets) {
    for (const f of t.params) {
      if (f.name === 'kind') throw new Error(`the ${t.kind} target declares --kind, which the kit uses to choose the target`)
      const flag = onlyTarget(kit) ? f : shared(f)
      const seen = flags.get(f.name)
      if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(flag)) throw new Error(`two kinds of target declare --${f.name} differently`)
      flags.set(f.name, flag)
    }
  }
  return [...flags.values()]
}

/** The secret `target set` takes typed: the one the kinds that ask for one share. Throws when two ask for different ones, or one asks for a secret it does not declare. */
export function askedOf(kit: Kit): SecretParam | undefined {
  const asking = kit.targets.filter((t) => t.asked !== undefined)
  const [first] = asking
  for (const t of asking) {
    const a = t.asked as SecretParam
    if (!(t.secrets ?? []).some((s) => s.name === a.name)) throw new Error(`the ${t.kind} target asks for the secret ${a.name}, which it does not declare`)
    if (a.name !== first?.asked?.name || a.hint !== first.asked.hint) throw new Error('two kinds of target ask for different secrets')
  }
  return first?.asked
}

const given = (v: OwnerValues[string] | undefined) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0)

/** The flags of the kind chosen that were given, `--kind` aside: what the configuration keeps to set it again. */
function givenOf(t: TargetAdapter, values: OwnerValues): Given {
  return Object.fromEntries(t.params.flatMap((f) => (given(values[f.name]) ? [[f.name, values[f.name] as string | readonly string[] | true]] : [])))
}

/** What is wrong with the values for the kind chosen: a flag of another kind given, or one of its own required flags left out. */
function kindWrong(kit: Kit, t: TargetAdapter, values: OwnerValues): string | null {
  const own = new Set(['kind', ...t.params.map((f) => f.name)])
  const how = `\n用法：${targetSetName(kit)} ${kindUsage(kit, t)}`
  const other = Object.keys(values).find((name) => !own.has(name) && given(values[name]))
  if (other !== undefined) return `--kind ${t.kind} 不接受 --${other}。${how}`
  const missing = t.params.find((f) => f.required && !given(values[f.name]))
  return missing === undefined ? null : `--kind ${t.kind} 需指定 --${missing.name}。${how}`
}

/** What `target set` says of the required secrets the target reads that the owner has not set. */
function secretNote(kit: Kit, unset: readonly SecretDecl[]): string[] {
  const required = unset.filter((s) => s.optional !== true).map((s) => s.name)
  return required.length === 0 ? [] : [`该部署目标需要密钥 ${required.join('、')}，未设置：${required.map((name) => setSecret(kit, name)).join('；')}。`]
}

/** How many things switched on in the content the target `t` does not hold under the name it gives them, by the records. */
function notHere(run: Run, t: Target): number {
  const sites = run.d.sites.get(t.key as TargetKey)
  return [...run.d.things.values()].filter((thing) => {
    if (!thing.on || run.ctx.tools.regionOf(thing.path) !== 'content') return false
    return sites?.get(t.siteName?.(thing.path) ?? siteName(thing.path))?.thing !== thing.id
  }).length
}

/** How many things a target holds sites of, by the records. */
const heldOn = (run: Run, t: Target) => new Set([...(run.d.sites.get(t.key as TargetKey)?.values() ?? [])].map((s) => s.thing)).size

function targetSetCommand(kit: Kit): OwnerCommand {
  const asked = askedOf(kit)
  return {
    name: targetSetName(kit),
    // The row names where it was connected: the first of these a kind takes, else the owner's own commands.
    act: { kind: 'connected', object: ['host', 'origin', 'admin', 'to'], name: '自定义命令' },
    summary: `连接部署目标：${kit.targets.map((t) => t.label).join('、')}`,
    params: { flags: targetFlags(kit), ...(asked === undefined ? {} : { secret: asked }) },
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run({ values, secret }, ctx) {
      // The kernel checked --kind against the kinds; it is left out only when there is one.
      const kind = typeof values.kind === 'string' ? values.kind : onlyTarget(kit)?.kind
      const adapter = kit.targets.find((t) => t.kind === kind) as TargetAdapter
      const wrong = kindWrong(kit, adapter, values)
      if (wrong !== null) return refused('usage', wrong)
      // What was typed for the secret, read only if `configure` asks; a kind that asks for none reads nothing.
      const typed: { value: string | null } = { value: null }
      const configured = await adapter.configure(values, ctx, async () => (adapter.asked === undefined ? null : (typed.value = await secret())))
      if (!configured.ok) return refused(configured.reason, configured.text)
      if (adapter.asked !== undefined && typed.value !== null) await ctx.secrets.set(adapter.asked.name, typed.value)
      const stored = { kind: adapter.kind, ...configured.config }
      const unset: SecretDecl[] = []
      for (const s of adapter.secrets ?? []) if ((await ctx.secrets.get(s.name)) === null) unset.push(s)
      const secrets = configured.note === undefined ? secretNote(kit, unset) : [configured.note]
      return withRun(kit, ctx, async (run) => {
        await targetFile(ctx).write({ format: 1, target: stored, given: givenOf(adapter, values) })
        const next = openTarget(kit, stored, ctx)
        await closeTarget(next)
        const waiting = notHere(run, next)
        const old = run.target !== null && run.target.key !== next.key ? heldOn(run, run.target) : 0
        const notes = [
          ...(waiting > 0 ? [`${waiting} 个待发布。`] : []),
          ...(old > 0 && run.target ? [`${run.target.label} 上的 ${old} 个条目未取消发布。`] : []),
        ]
        return done([`已连接 ${next.label}。`, ...secrets, ...notes].join(''), { target: stored })
      })
    },
  }
}

function targetListCommand(kit: Kit): OwnerCommand {
  return defineCommand({
    name: `${kit.name} target list`,
    summary: '列出已连接的部署目标，以及本机检测到的部署目标',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run(_values, ctx) {
      return withRun(kit, ctx, async (run) => {
        const found = await foundAll(kit, ctx)
        const connected = run.target && run.set ? { kind: run.set.kind, label: run.target.label } : null
        const lines = [
          connected && run.set ? `已连接 ${connected.label}：${setCommand(kit, { kind: connected.kind, ...run.set.given })}` : '未连接部署目标。',
          ...found.map((f) => `本机检测到 ${f.found.label}：${setCommand(kit, { kind: f.adapter.kind, ...f.found.values })}`),
        ]
        return done(lines.join('\n'), { connected, found: found.map((f) => ({ kind: f.adapter.kind, label: f.found.label, values: f.found.values })) })
      })
    },
  })
}

function targetRemoveCommand(kit: Kit): OwnerCommand {
  return defineCommand({
    name: targetRemoveName(kit),
    act: { kind: 'disconnected', name: '部署目标' },
    summary: '断开部署目标的连接：已发布的条目不取消发布，开关保留',
    params: {},
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run(_values, ctx) {
      return withRun(kit, ctx, async (run) => {
        if (run.target === null) return refused('no-target', '未连接部署目标。')
        const left = heldOn(run, run.target)
        await targetFile(ctx).remove()
        return done(`已断开连接 ${run.target.label}。${left > 0 ? `${left} 个已发布的条目未取消发布。` : ''}`, { left })
      })
    },
  })
}

export function commands(kit: Kit): OwnerCommand[] {
  return [switchCommand(kit, true), switchCommand(kit, false), syncCommand(kit), listCommand(kit), targetSetCommand(kit), targetListCommand(kit), targetRemoveCommand(kit)]
}
