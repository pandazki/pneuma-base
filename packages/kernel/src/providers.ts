// Storage providers on this machine (tmp/run-7 architecture.md, 「存储的实现是可以安装的」; PROVIDERS.md).
// A provider is any program that speaks STORAGE.md and answers `describe`. A library's address has a
// form, a local path or a scheme, and the provider that answers it here is the one the door starts.
//
//   $PNEUMA_BASE_HOME/storage/providers/<name>/provider.json   an installed provider: its registry entry
//   $PNEUMA_BASE_HOME/storage/providers/<name>/<version>/…     its executable
//   $PNEUMA_BASE_HOME/storage/libraries/<key>.json            which provider a library uses
//
// The provider this installation carries (the local folder) has no entry there: it is the program
// beside the kernel, registered by being installed with it, so it never points at a moved copy.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from './machine-files.js'
import type { Instant } from '@pneuma-base/sdk'

/** The version of STORAGE.md this kernel speaks. A provider that speaks another is not used. */
export const STORAGE_CONTRACT = 1
export const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,40}$/
/** An address form: `path`, or the scheme of `<scheme>://…`. */
export const ADDRESS_FORM = /^[a-z][a-z0-9+.-]{0,30}$/

/** This machine as Node names it: `darwin-arm64`, `linux-x64`. */
export const platformKey = (): string => `${process.platform}-${process.arch}`
export const platformName = (key: string): string => (key === 'darwin-arm64' ? 'Apple 芯片的 Mac (darwin-arm64)' : key)

/** The form of an address: the scheme of `<scheme>://…`, else `path`, a folder on this machine. */
export function addressForm(address: string): string {
  return /^([a-z][a-z0-9+.-]*):\/\//.exec(address)?.[1] ?? 'path'
}

let chosenHome: string | null = null

/** The machine state the door reads which provider answers a library from. Set by whoever knows the home (the command line); else `$PNEUMA_BASE_HOME`. */
export const useMachineHome = (home: string): void => {
  chosenHome = home
}
export const machineHome = (): string => chosenHome ?? process.env.PNEUMA_BASE_HOME ?? join(homedir(), '.pneuma-base')

// ---- this installation's programs ----

/** A program of this installation: `env[override]`; else the one a package file carries beside the kernel (scripts/pack-dist.mjs); else the one built in this repository, release before debug. */
function programOf(name: string, override: string, env: NodeJS.ProcessEnv): string | null {
  if (env[override]) return env[override] as string
  for (const at of [`../bin/${name}`, `../../../core/target/release/${name}`, `../../../core/target/debug/${name}`]) {
    const path = fileURLToPath(new URL(at, import.meta.url))
    if (existsSync(path)) return path
  }
  return null
}

/** The local folder's program, the provider this installation carries. */
export function corePath(env: NodeJS.ProcessEnv = process.env): string {
  const path = programOf('pneuma-base-core', 'PNEUMA_BASE_CORE', env)
  if (path === null) throw new Error('存储的程序 pneuma-base-core 不在：在 pneuma-base 的仓库里运行 pnpm build，或用 PNEUMA_BASE_CORE 指明它在哪')
  return path
}

/** The contract suite's program, which vets a provider before it is used. */
export function contractPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = programOf('pneuma-base-contract', 'PNEUMA_BASE_CONTRACT', env)
  if (path === null) throw new Error('契约测试的程序 pneuma-base-contract 不在：在 pneuma-base 的仓库里运行 pnpm build，或用 PNEUMA_BASE_CONTRACT 指明它在哪')
  return path
}

