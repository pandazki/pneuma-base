// The kernel's own owner commands, as data shaped like a plugin's OwnerCommand. ARCHITECTURE.md「命令表」.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { agentCommands } from './agent-commands.js'
import { catchUp, caughtUpText } from './catch-up.js'
import { said, takenBy } from './claims.js'
import { skillText } from './cognition.js'
import { exists, writeAtomic } from './machine-files.js'
import { ensureLauncher, launcherInstall } from './launcher.js'
import { installDir, loadDir, machineDirOf, machinePlugins, machinePluginsDir, uninstallDir, whyNotLoaded } from './plugin-table.js'
import { storageOf } from './storage.js'
import { thingsUnder } from './things.js'
import { GRANT_NAME, readGrantFile, removeGrantFile, writeGrantFile } from './grants.js'
import { command, done, refused, type KernelCommand } from './kernel-command.js'
import { saveConfig } from './library.js'
import type { OwnerCall } from './owner.js'
import { ARCHIVE_DIR, parseLibraryPath, regionOf } from './paths.js'
import { eachPlugin, messageOf, pluginContext } from './pipeline.js'
import { codexHint } from './products.js'
import { IGNORE_COMMANDS } from './ignore-commands.js'
import { PAIR_COMMANDS } from './pair-commands.js'
import { REQUEST_COMMANDS } from './request-commands.js'
import { STORAGE_COMMANDS } from './storage-commands.js'
import { readSecret, removeSecret, SECRET_LIMIT, secretNames, secretsDir, writeSecret } from './secrets.js'
import {
  formOf,
  isDescribed,
  isFailure,
  SECRET_NAME,
  type Action,
  type Context,
  type Grant,
  type GrantId,
  type Library,
  type Plugin,
  type PluginContext,
  type PluginName,
  type PluginProblem,
  type PluginTable,
  type SecretDecl,
} from '@pneuma-base/sdk'

/** A directory as the person typed it: `~` is the home directory, a relative one is taken from the caller's working directory. */
const typedDir = (dir: string, cwd: string) => resolve(cwd, dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir)

const PLUGIN = { name: 'plugin', hint: '插件名称', required: true } as const
const DISABLE = { positional: [PLUGIN], flags: [{ name: 'force', hint: '强制停用', kind: 'boolean' }] } as const

export type { KernelCommand, Outcome } from './kernel-command.js'

const grantCreate = command({
  name: 'grant create',
  act: { kind: 'granted', object: 'name' },
  summary: '新建授权：授权对象、区域、只读或读写',
  params: {
    positional: [{ name: 'name', hint: '授权名称', required: true, pattern: GRANT_NAME.source }],
    flags: [
      { name: 'agent', hint: '授权对象', kind: 'value', required: true },
      { name: 'area', hint: '子文件夹', kind: 'value' },
      { name: 'read-only', hint: '只读', kind: 'boolean' },
    ],
  },
  destructive: false,
  ownerOnly: true,
  scope: 'library',
  async run({ name, agent, area: areaInput, 'read-only': readOnly }, call) {
    const { library } = call.ctx
    let area: Grant['area'] = null
    if (areaInput !== null) {
      const parsed = parseLibraryPath(library.root, areaInput)
      if (parsed === null || regionOf(parsed) !== 'content') return refused('bad-area', `区域必须是资料库中的子文件夹：${areaInput}`)
      area = parsed
    }
    const local = await readGrantFile(call.ctx.home, name)
    if (local && local.library !== library.root) return refused('grant-name-taken', `本机已有名为 ${name} 的授权，指向另一个资料库：${local.library}`)
    const existing = library.config.grants.find((g) => g.name === name)
    if (existing && (existing.agent !== agent || existing.area !== area || existing.readOnly !== readOnly)) {
      return refused('grant-exists', `此资料库已有名为 ${name} 的授权，授权对象为 ${existing.agent}。请先撤销再新建。`)
    }
    // Issuing the same grant again keeps its id and rewrites the local copy.
    const grant: Grant = existing ?? { id: randomUUID() as GrantId, name, agent, area, readOnly }
    const updated = existing ? library : await saveConfig(library.root, { ...library.config, grants: [...library.config.grants, grant] }, call.table)
    const file = await writeGrantFile(call.ctx.home, { name: grant.name, library: library.root, grant: grant.id })
    return done(`已新建授权 ${grant.name}，授权对象为 ${grant.agent}。本机副本：${file}`, { grant, file }, updated)
  },
})

