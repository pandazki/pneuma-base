// The kernel's own owner commands, as data shaped like a plugin's OwnerCommand. ARCHITECTURE.md section 6.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { agentCommands } from './agent-commands.js'
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
import { NOISE_COMMANDS } from './noise-commands.js'
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

const PLUGIN = { name: 'plugin', hint: '插件名', required: true } as const
const REMOVE = { positional: [PLUGIN], flags: [{ name: 'anyway', hint: '插件不肯也卸', kind: 'boolean' }] } as const

export type { KernelCommand, Outcome } from './kernel-command.js'

const grantIssue = command({
  name: 'grant issue',
  summary: '发一份授权：给谁、哪个区域、只读还是读写',
  params: {
    positional: [{ name: 'name', hint: '授权名', required: true, pattern: GRANT_NAME.source }],
    flags: [
      { name: 'agent', hint: '给谁', kind: 'value', required: true },
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
      if (parsed === null || regionOf(parsed) !== 'content') return refused('bad-area', `区域要是库里的一个子文件夹：${areaInput}`)
      area = parsed
    }
    const local = await readGrantFile(call.ctx.home, name)
    if (local && local.library !== library.root) return refused('grant-name-taken', `本机已有叫 ${name} 的授权，指向另一个库：${local.library}`)
    const existing = library.config.grants.find((g) => g.name === name)
    if (existing && (existing.agent !== agent || existing.area !== area || existing.readOnly !== readOnly)) {
      return refused('grant-exists', `这个库已有叫 ${name} 的授权，给的是 ${existing.agent}。先撤回再发。`)
    }
    // Issuing the same grant again keeps its id and rewrites the local copy.
    const grant: Grant = existing ?? { id: randomUUID() as GrantId, name, agent, area, readOnly }
    const updated = existing ? library : await saveConfig(library.root, { ...library.config, grants: [...library.config.grants, grant] }, call.table)
    const file = await writeGrantFile(call.ctx.home, { name: grant.name, library: library.root, grant: grant.id })
    return done(`已发授权 ${grant.name} 给 ${grant.agent}。本机副本：${file}`, { grant, file }, updated)
  },
})

const grantRevoke = command({
  name: 'grant revoke',
  summary: '撤回一份授权',
  params: { positional: [{ name: 'name', hint: '授权名', required: true }] },
  destructive: false,
  ownerOnly: true,
  scope: 'library',
  async run({ name }, call) {
    const { library } = call.ctx
    const grant = library.config.grants.find((g) => g.name === name)
    if (!grant) return refused('no-such-grant', `这个库没有叫 ${name} 的授权`)
    const updated = await saveConfig(library.root, { ...library.config, grants: library.config.grants.filter((g) => g.id !== grant.id) }, call.table)
    const local = await readGrantFile(call.ctx.home, name)
    if (local?.library === library.root) await removeGrantFile(call.ctx.home, name)
    return done(`已撤回授权 ${name}。`, { grant }, updated)
  },
})

const skillInstall = command({
  name: 'skill install',
  summary: '为一个 agent 产品写一份指向说明的技能',
  params: {
    positional: [{ name: 'grant', hint: '授权名', required: true }],
    flags: [
      { name: 'agent', hint: '给谁', kind: 'value' },
      { name: 'dir', hint: '放技能的目录', kind: 'value', required: true },
    ],
  },
  destructive: false,
  ownerOnly: false,
  scope: 'library',
  /** Writes `<dir>/pneuma-base-<grant>/SKILL.md`. A relative `--dir` is taken from the caller's working directory; `~` is the home directory. */
  async run({ grant: grantName, agent: agentInput, dir }, call) {
    const { library } = call.ctx
    const grant = library.config.grants.find((g) => g.name === grantName)
    if (!grant) return refused('no-such-grant', `这个库没有叫 ${grantName} 的授权`)
    const agent = agentInput ?? grant.agent
    const folder = join(typedDir(dir, call.ctx.session.cwd), `pneuma-base-${grant.name}`)
    const file = join(folder, 'SKILL.md')
    const { launcher } = await ensureLauncher(call.ctx.home, call.env)
    await writeAtomic(file, skillText(grant.name, library.root, launcher.path), folder)
    const text = `已为 ${agent} 写好技能：${file}`
    if (agent !== 'codex' && !agent.startsWith('codex-')) return done(text, { file })
    const hint = codexHint(library.root)
    return done(`${text}\n${hint}`, { file, hint })
  },
})

