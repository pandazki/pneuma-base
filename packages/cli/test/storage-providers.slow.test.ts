// Installing storage providers for real (ARCHITECTURE.md「存储」; PROVIDERS.md): each
// install runs the whole contract suite against the program, about half a minute. A good provider
// installs once the owner accepts it; a library created at an address it answers is served by it, the
// door choosing by address, while a folder stays the local folder's; updating is vetted again; one that
// fails a sentence of STORAGE.md is refused; an official one installs with no trust statement; removing
// one names the libraries that used it. Releases come from a stand-in host on this machine.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './helpers.js'
import { manifestFor, providerScript, releaseHost, runCli, sha256, type ReleaseHost } from './storage-host.js'

let host: ReleaseHost
beforeAll(async () => {
  host = await releaseHost()
})
afterAll(() => host.close())

describe('storage providers, installed and used', () => {
  const home = tempDir('pb-storage-slow-')
  const pbHome = join(home, '.pneuma-base')
  const log = join(home, 'test-folder.log')
  const official = join(home, 'official.json')
  const run = (args: string[]) => runCli(home, args, { PNEUMA_BASE_RELEASE_HOST: host.url, PNEUMA_BASE_OFFICIAL_PROVIDERS: official })
  const release = (repository: string, name: string, version: string, bytes: Buffer, latest = true) =>
    host.publish({ repository, manifest: manifestFor({ name, version, form: 'testfs', asset: name, bytes }), assets: { [name]: bytes }, latest })
  writeFileSync(
    official,
    JSON.stringify({
      format: 1,
      providers: [
        { name: 'local-folder', summary: '本机文件夹', addresses: ['path'], repository: 'example/pneuma-base', version: null, builtIn: true, sha256: {} },
        { name: 'kept-folder', summary: '官方的测试提供者', addresses: ['keptfs'], repository: 'example/kept-folder', version: 'v1.0.0', builtIn: false, sha256: {} },
      ],
    }),
  )

  const v1 = providerScript({ name: 'test-folder', form: 'testfs', log, note: 'v1' })
  const v2 = providerScript({ name: 'test-folder', form: 'testfs', log, note: 'v2' })
  const testLib = `testfs://${join(home, 'served-by-test-folder')}`
  const pathLib = join(home, 'a-folder')

  it('installs a provider the owner accepted, after its checksum and the contract suite', async () => {
    release('acme/test-folder', 'test-folder', 'v1.0.0', v1)
    const r = await run(['storage', 'install', 'acme/test-folder', '--checksum', sha256(v1)])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^已装上存储提供者 test-folder v1\.0\.0（来自 acme\/test-folder，地址：testfs，契约 1）。契约测试：\d+ 项过/)
    const listed = (await run(['storage', 'list', '--json'])).json().data.providers
    expect(listed.map((p: { name: string }) => p.name)).toEqual(['local-folder', 'test-folder'])
    expect(listed[1]).toMatchObject({ version: 'v1.0.0', contract: 1, addresses: ['testfs'], sha256: sha256(v1), origin: { kind: 'repository', repository: 'acme/test-folder', tag: 'v1.0.0' }, official: false })
    expect(readFileSync(listed[1].executable)).toEqual(v1)
  })

  it('the door chooses by address: a testfs:// library is served by test-folder, a folder by the local folder', async () => {
    writeFileSync(log, '')
    expect((await run(['init', testLib, '--bare', '--json'])).json().data).toEqual({ root: testLib, provider: 'test-folder' })
    writeFileSync(join(home, 'note.md'), '# 放进 testfs 的库\n')
    const put = await run(['--library', testLib, 'put', join(home, 'note.md'), '--to', 'notes/note.md', '--brought'])
    expect(put.code, put.stdout + put.stderr).toBe(0)
    expect((await run(['--library', testLib, 'inspect', 'notes/note.md'])).stdout).toContain('notes/note.md')
    expect(readFileSync(join(home, 'served-by-test-folder/notes/note.md'), 'utf8')).toBe('# 放进 testfs 的库\n')
    expect(readFileSync(log, 'utf8')).toContain(`serve --root ${testLib}`)

    writeFileSync(log, '')
    expect((await run(['init', pathLib, '--bare', '--json'])).json().data).toEqual({ root: pathLib, provider: 'local-folder' })
    expect((await run(['--library', pathLib, 'put', join(home, 'note.md'), '--to', 'note.md', '--brought'])).code).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('')
  })

  it('updating is the owner’s act, vetted again: the trust statement names the new version', async () => {
    release('acme/test-folder', 'test-folder', 'v2.0.0', v2)
    const asked = await run(['storage', 'update', 'test-folder'])
    expect(asked.stdout).toContain('拒绝（not-confirmed）')
    expect(asked.stdout).toContain(`要把 test-folder v1.0.0 换成 acme/test-folder 的 v2.0.0，校验和 sha256:${sha256(v2)}。`)
    const r = await run(['storage', 'update', 'test-folder', '--checksum', sha256(v2)])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^已把存储提供者 test-folder 从 v1\.0\.0 换成 v2\.0\.0.*契约测试：\d+ 项过/)
    expect(existsSync(join(pbHome, 'storage/providers/test-folder/v1.0.0'))).toBe(false)
    expect((await run(['--library', testLib, 'inspect', 'notes/note.md'])).code).toBe(0)
    expect((await run(['storage', 'update', 'test-folder'])).stdout).toBe('test-folder 已经是 v2.0.0。\n')
  })

  it('refuses a provider that fails a sentence of the contract, and leaves nothing installed', async () => {
    const broken = providerScript({ name: 'broken-folder', form: 'testfs', log: join(home, 'broken.log'), breaks: 'probe' })
    host.publish({ repository: 'acme/broken-folder', manifest: manifestFor({ name: 'broken-folder', version: 'v1.0.0', form: 'testfs', asset: 'broken-folder', bytes: broken }), assets: { 'broken-folder': broken }, latest: true })
    const r = await run(['storage', 'install', 'acme/broken-folder', '--checksum', sha256(broken)])
    expect(r.code).toBe(2)
    expect(r.stdout).toMatch(/拒绝（contract-unmet）：没有装：契约测试有 \d+ 项没过：/)
    expect(r.stdout).toContain('probe')
    expect(existsSync(join(pbHome, 'storage/providers/broken-folder'))).toBe(false)
  })

  it('an official provider installs by the same mechanism, with no trust statement, its checksum from the official list', async () => {
    const kept = providerScript({ name: 'kept-folder', form: 'keptfs', log: join(home, 'kept.log') })
    host.publish({ repository: 'example/kept-folder', manifest: manifestFor({ name: 'kept-folder', version: 'v1.0.0', form: 'keptfs', asset: 'kept-folder', bytes: kept }), assets: { 'kept-folder': kept } })
    const list = JSON.parse(readFileSync(official, 'utf8'))
    list.providers[1].sha256 = { [`${process.platform}-${process.arch}`]: sha256(kept) }
    writeFileSync(official, JSON.stringify(list))
    expect((await run(['storage', 'list'])).stdout).toContain('kept-folder v1.0.0 · 地址：keptfs · pneuma-base storage install example/kept-folder')
    const r = await run(['storage', 'install', 'example/kept-folder'])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).not.toContain('以你的身份运行')
    expect((await run(['storage', 'list'])).stdout).toMatch(/^kept-folder v1\.0\.0 · 来自 example\/kept-folder · 官方 · 地址：keptfs/m)
  })

  it('removing a provider names the libraries that used it; they cannot be opened without it', async () => {
    const r = await run(['storage', 'remove', 'test-folder'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`已卸下存储提供者 test-folder v2.0.0。\n用它的库：${testLib}\n`)
    expect(existsSync(join(pbHome, 'storage/providers/test-folder'))).toBe(false)
    const after = await run(['--library', testLib, 'inspect', 'notes/note.md'])
    expect(after.code).toBe(1)
    expect(after.stderr).toContain(`库 ${testLib} 用的存储提供者 test-folder 不在这台机器上`)
    expect((await run(['storage', 'remove', 'local-folder'])).stdout).toContain('拒绝（built-in）')
  })
})
