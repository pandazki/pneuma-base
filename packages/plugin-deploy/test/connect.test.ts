// Connecting a PneumaSpace through the real command line, against the stand-ins (fake-cloudflare.ts,
// fake-space.ts) and a temporary home: what this machine has, connected in one command; a key typed
// hidden, kept on this machine and nowhere in the library, a record or an answer; a destination that
// does not answer, which stores nothing; the prefix the library's folder gives; the page a site needs
// at its top.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { it, onTestFinished } from 'vitest'
import { fakeCloudflare } from './fake-cloudflare.js'
import { fakeSpace } from './fake-space.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

async function fresh(): Promise<Sandbox> {
  const sb = await sandbox({ builtins: ['deploy'], cli })
  onTestFinished(() => sb.cleanup())
  return sb
}

/** A site of `files`, put in by an agent at `path` and declared deployable. */
async function site(sb: Sandbox, path: string, files: Record<string, string>): Promise<void> {
  const dir = join(sb.work, path.replaceAll('/', '-'))
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  for (const args of [['put', dir, '--to', path, '--made'], ['say', 'deployable', path]]) assert.equal((await sb.agent('claude-code', 's1', args)).code, 0)
}

/** Every file under a directory, as text. */
async function everything(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return (await Promise.all(entries.filter((e) => e.isFile()).map((e) => readFile(join(e.parentPath, e.name), 'utf8')))).join('\n')
}

const configOf = (sb: Sandbox) => join(sb.library, '.pneuma-base/deploy/config.json')

it('finds a PneumaSpace installed from this machine and connects it in one command; each publish reads the key from its file again; the prefix comes from the library’s folder', async () => {
  const fake = fakeCloudflare()
  const sb = await fresh()
  const origin = await sb.serve(fake.handler)
  const hosts = join(sb.env.HOME as string, '.pneuma-space', 'hosts')
  const owner = join(hosts, 'space.example.com', 'owner.json')
  await mkdir(join(hosts, 'space.example.com'), { recursive: true })
  await writeFile(owner, JSON.stringify({ origin, account: fake.account, key: fake.key, tenantId: fake.tenant }))
  // Not an installation: a folder without owner.json, a hidden folder, a file.
  await mkdir(join(hosts, 'empty.example.com'))
  await mkdir(join(hosts, '.cache'))
  await writeFile(join(hosts, 'notes.txt'), 'x')

  const list = await sb.owner(['deploy', 'target', 'list', '--json'])
  assert.deepEqual(list.json.data, { connected: null, found: [{ kind: 'cloudflare', label: 'space.example.com', values: { host: 'space.example.com' } }] })
  const set = await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--host', 'space.example.com', '--json'])
  assert.equal(set.json.text, '已连上 space.example.com。', set.stdout)
  assert.deepEqual([fake.state.logins, fake.state.logouts], [1, 1])
  assert.deepEqual(JSON.parse(await readFile(configOf(sb), 'utf8')), {
    format: 1,
    target: { kind: 'cloudflare', host: 'space.example.com', origin, account: fake.account, prefix: 'library', tenant: fake.tenant },
    given: { host: 'space.example.com' },
  })

  await site(sb, 'sites/shop', { 'index.html': '<h1>店</h1>' })
  const on = await sb.owner(['deploy', 'on', 'sites/shop', '--json'])
  assert.equal(on.json.text, `已上线 sites/shop → ${origin}/apps/library-sites-shop/`, on.stdout)
  assert.equal((await fake.browse(on.json.data.url)).text, '<h1>店</h1>')

  await writeFile(owner, JSON.stringify({ origin, account: fake.account, key: 'not-the-key', tenantId: fake.tenant }))
  await writeFile(join(sb.library, 'sites/shop/index.html'), '<h1>新店</h1>')
  const sync = await sb.owner(['deploy', 'sync', '--json'])
  assert.match(sync.json.text, /账户或密钥不对/, sync.stdout)
  assert.equal((await fake.browse(on.json.data.url)).text, '<h1>店</h1>')
})

