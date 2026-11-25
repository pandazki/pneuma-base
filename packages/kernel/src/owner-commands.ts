// The kernel's own owner commands, as data shaped like a plugin's OwnerCommand. ARCHITECTURE.md section 6.
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { skillText } from './cognition.js'
import { exists, writeAtomic } from './files.js'
import { whyNotLoaded } from './plugin-table.js'
import { listThings } from './things.js'
import { GRANT_NAME, readGrantFile, removeGrantFile, writeGrantFile } from './grants.js'
import { saveConfig } from './library.js'
import type { OwnerCall } from './owner.js'
import { ARCHIVE_DIR, parseLibraryPath, regionOf } from './paths.js'
import type { Grant, GrantId, Library, LibraryPath, OwnerAnswer, OwnerArgs, PluginName } from '@pneuma-base/sdk'

export type Outcome = { answer: OwnerAnswer; library?: Library }

/** Like a plugin's OwnerCommand, but it runs with the whole owner call and may hand back the reopened library. */
export type KernelCommand = {
  readonly name: string
  readonly summary: string
  readonly usage?: string
  readonly destructive: boolean
  readonly ownerOnly: boolean
  readonly setup?: boolean
  run(args: OwnerArgs, call: OwnerCall): Promise<Outcome>
}

const refused = (reason: string, text: string): Outcome => ({ answer: { outcome: 'refused', reason, text } })
const done = (text: string, data?: unknown, library?: Library): Outcome => ({
  answer: { outcome: 'done', text, ...(data === undefined ? {} : { data }) },
  ...(library ? { library } : {}),
})

type Read = { positional: string[]; value(flag: string): string | null }

/**
 * A command's arguments, or the usage text that says what is wrong with them. A flag given with an
 * empty value counts as not given, so a form's empty optional field means the same as leaving it out.
 */
function read(command: string, args: OwnerArgs, arity: number, flags: readonly string[]): Read | string {
  if (args.positional.length !== arity) return `${command} 的参数个数不对`
  for (const flag of Object.keys(args.flags)) if (!flags.includes(flag)) return `${command} 不认识 --${flag}`
  const value = (flag: string) => {
    const v = args.flags[flag]
    return Array.isArray(v) && v[0] !== undefined && v[0] !== '' ? v[0] : null
  }
  return { positional: args.positional, value }
}

/** A refusal whose reason is `usage`: the call itself was malformed. The command line shows it as a usage error. */
const usage = (text: string) => refused('usage', text)

