// Deploy targets: where published sites go. A target publishes a directory under a site name and
// takes a site name down. Two kinds: a local directory, and the owner's own pair of commands.
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Fingerprint, Instant, LibraryPath } from '@pneuma-base/kernel'
import type { TargetKey } from './facts.js'
import type { SiteName } from './model.js'

export type TargetConfig =
  | { kind: 'dir'; to: string }
  | { kind: 'command'; publish: string[]; unpublish: string[]; url: string | null; timeout: number }

/** What a publish is: the content's fingerprint and library path, recorded in a dir target's index. */
type Entry = { fingerprint: Fingerprint; path: LibraryPath; at: Instant }

export interface Target {
  readonly key: TargetKey
  /** One line for people: what kind and where. */
  readonly label: string
  publish(site: SiteName, dir: string, entry: Entry): Promise<{ url: string | null }>
  unpublish(site: SiteName): Promise<void>
}

export const DEFAULT_TIMEOUT = 120
const CONFIG_FILE = 'config.json'

export function targetOf(config: TargetConfig, opts: { cwd: string; scratch: string }): Target {
  return config.kind === 'dir' ? dirTarget(config.to) : commandTarget(config, opts)
}

// ---- dir ----

type Index = { format: 1; sites: ({ name: SiteName } & Entry)[] }

/** `<to>/<site>/…` and `<to>/index.json`. A site is copied to a dot-named temporary name and swapped in. */
function dirTarget(to: string): Target {
  const scratchName = (site: SiteName, kind: 'tmp' | 'old') => join(to, `.${kind}-${site}-${randomBytes(4).toString('hex')}`)
  const takeDown = async (site: SiteName) => {
    const aside = scratchName(site, 'old')
    await rename(join(to, site), aside).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await rm(aside, { recursive: true, force: true })
  }
  return {
    key: `dir:${to}` as TargetKey,
    label: `本地目录 ${to}`,
    async publish(site, dir, entry) {
      await mkdir(to, { recursive: true })
      const tmp = scratchName(site, 'tmp')
      try {
        await cp(dir, tmp, { recursive: true })
        await takeDown(site)
        await rename(tmp, join(to, site))
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
      await updateIndex(to, (sites) => [...sites.filter((s) => s.name !== site), { name: site, ...entry }])
      return { url: `${pathToFileURL(join(to, site)).href}/` }
    },
    async unpublish(site) {
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

/** Runs the owner's commands without a shell, `{dir}` and `{name}` replaced in each word. Taking down gets an empty directory as `{dir}`. */
function commandTarget(config: Extract<TargetConfig, { kind: 'command' }>, opts: { cwd: string; scratch: string }): Target {
  const run = (argv: string[], dir: string, site: SiteName) => runCommand(argv.map((w) => w.replaceAll('{dir}', dir).replaceAll('{name}', site)), opts.cwd, config.timeout)
  return {
    key: `command:${JSON.stringify(config.publish)}` as TargetKey,
    label: `命令 ${config.publish.join(' ')}`,
    async publish(site, dir) {
      await run(config.publish, dir, site)
      return { url: config.url === null ? null : config.url.replaceAll('{name}', site) }
    },
    async unpublish(site) {
      const empty = join(opts.scratch, randomUUID())
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
      if (error.killed) reject(new Error(`命令超时（${timeout} 秒），已停下：${file}`))
      else if (code === 'ENOENT') reject(new Error(`找不到命令：${file}`))
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
  if (quote !== null) throw new Error(`命令里的引号没有配对：${command}`)
  if (started) out.push(word)
  if (out.length === 0) throw new Error('命令是空的')
  return out
}

// ---- configuration ----

/** The configured target, parsed at the boundary; null when none is set. */
export async function readTargetConfig(dir: string): Promise<TargetConfig | null> {
  const text = await readFile(join(dir, CONFIG_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return null
  const raw = (JSON.parse(text) as { target?: Partial<TargetConfig> }).target
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === 'string')
  if (raw?.kind === 'dir' && typeof raw.to === 'string') return { kind: 'dir', to: raw.to }
  if (raw?.kind === 'command' && strings(raw.publish) && strings(raw.unpublish)) {
    return { kind: 'command', publish: raw.publish, unpublish: raw.unpublish, url: typeof raw.url === 'string' ? raw.url : null, timeout: typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : DEFAULT_TIMEOUT }
  }
  throw new Error(`部署目标的配置读不懂：.pneuma-base/deploy/${CONFIG_FILE}`)
}

/** Writes the configuration to a temporary name, then renames it into place. */
export async function writeTargetConfig(dir: string, target: TargetConfig): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}-${CONFIG_FILE}`)
  await writeFile(tmp, `${JSON.stringify({ format: 1, target }, null, 2)}\n`)
  await rename(tmp, join(dir, CONFIG_FILE))
}