const grantRevoke = command({
  name: 'grant revoke',
  act: { kind: 'revoked', object: 'name' },
  summary: '撤销授权',
  params: { positional: [{ name: 'name', hint: '授权名称', required: true }] },
  destructive: false,
  ownerOnly: true,
  scope: 'library',
  async run({ name }, call) {
    const { library } = call.ctx
    const grant = library.config.grants.find((g) => g.name === name)
    if (!grant) return refused('no-such-grant', `此资料库没有名为 ${name} 的授权`)
    const updated = await saveConfig(library.root, { ...library.config, grants: library.config.grants.filter((g) => g.id !== grant.id) }, call.table)
    const local = await readGrantFile(call.ctx.home, name)
    if (local?.library === library.root) await removeGrantFile(call.ctx.home, name)
    return done(`已撤销授权 ${name}。`, { grant }, updated)
  },
})

const skillInstall = command({
  name: 'skill install',
  act: { kind: 'installed', object: 'grant' },
  summary: '为 Agent 产品写入指向资料库说明的技能',
  params: {
    positional: [{ name: 'grant', hint: '授权名称', required: true }],
    flags: [
      { name: 'agent', hint: 'Agent 产品', kind: 'value' },
      { name: 'dir', hint: '技能目录', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: false,
  scope: 'library',
  /** Writes `<dir>/pneuma-base-<grant>/SKILL.md`. A relative `--dir` is taken from the caller's working directory; `~` is the home directory. */
  async run({ grant: grantName, agent: agentInput, dir }, call) {
    const { library } = call.ctx
    const grant = library.config.grants.find((g) => g.name === grantName)
    if (!grant) return refused('no-such-grant', `此资料库没有名为 ${grantName} 的授权`)
    const agent = agentInput ?? grant.agent
    const folder = join(typedDir(dir, call.ctx.session.cwd), `pneuma-base-${grant.name}`)
    const file = join(folder, 'SKILL.md')
    const { launcher } = await ensureLauncher(call.ctx.home, call.env)
    await writeAtomic(file, skillText(grant.name, library.root, launcher.path), folder)
    const text = `已为 ${agent} 写入技能：${file}`
    if (agent !== 'codex' && !agent.startsWith('codex-')) return done(text, { file })
    const hint = codexHint(library.root)
    return done(`${text}\n${hint}`, { file, hint })
  },
})

export const KERNEL_COMMANDS: readonly KernelCommand[] = [
  grantCreate,
  grantRevoke,
  command({
    name: 'plugin enable',
    act: { kind: 'on', object: 'plugin' },
    summary: '在此资料库中启用插件',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'library',
    async run({ plugin: name }, call) {
      const { library } = call.ctx
      if (library.config.plugins.includes(name as PluginName)) return done(`插件 ${name} 已启用。`)
      const plugin = call.table.get(name)
      if (!plugin) {
        const why = await whyNotLoaded(call.ctx.home, name)
        if (why !== null) return refused('plugin-failed-to-load', `插件 ${name} 加载失败：${why}`)
        return refused('unknown-plugin', `插件 ${name} 不存在。可用插件：${[...call.table.keys()].join('、') || '无'}`)
      }
      const taken = takenBy(plugin, library.plugins)
      if (taken.length > 0) {
        const holders = [...new Set(taken.map((t) => t.holder))].join('、')
        const what = taken.map((t) => `${said(t.claim)}已属于插件 ${t.holder}`).join('；')
        return refused('name-taken', `未启用插件 ${name}：${what}。一个名称只能属于一个插件；如需改用 ${name}，请先停用 ${holders}。`)
      }
      const updated = await saveConfig(library.root, { ...library.config, plugins: [...library.config.plugins, name as PluginName] }, call.table)
      const added = updated.plugins.find((p) => p.name === name)
      const ctx = { ...call.ctx, library: updated }
      const heard = await hear(added, (p, pctx) => p.onAdd?.(pctx), ctx)
      const problems = [...heard.problems, ...(heard.answer ? heard.answer.problems.map((message) => ({ plugin: name as PluginName, message })) : [])]
      // A library in use: the plugin catches up on what was registered before it, from the first page.
      const caught = await caughtUp(ctx, added, 'fresh')
      const text = [`已启用插件 ${name}，资料库说明已重新生成。`, ...(caught.text === null ? [] : [caught.text])].join('\n')
      return done(text, caught.data, updated, [...problems, ...caught.problems])
    },
  }),
  command({
    name: 'plugin disable',
    act: { kind: 'off', object: 'plugin' },
    summary: '在此资料库中停用插件；插件的数据目录保留不变',
    params: DISABLE,
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'library',
    /** Asks the plugin first; it may refuse, saying why. `--force` disables it all the same: the owner may always drop a plugin. */
    async run({ plugin: name, force }, call) {
      const { library } = call.ctx
      if (!library.config.plugins.includes(name as PluginName)) return refused('not-enabled', `此资料库未启用插件 ${name}`)
      const heard = await hear(library.plugins.find((p) => p.name === name), (p, pctx) => p.onRemove?.(pctx), call.ctx)
      const warning = heard.answer ? heard.answer.refuse : null
      if (warning !== null && !force) {
        const text = `插件 ${name} 未停用，插件提示：${warning}\n如需强制停用，运行 plugin disable ${name} --force。`
        const { call: forced } = formOf({ name: 'plugin disable', params: DISABLE }, { fixed: { plugin: name, force: true } })
        const offer: Action = { label: '仍然停用', tone: 'danger', confirm: `插件 ${name} 提示：${warning}\n仍然停用？`, inputs: [], call: forced }
        return { answer: { outcome: 'refused', reason: 'plugin-refused', text, offer }, problems: heard.problems }
      }
      const updated = await saveConfig(library.root, { ...library.config, plugins: library.config.plugins.filter((p) => p !== name) }, call.table)
      const text = `已停用插件 ${name}，资料库说明已重新生成。插件的数据目录 .pneuma-base/${name}/ 保留不变。${warning === null ? '' : `\n停用前的插件提示：${warning}`}`
      return done(text, undefined, updated, heard.problems)
    },
  }),
  command({
    name: 'plugin backfill',
    act: { kind: 'synced', object: 'plugin' },
    summary: '为插件补录启用前已登记的条目；中断后继续补录',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: false,
    scope: 'library',
    async run({ plugin: name }, call) {
      const plugin = call.ctx.library.plugins.find((p) => p.name === name)
      if (!plugin) return refused('not-enabled', `此资料库未启用插件 ${name}`)
      if (!plugin.catchUp) return refused('nothing-to-backfill', `插件 ${name} 不跟踪已登记的条目，无需补录。`)
      const caught = await caughtUp(call.ctx, plugin, 'resume')
      return done(caught.text ?? '', caught.data, undefined, caught.problems)
    },
  }),
  skillInstall,
  command({
    name: 'archive purge',
    act: { kind: 'removed', name: '归档' },
    summary: '清空归档',
    params: {},
    destructive: true,
    ownerOnly: true,
    scope: 'library',
    /** Deletes everything in `_archive/`, then tells each plugin's onPurged. The answer's data names the library paths it deleted. */
    async run(_values, call) {
      const store = storageOf(call.ctx.library.root)
      for (let tries = 0; ; tries++) {
        const [there] = await store.glance([ARCHIVE_DIR])
        if (there === undefined || !isDescribed(there) || there.kind !== 'dir') return done('暂无归档条目。', { removed: 0, paths: [] })
        const paths = (await thingsUnder(store, ARCHIVE_DIR)).map((t) => t.path)
        const removed = await store.remove(ARCHIVE_DIR, there.token ?? '')
        if (isFailure(removed)) {
          if (removed.reason === 'refused' && tries < 3) continue
          return refused('busy', `归档目录正在被修改，未清空：${removed.reason}`)
        }
        const heard = paths.length === 0 ? { problems: [] } : await eachPlugin(call.ctx, (plugin, pctx) => plugin.onPurged?.(paths, pctx))
        return done(`已清空归档，删除 ${paths.length} 个条目。`, { removed: paths.length, paths }, undefined, heard.problems)
      }
    },
  }),
  command({
    name: 'plugin install',
    act: { kind: 'installed', object: 'dir' },
    summary: '将插件目录安装到本机，替换同名插件',
    params: { positional: [{ name: 'dir', hint: '插件目录', required: true }] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    /** Loads the directory as the loader would, without touching the copy already installed, then copies it into place. */
    async run({ dir }, call) {
      const from = typedDir(dir, call.ctx.session.cwd)
      const loaded = await loadDir(from, null)
      if ('failed' in loaded) return refused('plugin-failed-to-load', `安装失败：${loaded.failed}`)
      const { name } = loaded
      const current = call.table.get(name)
      if (current && machineDirOf(current) === null) return refused('built-in-name', `安装失败：插件名称 ${name} 已被内置插件使用。请更换名称。`)
      const broken = !current && (await exists(join(machinePluginsDir(call.ctx.home), name)))
      await installDir(call.ctx.home, from, name)
      const replaced = current ? `，替换原有版本 ${current.version ?? '（未注明版本）'}` : broken ? '，替换原有的加载失败的插件' : ''
      const use = `在资料库中启用：pneuma-base plugin enable ${name} --library <资料库目录>。`
      return done(`已将插件 ${named(loaded)} 安装到本机${replaced}。${use}`, { name, version: loaded.version ?? null, replaced: current?.version ?? null, dir: join(machinePluginsDir(call.ctx.home), name) })
    },
  }),
  command({
    name: 'plugin uninstall',
    act: { kind: 'uninstalled', object: 'plugin' },
    summary: '从本机卸载已安装的插件；资料库中的插件数据目录和插件密钥保留不变',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    async run({ plugin: name }, call) {
      const current = call.table.get(name)
      if (current && machineDirOf(current) === null) return refused('built-in', `${name} 是内置插件，无法卸载。在资料库中停用：pneuma-base plugin disable ${name} --library <资料库目录>。`)
      if (!(await machinePlugins(call.ctx.home)).includes(name)) {
        const installed = (await machinePlugins(call.ctx.home)).join('、') || '无'
        return refused('not-on-machine', `本机未安装插件 ${name}。已安装：${installed}`)
      }
      const library = call.ctx.library
      if (library?.config.plugins.includes(name as PluginName)) {
        return refused('still-enabled', `资料库 ${library.root} 仍启用插件 ${name}。请先运行 pneuma-base plugin disable ${name} --library ${library.root}，再卸载。`)
      }
      await uninstallDir(call.ctx.home, name)
      return done(`已从本机卸载插件 ${current ? named(current) : name}。本机其他启用该插件的资料库将报告其不可用；插件在资料库中的数据目录和在本机的密钥保留不变。`, { name })
    },
  }),
  command({
    name: 'plugin list',
    summary: '本机可用的插件：内置和已安装的插件，及其版本、契约、名称和说明；带 --library 时标出此资料库已启用的插件',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    scope: 'machine',
    async run(_values, call) {
      const plugins = await machineListing(call.ctx.home, call.table, call.ctx.library)
      const lines = plugins.map((p) => {
        const state = p.failed !== null ? `加载失败：${p.failed}` : [`契约 ${p.contract}`, p.origin === 'built-in' ? '内置' : '已安装', ...(p.enabled ? ['已启用'] : [])].join(' · ')
        const line = p.title === null ? p.summary : `${p.title}${p.summary === null ? '' : `：${p.summary}`}`
        return [`${p.name} ${p.version ?? '—'}  ${state}`, ...[line, p.about].flatMap((l) => (l === null ? [] : [`    ${l}`]))].join('\n')
      })
      return done(lines.join('\n') || '本机暂无插件。', { plugins })
    },
  }),
  command({
    name: 'secret set',
    act: { kind: 'set', object: 'name' },
    summary: '在本机为插件设置密钥；值从标准输入读取，或在终端中以不回显方式输入',
    params: { positional: [PLUGIN, { name: 'name', hint: '密钥名称', required: true, pattern: SECRET_NAME.source }] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    // The value is the owner's own to give, in person.
    askable: false,
    scope: 'machine',
    async run({ plugin, name }, call) {
      const declared = await declaredSecrets(call, plugin)
      if (typeof declared === 'string') return refused('unknown-plugin', declared)
      if (!declared.some((s) => s.name === name)) {
        const which = declared.length === 0 ? '该插件不使用密钥' : `该插件使用的密钥：${declared.map((s) => s.name).join('、')}`
        return refused('undeclared-secret', `插件 ${plugin} 未声明名为 ${name} 的密钥；${which}。`)
      }
      const value = (await call.readSecret?.(`插件 ${plugin} 的密钥 ${name}（输入时不显示）：`)) ?? null
      if (value === null || value === '') return refused('no-value', '未读取到值，未做任何修改。从标准输入提供，例如 printf %s "$TOKEN" | pneuma-base secret set …；或在终端中按提示输入。')
      if (Buffer.byteLength(value) > SECRET_LIMIT) return refused('too-long', `密钥最长 ${SECRET_LIMIT / 1024} KB，未做任何修改。`)
      const had = (await readSecret(call.ctx.home, plugin, name)) !== null
      await writeSecret(call.ctx.home, plugin, name, value)
      const where = secretsDir(call.ctx.home, plugin)
      return done(`已${had ? '更换' : '设置'}插件 ${plugin} 的密钥 ${name}。密钥仅保存在本机（${where}），不写入任何资料库，也不会同步。`, { plugin, name, replaced: had })
    },
  }),
  command({
    name: 'secret list',
    summary: '列出插件在本机已设置的密钥，仅列名称',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: true,
    readOnly: true,
    scope: 'machine',
    async run({ plugin }, call) {
      const set = await secretNames(call.ctx.home, plugin)
      const known = await declaredSecrets(call, plugin)
      const declared = (typeof known === 'string' ? [] : known).map((s) => ({ ...s, set: set.includes(s.name) }))
      const unset = (optional: boolean) => declared.filter((s) => !s.set && (s.optional === true) === optional).map((s) => s.name)
      const lines = [set.length === 0 ? `插件 ${plugin} 在本机未设置密钥。` : `插件 ${plugin} 已设置的密钥：${set.join('、')}`]
      if (unset(false).length > 0) lines.push(`必需、未设置：${unset(false).join('、')}`)
      if (unset(true).length > 0) lines.push(`可选、未设置：${unset(true).join('、')}`)
      return done(lines.join('\n'), { plugin, set, declared })
    },
  }),
  command({
    name: 'secret remove',
    act: { kind: 'removed', object: 'name' },
    summary: '删除插件在本机的密钥',
    params: { positional: [PLUGIN, { name: 'name', hint: '密钥名称', required: true, pattern: SECRET_NAME.source }] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    async run({ plugin, name }, call) {
      const had = await removeSecret(call.ctx.home, plugin, name)
      return done(had ? `已删除插件 ${plugin} 的密钥 ${name}。` : `插件 ${plugin} 在本机未设置密钥 ${name}。`, { plugin, name, removed: had })
    },
  }),
  ...agentCommands({ grantCreate, grantRevoke, skillInstall }),
  launcherInstall,
  ...REQUEST_COMMANDS,
  ...PAIR_COMMANDS,
  ...IGNORE_COMMANDS,
  ...STORAGE_COMMANDS,
]

/** A plugin by name and version, as `pager 0.2.0`. */
const named = (p: Plugin) => (p.version === undefined ? `${p.name}（未注明版本）` : `${p.name} ${p.version}`)

/** The secrets a plugin of this machine declares; or, when this machine has no such plugin, why. */
async function declaredSecrets(call: OwnerCall, plugin: string): Promise<readonly SecretDecl[] | string> {
  const p = call.table.get(plugin)
  if (p) return p.secrets ?? []
  const why = await whyNotLoaded(call.ctx.home, plugin)
  return why === null ? `插件 ${plugin} 不存在。可用插件：${[...call.table.keys()].join('、') || '无'}` : `插件 ${plugin} 加载失败：${why}`
}

export type MachinePlugin = {
  name: string
  version: string | null
  contract: number | null
  /** The name a person says, its short line (else its cognition's title) and its whole text. */
  title: string | null
  summary: string | null
  about: string | null
  origin: 'built-in' | 'machine'
  /** Whether the library given has it enabled; null when none was given. */
  enabled: boolean | null
  /** Why a plugin in this machine's plugin directory did not load; null when it did. */
  failed: string | null
}

/** Every plugin this machine can install, built-in and installed, by name, with one that failed to load and why. */
async function machineListing(home: string, table: PluginTable, library: Library | null): Promise<MachinePlugin[]> {
  const names = [...new Set([...table.keys(), ...(await machinePlugins(home))])].sort()
  const out: MachinePlugin[] = []
  for (const name of names) {
    const p = table.get(name)
    const enabled = library === null ? null : library.config.plugins.includes(name as PluginName)
    if (!p) {
      out.push({ name, version: null, contract: null, title: null, summary: null, about: null, origin: 'machine', enabled, failed: (await whyNotLoaded(home, name)) ?? '加载失败' })
      continue
    }
    const summary = p.summary ?? p.cognition?.title ?? null
    out.push({ name, version: p.version ?? null, contract: p.contract, title: p.title ?? null, summary, about: p.about ?? null, origin: machineDirOf(p) === null ? 'built-in' : 'machine', enabled, failed: null })
  }
  return out
}

/** One plugin's lifecycle hook, if it is installed here and has it: what it answered, or the problem it threw (K8). */
/** A plugin's catching up as a command answers it: one line, the counts, and the plugin's problem when its hook threw. */
async function caughtUp(ctx: Context, plugin: Plugin | undefined, how: 'fresh' | 'resume'): Promise<{ text: string | null; data?: unknown; problems: PluginProblem[] }> {
  if (!plugin) return { text: null, problems: [] }
  try {
    const r = await catchUp(ctx, plugin, how)
    if (r === null || (how === 'fresh' && r.nothing)) return { text: null, problems: [] }
    return { text: caughtUpText(plugin.name, r, r.keeper), data: { catchUp: { done: r.done, total: r.total, finished: r.finished } }, problems: [] }
  } catch (error) {
    return { text: `${plugin.name} 补录启用前已登记的条目时出错；继续补录：pneuma-base plugin backfill ${plugin.name}`, problems: [{ plugin: plugin.name, message: messageOf(error) }] }
  }
}

async function hear<T>(plugin: Plugin | undefined, call: (p: Plugin, pctx: PluginContext) => Promise<T> | undefined, ctx: Context): Promise<{ answer: T | undefined; problems: PluginProblem[] }> {
  if (!plugin) return { answer: undefined, problems: [] }
  try {
    return { answer: await call(plugin, pluginContext(ctx, plugin.name)), problems: [] }
  } catch (error) {
    return { answer: undefined, problems: [{ plugin: plugin.name, message: messageOf(error) }] }
  }
}