it('a key typed when connecting is checked, kept on this machine, and in no file of the library and no answer; none, or a wrong one, connects nothing', async () => {
  const fake = fakeCloudflare()
  const sb = await fresh()
  const origin = await sb.serve(fake.handler)
  const said: string[] = []
  const set = async (input?: string) => {
    const r = await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--origin', origin, '--account', fake.account, '--json'], input === undefined ? {} : { input })
    said.push(r.stdout, r.stderr)
    return r
  }
  assert.deepEqual((await set()).json, { outcome: 'refused', reason: 'no-key', text: '没有账户密钥。', problems: [] })
  const wrong = await set('not-the-key\n')
  assert.equal(wrong.json.reason, 'unreachable')
  assert.match(wrong.json.text, /拒绝了账户 demo 的登录：账户或密钥不对。$/)
  assert.equal(existsSync(configOf(sb)), false)

  const right = await set(`${fake.key}\n`)
  assert.equal(right.json.text, `已连上 ${new URL(origin).host}。`, right.stdout)
  await site(sb, 'sites/shop', { 'index.html': '<h1>店</h1>' })
  // Kept on this machine: the publish needs nothing typed.
  const on = await sb.owner(['deploy', 'on', 'sites/shop', '--json'])
  said.push(on.stdout, on.stderr)
  assert.equal(on.json.outcome, 'done', on.stdout)
  assert.ok(!said.join('\n').includes(fake.key))
  assert.ok(!(await everything(sb.library)).includes(fake.key))
  assert.ok(!(await readFile(configOf(sb), 'utf8')).includes('key'))
})

it('a destination that does not answer as PneumaSpace is refused in one sentence, and nothing is stored', async () => {
  const sb = await fresh()
  const nothing = await sb.serve(() => new Response('not here', { status: 404 }))
  const refused = await sb.owner(['deploy', 'target', 'set', '--kind', 'machine', '--admin', nothing, '--json'])
  assert.deepEqual([refused.json.reason, refused.json.text], ['unreachable', `${nothing} 不是 PneumaSpace 的管理地址。`])
  assert.equal(existsSync(configOf(sb)), false)
  const admin = await sb.serve(fakeSpace())
  assert.equal((await sb.owner(['deploy', 'target', 'set', '--kind', 'machine', '--admin', admin, '--json'])).json.text, `已连上 ${new URL(admin).host}。`)
})

it('both kinds of PneumaSpace refuse a site with no index.html at its top, before anything is sent', async () => {
  const fake = fakeCloudflare()
  let admin = ''
  /** Each kind: how it is connected, and how many apps its stand-in holds. */
  const kinds: [string, (sb: Sandbox) => Promise<string[]>, () => Promise<number>][] = [
    [
      'machine',
      async (sb) => ['--admin', (admin = await sb.serve(fakeSpace()))],
      async () => ((await (await fetch(`${admin}/api/apps`)).json()) as unknown[]).length,
    ],
    [
      'cloudflare',
      async (sb) => {
        await writeFile(join(sb.work, 'credentials.json'), JSON.stringify({ origin: await sb.serve(fake.handler), account: fake.account, key: fake.key }))
        return ['--credentials', join(sb.work, 'credentials.json')]
      },
      async () => (fake.app('library-sites-home') === undefined ? 0 : 1),
    ],
  ]
  for (const [kind, flags, apps] of kinds) {
    const sb = await fresh()
    assert.equal((await sb.owner(['deploy', 'target', 'set', '--kind', kind, ...(await flags(sb))])).code, 0)
    await site(sb, 'sites/home', { 'home.html': '<h1>家</h1>' })
    const on = await sb.owner(['deploy', 'on', 'sites/home', '--json'])
    assert.deepEqual([on.json.reason, on.json.text], ['publish-failed', '已打开 sites/home 的开关，没能发布：站点顶上没有 index.html。'], kind)
    assert.equal(await apps(), 0, kind)
  }
})
