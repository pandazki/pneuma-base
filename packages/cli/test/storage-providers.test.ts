// Storage providers on this machine (ARCHITECTURE.md「存储」; PROVIDERS.md):
// the one the installation carries is there with no step; installing one from a repository's releases
// is refused, leaving nothing installed, when its checksum is wrong, its contract version does not fit,
// the owner has not accepted the trust statement, or the download breaks off; init chooses the provider
// by the address's form and records it on this machine. Releases come from a stand-in host on this
// machine. Installs that run the whole contract suite are in storage-providers.slow.test.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './helpers.js'
import { CORE, manifestFor, providerScript, releaseHost, runCli, sha256, type ReleaseHost } from './storage-host.js'

let host: ReleaseHost
beforeAll(async () => {
  host = await releaseHost()
})
afterAll(() => host.close())

/** A machine of its own: a temporary HOME, its $PNEUMA_BASE_HOME inside, releases from the stand-in host. */
function machine() {
  const home = tempDir('pb-storage-')
  const pbHome = join(home, '.pneuma-base')
  const run = (args: string[], env: Record<string, string> = {}) => runCli(home, args, { PNEUMA_BASE_RELEASE_HOST: host.url, ...env })
  /** Nothing of a provider is left on this machine: no entry, no executable, no download in progress. */
  const installedNothing = (name: string) => !existsSync(join(pbHome, 'storage/providers', name)) && (existsSync(join(pbHome, 'storage/tmp')) ? readdirSync(join(pbHome, 'storage/tmp')) : []).length === 0
  return { home, pbHome, run, installedNothing }
}

const coreSha = () => sha256(readFileSync(CORE))

