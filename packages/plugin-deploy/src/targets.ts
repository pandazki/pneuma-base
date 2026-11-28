// The built-in deploy plugin's two kinds of target: a local folder, and the owner's own pair of
// commands. Everything else a deploy plugin does is the kit's. Neither reads the library: the folder
// target writes only its directory outside it, and the commands run in the copy of the content the
// kit staged (or in an empty directory to take a site down).
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Instant, LibraryPath, PluginContext } from '@pneuma-base/sdk'
import { defineTarget, type Configured, type ContentId, type SiteName, type Target, type TargetAdapter, type TargetEnv } from '@pneuma-base/sdk/kit'

export const DEFAULT_TIMEOUT = 120

/** A malformed call; the command line shows it as a usage error. */
const usage = (text: string): Configured => ({ ok: false, reason: 'usage', text })

// ---- folder ----

/** What a folder target's index says of each site: the content's fingerprint and library path. */
type Entry = { fingerprint: ContentId; path: LibraryPath; at: Instant }
type Index = { format: 1; sites: ({ name: SiteName } & Entry)[] }

/** Whether `dir` lies in the library or holds it: a target there would publish into the library itself. */
async function overlaps(ctx: PluginContext, dir: string): Promise<boolean> {
  const root = ctx.library.root
  const within = (inner: string, outer: string) => {
    const rel = relative(outer, inner)
    return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
  }
  return within(dir, root) || within(root, dir) || (await ctx.tools.resolve(dir)) !== null
}

/**
 * `<to>/<site>/…` and `<to>/index.json`. A site is copied to a dot-named temporary name and swapped in.
 * Its kind was `dir`; its key still is, so the records of a folder connected before count.
 */
export const folderTarget: TargetAdapter = defineTarget({
  kind: 'folder',
  formerly: ['dir'],
  label: '本地文件夹',
  icon: 'folder',
  params: [{ name: 'to', hint: '目录', kind: 'value', required: true }],
  async configure({ to }, ctx) {
    const dir = resolve(ctx.session.cwd, to)
    if (await overlaps(ctx, dir)) return { ok: false, reason: 'inside-library', text: `部署目标不能位于资料库中，也不能包含资料库：${dir}` }
    return { ok: true, config: { to: dir } }
  },
  open(config) {
    if (typeof config.to !== 'string') throw new Error('a folder target names its directory')
    return folderAt(config.to)
  },
})

