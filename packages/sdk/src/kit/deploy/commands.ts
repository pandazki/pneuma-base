// The owner commands of a deploy plugin, named after it. None loses anything, so none is
// destructive. Publishing faces outward, so the switch and the target are owner-only: the kernel
// refuses them in an agent session. Every command declares its arguments; `target set` takes them
// from the kinds of target.
import { defineCommand } from '../../params.js'
import type { FlagParam, OwnerAnswer, OwnerCommand, OwnerValues, SecretDecl } from '../../types.js'
import { declaredAt, looks, onlyTarget, openTarget, record, setSecret, settle, sweep, targetFile, withRun, type Done, type Kit, type Settled } from './reconcile.js'
import type { TargetKey } from './facts.js'
import type { TargetAdapter } from './target.js'
import { kindUsage, lookText, noTarget, STATUS } from './words.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

function doneText(path: string, d: Done): string {
  return d.kind === 'publish' ? `已发布 ${path}${d.url ? ` → ${d.url}` : ''}` : `已下线 ${path} 的站点 ${d.site}`
}

export const switchName = (plugin: string, on: boolean) => `${plugin} ${on ? 'on' : 'off'}`
export const SWITCH_PARAMS = { positional: [{ name: 'path', hint: '库内路径', required: true }] } as const

function switchCommand(kit: Kit, on: boolean): OwnerCommand {
  const [verb, effect] = on ? ['打开', '发布'] : ['关上', '下线']
  return defineCommand({
    name: switchName(kit.name, on),
    summary: on ? '打开开关：发布一样可部署的东西，之后线上跟着它的内容' : '关上开关：把一样东西从目标上撤下',
    params: SWITCH_PARAMS,
    destructive: false,
    ownerOnly: true,
    async run({ path: input }, ctx) {
      return withRun(kit, ctx, async (run) => {
        const id = await declaredAt(run, input)
        if (id === null) return refused('not-declared', `${input} 没有声明过可以部署。先 say deployable ${input}。`)
        if (run.d.things.get(id)?.on !== on) record(run, { kind: 'switch', thing: id, on })
        const r = await settle(run, id)
        const path = r.thing.path
        if (r.problem?.kind === 'no-target') return refused('no-target', `已${verb} ${path} 的开关，但没有${effect}。${noTarget(kit)}，再 ${kit.name} sync。`)
        if (r.problem?.kind === 'failed') {
          return refused(on ? 'publish-failed' : 'unpublish-failed', `已${verb} ${path} 的开关，但${effect}失败：${r.problem.message}。现在是${STATUS[r.status].text}；目标好了之后运行 ${kit.name} sync。`)
        }
        return done(`已${verb} ${path}：${lookText(r)}`, { path, status: r.status, site: r.site, url: r.url })
      })
    },
  })
}

function syncCommand(kit: Kit): OwnerCommand {
  return defineCommand({
    name: `${kit.name} sync`,
    summary: '把全部可部署的东西对一遍：该发布的发布，该下线的下线；跑几遍结果都一样',
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
          return n > 0 ? [`${STATUS[s].text} ${n}`] : []
        })
        const lines = [
          ...results.flatMap((r) => r.done.map((d) => doneText(r.thing.path, d))),
          ...swept.done.map((d) => `已下线没人声明的站点 ${d.site}`),
          ...results.flatMap((r) => (r.problem?.kind === 'failed' ? [`没能跟上 ${r.thing.path}：${r.problem.message}`] : [])),
          ...swept.failed.map((f) => `没能下线站点 ${f.site}：${f.message}`),
        ]
        if (results.length === 0 && swept.done.length === 0) return done('还没有声明过可以部署的东西。', { changed })
        const quiet = lines.length === 0 && results.every((r) => r.problem === null)
        const head = quiet ? `对了一遍，没有要改的：${counts.join('，')}。` : `对了一遍：${counts.join('，')}。`
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
    summary: '列出可部署的东西、状态和地址',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run(_values, ctx) {
      return withRun(kit, ctx, async (run) => {
        const all = await looks(run)
        const head = run.target ? `目标：${run.target.label}` : noTarget(kit)
        const rows = all.map((l) => `${l.thing.path}  ${STATUS[l.status].text}${l.url ? `  ${l.url}` : ''}`)
        return done([head, ...(rows.length > 0 ? rows : ['还没有声明过可以部署的东西。'])].join('\n'), all.map((l) => ({ path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url })))
      })
    },
  })
}