describe('storage list', () => {
  it('shows the provider this installation carries, with no step taken: the local folder, its program and checksum', async () => {
    const m = machine()
    const r = await m.run(['storage', 'list'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^local-folder \S+ · 自带 · 官方 · 地址：path · 契约 1$/m)
    expect(r.stdout).toContain(`程序：${CORE}`)
    expect(r.stdout).toContain(`校验和：sha256:${coreSha()}`)
    const data = (await m.run(['storage', 'list', '--json'])).json().data
    expect(data.providers).toEqual([expect.objectContaining({ name: 'local-folder', addresses: ['path'], contract: 1, executable: CORE, sha256: coreSha(), origin: { kind: 'built-in' }, official: true })])
    expect(data.official).toEqual([])
  })

  it('shows the official providers not installed, each with the command that installs it', async () => {
    const m = machine()
    const list = join(m.home, 'official.json')
    writeFileSync(
      list,
      JSON.stringify({
        format: 1,
        providers: [
          { name: 'local-folder', summary: '本机文件夹', addresses: ['path'], repository: 'example/pneuma-base', version: null, builtIn: true, sha256: {} },
          { name: 'cloud-folder', summary: '云上的文件夹', addresses: ['cloud'], repository: 'example/cloud-folder', version: 'v2.0.0', builtIn: false, sha256: {} },
        ],
      }),
    )
    const r = await m.run(['storage', 'list'], { PNEUMA_BASE_OFFICIAL_PROVIDERS: list })
    expect(r.stdout).toContain('官方的、没装的：')
    expect(r.stdout).toContain('cloud-folder v2.0.0 · 地址：cloud · pneuma-base storage install example/cloud-folder')
  })

  it('names the provider the library at hand uses', async () => {
    const m = machine()
    const lib = join(m.home, 'lib')
    expect((await m.run(['init', lib, '--bare'])).code).toBe(0)
    expect((await m.run(['storage', 'list', '--library', lib])).stdout).toMatch(/^local-folder .* · 这个库在用$/m)
    expect((await m.run(['storage', 'list', '--library', lib, '--json'])).json().data.library).toEqual({ address: lib, provider: 'local-folder' })
  })

  it('is the owner’s: refused in an agent’s session', async () => {
    const r = await machine().run(['storage', 'list'], { CLAUDE_CODE_SESSION_ID: 'agent-session' })
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（agent-session）')
  })
})

describe('storage install', () => {
  /** A release of a provider answering `form://` addresses, published on the stand-in host. */
  function publish(repository: string, o: { name: string; version: string; form?: string; contract?: number; manifestContract?: number; sha?: string; cut?: boolean }) {
    const form = o.form ?? o.name.replace(/-.*/, '')
    const bytes = providerScript({ name: o.name, form, log: join(tempDir('pb-log-'), 'log'), ...(o.contract === undefined ? {} : { contract: o.contract }) })
    const manifest = manifestFor({ name: o.name, version: o.version, form, asset: o.name, bytes, ...(o.manifestContract === undefined ? {} : { contract: o.manifestContract }), ...(o.sha === undefined ? {} : { sha: o.sha }) })
    host.publish({ repository, manifest, assets: { [o.name]: o.cut ? { cut: Buffer.concat([bytes, Buffer.alloc(256 * 1024)]) } : bytes }, latest: true })
    return { sha: sha256(bytes) }
  }

  it('before installing a third-party provider, says what a provider is and names the repository, version and checksum; not accepted, nothing is installed', async () => {
    const m = machine()
    const { sha } = publish('acme/alpha-folder', { name: 'alpha-folder', version: 'v1.0.0' })
    const r = await m.run(['storage', 'install', 'acme/alpha-folder'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（not-confirmed）')
    expect(r.stdout).toContain('存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。')
    expect(r.stdout).toContain(`要装的是 acme/alpha-folder 的 v1.0.0，校验和 sha256:${sha}。`)
    expect(r.stdout).toContain(`pneuma-base storage install acme/alpha-folder@v1.0.0 --checksum ${sha}`)
    const offer = (await m.run(['storage', 'install', 'acme/alpha-folder', '--json'])).json().offer
    expect(offer.call).toEqual({ face: 'owner', command: 'storage install', args: { positional: ['acme/alpha-folder@v1.0.0'], flags: { checksum: [sha] } } })
    expect(offer.confirm).toContain(`sha256:${sha}`)
    expect(m.installedNothing('alpha-folder')).toBe(true)
    expect(host.asked).not.toContain('/acme/alpha-folder/releases/download/v1.0.0/alpha-folder')
  })

  it('refuses when the checksum the owner accepted is not the release’s any more', async () => {
    const m = machine()
    publish('acme/beta-folder', { name: 'beta-folder', version: 'v1.0.0' })
    const r = await m.run(['storage', 'install', 'acme/beta-folder@v1.0.0', '--checksum', '0'.repeat(64)])
    expect(r.stdout).toContain('拒绝（checksum-changed）')
    expect(m.installedNothing('beta-folder')).toBe(true)
  })

  it('refuses an executable whose bytes do not match the checksum, and leaves nothing installed', async () => {
    const m = machine()
    const wrong = 'f'.repeat(64)
    publish('acme/gamma-folder', { name: 'gamma-folder', version: 'v1.0.0', sha: wrong })
    const r = await m.run(['storage', 'install', 'acme/gamma-folder@v1.0.0', '--checksum', wrong])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（checksum）')
    expect(r.stdout).toContain(`清单写的是 sha256:${wrong}`)
    expect(m.installedNothing('gamma-folder')).toBe(true)
    expect((await m.run(['storage', 'list', '--json'])).json().data.providers.map((p: { name: string }) => p.name)).toEqual(['local-folder'])
  })

  it('refuses a provider of a newer contract version before taking its executable', async () => {
    const m = machine()
    publish('acme/delta-folder', { name: 'delta-folder', version: 'v3.0.0', manifestContract: 2 })
    const r = await m.run(['storage', 'install', 'acme/delta-folder'])
    expect(r.stdout).toContain('拒绝（contract-version）')
    expect(r.stdout).toContain('delta-folder 讲的是存储契约第 2 版，这个 pneuma-base 讲第 1 版。')
    expect(host.asked).not.toContain('/acme/delta-folder/releases/download/v3.0.0/delta-folder')
    expect(m.installedNothing('delta-folder')).toBe(true)
  })

  it('refuses a program whose describe says another contract version than its manifest', async () => {
    const m = machine()
    const { sha } = publish('acme/eta-folder', { name: 'eta-folder', version: 'v1.0.0', contract: 2 })
    const r = await m.run(['storage', 'install', 'acme/eta-folder', '--checksum', sha])
    expect(r.stdout).toContain('拒绝（contract-version）')
    expect(m.installedNothing('eta-folder')).toBe(true)
  })

  it('a network failure midway leaves nothing half-installed', async () => {
    const m = machine()
    publish('acme/zeta-folder', { name: 'zeta-folder', version: 'v1.0.0', cut: true })
    const manifest = (await (await fetch(`${host.url}/acme/zeta-folder/releases/download/v1.0.0/pneuma-base-provider.json`)).json()) as { executables: Record<string, { sha256: string }> }
    const sha = Object.values(manifest.executables)[0]?.sha256 as string
    const r = await m.run(['storage', 'install', 'acme/zeta-folder@v1.0.0', '--checksum', sha])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（unreachable）')
    expect(m.installedNothing('zeta-folder')).toBe(true)
  })

  it('a repository with no such release is refused, saying so', async () => {
    const r = await machine().run(['storage', 'install', 'acme/nothing-here'])
    expect(r.stdout).toContain('拒绝（no-release）')
    expect(r.stdout).toContain('acme/nothing-here 没有最新的发布')
  })

  it('is the owner’s alone: refused in an agent’s session, and not one an agent may ask for', async () => {
    const r = await machine().run(['storage', 'install', 'acme/alpha-folder'], { CLAUDE_CODE_SESSION_ID: 'agent-session' })
    expect(r.stdout).toContain('拒绝（agent-session）')
    expect(r.stdout).not.toContain('pneuma-base ask')
  })
})

describe('init <地址>', () => {
  it('a path is the local folder, recorded on this machine as the provider the library uses', async () => {
    const m = machine()
    const lib = join(m.home, 'lib')
    const r = await m.run(['init', lib, '--bare', '--json'])
    expect(r.json().data).toEqual({ root: lib, provider: 'local-folder' })
    const records = readdirSync(join(m.pbHome, 'storage/libraries')).map((f) => JSON.parse(readFileSync(join(m.pbHome, 'storage/libraries', f), 'utf8')))
    expect(records).toEqual([{ address: lib, provider: 'local-folder' }])
  })

  it('an address no provider here answers is refused, naming its form', async () => {
    const m = machine()
    const r = await m.run(['init', 'cloud://bucket/lib', '--bare'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('拒绝（no-provider）：这台机器上没有答 cloud 这种地址的存储提供者。')
    expect(existsSync(join(m.pbHome, 'storage/libraries'))).toBe(false)
  })

  it('a provider named that does not answer the address is refused', async () => {
    const m = machine()
    expect((await m.run(['init', join(m.home, 'lib'), '--provider', 'cloud-folder'])).stdout).toContain('拒绝（no-such-provider）')
  })

  it('is the owner’s: refused in an agent’s session, before anything is made', async () => {
    const m = machine()
    const r = await m.run(['init', join(m.home, 'lib')], { CLAUDE_CODE_SESSION_ID: 'agent-session' })
    expect(r.stdout).toContain('拒绝（agent-session）')
    expect(existsSync(join(m.home, 'lib'))).toBe(false)
  })
})

describe('the configuration page', () => {
  it('has a section for storage: the providers, the one this library uses, and 安装别的存储…', async () => {
    const m = machine()
    const lib = join(m.home, 'lib')
    await m.run(['init', lib, '--bare'])
    const page = (await m.run(['show', 'config', '--library', lib])).stdout
    expect(page).toContain('## 存储')
    expect(page).toMatch(/local-folder .*随 pneuma-base 带着 \[这个库在用\]/)
    expect(page).toContain('$ storage install <owner/repo[@版本]>  # 安装别的存储…')
  })
})
