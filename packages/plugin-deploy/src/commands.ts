// The deploy plugin's owner commands. None loses anything, so none is destructive. Publishing faces
// outward, so the switch and the target are owner-only: the kernel refuses them in an agent session.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseLibraryPath, regionOf, type OwnerAnswer, type OwnerArgs, type OwnerCommand, type PluginContext } from '@pneuma-base/kernel'
import type { Status } from './model.js'
import { declaredAt, looks, record, settle, sweep, withRun, type Done, type Settled } from './reconcile.js'
import { DEFAULT_TIMEOUT, targetOf, words, writeTargetConfig, type TargetConfig } from './targets.js'
import { lookText, STATUS } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })
/** A malformed call; the command line shows it as a usage error. */
const usage = (text: string) => refused('usage', text)

/** Who may run a command: the owner alone, anyone, or anyone, as it only reads. */
type Who = 'owner' | 'anyone' | 'reader'

function command(name: string, summary: string, who: Who, run: OwnerCommand['run'], args?: string): OwnerCommand {
  return { name, summary, ...(args === undefined ? {} : { usage: args }), destructive: false, ownerOnly: who === 'owner', readOnly: who === 'reader', run }
}

type Read = { positional: string[]; value(flag: string): string | null; values(flag: string): string[] }

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

const NO_TARGET = '还没配部署目标：deploy target set --kind dir --to <目录>，或 --kind command --publish "<命令>" --unpublish "<命令>"'

function doneText(path: string, d: Done): string {
  return d.kind === 'publish' ? `已发布 ${path}${d.url ? ` → ${d.url}` : ''}` : `已下线 ${path} 的站点 ${d.site}`
}

function switchCommand(on: boolean): OwnerCommand {
  const name = on ? 'deploy on' : 'deploy off'
  const [verb, effect] = on ? ['打开', '发布'] : ['关上', '下线']
  const summary = on ? '打开开关：发布一样可部署的东西，之后线上跟着它的内容' : '关上开关：把一样东西从目标上撤下'
  return command(name, summary, 'owner', async (args, ctx) => {
    const a = read(name, args, 1, [])
    if (typeof a === 'string') return usage(a)
    const input = a.positional[0] as string
    return withRun(ctx, async (run) => {
      const id = await declaredAt(run, input)
      if (id === null) return refused('not-declared', `${input} 没有声明过可以部署。先 say deployable ${input}。`)
      if (run.d.things.get(id)?.on !== on) record(run, { kind: 'switch', thing: id, on })
      const r = await settle(run, id)
      const path = r.thing.path
      if (r.problem?.kind === 'no-target') return refused('no-target', `已${verb} ${path} 的开关，但没有${effect}。${NO_TARGET}，再 deploy sync。`)
      if (r.problem?.kind === 'failed') {
        return refused(on ? 'publish-failed' : 'unpublish-failed', `已${verb} ${path} 的开关，但${effect}失败：${r.problem.message}。现在是${STATUS[r.status].text}；目标好了之后运行 deploy sync。`)
      }
      return done(`已${verb} ${path}：${lookText(r)}`, { path, status: r.status, site: r.site, url: r.url })
    })
  }, '<库内路径>')
}

