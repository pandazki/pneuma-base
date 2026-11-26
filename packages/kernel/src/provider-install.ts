// Taking a storage provider from a repository's releases (PROVIDERS.md): the manifest the release
// carries, the executable it names for this platform, checked against its checksum, then `describe`
// and the contract suite, all before the provider is used. A download, a check or a run that fails
// leaves nothing installed: the work happens in a scratch directory under $PNEUMA_BASE_HOME/storage/tmp/,
// and the registry entry, written last, is what makes a provider installed.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { contractPath, describeProgram, platformKey, providersDir, runProgram, STORAGE_CONTRACT, writeEntry, ADDRESS_FORM, PROVIDER_NAME, type Provider } from './providers.js'
import type { Instant } from '@pneuma-base/sdk'

/** The file a provider's repository keeps at its root and attaches to each release. */
export const MANIFEST = 'pneuma-base-provider.json'

/** `<owner>/<repo>` and, after `@`, a release tag. */
export const RELEASE = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)(?:@([A-Za-z0-9._+-]+))?$/
const ASSET = /^[A-Za-z0-9._+-]+$/
const SHA256 = /^[0-9a-f]{64}$/

export type Release = { repository: string; tag: string | null }

export const parseRelease = (spec: string): Release | null => {
  const m = RELEASE.exec(spec)
  return m ? { repository: m[1] as string, tag: m[2] ?? null } : null
}

/** A provider's manifest. `version` is its release's tag; `executables` maps a platform (`darwin-arm64`) to the release asset and the sha256 of its bytes. */
export type Manifest = { name: string; version: string; contract: number; addresses: string[]; summary: string | null; executables: Record<string, { asset: string; sha256: string }> }

/** A manifest as the release carried it, or why it is not one. */
export function parseManifest(raw: unknown): Manifest | string {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (m.format !== 1) return 'format 不是 1'
  if (typeof m.name !== 'string' || !PROVIDER_NAME.test(m.name)) return 'name 不是一个提供者的名字（小写字母开头，只用小写字母、数字和连字符）'
  if (typeof m.version !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(m.version) || m.version === 'provider.json') return 'version 不是一个发布的标签'
  if (typeof m.contract !== 'number') return 'contract 不是一个数'
  if (!Array.isArray(m.addresses) || m.addresses.length === 0 || !m.addresses.every((a) => typeof a === 'string' && ADDRESS_FORM.test(a))) return 'addresses 不是地址写法的列表'
  if (typeof m.executables !== 'object' || m.executables === null) return 'executables 不是一个对象'
  const executables: Manifest['executables'] = {}
  for (const [platform, e] of Object.entries(m.executables as Record<string, unknown>)) {
    const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>
    if (typeof x.asset !== 'string' || !ASSET.test(x.asset) || typeof x.sha256 !== 'string' || !SHA256.test(x.sha256)) return `executables.${platform} 要有 asset（发布里的文件名）和 sha256（64 位小写十六进制）`
    executables[platform] = { asset: x.asset, sha256: x.sha256 }
  }
  return { name: m.name, version: m.version, contract: m.contract, addresses: m.addresses as string[], summary: typeof m.summary === 'string' ? m.summary : null, executables }
}

/** Where releases are fetched from: GitHub, or the host `PNEUMA_BASE_RELEASE_HOST` names, laid out the same way. */
const releaseHost = (env: NodeJS.ProcessEnv) => (env.PNEUMA_BASE_RELEASE_HOST ?? 'https://github.com').replace(/\/+$/, '')

const assetUrl = (env: NodeJS.ProcessEnv, repository: string, tag: string | null, asset: string) =>
  tag === null ? `${releaseHost(env)}/${repository}/releases/latest/download/${asset}` : `${releaseHost(env)}/${repository}/releases/download/${encodeURIComponent(tag)}/${asset}`

export type Refusal = { reason: string; text: string }

const WAIT_MS = 60_000

const why = (error: unknown) => {
  const e = error as { cause?: { code?: string; message?: string }; message?: string }
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(error)
}

