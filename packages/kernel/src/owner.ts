import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { skillText } from './cognition.js'
import { exists, listFiles, writeAtomic } from './files.js'
import { GRANT_NAME, readGrantFile, removeGrantFile, writeGrantFile } from './grants.js'
import { CONFIG_FILE, newConfig, saveConfig } from './library.js'
import { ARCHIVE_DIR, parseLibraryPath, regionOf } from './paths.js'
import { makeContext, performOwner, pluginContext } from './pipeline.js'
import { looksLikeAgentSession, type Env } from './session.js'
import type {
  Actor,
  Context,
  Grant,
  GrantId,
  Library,
  LibraryPath,
  OwnerAnswer,
  OwnerArgs,
  OwnerCommand,
  OwnerResult,
  Plugin,
  PluginName,
  PluginTable,
  Session,
} from './types.js'

/** What every owner command needs besides its own arguments. */
export type OwnerCall = {
  ctx: Context
  table: PluginTable
  home: string
  env: Env
  viaGrant: boolean
  confirm: (question: string) => Promise<boolean>
}

type Body = () => Promise<{ answer: OwnerAnswer; library?: Library }>

/**
 * The one place owner commands pass through. A destructive command is refused in an agent session
 * and without a confirmation the person gives in person (K7). Refused or not, it ends at the
 * pipeline's single exit.
 */
async function gated(call: OwnerCall, name: string, destructive: boolean, args: OwnerArgs, body: Body): Promise<OwnerResult> {
  return performOwner(call.ctx, name, args, destructive, async () => {
    if (destructive) {
      if (looksLikeAgentSession(call.env, call.viaGrant)) {
        return { answer: { outcome: 'refused', reason: 'agent-session', text: `「${name}」会丢数据，只能由主人在自己的终端里做，不能在 agent 的会话里做。` } }
      }
      if (!(await call.confirm(`「${name}」会丢数据，不能撤回。确认要做吗？`))) {
        return { answer: { outcome: 'refused', reason: 'not-confirmed', text: '没有得到当面确认，什么都没做。' } }
      }
    }
    return body()
  })
}

const refused = (reason: string, text: string) => ({ answer: { outcome: 'refused' as const, reason, text } })
const done = (text: string, data?: unknown, library?: Library) => ({ answer: { outcome: 'done' as const, text, ...(data === undefined ? {} : { data }) }, ...(library ? { library } : {}) })

/** Makes `dir` a library. Refused before anything is written, so a refused init has no library to send an event to. */
export async function initLibrary(
  dir: string,
  opts: { plugins: string[]; table: PluginTable; actor: Actor; session: Session },
): Promise<OwnerResult> {
  if (await exists(join(dir, CONFIG_FILE))) {
    return { outcome: 'refused', reason: 'already-a-library', text: `${dir} 已经是一个库了`, problems: [] }
  }
  const unknown = opts.plugins.filter((name) => !opts.table.has(name))
  if (unknown.length > 0) {
    return { outcome: 'refused', reason: 'unknown-plugin', text: `没有这个插件：${unknown.join('、')}`, problems: [] }
  }
  await mkdir(dir, { recursive: true })
  const library = await saveConfig(await realpath(dir), newConfig(opts.plugins as PluginName[]), opts.table)
  const ctx = makeContext(library, opts.actor, opts.session)
  const args: OwnerArgs = { positional: [library.root], flags: opts.plugins.length === 0 ? { bare: true } : {} }
  return performOwner(ctx, 'init', args, false, async () => done(`已把 ${library.root} 建成库。说明在 PNEUMA-BASE.md。`, { root: library.root }))
}