const sync = command('deploy sync', '把全部可部署的东西对一遍：该发布的发布，该下线的下线；跑几遍结果都一样', 'anyone', async (args, ctx) => {
  const a = read('deploy sync', args, 0, [])
  if (typeof a === 'string') return usage(a)
  return withRun(ctx, async (run) => {
    const results: Settled[] = []
    for (const thing of [...run.d.things.values()].sort((x, y) => (x.path < y.path ? -1 : 1))) results.push(await settle(run, thing.id))
    const swept = await sweep(run)
    const changed = results.reduce((n, r) => n + r.done.length, 0) + swept.done.length
    const counts = (Object.keys(STATUS) as Status[]).flatMap((s) => {
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
    if (results.some((r) => r.problem?.kind === 'no-target')) return refused('no-target', `${text}\n${NO_TARGET}`)
    if (results.some((r) => r.problem?.kind === 'failed') || swept.failed.length > 0) return refused('publish-failed', text)
    return done(text, { changed, things: results.map((r) => ({ path: r.thing.path, status: r.status, url: r.url, done: r.done })) })
  })
})

const list = command('deploy list', '列出可部署的东西、状态和地址', 'reader', async (args, ctx) => {
  const a = read('deploy list', args, 0, [])
  if (typeof a === 'string') return usage(a)
  return withRun(ctx, async (run) => {
    const all = await looks(run)
    const head = run.target ? `目标：${run.target.label}` : NO_TARGET
    const rows = all.map((l) => `${l.thing.path}  ${STATUS[l.status].text}${l.url ? `  ${l.url}` : ''}`)
    return done([head, ...(rows.length > 0 ? rows : ['还没有声明过可以部署的东西。'])].join('\n'), all.map((l) => ({ path: l.thing.path, status: l.status, on: l.thing.on, site: l.site, url: l.url })))
  })
})

/** Whether `dir` lies in the library or holds it: a target there would publish into the library itself. */
function overlaps(root: string, dir: string): boolean {
  const within = (inner: string, outer: string) => {
    const rel = relative(outer, inner)
    return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
  }
  return within(dir, root) || within(root, dir) || parseLibraryPath(root, dir) !== null
}

/** A command given as one string is split like a shell would; given as several words it is already argv. */
function argv(values: string[]): string[] | null {
  if (values.length === 0) return null
  return values.length === 1 ? words(values[0] as string) : values
}

function targetConfig(a: Read, ctx: PluginContext): TargetConfig | OwnerAnswer {
  const kind = a.value('kind')
  if (kind === 'dir') {
    const to = a.value('to')
    if (to === null) return usage('--kind dir 要写 --to <目录>。')
    const dir = resolve(ctx.session.cwd, to)
    if (overlaps(ctx.library.root, dir)) return refused('inside-library', `部署目标不能在库里，也不能包含库：${dir}`)
    return { kind: 'dir', to: dir }
  }
  if (kind !== 'command') return usage('要写 --kind dir 或 --kind command。')
  let publish: string[] | null
  let unpublish: string[] | null
  try {
    publish = argv(a.values('publish'))
    unpublish = argv(a.values('unpublish'))
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error))
  }
  if (publish === null || unpublish === null) return usage('--kind command 要写 --publish "<发布命令>" 和 --unpublish "<下线命令>"，命令里用 {dir} 和 {name}。')
  const timeout = a.value('timeout')
  if (timeout !== null && !/^[1-9]\d*$/.test(timeout)) return usage(`--timeout 要写一个正整数，单位是秒：${timeout}`)
  return { kind: 'command', publish, unpublish, url: a.value('url'), timeout: timeout === null ? DEFAULT_TIMEOUT : Number(timeout) }
}

const targetSet = command('deploy target set', '配部署目标：一个本地目录，或一对发布和下线的命令', 'owner', async (args, ctx) => {
  const a = read('deploy target set', args, 0, ['kind', 'to', 'publish', 'unpublish', 'url', 'timeout'])
  if (typeof a === 'string') return usage(a)
  const config = targetConfig(a, ctx)
  if ('outcome' in config) return config
  return withRun(ctx, async (run) => {
    await writeTargetConfig(ctx.dir, config)
    const next = targetOf(config, { cwd: ctx.library.root, scratch: ctx.cacheDir })
    const head = `部署目标已设为 ${next.label}。`
    if (run.target?.key === next.key) return done(head, { target: config })
    const on = [...run.d.things.values()].filter((t) => t.on && regionOf(t.path) === 'content').length
    const left = run.target ? (run.d.sites.get(run.target.key)?.size ?? 0) : 0
    const notes = [...(on > 0 ? [`开着的 ${on} 样还没发到新目标：运行 deploy sync。`] : []), ...(left > 0 ? [`旧目标上的 ${left} 个站点没有撤下。`] : [])]
    return done([head, ...notes].join(''), { target: config })
  })
}, '--kind dir --to <目录> | --kind command --publish "<命令>" --unpublish "<命令>" [--url <模板>] [--timeout <秒>]')

export const COMMANDS: readonly OwnerCommand[] = [switchCommand(true), switchCommand(false), sync, list, targetSet]