export const KERNEL_COMMANDS: readonly KernelCommand[] = [
  grantIssue,
  grantRevoke,
  command({
    name: 'plugin add',
    summary: '在这个库里装上一个插件',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'library',
    async run({ plugin: name }, call) {
      const { library } = call.ctx
      if (library.config.plugins.includes(name as PluginName)) return done(`插件 ${name} 已经装了。`)
      const plugin = call.table.get(name)
      if (!plugin) {
        const why = await whyNotLoaded(call.ctx.home, name)
        if (why !== null) return refused('plugin-failed-to-load', `插件 ${name} 没能加载：${why}`)
        return refused('unknown-plugin', `没有这个插件：${name}。可用的：${[...call.table.keys()].join('、') || '无'}`)
      }
      const taken = takenBy(plugin, library.plugins)
      if (taken.length > 0) {
        const holders = [...new Set(taken.map((t) => t.holder))].join('、')
        const what = taken.map((t) => `${said(t.claim)}已归插件 ${t.holder}`).join('；')
        return refused('name-taken', `没有装上插件 ${name}：${what}。一个名字只归一个插件；要换用 ${name}，先卸下 ${holders}。`)
      }
      const updated = await saveConfig(library.root, { ...library.config, plugins: [...library.config.plugins, name as PluginName] }, call.table)
      const added = updated.plugins.find((p) => p.name === name)
      const heard = await hear(added, (p, pctx) => p.onAdd?.(pctx), { ...call.ctx, library: updated })
      const problems = [...heard.problems, ...(heard.answer ? heard.answer.problems.map((message) => ({ plugin: name as PluginName, message })) : [])]
      return done(`已装上插件 ${name}，说明已重新生成。`, undefined, updated, problems)
    },
  }),
  command({
    name: 'plugin remove',
    summary: '在这个库里卸下一个插件；它名下的目录原样留着',
    params: REMOVE,
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'library',
    /** Asks the plugin first; it may refuse, saying why. `--anyway` removes it all the same: the owner may always drop a plugin. */
    async run({ plugin: name, anyway }, call) {
      const { library } = call.ctx
      if (!library.config.plugins.includes(name as PluginName)) return refused('not-installed', `这个库没装插件 ${name}`)
      const heard = await hear(library.plugins.find((p) => p.name === name), (p, pctx) => p.onRemove?.(pctx), call.ctx)
      const warning = heard.answer ? heard.answer.refuse : null
      if (warning !== null && !anyway) {
        const text = `插件 ${name} 没有卸下，它说：${warning}\n照样要卸，用 plugin remove ${name} --anyway。`
        const { call: removeAnyway } = formOf({ name: 'plugin remove', params: REMOVE }, { fixed: { plugin: name, anyway: true } })
        const offer: Action = { label: '仍然卸下', tone: 'danger', confirm: `插件 ${name} 说：${warning}\n仍然卸下吗？`, inputs: [], call: removeAnyway }
        return { answer: { outcome: 'refused', reason: 'plugin-refused', text, offer }, problems: heard.problems }
      }
      const updated = await saveConfig(library.root, { ...library.config, plugins: library.config.plugins.filter((p) => p !== name) }, call.table)
      const text = `已卸下插件 ${name}，说明已重新生成。它名下的目录 .pneuma-base/${name}/ 原样留着。${warning === null ? '' : `\n它卸下前提醒过：${warning}`}`
      return done(text, undefined, updated, heard.problems)
    },
  }),
  skillInstall,
  command({
    name: 'archive purge',
    summary: '清空归档区',
    params: {},
    destructive: true,
    ownerOnly: true,
    scope: 'library',
    /** Deletes everything in `_archive/`, then tells each plugin's onPurged. The answer's data names the library paths it deleted. */
    async run(_values, call) {
      const store = storageOf(call.ctx.library.root)
      for (let tries = 0; ; tries++) {
        const [there] = await store.glance([ARCHIVE_DIR])
        if (there === undefined || !isDescribed(there) || there.kind !== 'dir') return done('归档区是空的。', { removed: 0, paths: [] })
        const paths = (await thingsUnder(store, ARCHIVE_DIR)).map((t) => t.path)
        const removed = await store.remove(ARCHIVE_DIR, there.token ?? '')
        if (isFailure(removed)) {
          if (removed.reason === 'refused' && tries < 3) continue
          return refused('busy', `归档区正在被改动，没有清空：${removed.reason}`)
        }
        const heard = paths.length === 0 ? { problems: [] } : await eachPlugin(call.ctx, (plugin, pctx) => plugin.onPurged?.(paths, pctx))
        return done(`已清空归档区，删掉了 ${paths.length} 样东西。`, { removed: paths.length, paths }, undefined, heard.problems)
      }
    },
  }),
  command({
    name: 'plugin install',
    summary: '把一个插件目录装到这台机器上，同名的换成新的',
    params: { positional: [{ name: 'dir', hint: '插件目录', required: true }] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    /** Loads the directory as the loader would, without touching the copy already installed, then copies it into place. */
    async run({ dir }, call) {
      const from = typedDir(dir, call.ctx.session.cwd)
      const loaded = await loadDir(from, null)
      if ('failed' in loaded) return refused('plugin-failed-to-load', `没有装：${loaded.failed}`)
      const { name } = loaded
      const current = call.table.get(name)
      if (current && machineDirOf(current) === null) return refused('built-in-name', `没有装：插件名 ${name} 是自带插件的。给它换一个名字。`)
      const broken = !current && (await exists(join(machinePluginsDir(call.ctx.home), name)))
      await installDir(call.ctx.home, from, name)
      const replaced = current ? `，换掉了原来的 ${current.version ?? '（没写版本）'}` : broken ? '，换掉了原来那份没能加载的' : ''
      const use = `要在一个库里用它：pneuma-base plugin add ${name} --library <库的目录>。`
      return done(`已把插件 ${named(loaded)} 装到这台机器上${replaced}。${use}`, { name, version: loaded.version ?? null, replaced: current?.version ?? null, dir: join(machinePluginsDir(call.ctx.home), name) })
    },
  }),
  command({
    name: 'plugin uninstall',
    summary: '从这台机器卸掉一个装上来的插件；库里名下的目录和它的密钥原样留着',
    params: { positional: [PLUGIN] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    async run({ plugin: name }, call) {
      const current = call.table.get(name)
      if (current && machineDirOf(current) === null) return refused('built-in', `${name} 是自带的插件，卸不掉。不想在一个库里用它：pneuma-base plugin remove ${name} --library <库的目录>。`)
      if (!(await machinePlugins(call.ctx.home)).includes(name)) {
        const installed = (await machinePlugins(call.ctx.home)).join('、') || '无'
        return refused('not-on-machine', `这台机器没装插件 ${name}。装上来的：${installed}`)
      }
      const library = call.ctx.library
      if (library?.config.plugins.includes(name as PluginName)) {
        return refused('still-installed', `库 ${library.root} 还装着插件 ${name}。先 pneuma-base plugin remove ${name} --library ${library.root}，再卸。`)
      }
      await uninstallDir(call.ctx.home, name)
      return done(`已从这台机器卸掉插件 ${current ? named(current) : name}。这台机器上别的库装着它的，会报它不可用；它在库里名下的目录和它在这台机器上的密钥都原样留着。`, { name })
    },
  }),
  command({
    name: 'plugin list',
    summary: '这台机器能装的插件：自带的和装上来的，各自的版本、契约和一句说明；带 --library 时标出这个库装了哪些',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    scope: 'machine',
    async run(_values, call) {
      const plugins = await machineListing(call.ctx.home, call.table, call.ctx.library)
      const lines = plugins.map((p) => {
        const state = p.failed !== null ? `没能加载：${p.failed}` : [`契约 ${p.contract}`, p.origin === 'built-in' ? '自带' : '装上来的', ...(p.installed ? ['这个库装了'] : [])].join(' · ')
        return `${p.name} ${p.version ?? '—'}  ${state}${p.summary === null ? '' : `\n    ${p.summary}`}`
      })
      return done(lines.join('\n') || '这台机器没有任何插件。', { plugins })
    },
  }),
  command({
    name: 'secret set',
    summary: '为一个插件在这台机器上设一个密钥；值从标准输入读，或在终端里不回显地输入',
    params: { positional: [PLUGIN, { name: 'name', hint: '密钥名', required: true, pattern: SECRET_NAME.source }] },
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
        const which = declared.length === 0 ? '它不用密钥' : `它用的：${declared.map((s) => s.name).join('、')}`
        return refused('undeclared-secret', `插件 ${plugin} 没有声明叫 ${name} 的密钥；${which}。`)
      }
      const value = (await call.readSecret?.(`插件 ${plugin} 的密钥 ${name}（输入时不显示）：`)) ?? null
      if (value === null || value === '') return refused('no-value', '没有读到值，什么都没改。从标准输入给，比如 printf %s "$TOKEN" | pneuma-base secret set …；或在终端里按提示输入。')
      if (Buffer.byteLength(value) > SECRET_LIMIT) return refused('too-long', `密钥最长 ${SECRET_LIMIT / 1024} KB，什么都没改。`)
      const had = (await readSecret(call.ctx.home, plugin, name)) !== null
      await writeSecret(call.ctx.home, plugin, name, value)
      const where = secretsDir(call.ctx.home, plugin)
      return done(`已${had ? '换掉' : '设好'}插件 ${plugin} 的密钥 ${name}。它只在这台机器上（${where}），不进任何库，也不会同步。`, { plugin, name, replaced: had })
    },
  }),
  command({
    name: 'secret list',
    summary: '一个插件在这台机器上设了哪些密钥，只列名字',
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
      const lines = [set.length === 0 ? `插件 ${plugin} 在这台机器上没设密钥。` : `插件 ${plugin} 设了的密钥：${set.join('、')}`]
      if (unset(false).length > 0) lines.push(`它用、还没设的：${unset(false).join('、')}`)
      if (unset(true).length > 0) lines.push(`可以不设、还没设的：${unset(true).join('、')}`)
      return done(lines.join('\n'), { plugin, set, declared })
    },
  }),
  command({
    name: 'secret remove',
    summary: '删掉一个插件在这台机器上的一个密钥',
    params: { positional: [PLUGIN, { name: 'name', hint: '密钥名', required: true, pattern: SECRET_NAME.source }] },
    destructive: false,
    ownerOnly: true,
    setup: true,
    scope: 'machine',
    async run({ plugin, name }, call) {
      const had = await removeSecret(call.ctx.home, plugin, name)
      return done(had ? `已删掉插件 ${plugin} 的密钥 ${name}。` : `插件 ${plugin} 在这台机器上本来就没设密钥 ${name}。`, { plugin, name, removed: had })
    },
  }),
  ...agentCommands({ grantIssue, grantRevoke, skillInstall }),
  launcherInstall,
  ...REQUEST_COMMANDS,
  ...PAIR_COMMANDS,
  ...NOISE_COMMANDS,
  ...STORAGE_COMMANDS,
]