export const ownerFace = {
  issueGrant(call: OwnerCall, req: { name: string; agent: string; area: string | null; readOnly: boolean }): Promise<OwnerResult> {
    const args: OwnerArgs = {
      positional: [req.name],
      flags: { agent: [req.agent], ...(req.area === null ? {} : { area: [req.area] }), ...(req.readOnly ? { 'read-only': true as const } : {}) },
    }
    return gated(call, 'grant issue', false, args, async () => {
      const { library } = call.ctx
      if (!GRANT_NAME.test(req.name)) return refused('bad-grant-name', `授权名只能用小写字母、数字和连字符，最长 41 个字符：${req.name}`)
      let area: Grant['area'] = null
      if (req.area !== null) {
        const parsed = parseLibraryPath(library.root, req.area)
        if (parsed === null || regionOf(parsed) !== 'content') return refused('bad-area', `区域要是库里的一个子文件夹：${req.area}`)
        area = parsed
      }
      const local = await readGrantFile(call.home, req.name)
      if (local && local.library !== library.root) return refused('grant-name-taken', `本机已有叫 ${req.name} 的授权，指向另一个库：${local.library}`)
      const existing = library.config.grants.find((g) => g.name === req.name)
      if (existing && (existing.agent !== req.agent || existing.area !== area || existing.readOnly !== req.readOnly)) {
        return refused('grant-exists', `这个库已有叫 ${req.name} 的授权，给的是 ${existing.agent}。先撤回再发。`)
      }
      // Issuing the same grant again keeps its id and rewrites the local copy.
      const grant: Grant = existing ?? { id: randomUUID() as GrantId, name: req.name, agent: req.agent, area, readOnly: req.readOnly }
      const updated = existing ? library : await saveConfig(library.root, { ...library.config, grants: [...library.config.grants, grant] }, call.table)
      const file = await writeGrantFile(call.home, { name: grant.name, library: library.root, grant: grant.id })
      return done(`已发授权 ${grant.name} 给 ${grant.agent}。本机副本：${file}`, { grant, file }, updated)
    })
  },

  revokeGrant(call: OwnerCall, name: string): Promise<OwnerResult> {
    return gated(call, 'grant revoke', false, { positional: [name], flags: {} }, async () => {
      const { library } = call.ctx
      const grant = library.config.grants.find((g) => g.name === name)
      if (!grant) return refused('no-such-grant', `这个库没有叫 ${name} 的授权`)
      const updated = await saveConfig(library.root, { ...library.config, grants: library.config.grants.filter((g) => g.id !== grant.id) }, call.table)
      const local = await readGrantFile(call.home, name)
      if (local?.library === library.root) await removeGrantFile(call.home, name)
      return done(`已撤回授权 ${name}。`, { grant }, updated)
    })
  },

  addPlugin(call: OwnerCall, name: string): Promise<OwnerResult> {
    return gated(call, 'plugin add', false, { positional: [name], flags: {} }, async () => {
      const { library } = call.ctx
      if (library.config.plugins.includes(name as PluginName)) return done(`插件 ${name} 已经装了。`)
      if (!call.table.has(name)) return refused('unknown-plugin', `没有这个插件：${name}。可用的：${[...call.table.keys()].join('、') || '无'}`)
      const updated = await saveConfig(library.root, { ...library.config, plugins: [...library.config.plugins, name as PluginName] }, call.table)
      return done(`已装上插件 ${name}，说明已重新生成。`, undefined, updated)
    })
  },

  /** Takes the plugin out of the configuration. Its directory stays as it is. */
  removePlugin(call: OwnerCall, name: string): Promise<OwnerResult> {
    return gated(call, 'plugin remove', false, { positional: [name], flags: {} }, async () => {
      const { library } = call.ctx
      if (!library.config.plugins.includes(name as PluginName)) return refused('not-installed', `这个库没装插件 ${name}`)
      const updated = await saveConfig(library.root, { ...library.config, plugins: library.config.plugins.filter((p) => p !== name) }, call.table)
      return done(`已卸下插件 ${name}，说明已重新生成。它名下的目录 .pneuma-base/${name}/ 原样留着。`, undefined, updated)
    })
  },

  /** Writes `<dir>/pneuma-base-<grant>/SKILL.md` for one agent product. */
  installSkill(call: OwnerCall, req: { grantName: string; agent: 'claude' | 'codex'; dir: string }): Promise<OwnerResult> {
    return gated(call, 'skill install', false, { positional: [req.grantName], flags: { agent: [req.agent], dir: [req.dir] } }, async () => {
      const { library } = call.ctx
      const grant = library.config.grants.find((g) => g.name === req.grantName)
      if (!grant) return refused('no-such-grant', `这个库没有叫 ${req.grantName} 的授权`)
      const folder = join(req.dir, `pneuma-base-${grant.name}`)
      const file = join(folder, 'SKILL.md')
      await writeAtomic(file, skillText(grant.name, library.root), folder)
      const text = `已为 ${req.agent} 写好技能：${file}`
      if (req.agent === 'claude') return done(text, { file })
      const hint = `Codex 在沙箱里运行，这个库要是它能写的目录之一，比如：codex --add-dir ${library.root}`
      return done(`${text}\n${hint}`, { file, hint })
    })
  },

  /** Deletes everything in `_archive/`. Destructive. The answer's data names the library paths it deleted. */
  purgeArchive(call: OwnerCall): Promise<OwnerResult> {
    return gated(call, 'archive purge', true, { positional: [], flags: {} }, async () => {
      const dir = join(call.ctx.library.root, ARCHIVE_DIR)
      const paths = (await exists(dir)) ? (await listFiles(dir, new Set())).map((p) => `${ARCHIVE_DIR}/${p}` as LibraryPath) : []
      await rm(dir, { recursive: true, force: true })
      return done(`已清空归档区，删掉了 ${paths.length} 个文件。`, { removed: paths.length, paths })
    })
  },

  /** Runs a command a plugin added to the owner face, through the same gate. */
  run(call: OwnerCall, plugin: Plugin, command: OwnerCommand, args: OwnerArgs): Promise<OwnerResult> {
    return gated(call, command.name, command.destructive, args, async () => ({ answer: await command.run(args, pluginContext(call.ctx, plugin.name)) }))
  },
}

