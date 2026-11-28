// The Cloudflare kind through the real command line, against PneumaSpace on Cloudflare stood in for in
// memory (fake-cloudflare.ts): publishing, what is and is not uploaded, taking down and switching on
// again, the refusals made before any upload, a name someone else holds, a missing key, a publish
// whose upload failed, the sign-in of each run, the pages, and that the account key never lands in the
// library or in an answer.
import assert from 'node:assert/strict'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Block, ViewResult } from '@pneuma-base/sdk'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, it, onTestFinished } from 'vitest'
import type { BoardData } from '../src/views.js'
import { fakeCloudflare } from './fake-cloudflare.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

/** A site of `files` in the sandbox's working directory, ready to put in. */
async function site(sb: Sandbox, name: string, files: Record<string, string | Buffer>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(sb.work, name, path, '..'), { recursive: true })
    await writeFile(join(sb.work, name, path), content)
  }
  return name
}

/** Every file under a directory, as text. */
async function everything(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const texts = await Promise.all(entries.filter((e) => e.isFile()).map((e) => readFile(join(e.parentPath, e.name), 'utf8')))
  return texts.join('\n')
}

/** Every block of an answer, sections opened. */
const blocks = (r: ViewResult): Block[] => {
  const walk = (list: Block[]): Block[] => list.flatMap((b) => [b, ...(b.kind === 'section' ? walk(b.blocks) : [])])
  return r.outcome === 'shown' ? walk(r.blocks) : []
}

