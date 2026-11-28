// The 部署 page in each state a person meets it, and the panel of a site nobody declared: every button
// on it is printed by show as the command that does the same, beside the button's label. PneumaSpace is
// the stand-in of packages/plugin-deploy/test/fake-cloudflare.ts; the home, with the installation this
// machine made, is the sandbox's own. Reading the destinations is a reading: it changes nothing.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLibrary, ownerFace, type Action, type Block, type ViewResult } from '@pneuma-base/kernel'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { expect, it, onTestFinished } from 'vitest'
import { fakeCloudflare } from '../../plugin-deploy/test/fake-cloudflare.js'
import { commandOf } from '../dist/page.js'
import { builtinPlugins } from '../dist/plugins.js'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

type Shown = Extract<ViewResult, { outcome: 'shown' }>

/** A library with 部署, two sites put in by the owner, and the PneumaSpace on Cloudflare this machine installed. */
async function library(): Promise<{ sb: Sandbox; fake: ReturnType<typeof fakeCloudflare>; origin: string }> {
  const fake = fakeCloudflare()
  const sb = await sandbox({ builtins: ['deploy'], cli })
  onTestFinished(() => sb.cleanup())
  const origin = await sb.serve(fake.handler)
  const installed = join(sb.env.HOME as string, '.pneuma-space', 'hosts', 'space.example.com')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'owner.json'), JSON.stringify({ origin, account: fake.account, key: fake.key, tenantId: fake.tenant }))
  for (const name of ['shop', 'blog', 'docs']) {
    await mkdir(join(sb.work, name))
    await writeFile(join(sb.work, name, 'index.html'), `<h1>${name}</h1>`)
    expect((await sb.owner(['put', name, '--to', `sites/${name}`, '--brought'])).code).toBe(0)
  }
  return { sb, fake, origin }
}

function actionsIn(blocks: readonly Block[]): Action[] {
  return blocks.flatMap((b): Action[] => {
    if (b.kind === 'section') return [...actionsIn(b.blocks), ...b.actions]
    if (b.kind === 'actions') return b.actions
    if (b.kind === 'list') return b.items.flatMap((i) => [...i.actions, ...(i.toggle ? [i.toggle.action] : [])])
    return []
  })
}

/** The page as JSON and as show prints it; every button's command is in the words, beside its label. */
async function shown(sb: Sandbox, args: string[]): Promise<{ actions: Action[]; text: string; json: Shown }> {
  const json = (await sb.owner(['show', ...args, '--json'])).json as Shown
  const text = (await sb.owner(['show', ...args])).stdout
  const opened = await openLibrary(sb.library, builtinPlugins)
  const commands = ownerFace.commands(opened?.plugins ?? [])
  const actions = actionsIn(json.blocks)
  for (const action of actions) expect(text, action.label).toContain(`$ ${commandOf(action, commands)}  # ${action.label}`)
  return { actions, text, json }
}

const labels = (actions: Action[]) => actions.map((a) => a.label)

it('every button of 部署, connecting, putting online, waiting and taken down, and of the panel of a site nobody declared, is in show as its command', async () => {
  const { sb, fake } = await library()

  // Nothing connected: what this machine has, another PneumaSpace, and the loose kinds in the menu.
  const none = await shown(sb, ['deploy.sites'])
  expect(labels(none.actions)).toEqual(['连上', '连上…', '本地文件夹…', '自己的命令…'])
  expect(none.text).toContain('$ deploy target set --kind cloudflare --host space.example.com  # 连上（只给主人）')

  // Connected and empty: put one online, and the destination's menu.
  expect((await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--host', 'space.example.com'])).code).toBe(0)
  const empty = await shown(sb, ['deploy.sites'])
  expect(labels(empty.actions)).toEqual(['上线一样东西', '换一个…', '应用名前缀…', '断开'])

  // Three online, one of them changed from outside and its upload refused: 重试, and each row's switch.
  for (const name of ['shop', 'blog', 'docs']) expect((await sb.owner(['deploy', 'on', `sites/${name}`])).code).toBe(0)
  fake.state.failNextPut = true
  await writeFile(join(sb.library, 'sites/shop/index.html'), '<h1>新的小店</h1>')
  await sb.owner(['deploy', 'sync'])
  const three = await shown(sb, ['deploy.sites'])
  expect(labels(three.actions)).toEqual(['上线一样东西', '重试', '换一个…', '应用名前缀…', '断开', '下线', '下线', '下线'])
  expect(three.text).toMatch(/shop\s+\[待发布（.+）\]/)
  for (const name of ['shop', 'blog', 'docs']) expect(three.text).toContain(`/apps/library-sites-${name}/`)

  // Taken down, a site is nobody's to put online until the owner says so; its panel offers it.
  expect((await sb.owner(['deploy', 'off', 'sites/docs'])).code).toBe(0)
  await mkdir(join(sb.work, 'new'))
  await writeFile(join(sb.work, 'new', 'index.html'), '<h1>new</h1>')
  expect((await sb.owner(['put', 'new', '--to', 'sites/new', '--brought'])).code).toBe(0)
  const panel = await shown(sb, ['item', '--path', 'sites/new'])
  expect(labels(panel.actions)).toContain('上线…')
  expect(panel.text).toContain('$ deploy on sites/new  # 上线…（只给主人）；先问：把 new 发到 space.example.com？')
})

it('reading the destinations changes nothing: no file of the library or its records, no sign-in', async () => {
  const { sb, fake } = await library()
  const info = ownerFace.commands((await openLibrary(sb.library, builtinPlugins))?.plugins ?? []).find((c) => c.name === 'deploy target list')
  expect(info).toMatchObject({ readOnly: true, ownerOnly: false })
  const state = async () => {
    const entries = await readdir(sb.library, { recursive: true, withFileTypes: true })
    // The rows cache is not the library: opening it touches its files.
    const files = entries.filter((e) => e.isFile() && !e.parentPath.startsWith(join(sb.library, '.pneuma-base', 'cache'))).map((e) => join(e.parentPath, e.name)).sort()
    return Promise.all(files.map(async (f) => `${f.slice(sb.library.length)} ${(await stat(f)).mtimeMs} ${(await readFile(f)).toString('utf8').slice(0, 200)}`))
  }
  for (const connected of [false, true]) {
    if (connected) expect((await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--host', 'space.example.com'])).code).toBe(0)
    const before = await state()
    const logins = fake.state.logins
    const read = await sb.owner(['deploy', 'target', 'list'])
    expect(read.code).toBe(0)
    expect(read.stdout).toContain(connected ? '连着 space.example.com' : '这台机器上有 space.example.com')
    expect(await state()).toEqual(before)
    expect(fake.state.logins).toBe(logins)
  }
})
