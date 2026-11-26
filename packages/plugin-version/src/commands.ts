// The owner commands over versions. Only prune is destructive: export writes outside the library,
// and restore makes the current content one more version through the kernel's put.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import {
  agentFace,
  archivedPath,
  defineCommand,
  originalPath,
  parseLibraryPath,
  type OwnerAnswer,
  type OwnerCommand,
  type PluginContext,
  type PluginProblem,
} from '@pneuma-base/kernel'
import { declaredAt, latest, neededContent, type Model, type Thing, type Version } from './model.js'
import { complete, drop, writeOut } from './store.js'
import { archived, timelineData, timelineText } from './text.js'
import { apply, commit, diskState, load, thingPath, writing } from './versions.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

const numbers = (versions: Version[]) => versions.map((v) => v.n).join('、')
const problemLines = (problems: PluginProblem[]) => problems.map((p) => `\n插件 ${p.plugin} 出错：${p.message}`).join('')

/**
 * The declared thing an input names, or the refusal to answer with. A thing the owner deleted with
 * the archive is no longer named by any path: its versions stay in the store, out of every command's
 * reach, and the refusal says so rather than that it was never declared.
 */
async function named(ctx: PluginContext, model: Model, input: string): Promise<Thing | OwnerAnswer> {
  const path = await thingPath(ctx, input)
  const thing = path === null ? undefined : declaredAt(model, path)
  if (thing) return thing
  const gone = path === null ? undefined : [...model.things.values()].find((t) => t.gone && (t.path === path || t.path === archivedPath(path)))
  if (gone) return refused('gone', `${gone.path} 随归档区清掉了。它的 ${gone.versions.filter((v) => !v.pruned).length} 版内容还在版本存放里，没有命令能取回或清掉它们。`)
  return refused('not-versioned', `${input} 没有声明有版本。要留住它的每一版，agent 用 say versioned ${input} 声明。`)
}

/** Version `n` of the thing, with its content in the store, or the refusal to answer with. */
async function kept(ctx: PluginContext, thing: Thing, n: number): Promise<Version | OwnerAnswer> {
  const v = thing.versions[n - 1]
  if (!v) return refused('no-such-version', `${thing.path} 没有第 ${n} 版，它有 ${thing.versions.length} 版。`)
  if (v.pruned) return refused('pruned', `${thing.path} 的第 ${n} 版已经清掉了，取不回。`)
  if (!(await complete(ctx.dir, v.manifest))) return refused('content-missing', `${thing.path} 的第 ${n} 版的内容不在存放里了，取不回。`)
  return v
}

/** The thing and its version `n` that a command's arguments name, or the refusal to answer with. */
async function chosen(ctx: PluginContext, input: string, n: number): Promise<{ thing: Thing; v: Version } | OwnerAnswer> {
  const thing = await named(ctx, await load(ctx), input)
  if ('outcome' in thing) return thing
  const v = await kept(ctx, thing, n)
  return 'outcome' in v ? v : { thing, v }
}

const PATH = { name: 'path', hint: '库内路径', required: true } as const
const NUMBER = '[1-9][0-9]*'