/** The manifest of a release, the latest one when no tag is given. */
export async function fetchManifest(env: NodeJS.ProcessEnv, release: Release): Promise<Manifest | Refusal> {
  const url = assetUrl(env, release.repository, release.tag, MANIFEST)
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(WAIT_MS) })
  } catch (error) {
    return { reason: 'unreachable', text: `取 ${url} 时连不上：${why(error)}` }
  }
  const which = release.tag === null ? '最新的发布' : `发布 ${release.tag}`
  if (response.status === 404) return { reason: 'no-release', text: `${release.repository} 没有${which}，或${which}里没有 ${MANIFEST}（${url} 答 404）` }
  if (!response.ok) return { reason: 'unreachable', text: `取 ${url} 时答 ${response.status}` }
  let raw: unknown
  try {
    raw = await response.json()
  } catch (error) {
    return { reason: 'bad-manifest', text: `${url} 不是 JSON：${why(error)}` }
  }
  const manifest = parseManifest(raw)
  if (typeof manifest === 'string') return { reason: 'bad-manifest', text: `${release.repository} 的 ${MANIFEST} 不对：${manifest}` }
  if (release.tag !== null && manifest.version !== release.tag) return { reason: 'bad-manifest', text: `${release.repository} 的发布 ${release.tag} 里的 ${MANIFEST} 写的版本是 ${manifest.version}` }
  return manifest
}

/** Saves a release asset to `file`, hashing it on the way: its sha256, or why it did not arrive whole. */
async function download(url: string, file: string): Promise<string | Refusal> {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * WAIT_MS) })
    if (!response.ok || response.body === null) return { reason: response.status === 404 ? 'no-release' : 'unreachable', text: `取 ${url} 时答 ${response.status}` }
    const hash = createHash('sha256')
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => hash.update(chunk))
    await pipeline(body, createWriteStream(file, { mode: 0o700 }))
    return hash.digest('hex')
  } catch (error) {
    return { reason: 'unreachable', text: `取 ${url} 时断了：${why(error)}` }
  }
}

/** One release, as it is to be installed: its manifest and this platform's executable. `official`: on the official list, whose checksum it carries. */
export type Candidate = { repository: string; manifest: Manifest; executable: { asset: string; sha256: string }; official: boolean }

/** This platform's executable of a manifest, or why there is none. */
export function candidateOf(repository: string, manifest: Manifest, official: boolean): Candidate | Refusal {
  if (manifest.contract !== STORAGE_CONTRACT) return contractRefusal(manifest.name, manifest.contract)
  const executable = manifest.executables[platformKey()]
  if (executable === undefined) {
    const has = Object.keys(manifest.executables).join('、') || '无'
    return { reason: 'no-executable', text: `${repository} 的 ${manifest.version} 没有给这台机器（${platformKey()}）的程序；它有：${has}` }
  }
  return { repository, manifest, executable, official }
}

const contractRefusal = (name: string, contract: unknown): Refusal => ({ reason: 'contract-version', text: `${name} 讲的是存储契约第 ${String(contract)} 版，这个 pneuma-base 讲第 ${STORAGE_CONTRACT} 版。` })

/** What the contract suite said of a program: how many checks it met and could not exercise. */
export type Vetted = { met: number; notExercised: number }

type SuiteRun = { met: number; notExercised: number; unmet: { name: string; line: string }[] } | { failed: string }

/** One run of the contract suite against a program, every check or those `filter` names. */
async function suite(program: string, filter: string | null): Promise<SuiteRun> {
  const r = await runProgram(contractPath(), ['--provider', program, ...(filter === null ? [] : ['--filter', filter])], 30 * WAIT_MS)
  const lines = r.stdout.split('\n')
  const summary = /checks: (\d+) met, (\d+) unmet, (\d+) not exercised/.exec(lines.find((l) => l.startsWith('checks:')) ?? '')
  if (summary === null || (r.code !== 0 && r.code !== 1)) return { failed: `契约测试没能跑完（退出码 ${r.code ?? '无'}）：${(r.stderr || r.stdout).trim().slice(-400)}` }
  const unmet = lines.filter((l) => l.startsWith('UNMET')).map((l) => {
    const line = l.replace(/^UNMET\s+/, '').replace(/\s+/g, ' ').slice(0, 300)
    return { name: line.split(' ')[0] as string, line }
  })
  return { met: Number(summary[1]), notExercised: Number(summary[3]), unmet }
}