/** A plugin by name and version, as `pager 0.2.0`. */
const named = (p: Plugin) => (p.version === undefined ? `${p.name}（没写版本）` : `${p.name} ${p.version}`)

/** The secrets a plugin of this machine declares; or, when this machine has no such plugin, why. */
async function declaredSecrets(call: OwnerCall, plugin: string): Promise<readonly SecretDecl[] | string> {
  const p = call.table.get(plugin)
  if (p) return p.secrets ?? []
  const why = await whyNotLoaded(call.ctx.home, plugin)
  return why === null ? `没有这个插件：${plugin}。可用的：${[...call.table.keys()].join('、') || '无'}` : `插件 ${plugin} 没能加载：${why}`
}

export type MachinePlugin = {
  name: string
  version: string | null
  contract: number | null
  summary: string | null
  origin: 'built-in' | 'machine'
  /** Whether the library given has it installed; null when none was given. */
  installed: boolean | null
  /** Why a plugin in this machine's plugin directory did not load; null when it did. */
  failed: string | null
}

/** Every plugin this machine can install, built-in and installed, by name, with one that failed to load and why. */
async function machineListing(home: string, table: PluginTable, library: Library | null): Promise<MachinePlugin[]> {
  const names = [...new Set([...table.keys(), ...(await machinePlugins(home))])].sort()
  const out: MachinePlugin[] = []
  for (const name of names) {
    const p = table.get(name)
    const installed = library === null ? null : library.config.plugins.includes(name as PluginName)
    if (!p) {
      out.push({ name, version: null, contract: null, summary: null, origin: 'machine', installed, failed: (await whyNotLoaded(home, name)) ?? '没能加载' })
      continue
    }
    const summary = p.summary ?? p.cognition?.title ?? null
    out.push({ name, version: p.version ?? null, contract: p.contract, summary, origin: machineDirOf(p) === null ? 'built-in' : 'machine', installed, failed: null })
  }
  return out
}

/** One plugin's lifecycle hook, if it is installed here and has it: what it answered, or the problem it threw (K8). */
async function hear<T>(plugin: Plugin | undefined, call: (p: Plugin, pctx: PluginContext) => Promise<T> | undefined, ctx: Context): Promise<{ answer: T | undefined; problems: PluginProblem[] }> {
  if (!plugin) return { answer: undefined, problems: [] }
  try {
    return { answer: await call(plugin, pluginContext(ctx, plugin.name)), problems: [] }
  } catch (error) {
    return { answer: undefined, problems: [{ plugin: plugin.name, message: messageOf(error) }] }
  }
}
