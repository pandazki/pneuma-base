// C9 and C10 in the UI: the library of the whole story, every plugin installed, seen and worked from
// the page. Every plugin's page is in the navigation; the deploy page lists the ten sites with their
// states and its switch puts one online, which an agent then sees in check; a site's panel gathers
// the ledger's provenance, the version timeline and the deploy section; the sync and search pages
// render.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, navTitles, openShared, tempDir, test, write, type Cli } from './support.ts'

const SITES: Record<string, string> = {
  coffee: '手冲咖啡：豆子、水温和研磨度',
  hiking: '登山路线：从山脚到山顶的三条路',
  books: '旧书交换：每月第一个周六',
  pets: '宠物医院：疫苗和体检',
  cycling: '城市骑行：周末的骑行路线',
  recipes: '家常菜谱：红烧肉和番茄炒蛋',
  photo: '摄影入门：光圈与快门',
  plants: '盆栽养护：浇水和光照',
  music: '古典音乐：巴赫入门',
  camping: '露营装备：帐篷和睡袋',
}

/** The story up to the owner's switches, through the command line: ten sites, three online, three archived, one versioned and changed, synced. */
function storyLibrary(pb: Cli): { lib: string; www: string } {
  const root = tempDir('pb-e2e-story-')
  const lib = join(root, 'lib')
  const www = join(root, 'www')
  const syncTarget = join(root, 'sync-target')
  mkdirSync(syncTarget)
  pb.run(['init', lib])
  for (const name of ['version', 'deploy', 'sync', 'search']) pb.run(['plugin', 'enable', name, '--library', lib])
  pb.run(['deploy', 'target', 'set', '--kind', 'dir', '--to', www, '--library', lib])
  pb.run(['sync', 'target', 'set', '--kind', 'dir', '--to', syncTarget, '--library', lib])
  pb.run(['search', 'embedding', 'set', '--kind', 'hash', '--library', lib])
  const agent = (as: string, args: string[]) => pb.run(['--library', lib, '--as', as, '--session', `${as}-1`, ...args], { cwd: root })
  agent('claude-code', ['start', '做十个小网站'])
  for (const [name, text] of Object.entries(SITES)) {
    write(root, `made/${name}/index.html`, `<!doctype html><title>${text}</title><h1>${text}</h1>\n`)
    agent('claude-code', ['put', join(root, 'made', name), '--to', `sites/${name}`, '--generated'])
    agent('claude-code', ['say', 'deployable', `sites/${name}`])
  }
  // The coffee site's panel shows its versions.
  agent('claude-code', ['say', 'versioned', 'sites/coffee'])
  for (const name of ['coffee', 'hiking', 'books']) pb.run(['--library', lib, 'deploy', 'on', `sites/${name}`])
  for (const name of ['plants', 'music', 'camping']) pb.run(['--library', lib, 'archive', `sites/${name}`])
  agent('codex', ['start', '把手冲咖啡那个网站的配色改一下'])
  write(root, 'codex/coffee/index.html', `<!doctype html><h1>${SITES.coffee}，换了深色配色</h1>\n`)
  agent('codex', ['put', join(root, 'codex/coffee'), '--to', 'sites/coffee', '--generated'])
  pb.run(['--library', lib, 'sync', 'now'])
  return { lib, www }
}

const served = (www: string) => (existsSync(www) ? readdirSync(www).filter((n) => !n.startsWith('.') && n !== 'index.json').sort() : [])

test('the whole story in the UI: every plugin’s page, the deploy switch, a site’s panel, sync and search', async ({ page, pb }) => {
  const { lib, www } = storyLibrary(pb)
  expect(served(www)).toEqual(['sites-books', 'sites-coffee', 'sites-hiking'])
  const { url } = await pb.view(lib)
  await page.goto(url)
  const nav = page.getByRole('navigation', { name: '导航' })
  const main = page.getByRole('main')
  const panel = page.getByRole('complementary', { name: '详情' })

  // Every plugin's page is in the navigation: the home page, the plugins' in configuration order, then the kernel's.
  expect(await navTitles(page)).toEqual(['首页', '库', '活动', '文件', 'Agent', '有版本的东西', '部署', '配置'])

  // The deploy page: the ten sites and their states.
  await nav.getByRole('button', { name: '部署' }).click()
  const sites = main.getByRole('region', { name: '可部署的东西' })
  await expect(sites.getByRole('row')).toHaveCount(11)
  const state = (name: string) => sites.getByRole('row', { name: new RegExp(`^(_archive/)?sites/${name}\\b`) })
  for (const name of ['coffee', 'hiking', 'books']) await expect(state(name)).toContainText('在线')
  // Offline is where a site rests until the owner turns it on: its row says no state.
  for (const name of ['pets', 'cycling', 'recipes', 'photo']) await expect(state(name)).not.toContainText(/在线|已归档|待发布/)
  for (const name of ['plants', 'music', 'camping']) await expect(state(name)).toContainText('已归档')

  // Turn pets on from the page: the target gets it, and an agent's check reports the owner's operation.
  await state('pets').getByRole('button', { name: '打开' }).click()
  await expect(page.getByRole('status')).toContainText('已打开 sites/pets')
  await expect(state('pets')).toContainText('在线')
  expect(served(www)).toEqual(['sites-books', 'sites-coffee', 'sites-hiking', 'sites-pets'])
  expect(readFileSync(join(www, 'sites-pets/index.html'), 'utf8')).toContain(SITES.pets)
  const check = pb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-code-2', 'check']).stdout
  expect(check).toMatch(/主人面的操作 deploy on：已打开 sites\/pets：在线/)
  await page.getByRole('status').getByRole('button', { name: '关闭' }).click()

  // A site's panel: the ledger's provenance, the version timeline and the deploy section together.
  await state('coffee').click()
  await expect(panel.getByTestId('panel-title')).toHaveText('coffee')
  const provenance = panel.getByRole('region', { name: '来历', exact: true })
  await expect(provenance).toContainText('做出来的')
  await expect(provenance).toContainText('做十个小网站')
  await expect(provenance.getByRole('region', { name: '留存' })).toBeVisible()
  const versions = panel.getByRole('region', { name: '版本', exact: true })
  await expect(versions).toContainText('第 2 版')
  await expect(versions).toContainText('第 1 版')
  const deploy = panel.getByRole('region', { name: '部署', exact: true })
  await expect(deploy).toContainText('在线')
  await expect(deploy).toContainText('sites-coffee')
  await panel.getByRole('button', { name: '关闭详情' }).click()

  // The sync and search pages render.
  await openShared(page, '配置', '同步')
  await expect(main.getByRole('heading', { name: '同步', exact: true })).toBeVisible()
  await expect(main).toContainText('sync-target')
  await expect(main.getByRole('button', { name: '现在同步' })).toBeVisible()
  await openShared(page, '配置', '查找')
  await expect(main.getByRole('heading', { name: '查找', exact: true })).toBeVisible()
  await expect(main).toContainText('hash')

  // Bundles on the files and archive pages: each site is one row.
  await nav.getByRole('button', { name: '文件' }).click()
  await main.getByRole('row', { name: /^sites/ }).dblclick()
  await expect(main.getByRole('row', { name: /coffee/ })).toContainText('1 项')
  await openShared(page, '文件', '归档区')
  await main.getByRole('row', { name: /^sites\// }).dblclick()
  await expect(main.getByRole('row')).toHaveCount(4) // the header and the three archived sites
})