describe('the Cloudflare kind against a stand-in', () => {
  const fake = fakeCloudflare()
  let sb: Sandbox
  let origin = ''
  beforeAll(async () => {
    sb = await sandbox({ builtins: ['deploy'], cli })
    origin = await sb.serve(fake.handler)
  })
  afterAll(() => sb?.cleanup())
  const said: string[] = []
  const heard = <R extends { stdout: string; stderr: string }>(r: R) => (said.push(r.stdout, r.stderr), r)
  const agent = async (...args: string[]) => heard(await sb.agent('claude-code', 's1', [...args, '--json']))
  const owner = async (...args: string[]) => heard(await sb.owner([...args, '--json']))
  /** Runs `step` and returns how often it signed in; every sign-in is signed out by the end of its run. */
  const signIns = async (step: () => Promise<unknown>) => {
    const before = fake.state.logins
    await step()
    assert.equal(fake.state.logouts, fake.state.logins, 'a run left a session signed in')
    return fake.state.logins - before
  }
  const app = 'pbs-cf-sites-demo'
  const tickets = () => fake.app(app)?.tickets
  const live = () => fake.app(app)?.current
  let url = ''

  it('target set with a credentials file says the key comes from it, signs in nowhere and stores no key', async () => {
    await writeFile(join(sb.work, 'credentials.json'), JSON.stringify({ origin, account: fake.account, key: fake.key, tenantId: fake.tenant }))
    const set = await owner('deploy', 'target', 'set', '--kind', 'cloudflare', '--credentials', join(sb.work, 'credentials.json'), '--prefix', 'pbs-cf')
    assert.equal(set.json.outcome, 'done', set.stdout)
    assert.match(set.json.text, /部署目标已设为 Cloudflare 上的 PneumaSpace http:\/\/127\.0\.0\.1:\d+，账户 demo，应用名前缀 pbs-cf。账户密钥从凭据文件 .*credentials\.json 读，不存进库。$/)
    assert.equal(fake.state.logins, 0)
  })

  it('on: release 1 at the app’s address, each file served with its type, managed by pneuma-base for this library', async () => {
    const files = { 'index.html': '<h1>one</h1>\n', 'style.css': 'h1{color:red}', 'font.woff2': Buffer.from([0x77, 0x4f, 0x46, 0x32]), 'photo.jpg': Buffer.from([0xff, 0xd8, 0xff]) }
    assert.equal((await agent('put', await site(sb, 'v1', files), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal((await agent('say', 'deployable', 'sites/demo')).json.outcome, 'heard')
    assert.equal((await agent('deploy', 'on', 'sites/demo')).json.outcome, 'refused')
    const n = await signIns(async () => {
      const on = await owner('deploy', 'on', 'sites/demo')
      assert.equal(on.json.outcome, 'done', on.stdout)
      url = on.json.data.url
    })
    assert.equal(n, 1, 'one sign-in for the whole command')
    assert.equal(url, `${origin}/apps/${app}/`)
    assert.deepEqual(await fake.browse(url), { status: 200, type: 'text/html; charset=utf-8', text: '<h1>one</h1>' })
    assert.equal((await fake.browse(`${url}font.woff2`)).type, 'font/woff2')
    assert.equal((await fake.browse(`${url}photo.jpg`)).type, 'image/jpeg')
    assert.equal((await fake.browse(`${url}style.css`)).type, 'text/css; charset=utf-8')
    const viewer = await sb.viewer()
    const library = (await viewer.state()).library?.id
    await viewer.stop()
    assert.deepEqual(fake.app(app)?.manager, { name: 'pneuma-base', url: `https://pneuma-base.invalid/library/${library}` })
    assert.deepEqual([live(), tickets()], [1, 1])
  })

  it('unchanged content uploads nothing, through sync or the switch', async () => {
    assert.equal((await owner('deploy', 'sync')).json.data.changed, 0)
    assert.equal((await owner('deploy', 'on', 'sites/demo')).json.outcome, 'done')
    assert.deepEqual([live(), tickets(), fake.app(app)?.releases.length], [1, 1, 1])
  })

  it('changed content makes release 2 with one upload', async () => {
    assert.equal((await agent('put', await site(sb, 'v2', { 'index.html': '<h1>two</h1>\n' }), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal((await fake.browse(url)).text, '<h1>two</h1>')
    assert.deepEqual([live(), tickets()], [2, 2])
  })

  it('off removes the app and never purges it; on again resumes it with no upload', async () => {
    assert.equal((await owner('deploy', 'off', 'sites/demo')).json.outcome, 'done')
    assert.equal(fake.app(app)?.status, 'removed')
    assert.equal((await fake.browse(url)).status, 409)
    assert.equal((await owner('deploy', 'list')).json.data[0].status, 'offline')
    assert.equal((await owner('deploy', 'on', 'sites/demo')).json.outcome, 'done')
    assert.equal((await fake.browse(url)).text, '<h1>two</h1>')
    assert.deepEqual([fake.app(app)?.status, live(), tickets()], ['registered', 2, 2])
  })

  it('content put back to what an earlier release had comes back as a new release with no upload', async () => {
    assert.equal((await agent('put', await site(sb, 'v1b', { 'index.html': '<h1>one</h1>\n', 'style.css': 'h1{color:red}', 'font.woff2': Buffer.from([0x77, 0x4f, 0x46, 0x32]), 'photo.jpg': Buffer.from([0xff, 0xd8, 0xff]) }), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal((await fake.browse(url)).text, '<h1>one</h1>')
    assert.deepEqual([live(), tickets()], [3, 2])
  })

  it('more than 256 files or more than 4 MiB is refused before anything is sent, with the number and the limit', async () => {
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p${i}.html`, `<p>${i}</p>`]))
    assert.equal((await agent('put', await site(sb, 'many', { 'index.html': '<h1>many</h1>', ...many }), '--to', 'sites/many', '--made')).json.outcome, 'accepted')
    await agent('say', 'deployable', 'sites/many')
    const tooMany = await owner('deploy', 'on', 'sites/many')
    assert.equal(tooMany.json.reason, 'publish-failed', tooMany.stdout)
    assert.match(tooMany.json.text, /站点有 258 个文件，Cloudflare 上的 PneumaSpace 一个应用最多收 256 个/)
    assert.equal(fake.app('pbs-cf-sites-many'), undefined)
    assert.equal((await agent('put', await site(sb, 'big', { 'index.html': '<h1>big</h1>', 'video.mp4': Buffer.alloc(3.5 * 1024 * 1024, 1) }), '--to', 'sites/big', '--made')).json.outcome, 'accepted')
    await agent('say', 'deployable', 'sites/big')
    const tooBig = await owner('deploy', 'on', 'sites/big')
    assert.match(tooBig.json.text, /站点打包后 4\.67 MiB，Cloudflare 上的 PneumaSpace 一个包最多 4 MiB/, tooBig.stdout)
    assert.equal(fake.app('pbs-cf-sites-big'), undefined)
    await owner('deploy', 'off', 'sites/many')
    await owner('deploy', 'off', 'sites/big')
  })

  it('a name another manager or another space holds is refused in any state, and its details are never read', async () => {
    const theirs = fake.seed('pbs-cf-sites-shared', { manager: { name: 'another-deployer', url: 'https://deployer.example.com/' } })
    fake.seed('pbs-cf-sites-elsewhere', { manager: null, tenant: 't_other' })
    for (const path of ['sites/shared', 'sites/elsewhere']) {
      await agent('put', await site(sb, path.slice(6), { 'index.html': '<h1>mine</h1>' }), '--to', path, '--made')
      await agent('say', 'deployable', path)
    }
    const shared = await owner('deploy', 'on', 'sites/shared')
    assert.match(shared.json.text, /应用名 pbs-cf-sites-shared 在 PneumaSpace 上已经有了：它归 another-deployer 管理，不是这个库的，所以不动它/, shared.stdout)
    theirs.status = 'removed'
    assert.match((await owner('deploy', 'on', 'sites/shared')).json.text, /它归 another-deployer 管理/)
    assert.equal((await owner('deploy', 'off', 'sites/shared')).json.outcome, 'done')
    assert.equal(theirs.status, 'removed')
    assert.match((await owner('deploy', 'on', 'sites/elsewhere')).json.text, /这个名字被这个 PneumaSpace 上别的空间的应用占着/)
    assert.equal(fake.state.detailsRead.get('pbs-cf-sites-shared'), undefined)
    const item = await (await sb.viewer()).item('sites/shared', { plugin: 'deploy' })
    assert.ok(blocks(item).some((b) => b.kind === 'text' && b.tone === 'bad' && b.text.includes('它归 another-deployer 管理')))
    await owner('deploy', 'off', 'sites/elsewhere')
  })

  it('a publish whose upload failed leaves the site as it was, pending until deploy sync', async () => {
    fake.state.failNextPut = true
    const put = await agent('put', await site(sb, 'v4', { 'index.html': '<h1>four</h1>\n' }), '--to', 'sites/demo', '--made')
    assert.equal(put.json.outcome, 'accepted', put.stdout)
    assert.ok(put.json.problems.some((p: { message: string }) => p.message.includes('上传 pbs-cf-sites-demo 的包被拒绝：503')), put.stdout)
    assert.equal((await fake.browse(url)).text, '<h1>one</h1>')
    assert.equal(live(), 3)
    assert.match((await agent('inspect', 'sites/demo')).stdout, /待发布/)
    assert.equal((await owner('deploy', 'sync')).json.outcome, 'done')
    assert.equal((await fake.browse(url)).text, '<h1>four</h1>')
    assert.equal(live(), 4)
  })

  it('the pages: no framed preview, who can see the site, the upload allowance, a board card without a preview', async () => {
    const viewer = await sb.viewer()
    const page = await viewer.view('deploy.sites')
    assert.equal(page.outcome === 'shown' && page.refresh, 60)
    assert.deepEqual(page.outcome === 'shown' && page.problems, [])
    const item = await viewer.item('sites/demo', { plugin: 'deploy' })
    assert.deepEqual(item.outcome === 'shown' && item.problems, [])
    assert.equal(blocks(item).some((b) => b.kind === 'embed'), false)
    assert.ok(blocks(item).some((b) => b.kind === 'text' && b.text.startsWith(`这个地址只有登录了 ${origin} 的账户看得到`)))
    const fields = blocks(item).flatMap((b) => (b.kind === 'fields' ? b.fields : []))
    assert.equal(fields.find((f) => f.label === '地址')?.value.href, url)
    // Four tickets: release 1, release 2, the upload that failed, and its retry.
    assert.match(fields.find((f) => f.label === '上传额度')?.value.text ?? '', /^用了 4\/200 次，包合计 \d+\.\d KiB\/10\.0 MiB$/)
    assert.equal(fields.find((f) => f.label === '版本')?.value.text, '第 4 版')
    const board = blocks(await viewer.view('deploy.board')).find((b) => b.kind === 'custom')
    assert.ok(board?.kind === 'custom')
    const data = board.data as BoardData
    assert.match(data.visible ?? '', /只有登录了/)
    assert.deepEqual(data.cards.map((c) => [c.path, c.url, c.release]), [['sites/demo', url, 4]])
    await viewer.stop()
  })

  it('archive takes the site down and keeps its releases', async () => {
    assert.equal((await agent('archive', 'sites/demo')).json.outcome, 'accepted')
    assert.equal(fake.app(app)?.status, 'removed')
    assert.equal(fake.app(app)?.releases.length, 4)
  })

  it('every run signed out, and the key is in no answer and no file of the library', async () => {
    assert.equal(fake.state.logouts, fake.state.logins)
    assert.ok(!said.join('\n').includes(fake.key))
    assert.ok(!(await everything(sb.library)).includes(fake.key))
  })
})

it('a missing key: target set says what to run, on refuses saying it, and the secret makes it work', async () => {
  const fake = fakeCloudflare()
  const sb = await sandbox({ builtins: ['deploy'], cli })
  onTestFinished(() => sb.cleanup())
  const origin = await sb.serve(fake.handler)
  const set = await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--origin', origin, '--account', 'demo', '--prefix', 'pbs-key', '--json'])
  assert.match(set.json.text, /还没有 Cloudflare 上的 PneumaSpace 的账户密钥：运行 pneuma-base secret set deploy key 设它（值从标准输入读），或者重设目标时用 --credentials 给 PneumaSpace 的凭据文件。$/, set.stdout)
  await mkdir(join(sb.work, 'shop'))
  await writeFile(join(sb.work, 'shop', 'index.html'), '<h1>店</h1>')
  await sb.agent('claude-code', 's1', ['put', 'shop', '--to', 'sites/shop', '--made'])
  await sb.agent('claude-code', 's1', ['say', 'deployable', 'sites/shop'])
  const on = await sb.owner(['deploy', 'on', 'sites/shop', '--json'])
  assert.equal(on.json.reason, 'publish-failed', on.stdout)
  assert.match(on.json.text, /pneuma-base secret set deploy key/)
  assert.equal(fake.state.logins, 0)
  assert.equal((await sb.run(['secret', 'set', 'deploy', 'key'], { input: fake.key })).code, 0)
  const again = await sb.owner(['deploy', 'on', 'sites/shop', '--json'])
  assert.equal(again.json.outcome, 'done', again.stdout)
  assert.equal((await fake.browse(again.json.data.url)).text, '<h1>店</h1>')
  const reset = await sb.owner(['deploy', 'target', 'set', '--kind', 'cloudflare', '--origin', origin, '--account', 'demo', '--prefix', 'pbs-key', '--json'])
  assert.match(reset.json.text, /账户密钥用这台机器上设的密钥 key。$/)
  assert.ok(![set, on, again, reset].some((r) => (r.stdout + r.stderr).includes(fake.key)))
  assert.ok(!(await everything(sb.library)).includes(fake.key))
})