/** The platform this installation's programs were built for, as pack-dist wrote it beside them; null in a repository. */
function builtFor(): string | null {
  try {
    return readFileSync(fileURLToPath(new URL('../bin/platform', import.meta.url)), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** The sentence a package says on a machine its programs were not built for; null where they run. */
export function platformMismatch(): string | null {
  const built = builtFor()
  if (built === null || built === platformKey()) return null
  return `这个 pneuma-base 是给 ${platformName(built)} 构建的，这台机器是 ${platformKey()}。`
}

// ---- the official list ----

/** An official provider, as the list shipped in the package names it. `builtIn`: this installation carries it. `sha256`: per platform, of its executable. */
export type OfficialProvider = { name: string; summary: string; addresses: string[]; repository: string; version: string | null; builtIn: boolean; sha256: Record<string, string> }

/** The official list: `official-providers.json` in the kernel's package, or the file `PNEUMA_BASE_OFFICIAL_PROVIDERS` names. */
export function officialProviders(env: NodeJS.ProcessEnv = process.env): OfficialProvider[] {
  const file = env.PNEUMA_BASE_OFFICIAL_PROVIDERS ?? fileURLToPath(new URL('../official-providers.json', import.meta.url))
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers?: unknown }
  return (Array.isArray(raw.providers) ? raw.providers : []).flatMap((p): OfficialProvider[] => {
    const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.repository !== 'string' || !Array.isArray(o.addresses)) return []
    return [
      {
        name: o.name,
        summary: typeof o.summary === 'string' ? o.summary : o.name,
        addresses: o.addresses.filter((a): a is string => typeof a === 'string'),
        repository: o.repository,
        version: typeof o.version === 'string' ? o.version : null,
        builtIn: o.builtIn === true,
        sha256: typeof o.sha256 === 'object' && o.sha256 !== null ? (o.sha256 as Record<string, string>) : {},
      },
    ]
  })
}

/** The provider this installation carries, by the official list: the local folder, answering local paths. */
function builtIn(): OfficialProvider {
  const own = officialProviders().find((p) => p.builtIn)
  if (own === undefined) throw new Error('官方的存储提供者名单里没有自带的那一个')
  return own
}

// ---- the registry ----

export type ProviderOrigin = { kind: 'built-in' } | { kind: 'repository'; repository: string; tag: string }

/** A provider on this machine. `executable` is absolute; `sha256` is of its bytes. */
export type Provider = {
  name: string
  version: string
  contract: number
  addresses: string[]
  executable: string
  sha256: string
  origin: ProviderOrigin
  official: boolean
  installed: Instant | null
}

/** Where a provider runs from, all the door needs. */
export type Runnable = { name: string; addresses: string[]; executable: string; builtIn: boolean }

export const providersDir = (home: string): string => join(home, 'storage', 'providers')
const entryFile = (home: string, name: string) => join(providersDir(home), name, 'provider.json')

/** The registry entry of an installed provider, as written in provider.json; its executable is relative to its directory there. */
type Entry = Omit<Provider, 'origin' | 'executable'> & { format: 1; executable: string; from: { repository: string; tag: string } }

function parseEntry(raw: unknown, dir: string): Provider | null {
  const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Entry>
  const from = e.from
  if (e.format !== 1 || typeof e.name !== 'string' || typeof e.version !== 'string' || typeof e.executable !== 'string' || typeof e.sha256 !== 'string') return null
  if (typeof e.contract !== 'number' || !Array.isArray(e.addresses) || typeof from?.repository !== 'string' || typeof from.tag !== 'string') return null
  return {
    name: e.name,
    version: e.version,
    contract: e.contract,
    addresses: e.addresses,
    executable: resolve(dir, e.executable),
    sha256: e.sha256,
    origin: { kind: 'repository', repository: from.repository, tag: from.tag },
    official: e.official === true,
    installed: e.installed ?? null,
  }
}

/** An installed provider by name; null when there is none or its entry does not read. */
export function installedProvider(home: string, name: string): Provider | null {
  try {
    return parseEntry(JSON.parse(readFileSync(entryFile(home, name), 'utf8')), join(providersDir(home), name))
  } catch {
    return null
  }
}

/** The installed providers, by name. */
export function installedProviders(home: string): Provider[] {
  let names: string[]
  try {
    names = readdirSync(providersDir(home)).sort()
  } catch {
    return []
  }
  return names.flatMap((name) => installedProvider(home, name) ?? [])
}

/** Writes an installed provider's entry: the one write that makes it installed. Its executable must lie under its directory. */
export async function writeEntry(home: string, p: Provider & { origin: { kind: 'repository' } }): Promise<void> {
  const dir = join(providersDir(home), p.name)
  const { origin, executable, ...rest } = p
  const entry: Entry = { format: 1, ...rest, executable: executable.slice(dir.length + 1), from: { repository: origin.repository, tag: origin.tag } }
  await writeAtomic(entryFile(home, p.name), `${JSON.stringify(entry, null, 2)}\n`, join(home, 'storage', 'tmp'))
}

/** Takes an installed provider off this machine: its entry first, so a half-removed one is not installed. */
export async function removeInstalled(home: string, name: string): Promise<void> {
  await rm(entryFile(home, name), { force: true })
  await rm(join(providersDir(home), name), { recursive: true, force: true })
}

/** The provider this installation carries, as its program describes itself; this machine's checksum of it. */
export async function builtInProvider(): Promise<Provider> {
  const own = builtIn()
  const executable = corePath()
  const described = await describeProgram(executable)
  const version = typeof described === 'string' ? (own.version ?? '—') : String(described.version)
  return { name: own.name, version, contract: STORAGE_CONTRACT, addresses: own.addresses, executable, sha256: await sha256Of(executable), origin: { kind: 'built-in' }, official: true, installed: null }
}

/** Every provider on this machine: the built-in first, then the installed ones by name. */
export async function machineProviders(home: string): Promise<Provider[]> {
  return [await builtInProvider(), ...installedProviders(home)]
}

const runnable = (home: string): Runnable[] => {
  const own = builtIn()
  return [{ name: own.name, addresses: own.addresses, executable: corePath(), builtIn: true }, ...installedProviders(home).map((p) => ({ name: p.name, addresses: p.addresses, executable: p.executable, builtIn: false }))]
}

// ---- which provider a library uses ----

const librariesDir = (home: string) => join(home, 'storage', 'libraries')
/** One file per library, so two processes recording two libraries never write the same file. */
const libraryFile = (home: string, address: string) => join(librariesDir(home), `${createHash('sha256').update(address).digest('hex').slice(0, 32)}.json`)

type LibraryRecord = { address: string; provider: string }

function readRecord(file: string): LibraryRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<LibraryRecord>
    return typeof r.address === 'string' && typeof r.provider === 'string' ? { address: r.address, provider: r.provider } : null
  } catch {
    return null
  }
}

