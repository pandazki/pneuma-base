// The owner commands over versions. Only prune is destructive: export writes outside the library,
// and restore makes the current content one more version through the kernel's put.
import { join, posix } from 'node:path'
import { defineCommand, parseLibraryPath, type OwnerAnswer, type OwnerCommand, type Place, type PluginContext, type PluginProblem } from '@pneuma-base/kernel'
import { latest, placesOf, type Thing, type Version } from './model.js'
import { exportTarget, inScratch, writeOut } from './outside.js'
import { thingPages, thingWhere } from './rows.js'
import { drop, present, sweepPending } from './store.js'
import { archived, timelineData, timelineText } from './text.js'
import { apply, commit, declaredAt, diskState, fingerprintNow, load, thingPath, writing } from './versions.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })

const numbers = (versions: Version[]) => versions.map((v) => v.n).join('、')
const problemLines = (problems: PluginProblem[]) => problems.map((p) => `\n插件 ${p.plugin} 出错：${p.message}`).join('')

/**
 * The declared thing an input names, or the refusal to answer with. A thing the owner deleted with
 * the archive is no longer named by any path: its versions stay in the store, out of every command's
 * reach, and the refusal says so rather than that it was never declared.
 */
async function named(ctx: PluginContext, input: string): Promise<Thing | OwnerAnswer> {
  const path = await thingPath(ctx, input)
  if (path === null) return refused('not-versioned', `${input} 未启用版本管理。如需保留每个版本，由 Agent 执行 say versioned ${input}。`)
  const thing = await declaredAt(ctx, path)
  if (thing) return thing
  const records = ctx.tools.storage.records
  const gone = (await thingWhere(records, 'gone', path)) ?? (await thingWhere(records, 'gone', ctx.tools.archivedPath(path)))
  if (gone) return refused('gone', `${gone.path} 已随清空归档删除。其 ${gone.versions.filter((v) => !v.pruned).length} 个版本的内容仍在版本存储中，无法通过命令恢复或清除。`)
  return refused('not-versioned', `${input} 未启用版本管理。如需保留每个版本，由 Agent 执行 say versioned ${input}。`)
}

/** Version `n` of the thing, with its content in the store, or the refusal to answer with. */
async function kept(ctx: PluginContext, thing: Thing, n: number): Promise<Version | OwnerAnswer> {
  const v = thing.versions[n - 1]
  if (!v) return refused('no-such-version', `${thing.path} 无版本 ${n}，共 ${thing.versions.length} 个版本。`)
  if (v.pruned) return refused('pruned', `${thing.path} 的版本 ${n} 已清除，不可恢复。`)
  const places = placesOf(v)
  if ((await present(ctx, places)).size < new Set(places).size) return refused('content-missing', `${thing.path} 的版本 ${n} 的内容已从存储中缺失，不可恢复。`)
  return v
}

/** The thing and its version `n` that a command's arguments name, or the refusal to answer with. */
async function chosen(ctx: PluginContext, input: string, n: number): Promise<{ thing: Thing; v: Version } | OwnerAnswer> {
  await load(ctx)
  const thing = await named(ctx, input)
  if ('outcome' in thing) return thing
  const v = await kept(ctx, thing, n)
  return 'outcome' in v ? v : { thing, v }
}

const PATH = { name: 'path', hint: '库内路径', required: true } as const
const NUMBER = '[1-9][0-9]*'