function folderAt(to: string): Target {
  const scratchName = (site: SiteName, kind: 'tmp' | 'old') => join(to, `.${kind}-${site}-${randomBytes(4).toString('hex')}`)
  const takeDown = async (site: SiteName) => {
    const aside = scratchName(site, 'old')
    await rename(join(to, site), aside).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await rm(aside, { recursive: true, force: true })
  }
  return {
    key: `dir:${to}`,
    label: to,
    local: true,
    async publish(site, dir, meta) {
      await mkdir(to, { recursive: true })
      const tmp = scratchName(site, 'tmp')
      try {
        await cp(dir, tmp, { recursive: true })
        await takeDown(site)
        await rename(tmp, join(to, site))
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
      await updateIndex(to, (sites) => [...sites.filter((s) => s.name !== site), { name: site, fingerprint: meta.content, path: meta.path, at: meta.at }])
      return { url: `${pathToFileURL(join(to, site)).href}/` }
    },
    async remove(site) {
      await takeDown(site)
      await updateIndex(to, (sites) => sites.filter((s) => s.name !== site))
    },
  }
}

async function updateIndex(to: string, change: (sites: Index['sites']) => Index['sites']): Promise<void> {
  const file = join(to, 'index.json')
  const before = await readFile(file, 'utf8')
    .then((text) => (JSON.parse(text) as Index).sites)
    .catch(() => [] as Index['sites'])
  const index: Index = { format: 1, sites: change(Array.isArray(before) ? before : []).sort((a, b) => (a.name < b.name ? -1 : 1)) }
  const tmp = join(to, `.tmp-index-${randomBytes(4).toString('hex')}.json`)
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`)
  await rename(tmp, file)
}

// ---- command ----

type CommandConfig = { publish: string[]; unpublish: string[]; url: string | null; timeout: number }

/** A command given as one string is split like a shell would; given as several words it is already argv. */
function argv(values: readonly string[]): string[] {
  return values.length === 1 ? words(values[0] as string) : [...values]
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === 'string')

/**
 * Runs the owner's commands without a shell, `{dir}` and `{name}` replaced in each word, in `{dir}`:
 * the copy of the content to publish, or an empty directory to take a site down.
 */
export const commandTarget: TargetAdapter = defineTarget({
  kind: 'command',
  label: '自定义命令',
  icon: 'terminal',
  form: ['publish', 'unpublish', 'url', 'timeout'],
  params: [
    { name: 'publish', hint: '发布命令，可用 {dir} {name}', kind: 'list', required: true },
    { name: 'unpublish', hint: '取消发布命令，可用 {name}', kind: 'list', required: true },
    { name: 'url', hint: '地址模板，可用 {name}', kind: 'value' },
    { name: 'timeout', hint: '超时秒数', kind: 'value', pattern: '[1-9][0-9]*' },
  ],
  async configure({ publish, unpublish, url, timeout }) {
    try {
      return { ok: true, config: { publish: argv(publish), unpublish: argv(unpublish), url, timeout: timeout === null ? DEFAULT_TIMEOUT : Number(timeout) } }
    } catch (error) {
      return usage(error instanceof Error ? error.message : String(error))
    }
  },
  open(config, env) {
    if (!strings(config.publish) || !strings(config.unpublish)) throw new Error('a command target names its two commands')
    const url = typeof config.url === 'string' ? config.url : null
    const timeout = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT
    return commandsAt({ publish: config.publish, unpublish: config.unpublish, url, timeout }, env)
  },
})

function commandsAt(config: CommandConfig, env: TargetEnv): Target {
  const run = (argv: string[], dir: string, site: SiteName) => runCommand(argv.map((w) => w.replaceAll('{dir}', dir).replaceAll('{name}', site)), dir, config.timeout)
  return {
    key: `command:${JSON.stringify(config.publish)}`,
    label: '自定义命令',
    async publish(site, dir) {
      await run(config.publish, dir, site)
      return { url: config.url === null ? null : config.url.replaceAll('{name}', site) }
    },
    async remove(site) {
      const empty = join(env.scratch, randomUUID())
      await mkdir(empty, { recursive: true })
      try {
        await run(config.unpublish, empty, site)
      } finally {
        await rm(empty, { recursive: true, force: true })
      }
    },
  }
}

function runCommand(argv: string[], cwd: string, timeout: number): Promise<void> {
  const [file, ...args] = argv as [string, ...string[]]
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeout * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const said = stderr.trim().split('\n').slice(-3).join(' / ')
      const code = (error as NodeJS.ErrnoException).code
      if (error.killed) reject(new Error(`命令超时（${timeout} 秒），已停止：${file}`))
      else if (code === 'ENOENT') reject(new Error(`命令不存在：${file}`))
      else reject(new Error(`命令以退出码 ${String(code)} 结束：${file}${said ? `：${said}` : ''}`))
    })
  })
}

/** Splits a command the way a shell splits plain words, single and double quotes, and backslash escapes. */
export function words(command: string): string[] {
  const out: string[] = []
  let word = ''
  let started = false // a quoted empty word counts
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    const next = command[i + 1]
    if (quote === "'" && ch === "'") quote = null
    else if (quote === "'") word += ch
    else if (ch === '\\' && next !== undefined && (quote === null || next === '"' || next === '\\')) {
      word += next
      started = true
      i++
    } else if (quote === '"' && ch === '"') quote = null
    else if (quote === '"') word += ch
    else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) out.push(word)
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (quote !== null) throw new Error(`命令中的引号未配对：${command}`)
  if (started) out.push(word)
  if (out.length === 0) throw new Error('命令为空')
  return out
}