export const VERSION_EXPORT = defineCommand({
  name: 'version export',
  summary: '把某一版写到库外的一个新路径',
  params: {
    positional: [PATH],
    flags: [
      { name: 'version', hint: '第几版', kind: 'value', required: true, pattern: NUMBER },
      { name: 'to', hint: '库外的目录或文件', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run({ path: input, version, to }, ctx) {
    const n = Number(version)
    const found = await chosen(ctx, input, n)
    if ('outcome' in found) return found
    const { thing, v } = found
    // An existing directory receives the export under the thing's name, as cp does.
    let target = resolve(ctx.session.cwd, to)
    if ((await stat(target).catch(() => null))?.isDirectory()) target = join(target, posix.basename(thing.path))
    if (parseLibraryPath(ctx.library.root, target) !== null) return refused('inside-library', `导出要写到库外，${to} 在库里。要在库里用旧版，用 version restore。`)
    if (await stat(target).catch(() => null)) return refused('would-overwrite', `${target} 已有东西，没有动它。换一个路径。`)
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeOut(ctx.dir, v.manifest, target)
    } catch (error) {
      return refused('export-failed', `没能导出到 ${target}：${error instanceof Error ? error.message : String(error)}`)
    }
    return done(`已把 ${thing.path} 的第 ${n} 版导出到 ${target}。`, { path: thing.path, version: n, to: target })
  },
})

export const VERSION_RESTORE = defineCommand({
  name: 'version restore',
  summary: '把某一版放回来，作为新的一版',
  params: { positional: [PATH], flags: [{ name: 'version', hint: '第几版', kind: 'value', required: true, pattern: NUMBER }] },
  destructive: false,
  ownerOnly: false,
  async run({ path: input, version }, ctx) {
    const n = Number(version)
    const found = await chosen(ctx, input, n)
    if ('outcome' in found) return found
    const { thing, v } = found
    if (archived(thing)) return refused('archived', `${thing.path} 已归档。先 unarchive ${originalPath(thing.path) ?? thing.path}，再放回旧版。`)
    if ((await ctx.tools.thing(thing.path)) && (await ctx.tools.fingerprint(thing.path)) === v.fingerprint) return done(`${thing.path} 现在就是第 ${n} 版的内容，没有动。`)
    // Through the kernel's put, so every plugin sees it and it sends its event; the export is its source outside the library.
    const scratch = await mkdtemp(join(tmpdir(), 'pneuma-base-version-'))
    try {
      const from = join(scratch, posix.basename(thing.path))
      await writeOut(ctx.dir, v.manifest, from)
      const source = { kind: v.manifest.kind === 'bundle' ? ('directory' as const) : ('file' as const), path: from }
      const r = await agentFace.put({ kind: 'place', from: source, to: thing.path, origin: { kind: 'brought', source: `${thing.path} 的第 ${n} 版`, by: null } }, ctx)
      if (r.outcome === 'refused') return refused(r.reason, `没能放回 ${thing.path}：放入被拒绝（${r.reason}，${r.subject}）。${problemLines(r.problems)}`)
      const now = declaredAt(await load(ctx), thing.path)
      const m = now ? latest(now)?.n : undefined
      return done(`已把 ${thing.path} 的第 ${n} 版放回来${m === undefined ? '' : `，记为第 ${m} 版`}。${problemLines(r.problems)}`, { path: thing.path, version: n, recorded: m ?? null })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
})

export const VERSION_PRUNE = defineCommand({
  name: 'version prune',
  summary: '只留最近的几版，清掉更早的',
  params: { positional: [PATH], flags: [{ name: 'keep', hint: '留几版', kind: 'value', required: true, pattern: NUMBER }] },
  destructive: true,
  ownerOnly: true,
  async run({ path: input, keep: kept }, ctx) {
    const keep = Number(kept)
    const w = await writing(ctx)
    const thing = await named(ctx, w.model, input)
    if ('outcome' in thing) return thing
    const live = thing.versions.filter((v) => !v.pruned)
    const dropped = live.slice(0, Math.max(0, live.length - keep))
    const left = live.slice(dropped.length)
    if (dropped.length === 0) return done(`${thing.path} 留着的只有 ${live.length} 版，没有要清的。`)
    apply(w, { kind: 'prune', thing: thing.id, versions: dropped.map((v) => v.id) })
    await commit(w)
    // Content another kept version, of this thing or another, still needs stays.
    const needed = neededContent(w.model)
    const orphans = new Set(dropped.flatMap((v) => v.manifest.rows.map((r) => r.fingerprint)).filter((f) => !needed.has(f)))
    const deleted = await drop(ctx.dir, orphans)
    return done(`已清掉 ${thing.path} 的第 ${numbers(dropped)} 版，删了 ${deleted} 个只属于这些版本的内容文件；留着第 ${numbers(left)} 版。`, {
      path: thing.path,
      pruned: dropped.map((v) => v.n),
      kept: left.map((v) => v.n),
      deleted,
    })
  },
})

export const versionCommands: OwnerCommand[] = [
  defineCommand({
    name: 'version list',
    summary: '列出一样有版本的东西的每一版',
    params: { positional: [PATH] },
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run({ path: input }, ctx) {
      const thing = await named(ctx, await load(ctx), input)
      if ('outcome' in thing) return thing
      const state = await diskState(ctx, thing)
      return done(timelineText(thing, state), timelineData(thing, state))
    },
  }),
  VERSION_EXPORT,
  VERSION_RESTORE,
  VERSION_PRUNE,
]
