// The configuration page's storage section, with the commands behind its buttons: the providers this
// machine has, the one the library uses marked, and installing a third-party one from a repository,
// which is refused until the owner accepts what a provider is, then vetted and listed with its own
// buttons. The release comes from a stand-in for GitHub on this machine; installing runs the contract suite.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, tempDir, test } from './support.ts'

const CORE = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A test-only provider: the local folder's own program, describing itself as `name`, answering addresses of the form `form`. */
const providerScript = (name: string, form: string) =>
  Buffer.from(
    [
      '#!/bin/sh',
      `core='${CORE}'`,
      'if [ "$1" = describe ]; then',
      '  shift',
      `  "$core" describe "$@" | sed -e 's/"name":"local-folder"/"name":"${name}"/' -e 's/"addresses":\\["path"\\]/"addresses":["${form}"]/'`,
      '  exit 0',
      'fi',
      'exec "$core" "$@"',
      '',
    ].join('\n'),
  )

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

test('storage on the configuration page: the provider in use, and installing and removing another through its buttons', async ({ page, pb }) => {
  test.setTimeout(180_000)
  const bytes = providerScript('alpha-folder', 'alpha')
  const host = await releaseOf('acme/alpha-folder', 'v1.0.0', 'alpha-folder', 'alpha', bytes)
  try {
    const lib = join(tempDir(), 'lib')
    pb.run(['init', lib, '--bare'])
    const { url } = await pb.view(lib, { env: { PNEUMA_BASE_RELEASE_HOST: host.url } })
    await page.goto(`${url}#view=config`)
    const storage = page.getByRole('main').getByRole('region', { name: '存储', exact: true })
    const builtIn = storage.getByRole('row', { name: /^local-folder/ })
    await expect(builtIn).toContainText('本机路径')
    await expect(builtIn).toContainText('随 pneuma-base 带着')
    await expect(builtIn).toContainText('这个库在用')
    await expect(storage.getByRole('region', { name: '噪音' })).toBeVisible()

    // Another from a repository: refused at first, the refusal saying what a provider is, with the checksum.
    await storage.getByRole('button', { name: '安装别的存储…' }).click()
    const form = page.getByRole('dialog')
    await form.getByRole('textbox').fill('acme/alpha-folder')
    await form.getByRole('button', { name: '安装别的存储…' }).click()
    const notices = page.getByRole('status')
    await expect(notices).toContainText(`存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。要装的是 acme/alpha-folder 的 v1.0.0，校验和 sha256:${sha256(bytes)}。`)
    // Accepting it runs the same command with that checksum; the contract suite vets the program first.
    await notices.getByRole('button', { name: '安装' }).click()
    await expect(page.getByRole('dialog')).toContainText(`sha256:${sha256(bytes)}`)
    await page.getByRole('dialog').getByRole('button', { name: '安装' }).click()
    await expect(notices).toContainText('已装上存储提供者 alpha-folder v1.0.0', { timeout: 120_000 })
    const alpha = storage.getByRole('row', { name: /^alpha-folder/ })
    await expect(alpha).toContainText('来自 acme/alpha-folder')
    await expect(alpha).not.toContainText('这个库在用')
    await expect(alpha.getByRole('button', { name: '换新版本' })).toBeVisible()

    // Removing it asks first, then it is gone from the list.
    await alpha.getByRole('button', { name: '卸掉' }).click()
    await expect(page.getByRole('dialog')).toContainText('卸掉存储提供者 alpha-folder？')
    await page.getByRole('dialog').getByRole('button', { name: '卸掉' }).click()
    await expect(notices).toContainText('已卸下存储提供者 alpha-folder v1.0.0。')
    await expect(alpha).toHaveCount(0)
  } finally {
    await host.close()
  }
})
