// The configuration page's storage section, with the commands behind its buttons: where the library is
// kept, its folder copied and, in the Mac app, shown in Finder; installing a third-party provider from
// a repository, which is refused until the owner accepts what a provider is, then asks with the
// checksum; and removing an installed one. The release comes from a stand-in for GitHub on this machine. Installing for real runs
// the contract suite on the program, about half a minute, which packages/cli/test/storage-providers.slow.test.ts
// does; here the page goes as far as that question, and the provider it removes is one whose registry
// entry the test writes, as storage install writes it last (packages/cli/test/pages.test.ts does the same).
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, fromMenu, tempDir, test, write } from './support.ts'

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

test('storage on the configuration page: where the library is kept, installing another through its 「···」, and removing one', async ({ page, pb }) => {
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
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`${url}#view=settings`)
    const storage = page.getByRole('main').getByRole('region', { name: '存储', exact: true })
    // One row: the library's folder by its name, the whole path on demand and to copy, and the provider in use.
    const kept = storage.getByRole('listitem').first()
    await expect(kept).toContainText('lib')
    await expect(kept).toContainText('本机文件夹')
    await expect(kept.locator('[data-tip]').first()).toHaveAttribute('data-tip', lib)
    await kept.getByRole('button', { name: '复制' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(lib)
    // Showing it in Finder is the Mac app's.
    await expect(kept.getByRole('button', { name: '在访达中显示' })).toHaveCount(0)
    // The noise, folded under it with its count, opens to a row per name; among so many rows, a row's
    // 「···」 shows while the pointer is on it, where the one row of storage keeps its own in sight.
    const noise = storage.getByRole('region', { name: '忽略规则' })
    await noise.getByRole('button', { name: '忽略规则' }).click()
    const git = noise.getByRole('listitem').filter({ hasText: '.git' }).first()
    await page.mouse.move(0, 0)
    await expect(git.locator('.actions')).toHaveCSS('opacity', '0')
    await expect(kept.locator('.actions')).toHaveCSS('opacity', '1')
    await git.hover()
    await expect(git.locator('.actions')).toHaveCSS('opacity', '1')
    await noise.getByRole('button', { name: '忽略规则' }).click()
    // The other providers' actions are in its 「···」, the dangerous last.
    await kept.getByRole('button', { name: '更多' }).click()
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['更新 beta-folder', '安装其他存储…', '卸载 beta-folder'])
    await page.keyboard.press('Escape')

    // Another from a repository: refused at first, the refusal saying what a provider is, with the checksum.
    await fromMenu(kept, '安装其他存储…')
    const form = page.getByRole('dialog')
    await form.getByRole('textbox').fill('acme/alpha-folder')
    await form.getByRole('button', { name: '安装其他存储…' }).click()
    const notices = page.getByRole('status')
    await expect(notices).toContainText(`存储提供者是以当前用户身份运行的程序，可访问资料库中的全部内容。将安装 acme/alpha-folder 的 v1.0.0，校验和 sha256:${sha256(bytes)}。`)
    // Accepting it asks for the same command with that checksum; cancelled, nothing is installed.
    await notices.getByRole('button', { name: '安装' }).click()
    await expect(page.getByRole('dialog')).toContainText(`sha256:${sha256(bytes)}`)
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Removing one asks first, then it is gone from the menu.
    await fromMenu(kept, '卸载 beta-folder')
    await expect(page.getByRole('dialog')).toContainText('卸载存储提供者 beta-folder？')
    await page.getByRole('dialog').getByRole('button', { name: '卸载 beta-folder' }).click()
    await expect(notices).toContainText('已卸载存储提供者 beta-folder v1.0.0。')
    await kept.getByRole('button', { name: '更多' }).click()
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['安装其他存储…'])
    await page.keyboard.press('Escape')

    // In the Mac app the row shows the folder in Finder, by asking the app.
    await page.addInitScript(() => {
      const sent: unknown[] = []
      ;(window as unknown as { sent: unknown[] }).sent = sent
      ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { shell: { postMessage: (m: unknown) => sent.push(m) } } }
    })
    await page.goto(`${url}&shell=mac#view=settings`)
    await kept.getByRole('button', { name: '在访达中显示' }).click()
    expect(await page.evaluate(() => (window as unknown as { sent: { type: string }[] }).sent.filter((m) => m.type === 'reveal-local'))).toEqual([{ type: 'reveal-local', path: lib }])
  } finally {
    await host.close()
  }
})