/**
 * Runs the contract suite against a program: what it met, or the checks it did not. A check unmet is
 * run once more on its own before the program is refused: a few checks time the program, and a busy
 * machine can make one late; a sentence the program does not meet fails again.
 */
async function vet(program: string): Promise<Vetted | Refusal> {
  const first = await suite(program, null)
  if ('failed' in first) return { reason: 'contract-unmet', text: first.failed }
  const still: string[] = []
  for (const { name, line } of first.unmet) {
    const again = await suite(program, name)
    if ('failed' in again) return { reason: 'contract-unmet', text: again.failed }
    if (again.unmet.length > 0 || again.met === 0) still.push(again.unmet.find((u) => u.name === name)?.line ?? line)
  }
  if (still.length === 0) return { met: first.met + first.unmet.length, notExercised: first.notExercised }
  const shown = still.slice(0, 5).map((l) => `  ${l}`)
  return { reason: 'contract-unmet', text: [`契约测试有 ${still.length} 项没过：`, ...shown, ...(still.length > 5 ? [`  还有 ${still.length - 5} 项`] : [])].join('\n') }
}

/** A scratch directory left by an install that was stopped is this old at least before the next install clears it. */
const STALE_MS = 60 * 60 * 1000

async function clearStale(tmp: string): Promise<void> {
  for (const name of await readdir(tmp).catch(() => [] as string[])) {
    const at = join(tmp, name)
    const s = await stat(at).catch(() => null)
    if (s !== null && Date.now() - s.mtimeMs > STALE_MS) await rm(at, { recursive: true, force: true })
  }
}

/**
 * Downloads a candidate's executable, checks its checksum, asks it to describe itself, runs the
 * contract suite against it, and only then installs it: the executable under
 * `storage/providers/<name>/<version>/`, then its registry entry. Any other version of it there goes.
 */
export async function installCandidate(home: string, env: NodeJS.ProcessEnv, c: Candidate, now: Instant): Promise<{ provider: Provider; vetted: Vetted } | Refusal> {
  const { manifest, executable } = c
  const tmpRoot = join(home, 'storage', 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  await clearStale(tmpRoot)
  const scratch = join(tmpRoot, randomUUID())
  await mkdir(scratch)
  try {
    const file = join(scratch, executable.asset)
    const got = await download(assetUrl(env, c.repository, manifest.version, executable.asset), file)
    if (typeof got !== 'string') return got
    if (got !== executable.sha256) return { reason: 'checksum', text: `取到的程序的校验和是 sha256:${got}，${c.official ? '官方名单' : '清单'}写的是 sha256:${executable.sha256}` }
    await chmod(file, 0o755)
    const described = await describeProgram(file)
    if (typeof described === 'string') return { reason: 'describe', text: `程序没有答 describe：${described}` }
    if (described.contract !== STORAGE_CONTRACT) return contractRefusal(manifest.name, described.contract)
    const addresses = Array.isArray(described.addresses) ? described.addresses.map(String) : []
    if (described.name !== manifest.name || [...addresses].sort().join(',') !== [...manifest.addresses].sort().join(',')) {
      return { reason: 'describe', text: `程序的 describe 说它是 ${String(described.name)}，答 ${addresses.join('、') || '无'}；清单写的是 ${manifest.name}，答 ${manifest.addresses.join('、')}` }
    }
    const vetted = await vet(file)
    if ('reason' in vetted) return vetted
    const dir = join(providersDir(home), manifest.name)
    const versionDir = join(dir, manifest.version)
    await mkdir(dir, { recursive: true })
    await rm(versionDir, { recursive: true, force: true })
    await rename(scratch, versionDir)
    const provider: Provider & { origin: { kind: 'repository' } } = {
      name: manifest.name,
      version: manifest.version,
      contract: STORAGE_CONTRACT,
      addresses: manifest.addresses,
      executable: join(versionDir, executable.asset),
      sha256: executable.sha256,
      origin: { kind: 'repository', repository: c.repository, tag: manifest.version },
      official: c.official,
      installed: now,
    }
    await writeEntry(home, provider)
    for (const other of await readdir(dir)) {
      if (other !== manifest.version && other !== 'provider.json') await rm(join(dir, other), { recursive: true, force: true })
    }
    return { provider, vetted }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
