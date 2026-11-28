// The lifecycle on the owner's real PneumaSpace on Cloudflare, through the real command line: skipped
// unless PNEUMA_SPACE_CF_CREDENTIALS names its credentials file. Its one app is named
// `pbs-…` under a prefix of its own; at the end it is removed and purged, also when a step failed, and
// the test waits until the space no longer lists it. Each run uses two of the app's upload tickets.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { CREDENTIALS, freshPrefix, owner, unavailable } from './cf-live.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const why = await unavailable()

const site = async (sb: Sandbox, name: string, text: string) => {
  await mkdir(join(sb.work, name), { recursive: true })
  await writeFile(join(sb.work, name, 'index.html'), `<h1>${text}</h1>\n`)
  return name
}

describe.skipIf(why !== null)('the lifecycle on PneumaSpace on Cloudflare', () => {
  const prefix = freshPrefix()
  const app = `${prefix}-sites-demo`
  let sb: Sandbox
  let space: Awaited<ReturnType<typeof owner>>
  beforeAll(async () => {
    sb = await sandbox({ builtins: ['deploy'], cli })
    space = await owner()
  })
  // A purge waits for the app's last upload ticket to expire, three minutes after it was given.
  afterAll(async () => {
    await sb?.cleanup()
    if (space === undefined) return
    try {
      console.log(`removed and purged: ${(await space.purge(prefix)).join(', ') || 'nothing'}`)
      console.log(`apps on ${space.origin} now: ${(await space.names()).join(', ')}`)
    } finally {
      await space.close()
    }
  }, 360_000)
  const agent = (...args: string[]) => sb.agent('claude-code', 's1', [...args, '--json'])
  const space_ = (...args: string[]) => sb.owner(['deploy', ...args, '--json'])
  let url = ''

  it('target set reads the account from the credentials file, the key too, and stores no key', async () => {
    const set = await space_('target', 'set', '--kind', 'cloudflare', '--credentials', CREDENTIALS as string, '--prefix', prefix)
    assert.equal(set.json.outcome, 'done', set.stdout)
    assert.match(set.json.text, /账户密钥从凭据文件 .* 读，不存进库。$/)
    console.log(`target: ${set.json.text.split('。')[0]}`)
  })

  it('declared and switched on: release 1 answers at its address to a signed-in session', async () => {
    assert.equal((await agent('put', await site(sb, 'v1', 'one'), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal((await agent('say', 'deployable', 'sites/demo')).json.outcome, 'heard')
    const on = await space_('on', 'sites/demo')
    assert.equal(on.json.outcome, 'done', on.stdout)
    url = on.json.data.url
    assert.equal(url, `${space.origin}/apps/${app}/`)
    assert.equal(await space.browse(url), '200 <h1>one</h1>')
    const d = await space.detail(prefix, app)
    assert.equal(d.current.number, 1)
    assert.equal(d.manager.name, 'pneuma-base')
    console.log(`on: ${url} answers "<h1>one</h1>", release ${d.current.number}, managed by ${d.manager.name} (${d.manager.url})`)
  })

  it('changed content gives release 2', async () => {
    assert.equal((await agent('put', await site(sb, 'v2', 'two'), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal(await space.browse(url), '200 <h1>two</h1>')
    assert.equal((await space.detail(prefix, app)).current.number, 2)
    assert.equal(await space.tickets(prefix, app), 2)
    console.log('changed: release 2, 2 upload tickets used')
  })

  it('on with unchanged content uploads nothing', async () => {
    assert.equal((await space_('on', 'sites/demo')).json.outcome, 'done')
    assert.equal((await space.detail(prefix, app)).current.number, 2)
    assert.equal(await space.tickets(prefix, app), 2)
    console.log('unchanged: still release 2, still 2 tickets')
  })

  it('off: the app is removed, not purged, and its address says it is not active', async () => {
    assert.equal((await space_('off', 'sites/demo')).json.outcome, 'done')
    assert.equal(await space.browse(url), '409 inactive')
    assert.equal((await space.detail(prefix, app)).status, 'removed')
    console.log('off: removed; the address answers 409 inactive')
  })

  it('on again resumes it: release 2 again, no upload', async () => {
    assert.equal((await space_('on', 'sites/demo')).json.outcome, 'done')
    assert.equal(await space.browse(url), '200 <h1>two</h1>')
    const d = await space.detail(prefix, app)
    assert.deepEqual([d.status, d.current.number, await space.tickets(prefix, app)], ['registered', 2, 2])
    console.log('on again: registered, release 2, still 2 tickets')
  })

  it('archive takes it down and keeps its releases', async () => {
    assert.equal((await agent('archive', 'sites/demo')).json.outcome, 'accepted')
    const d = await space.detail(prefix, app)
    assert.deepEqual([d.status, d.releases.length], ['removed', 2])
    console.log('archive: removed, 2 releases kept')
  })
})