export const targetSetName = (kit: Kit) => `${kit.name} target set`

/** `--kind`, a choice of the kit's kinds; required unless it has only one. */
export function kindFlag(kit: Kit): FlagParam {
  return { name: 'kind', hint: '种类', kind: 'value', ...(onlyTarget(kit) ? {} : { required: true }), options: kit.targets.map((t) => ({ value: t.kind, label: t.label })) }
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

const given = (v: OwnerValues[string] | undefined) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0)

/** What is wrong with the values for the kind chosen: a flag of another kind given, or one of its own required flags left out. */
function kindWrong(kit: Kit, t: TargetAdapter, values: OwnerValues): string | null {
  const own = new Set(['kind', ...t.params.map((f) => f.name)])
  const how = `\n用法：${targetSetName(kit)} ${kindUsage(kit, t)}`
  const other = Object.keys(values).find((name) => !own.has(name) && given(values[name]))
  if (other !== undefined) return `--kind ${t.kind} 不带 --${other}。${how}`
  const missing = t.params.find((f) => f.required && !given(values[f.name]))
  return missing === undefined ? null : `--kind ${t.kind} 要写 --${missing.name}。${how}`
}

/** What `target set` says of the target's secrets the owner has not set: a required one as missing, an optional one as there to set when needed. */
function secretNotes(kit: Kit, unset: readonly SecretDecl[]): string[] {
  const required = unset.filter((s) => s.optional !== true).map((s) => s.name)
  const optional = unset.filter((s) => s.optional === true)
  return [
    ...(required.length === 0 ? [] : [`这个目标要用密钥 ${required.join('、')}，还没设：${required.map((name) => setSecret(kit, name)).join('；')}。`]),
    ...optional.map((s) => `可选的密钥 ${s.name} 没设（${s.description}）；要用时：${setSecret(kit, s.name)}。`),
  ]
}

function targetSetCommand(kit: Kit): OwnerCommand {
  return {
    name: targetSetName(kit),
    summary: `配部署目标：${kit.targets.map((t) => t.label).join('，或')}`,
    params: { flags: targetFlags(kit) },
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run({ values }, ctx) {
      // The kernel checked --kind against the kinds; it is left out only when there is one.
      const kind = typeof values.kind === 'string' ? values.kind : onlyTarget(kit)?.kind
      const adapter = kit.targets.find((t) => t.kind === kind) as TargetAdapter
      const wrong = kindWrong(kit, adapter, values)
      if (wrong !== null) return refused('usage', wrong)
      const configured = await adapter.configure(values, ctx)
      if (!configured.ok) return refused(configured.reason, configured.text)
      const stored = { kind: adapter.kind, ...configured.config }
      const unset: SecretDecl[] = []
      for (const s of adapter.secrets ?? []) if ((await ctx.secrets.get(s.name)) === null) unset.push(s)
      return withRun(kit, ctx, async (run) => {
        await targetFile(ctx).write({ format: 1, target: stored })
        const next = openTarget(kit, stored, ctx)
        const secrets = secretNotes(kit, unset)
        const head = `部署目标已设为 ${next.label}。`
        if (run.target?.key === next.key) return done([head, ...secrets].join(''), { target: stored })
        const on = [...run.d.things.values()].filter((t) => t.on && ctx.tools.regionOf(t.path) === 'content').length
        const left = run.target ? (run.d.sites.get(run.target.key as TargetKey)?.size ?? 0) : 0
        const notes = [...(on > 0 ? [`开着的 ${on} 样还没发到新目标：运行 ${kit.name} sync。`] : []), ...(left > 0 ? [`旧目标上的 ${left} 个站点没有撤下。`] : [])]
        return done([head, ...secrets, ...notes].join(''), { target: stored })
      })
    },
  }
}

export function commands(kit: Kit): OwnerCommand[] {
  return [switchCommand(kit, true), switchCommand(kit, false), syncCommand(kit), listCommand(kit), targetSetCommand(kit)]
}
