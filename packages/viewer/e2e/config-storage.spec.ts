// The configuration page's storage section, with the commands behind its buttons: the providers this
// machine has, the one the library uses marked; installing a third-party one from a repository, which
// is refused until the owner accepts what a provider is, then asks with the checksum; and removing an
// installed one. The release comes from a stand-in for GitHub on this machine. Installing for real runs
// the contract suite on the program, about half a minute, which packages/cli/test/storage-providers.slow.test.ts
// does; here the page goes as far as that question, and the provider it removes is one whose registry
// entry the test writes, as storage install writes it last (packages/cli/test/pages.test.ts does the same).
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, tempDir, test, write } from './support.ts'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** One release of `repository`, laid out as GitHub serves it: its manifest and the program for this machine. */
async function releaseOf(repository: string, version: string, name: string, form: string, bytes: Buffer) {
  const base = `/${repository}/releases/download/${version}`
  const manifest = { format: 1, name, version, contract: 1, addresses: [form], summary: `${name}，只给测试用`, executables: { [`${process.platform}-${process.arch}`]: { asset: name, sha256: sha256(bytes) } } }
  const files = new Map<string, Buffer>([
    [`${base}/pneuma-base-provider.json`, Buffer.from(JSON.stringify(manifest))],
    [`${base}/${name}`, bytes],
  ])
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://host').pathname)
    const latest = path.replace(`/${repository}/releases/latest/download/`, `${base}/`)
    if (latest !== path) return void res.writeHead(302, { location: latest }).end()
    const body = files.get(path)
    if (body === undefined) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
}

test('storage on the configuration page: the provider in use, installing another through its buttons, and removing one', async ({ page, pb }) => {
  const bytes = Buffer.from('#!/bin/sh\n')
  const host = await releaseOf('acme/alpha-folder', 'v1.0.0', 'alpha-folder', 'alpha', bytes)
  try {
    const lib = join(tempDir(), 'lib')
    pb.run(['init', lib, '--bare'])
    const providers = join(pb.home, '.pneuma-base/storage/providers')
    write(providers, 'beta-folder/v1.0.0/beta-folder', '#!/bin/sh\n')
    write(
      providers,
      'beta-folder/provider.json',
      JSON.stringify({ format: 1, name: 'beta-folder', version: 'v1.0.0', contract: 1, addresses: ['beta'], executable: 'v1.0.0/beta-folder', sha256: '0'.repeat(64), official: false, installed: '2026-11-27T00:00:00.000Z', from: { repository: 'acme/beta-folder', tag: 'v1.0.0' } }),
    )
    const { url } = await pb.view(lib, { env: { PNEUMA_BASE_RELEASE_HOST: host.url } })
    await page.goto(`${url}#view=config`)
    const storage = page.getByRole('main').getByRole('region', { name: '存储', exact: true })
    const builtIn = storage.getByRole('row', { name: /^local-folder/ })
    await expect(builtIn).toContainText('本机路径')
    await expect(builtIn).toContainText('随 pneuma-base 带着')
    await expect(builtIn).toContainText('这个库在用')
    await expect(storage.getByRole('region', { name: '噪音' })).toBeVisible()
    const beta = storage.getByRole('row', { name: /^beta-folder/ })
    await expect(beta).toContainText('来自 acme/beta-folder')
    await expect(beta).not.toContainText('这个库在用')
    await expect(beta.getByRole('button', { name: '换新版本' })).toBeVisible()

    // Another from a repository: refused at first, the refusal saying what a provider is, with the checksum.
    await storage.getByRole('button', { name: '安装别的存储…' }).click()
    const form = page.getByRole('dialog')
    await form.getByRole('textbox').fill('acme/alpha-folder')
    await form.getByRole('button', { name: '安装别的存储…' }).click()
    const notices = page.getByRole('status')
    await expect(notices).toContainText(`存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。要装的是 acme/alpha-folder 的 v1.0.0，校验和 sha256:${sha256(bytes)}。`)
    // Accepting it asks for the same command with that checksum; cancelled, nothing is installed.
    await notices.getByRole('button', { name: '安装' }).click()
    await expect(page.getByRole('dialog')).toContainText(`sha256:${sha256(bytes)}`)
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(storage.getByRole('row', { name: /^alpha-folder/ })).toHaveCount(0)

    // Removing one asks first, then it is gone from the list.
    await beta.getByRole('button', { name: '卸掉' }).click()
    await expect(page.getByRole('dialog')).toContainText('卸掉存储提供者 beta-folder？')
    await page.getByRole('dialog').getByRole('button', { name: '卸掉' }).click()
    await expect(notices).toContainText('已卸下存储提供者 beta-folder v1.0.0。')
    await expect(beta).toHaveCount(0)
  } finally {
    await host.close()
  }
})
