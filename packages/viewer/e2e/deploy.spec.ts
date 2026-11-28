// 部署 as the owner meets it, with no command line: the PneumaSpace on Cloudflare this machine
// installed, found and connected in one press; one of the owner's own sites put online, followed after
// its content is changed from outside, and taken down; and another PneumaSpace connected with its key
// typed, which is then in no file of the library, no fact, no activity row and no page. PneumaSpace is
// the stand-in of packages/plugin-deploy/test/fake-cloudflare.ts, served from this process; the home is
// the test's own. Nothing publishes an edit made outside by itself: the page finds it when it asks
// again (every 60 seconds for this kind, on the page's clock) and offers 重试.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeCloudflare } from '../../plugin-deploy/test/fake-cloudflare.ts'
import { expect, frames, standIn, tempDir, test, write, type Cli } from './support.ts'

/** A fresh library with two of the owner's sites, each a directory thing. */
function twoSites(pb: Cli): string {
  const lib = join(tempDir(), 'lib')
  const work = tempDir('pb-e2e-sites-')
  pb.run(['init', lib])
  write(work, 'shop/index.html', '<h1>小店</h1>')
  write(work, 'blog/index.html', '<h1>博客</h1>')
  for (const name of ['shop', 'blog']) pb.run(['--library', lib, 'put', name, '--to', `sites/${name}`, '--brought'], { cwd: work })
  return lib
}

test('the owner connects the PneumaSpace this machine installed, puts a site online, sees it follow an edit made outside, and takes it down', async ({ page, pb }) => {
  const fake = fakeCloudflare()
  const control = await standIn(fake.handler)
  try {
    write(pb.home, '.pneuma-space/hosts/space.example.com/owner.json', JSON.stringify({ origin: control.url, account: fake.account, key: fake.key, tenantId: fake.tenant }))
    const lib = twoSites(pb)
    const { url } = await pb.view(lib)
    await page.clock.install()
    await page.goto(url)
    const nav = page.getByRole('navigation', { name: '导航' })
    const main = page.getByRole('main')
    const dialog = page.getByRole('dialog')
    const status = page.getByRole('status')

    await nav.getByRole('button', { name: '配置' }).click()
    await main.getByRole('region', { name: '插件' }).getByRole('switch', { name: '部署' }).click()
    await expect(status).toContainText('已装上插件 deploy')
    await nav.getByRole('button', { name: '部署' }).click()

    // Nothing connected: one region, what this machine has first.
    const where = main.getByRole('region', { name: '发到哪里' })
    await expect(where.getByRole('listitem')).toHaveText([/^space\.example\.com/, /^别的 PneumaSpace/])
    await where.getByRole('listitem').filter({ hasText: 'space.example.com' }).getByRole('button', { name: '连上' }).click()
    await expect(status).toContainText('已连上 space.example.com。')
    await expect(main.getByRole('listitem').filter({ hasText: 'space.example.com' })).toBeVisible()
    await expect(main).toContainText('还没有上线的东西')

    // One of the owner's sites, chosen, goes online in one act.
    await main.getByRole('button', { name: '上线一样东西' }).click()
    await dialog.getByRole('radio', { name: 'sites/shop' }).click()
    await dialog.getByRole('button', { name: '上线一样东西' }).click()
    const app = `${control.url}/apps/lib-sites-shop/`
    await expect(status).toContainText(`已上线 sites/shop → ${app}`)
    const shop = main.getByRole('listitem').filter({ hasText: 'lib-sites-shop' })
    await expect(shop.getByRole('link')).toHaveAttribute('href', app)
    await expect(shop.getByRole('switch', { name: 'shop' })).toHaveAttribute('aria-checked', 'true')
    expect((await fake.browse(app)).text).toBe('<h1>小店</h1>')

    // Changed from outside: when the page asks again, the row is 待发布, and the old content is online until 重试.
    writeFileSync(join(lib, 'sites/shop/index.html'), '<h1>新的小店</h1>')
    await page.clock.runFor(61_000)
    await expect(shop.getByText('待发布')).toBeVisible()
    expect((await fake.browse(app)).text).toBe('<h1>小店</h1>')
    await main.getByRole('button', { name: '重试' }).click()
    await expect(status).toContainText('已发布 sites/shop')
    await expect(shop.getByText('待发布')).toHaveCount(0)
    await expect(main.getByRole('button', { name: '重试' })).toHaveCount(0)
    expect((await fake.browse(app)).text).toBe('<h1>新的小店</h1>')

    // Taken down from its switch.
    await shop.getByRole('switch', { name: 'shop' }).click()
    await expect(status).toContainText('已下线 sites/shop。')
    expect((await fake.browse(app)).status).toBe(409)
  } finally {
    await control.stop()
  }
})

test('another PneumaSpace, connected with its key typed: the key is then in no file of the library, no fact, no activity row and no page', async ({ page, pb }) => {
  const fake = fakeCloudflare()
  const control = await standIn(fake.handler)
  try {
    const lib = join(tempDir(), 'lib')
    pb.run(['init', lib])
    pb.run(['plugin', 'add', 'deploy', '--library', lib])
    const { url } = await pb.view(lib)
    await page.goto(url)
    const nav = page.getByRole('navigation', { name: '导航' })
    const main = page.getByRole('main')
    const dialog = page.getByRole('dialog')
    const pages: string[] = []

    await nav.getByRole('button', { name: '部署' }).click()
    const where = main.getByRole('region', { name: '发到哪里' })
    await expect(where.getByRole('listitem')).toHaveText([/^PneumaSpace/])
    await where.getByRole('button', { name: '连上…' }).click()
    await expect(dialog.getByRole('radio', { name: 'Cloudflare 上的' })).toHaveAttribute('aria-checked', 'true')
    await dialog.getByLabel('地址').fill(control.url)
    await dialog.getByLabel('账户', { exact: true }).fill(fake.account)
    await expect(dialog.getByLabel('账户密钥')).toHaveAttribute('type', 'password')
    await dialog.getByLabel('账户密钥').fill(fake.key)
    await dialog.getByRole('button', { name: '连上', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(`已连上 ${new URL(control.url).host}。`)
    // The field held it while the dialog was open; once the dialog is gone the page holds it nowhere.
    await expect(page.locator('[role=dialog]')).toHaveCount(0)
    pages.push(await page.content())
    for (const entry of ['部署', '活动', '首页', '配置']) {
      await nav.getByRole('button', { name: entry }).click()
      await frames(page)
      await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
      pages.push(await page.content())
    }
    // Signed in once, to check the key; drawing pages with nothing online asks nothing.
    expect(fake.state.logins).toBe(1)

    const files = readdirSync(lib, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    expect(files.some((e) => e.parentPath.includes(join('.pneuma-base', 'deploy', 'facts')) || e.parentPath.includes(join('.pneuma-base', 'ledger')))).toBe(true)
    const activity = pb.run(['--library', lib, 'show', 'ledger.activity', '--json']).stdout
    expect(activity).toContain('target set')
    for (const [what, text] of [...files.map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), 'utf8')]), ['the activity', activity], ...pages.map((p, i) => [`page ${i}`, p])]) {
      expect(text.includes(fake.key), `${what}: ${text.slice(Math.max(0, text.indexOf(fake.key) - 300), text.indexOf(fake.key) + 80)}`).toBe(false)
    }
  } finally {
    await control.stop()
  }
})
