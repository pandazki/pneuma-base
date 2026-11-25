// The owner commands of a deploy plugin, named after it. None loses anything, so none is
// destructive. Publishing faces outward, so the switch and the target are owner-only: the kernel
// refuses them in an agent session. Each command reads its arguments in one small function.
import type { OwnerAnswer, OwnerArgs, OwnerCommand } from '../../types.js'
import { declaredAt, looks, onlyTarget, openTarget, record, settle, sweep, targetFile, withRun, type Done, type Kit, type Settled } from './reconcile.js'
import type { TargetKey } from './facts.js'
import type { TargetAdapter, TargetFlags } from './target.js'
import { lookText, noTarget, STATUS } from './words.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })
/** A malformed call; the command line shows it as a usage error. */
const usage = (text: string) => refused('usage', text)

/** Who may run a command: the owner alone, anyone, or anyone, as it only reads. */
type Who = 'owner' | 'anyone' | 'reader'

function command(name: string, summary: string, who: Who, run: OwnerCommand['run'], args?: string): OwnerCommand {
  return { name, summary, ...(args === undefined ? {} : { usage: args }), destructive: false, ownerOnly: who === 'owner', readOnly: who === 'reader', run }
}

type Read = TargetFlags & { positional: string[] }

/** The arguments, or the usage text saying what is wrong with them. A flag with an empty value counts as not given, as a form's empty field. */
function read(name: string, args: OwnerArgs, arity: number, flags: readonly string[]): Read | string {
  if (args.positional.length !== arity) return `${name} 的参数个数不对`
  for (const flag of Object.keys(args.flags)) if (!flags.includes(flag)) return `${name} 不认识 --${flag}`
  const values = (flag: string) => {
    const v = args.flags[flag]
    return Array.isArray(v) ? v.filter((x) => x !== '') : []
  }
  return { positional: args.positional, values, value: (flag) => values(flag)[0] ?? null }
}

function doneText(path: string, d: Done): string {
  return d.kind === 'publish' ? `已发布 ${path}${d.url ? ` → ${d.url}` : ''}` : `已下线 ${path} 的站点 ${d.site}`
}

function switchCommand(kit: Kit, on: boolean): OwnerCommand {
  const name = `${kit.name} ${on ? 'on' : 'off'}`
  const [verb, effect] = on ? ['打开', '发布'] : ['关上', '下线']
  const summary = on ? '打开开关：发布一样可部署的东西，之后线上跟着它的内容' : '关上开关：把一样东西从目标上撤下'
  /** `<name> on|off <库内路径>`. */
  const args = (a: OwnerArgs): { input: string } | string => {
    const r = read(name, a, 1, [])
    return typeof r === 'string' ? r : { input: r.positional[0] as string }
  }
  return command(name, summary, 'owner', async (raw, ctx) => {
    const a = args(raw)
    if (typeof a === 'string') return usage(a)
    return withRun(kit, ctx, async (run) => {
      const id = await declaredAt(run, a.input)
      if (id === null) return refused('not-declared', `${a.input} 没有声明过可以部署。先 say deployable ${a.input}。`)
      if (run.d.things.get(id)?.on !== on) record(run, { kind: 'switch', thing: id, on })
      const r = await settle(run, id)
      const path = r.thing.path
      if (r.problem?.kind === 'no-target') return refused('no-target', `已${verb} ${path} 的开关，但没有${effect}。${noTarget(kit)}，再 ${kit.name} sync。`)
      if (r.problem?.kind === 'failed') {
        return refused(on ? 'publish-failed' : 'unpublish-failed', `已${verb} ${path} 的开关，但${effect}失败：${r.problem.message}。现在是${STATUS[r.status].text}；目标好了之后运行 ${kit.name} sync。`)
      }
      return done(`已${verb} ${path}：${lookText(r)}`, { path, status: r.status, site: r.site, url: r.url })
    })
  }, '<库内路径>')
}