export const KERNEL_COMMANDS: readonly KernelCommand[] = [
  {
    name: 'grant issue',
    summary: '发一份授权：给谁、哪个区域、只读还是读写',
    usage: '<授权名> --agent <给谁> [--area <子文件夹>] [--read-only]',
    destructive: false,
    ownerOnly: true,
    async run(args, call) {
      const a = read('grant issue', args, 1, ['agent', 'area', 'read-only'])
      if (typeof a === 'string') return usage(a)
      const name = a.positional[0] as string
      const agent = a.value('agent')
      if (agent === null) return usage('要写 --agent <给谁>，比如 --agent claude-code。')
      // `--read-only` on the command line; a form sends it with the value yes or no.
      const flag = args.flags['read-only']
      const readOnly = flag === true || (Array.isArray(flag) && flag[0] === 'yes')
      const { library } = call.ctx
      if (!GRANT_NAME.test(name)) return refused('bad-grant-name', `授权名只能用小写字母、数字和连字符，最长 41 个字符：${name}`)
      let area: Grant['area'] = null
      const areaInput = a.value('area')
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
  },
  {
    name: 'grant revoke',
    summary: '撤回一份授权',
    usage: '<授权名>',
    destructive: false,
    ownerOnly: true,
    async run(args, call) {
      const a = read('grant revoke', args, 1, [])
      if (typeof a === 'string') return usage(a)
      const name = a.positional[0] as string
      const { library } = call.ctx
      const grant = library.config.grants.find((g) => g.name === name)
      if (!grant) return refused('no-such-grant', `这个库没有叫 ${name} 的授权`)
      const updated = await saveConfig(library.root, { ...library.config, grants: library.config.grants.filter((g) => g.id !== grant.id) }, call.table)
      const local = await readGrantFile(call.ctx.home, name)
      if (local?.library === library.root) await removeGrantFile(call.ctx.home, name)
      return done(`已撤回授权 ${name}。`, { grant }, updated)
    },
  },
  {
    name: 'plugin add',
    summary: '装上一个插件',
    usage: '<插件名>',
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run(args, call) {
      const a = read('plugin add', args, 1, [])
      if (typeof a === 'string') return usage(a)
      const name = a.positional[0] as string
      const { library } = call.ctx
      if (library.config.plugins.includes(name as PluginName)) return done(`插件 ${name} 已经装了。`)
      if (!call.table.has(name)) {
        const why = await whyNotLoaded(call.ctx.home, name)
        if (why !== null) return refused('plugin-failed-to-load', `插件 ${name} 没能加载：${why}`)
        return refused('unknown-plugin', `没有这个插件：${name}。可用的：${[...call.table.keys()].join('、') || '无'}`)
      }
      const updated = await saveConfig(library.root, { ...library.config, plugins: [...library.config.plugins, name as PluginName] }, call.table)
      return done(`已装上插件 ${name}，说明已重新生成。`, undefined, updated)
    },
  },
  {
    name: 'plugin remove',
    summary: '卸下一个插件；它名下的目录原样留着',
    usage: '<插件名>',
    destructive: false,
    ownerOnly: true,
    setup: true,
    async run(args, call) {
      const a = read('plugin remove', args, 1, [])
      if (typeof a === 'string') return usage(a)
      const name = a.positional[0] as string
      const { library } = call.ctx
      if (!library.config.plugins.includes(name as PluginName)) return refused('not-installed', `这个库没装插件 ${name}`)
      const updated = await saveConfig(library.root, { ...library.config, plugins: library.config.plugins.filter((p) => p !== name) }, call.table)
      return done(`已卸下插件 ${name}，说明已重新生成。它名下的目录 .pneuma-base/${name}/ 原样留着。`, undefined, updated)
    },
  },
  {
    name: 'skill install',
    summary: '为一个 agent 产品写一份指向说明的技能',
    usage: '<授权名> [--agent <给谁>] --dir <目录>',
    destructive: false,
    ownerOnly: false,
    /** Writes `<dir>/pneuma-base-<grant>/SKILL.md`. A relative `--dir` is taken from the caller's working directory; `~` is the home directory. */
    async run(args, call) {
      const a = read('skill install', args, 1, ['agent', 'dir'])
      if (typeof a === 'string') return usage(a)
      const grantName = a.positional[0] as string
      const dir = a.value('dir')
      if (dir === null) return usage('要写 --dir <放技能的目录>。')
      const { library } = call.ctx
      const grant = library.config.grants.find((g) => g.name === grantName)
      if (!grant) return refused('no-such-grant', `这个库没有叫 ${grantName} 的授权`)
      const agent = (a.value('agent') ?? grant.agent).trim()
      if (agent === '') return usage('要写 --agent <给谁>。')
      const typed = dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir
      const folder = join(resolve(call.ctx.session.cwd, typed), `pneuma-base-${grant.name}`)
      const file = join(folder, 'SKILL.md')
      await writeAtomic(file, skillText(grant.name, library.root), folder)
      const text = `已为 ${agent} 写好技能：${file}`
      if (agent !== 'codex' && !agent.startsWith('codex-')) return done(text, { file })
      const hint = codexHint(library.root)
      return done(`${text}\n${hint}`, { file, hint })
    },
  },
  {
    name: 'archive purge',
    summary: '清空归档区',
    destructive: true,
    ownerOnly: true,
    /** Deletes everything in `_archive/`. The answer's data names the library paths it deleted. */
    async run(args, call) {
      const a = read('archive purge', args, 0, [])
      if (typeof a === 'string') return usage(a)
      const dir = join(call.ctx.library.root, ARCHIVE_DIR)
      const paths = (await exists(dir)) ? (await listThings(dir, new Set())).map((t) => `${ARCHIVE_DIR}/${t.path}` as LibraryPath) : []
      await rm(dir, { recursive: true, force: true })
      return done(`已清空归档区，删掉了 ${paths.length} 样东西。`, { removed: paths.length, paths })
    },
  },
]

/** What Codex needs before it can write the library from its sandbox. */
export function codexHint(root: string): string {
  return `Codex 在沙箱里运行，这个库要是它能写的目录之一，比如：codex --add-dir ${root}`
}