/** The provider recorded for a library on this machine; null when none is. */
export const recordedProvider = (home: string, address: string): string | null => readRecord(libraryFile(home, address))?.provider ?? null

export async function recordLibrary(home: string, address: string, provider: string): Promise<void> {
  await writeAtomic(libraryFile(home, address), `${JSON.stringify({ address, provider }, null, 2)}\n`, join(home, 'storage', 'tmp'))
}

/** The addresses of the libraries recorded as using a provider. */
export function librariesUsing(home: string, name: string): string[] {
  let files: string[]
  try {
    files = readdirSync(librariesDir(home)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files.flatMap((f) => readRecord(join(librariesDir(home), f)) ?? []).filter((r) => r.provider === name).map((r) => r.address).sort()
}

/** The provider a library uses: the one recorded for it, else the one this installation carries when it answers the address's form, else the first installed one that does. */
export function providerOf(address: string, home: string = machineHome()): Runnable {
  const all = runnable(home)
  const recorded = recordedProvider(home, address)
  if (recorded !== null) {
    const p = all.find((r) => r.name === recorded)
    if (p === undefined) throw new Error(`库 ${address} 用的存储提供者 ${recorded} 不在这台机器上`)
    return p
  }
  const form = addressForm(address)
  const p = all.find((r) => r.addresses.includes(form))
  if (p === undefined) throw new Error(`这台机器上没有答 ${form} 这种地址的存储提供者：${address}`)
  return p
}

/** The provider init uses for an address of `form`: the one named, which must answer it, else the only one that does, the built-in before the rest. */
export function chooseProvider(home: string, form: string, named: string | null): Runnable | { reason: string; text: string } {
  const all = runnable(home)
  if (named !== null) {
    const p = all.find((r) => r.name === named)
    if (p === undefined) return { reason: 'no-such-provider', text: `这台机器没有叫 ${named} 的存储提供者。有的：${all.map((r) => r.name).join('、')}` }
    if (!p.addresses.includes(form)) return { reason: 'wrong-address', text: `存储提供者 ${named} 不答 ${form} 这种地址，它答：${p.addresses.join('、')}` }
    return p
  }
  const answering = all.filter((r) => r.addresses.includes(form))
  const own = answering.find((r) => r.builtIn)
  if (own) return own
  if (answering.length === 1) return answering[0] as Runnable
  if (answering.length === 0) return { reason: 'no-provider', text: `这台机器上没有答 ${form} 这种地址的存储提供者。装上的：${all.map((r) => `${r.name}（${r.addresses.join('、')}）`).join('、')}` }
  return { reason: 'choose-provider', text: `答 ${form} 这种地址的存储提供者有：${answering.map((r) => r.name).join('、')}。用 --provider <名字> 选一个。` }
}

// ---- asking a program ----

/** Runs `program args…` to its end: what it printed and how it ended. Killed after `ms`. */
export function runProgram(program: string, args: readonly string[], ms: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-4000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ code: null, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

/** What a program answers to `describe`, run on an empty folder of its own; a string says why there is no answer. */
export async function describeProgram(program: string): Promise<Record<string, unknown> | string> {
  const root = await mkdtemp(join(tmpdir(), 'pneuma-base-describe-'))
  try {
    const r = await runProgram(program, ['describe', '--root', root], 10_000)
    try {
      const answer = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>
      return answer.outcome === 'done' ? answer : `答了 ${r.stdout.trim().slice(0, 200)}`
    } catch {
      return r.code === null ? `没能运行：${r.stderr.trim().slice(0, 200)}` : `没有答 JSON（退出码 ${r.code}）：${(r.stdout || r.stderr).trim().slice(0, 200)}`
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function sha256Of(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}