export const VERSION_EXPORT = defineCommand({
  name: 'version export',
  act: { kind: 'exported', object: 'path' },
  summary: '将指定版本导出到外部新路径',
  params: {
    positional: [PATH],
    flags: [
      { name: 'version', hint: '版本号', kind: 'value', required: true, pattern: NUMBER },
      { name: 'to', hint: '外部目录或文件', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: false,
  async run({ path: input, version, to }, ctx) {
    const n = Number(version)
    const found = await chosen(ctx, input, n)
    if ('outcome' in found) return found
    const { thing, v } = found
    const { target, taken } = await exportTarget(ctx.session.cwd, to, thing.path)
    if (parseLibraryPath(ctx.library.root, target) !== null) return refused('inside-library', `导出路径须位于资料库之外，${to} 在资料库中。如需在资料库中使用旧版本，请恢复该版本。`)
    if (taken) return refused('would-overwrite', `${target} 已存在，未修改。请使用其他路径。`)
    try {
      await writeOut(ctx, v, target)
    } catch (error) {
      return refused('export-failed', `导出到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return done(`已将 ${thing.path} 的版本 ${n} 导出到 ${target}。`, { path: thing.path, version: n, to: target })
  },
})

export const VERSION_RESTORE = defineCommand({
  name: 'version restore',
  act: { kind: 'restored', object: 'path' },
  summary: '恢复指定版本，记录为新版本',
  params: { positional: [PATH], flags: [{ name: 'version', hint: '版本号', kind: 'value', required: true, pattern: NUMBER }] },
  destructive: false,
  ownerOnly: false,
  async run({ path: input, version }, ctx) {
    const n = Number(version)
    const found = await chosen(ctx, input, n)
    if ('outcome' in found) return found
    const { thing, v } = found
    if (archived(thing)) return refused('archived', `${thing.path} 已归档。请先执行 unarchive ${ctx.tools.originalPath(thing.path) ?? thing.path}，再恢复旧版本。`)
    if ((await fingerprintNow(ctx, thing)) === v.fingerprint) return done(`${thing.path} 当前内容即为版本 ${n}，未修改。`)
    // Through the kernel's put, so every plugin sees it and it sends its event; the export is its source outside the library.
    return inScratch(async (scratch) => {
      const from = join(scratch, posix.basename(thing.path))
      await writeOut(ctx, v, from)
      const source = { kind: v.kept.kind === 'file' ? ('file' as const) : ('directory' as const), path: from }
      const r = await ctx.tools.put({ kind: 'place', from: source, to: thing.path, origin: { kind: 'imported', source: `${thing.path} 的版本 ${n}`, by: null } })
      if (r.outcome === 'refused') return refused(r.reason, `恢复 ${thing.path} 失败：添加被拒绝（${r.reason}，${r.subject}）。${problemLines(r.problems)}`)
      await load(ctx)
      const now = await declaredAt(ctx, thing.path)
      const m = now ? latest(now)?.n : undefined
      return done(`已恢复 ${thing.path} 的版本 ${n}${m === undefined ? '' : `，记录为版本 ${m}`}。${problemLines(r.problems)}`, { path: thing.path, version: n, recorded: m ?? null })
    })
  },
})

/** Every place some kept version of some thing still needs, from the rows a page at a time. */
async function neededContent(ctx: PluginContext): Promise<Set<Place>> {
  const out = new Set<Place>()
  for await (const page of thingPages(ctx.tools.storage.records)) for (const thing of page) for (const v of thing.versions) if (!v.pruned) for (const p of placesOf(v)) out.add(p)
  return out
}

export const VERSION_PRUNE = defineCommand({
  name: 'version prune',
  act: { kind: 'removed', object: 'path' },
  summary: '仅保留最近的版本，清除更早的版本',
  params: { positional: [PATH], flags: [{ name: 'keep', hint: '保留版本数', kind: 'value', required: true, pattern: NUMBER }] },
  destructive: true,
  ownerOnly: true,
  async run({ path: input, keep: kept }, ctx) {
    const keep = Number(kept)
    const w = await writing(ctx)
    const found = await named(ctx, input)
    if ('outcome' in found) return found
    const live = found.versions.filter((v) => !v.pruned)
    const dropped = live.slice(0, Math.max(0, live.length - keep))
    const left = live.slice(dropped.length)
    const leftovers = await sweepPending(ctx, ctx.now)
    const swept = leftovers === 0 ? '' : `另删除 ${leftovers} 个中断时残留的副本。`
    if (dropped.length === 0) return done(`${found.path} 仅保留 ${live.length} 个版本，无需清除。${swept}`)
    w.things.set(found.id, found)
    apply(w, { kind: 'prune', thing: found.id, versions: dropped.map((v) => v.id) })
    await commit(w)
    // Content another kept version, of this thing or another, still needs stays.
    const needed = await neededContent(ctx)
    const orphans = [...new Set(dropped.flatMap(placesOf))].filter((p) => !needed.has(p))
    const deleted = await drop(ctx, orphans)
    return done(`已清除 ${found.path} 的版本 ${numbers(dropped)}，删除 ${deleted} 份仅属于这些版本的内容；保留版本 ${numbers(left)}。${swept}`, {
      path: found.path,
      pruned: dropped.map((v) => v.n),
      kept: left.map((v) => v.n),
      deleted,
      leftovers,
    })
  },
})

export const versionCommands: OwnerCommand[] = [
  defineCommand({
    name: 'version list',
    summary: '列出受版本管理条目的所有版本',
    params: { positional: [PATH] },
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    async run({ path: input }, ctx) {
      await load(ctx)
      const thing = await named(ctx, input)
      if ('outcome' in thing) return thing
      const state = await diskState(ctx, thing)
      return done(timelineText(thing, state), timelineData(thing, state))
    },
  }),
  VERSION_EXPORT,
  VERSION_RESTORE,
  VERSION_PRUNE,
]