function syncCommand(kit: Kit): OwnerCommand {
  const name = `${kit.name} sync`
  /** `<name> sync`, no arguments. */
  const args = (a: OwnerArgs): null | string => {
    const r = read(name, a, 0, [])
    return typeof r === 'string' ? r : null
  }
  return command(name, '把全部可部署的东西对一遍：该发布的发布，该下线的下线；跑几遍结果都一样', 'anyone', async (raw, ctx) => {
    const a = args(raw)
    if (typeof a === 'string') return usage(a)
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
  })
}

function listCommand(kit: Kit): OwnerCommand {
  const name = `${kit.name} list`
  /** `<name> list`, no arguments. */
  const args = (a: OwnerArgs): null | string => {
    const r = read(name, a, 0, [])
    return typeof r === 'string' ? r : null
  }
  return command(name, '列出可部署的东西、状态和地址', 'reader', async (raw, ctx) => {
    const a = args(raw)
    if (typeof a === 'string') return usage(a)
    return withRun(kit, ctx, async (run) => {
      const all = await looks(run)
      const head = run.target ? `目标：${run.target.label}` : noTarget(kit)
      const rows = all.map((l) => `${l.thing.path}  ${STATUS[l.status].text}${l.url ? `  ${l.url}` : ''}`)
      return done([head, ...(rows.length > 0 ? rows : ['还没有声明过可以部署的东西。'])].join('\n'), all.map((l) => ({ path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url })))
    })
  })
}

/** `--kind <kind> <its flags>` for each kind, or the one kind's flags alone. */
function targetUsage(kit: Kit): string {
  return onlyTarget(kit)?.usage ?? kit.targets.map((t) => `--kind ${t.kind} ${t.usage}`).join(' | ')
}

function targetSetCommand(kit: Kit): OwnerCommand {
  const name = `${kit.name} target set`
  const flags = ['kind', ...new Set(kit.targets.flatMap((t) => t.flags))]
  /** `<name> target set [--kind <kind>] <that kind's flags>`; with one kind, `--kind` may be left out. */
  const args = (a: OwnerArgs): { adapter: TargetAdapter; flags: TargetFlags } | string => {
    const r = read(name, a, 0, flags)
    if (typeof r === 'string') return r
    const kind = r.value('kind') ?? onlyTarget(kit)?.kind
    const adapter = kit.targets.find((t) => t.kind === kind)
    return adapter ? { adapter, flags: r } : `要写 ${kit.targets.map((t) => `--kind ${t.kind}`).join(' 或 ')}。`
  }
  const summary = `配部署目标：${kit.targets.map((t) => t.label).join('，或')}`
  return { setup: true, ...command(name, summary, 'owner', async (raw, ctx) => {
    const a = args(raw)
    if (typeof a === 'string') return usage(a)
    const configured = await a.adapter.configure(a.flags, ctx)
    if (!configured.ok) return refused(configured.reason, configured.text)
    const stored = { kind: a.adapter.kind, ...configured.config }
    return withRun(kit, ctx, async (run) => {
      await targetFile(ctx).write({ format: 1, target: stored })
      const next = openTarget(kit, stored, ctx)
      const head = `部署目标已设为 ${next.label}。`
      if (run.target?.key === next.key) return done(head, { target: stored })
      const on = [...run.d.things.values()].filter((t) => t.on && ctx.tools.regionOf(t.path) === 'content').length
      const left = run.target ? (run.d.sites.get(run.target.key as TargetKey)?.size ?? 0) : 0
      const notes = [...(on > 0 ? [`开着的 ${on} 样还没发到新目标：运行 ${kit.name} sync。`] : []), ...(left > 0 ? [`旧目标上的 ${left} 个站点没有撤下。`] : [])]
      return done([head, ...notes].join(''), { target: stored })
    })
  }, targetUsage(kit)) }
}

export function commands(kit: Kit): OwnerCommand[] {
  return [switchCommand(kit, true), switchCommand(kit, false), syncCommand(kit), listCommand(kit), targetSetCommand(kit)]
}
