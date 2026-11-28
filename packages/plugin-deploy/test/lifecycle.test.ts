// The whole lifecycle against a real PneumaSpace, through the real command line. The target is set to
// a pass-through proxy in front of the stack, so one publish can be cut after its bundle is uploaded
// and before its release is made. Skipped unless SPACE_ADMIN names a PneumaSpace that answers (stack.ts).
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { ADMIN, api, freshPrefix, purge, unreachable } from './stack.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const down = await unreachable()

/**
 * Forwards every call to the stack and keeps the `authorization` headers it saw; with `cutNextRelease`
 * set, drops the next `PUT …/release` unanswered.
 */
async function proxy(): Promise<{ url: string; cutNextRelease: boolean; authorizations: Set<string>; close: () => Promise<void> }> {
  const state = { url: '', cutNextRelease: false, authorizations: new Set<string>(), close: async () => {} }
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.headers.authorization) state.authorizations.add(req.headers.authorization)
    if (state.cutNextRelease && req.method === 'PUT' && req.url?.endsWith('/release')) {
      state.cutNextRelease = false
      req.socket.destroy()
      return
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))) as Record<string, string>
    const upstream = await fetch(ADMIN + req.url, { method: req.method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port')
  state.url = `http://127.0.0.1:${address.port}`
  state.close = () => new Promise((resolve) => server.close(() => resolve()))
  return state
}

const site = async (sb: Sandbox, name: string, text: string) => {
  await mkdir(join(sb.work, name), { recursive: true })
  await writeFile(join(sb.work, name, 'index.html'), `<h1>${text}</h1>\n`)
  return name
}
const served = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  return `${r.status} ${(await r.text()).trim()}`
}

describe.skipIf(down !== null)('the lifecycle against PneumaSpace', () => {
  const prefix = freshPrefix()
  const app = `${prefix}-sites-demo`
  let front: Awaited<ReturnType<typeof proxy>>
  let sb: Sandbox
  let other: Sandbox
  beforeAll(async () => {
    front = await proxy()
    sb = await sandbox({ builtins: ['deploy'], cli })
    other = await sandbox({ builtins: ['deploy'], cli })
  })
  afterAll(async () => {
    await Promise.all([sb?.cleanup(), other?.cleanup(), front?.close()])
    await purge(prefix)
  })
  const agent = (...args: string[]) => sb.agent('claude-code', 's1', [...args, '--json'])
  const owner = (...args: string[]) => sb.owner([...args, '--json'])
  const detail = async () => (await api('GET', `/api/apps/${app}`)).body
  let url = ''

  it('an agent declares a site, and cannot switch it on', async () => {
    assert.equal((await agent('put', await site(sb, 'v1', 'one'), '--to', 'sites/demo', '--made')).code, 0)
    assert.equal((await agent('say', 'deployable', 'sites/demo')).json.outcome, 'heard')
    assert.equal((await agent('deploy', 'on', 'sites/demo')).json.outcome, 'refused')
    assert.equal((await owner('deploy', 'target', 'set', '--kind', 'machine', '--admin', front.url, '--prefix', prefix)).json.outcome, 'done')
  })

  it('on: release 1, managed by pneuma-base, owned by this library, with the token as a bearer', async () => {
    assert.equal((await sb.run(['secret', 'set', 'deploy', 'token'], { input: 't0ken' })).code, 0)
    const on = await owner('deploy', 'on', 'sites/demo')
    assert.equal(on.json.outcome, 'done', on.stdout)
    url = on.json.data.url
    assert.equal(await served(url), '200 <h1>one</h1>')
    const d = await detail()
    assert.equal(d.app.current, 1)
    assert.deepEqual(d.app.manager, { name: 'pneuma-base', url: null })
    const viewer = await sb.viewer()
    assert.equal(d.app.owner, `service:pneuma-base.${(await viewer.state()).library?.id}`)
    await viewer.stop()
    assert.deepEqual([...front.authorizations], ['Bearer t0ken'])
  })

  it('changed content gives release 2', async () => {
    assert.equal((await agent('put', await site(sb, 'v2', 'two'), '--to', 'sites/demo', '--made')).json.outcome, 'accepted')
    assert.equal(await served(url), '200 <h1>two</h1>')
    assert.equal((await detail()).app.current, 2)
  })

  it('off gives 404, and on again restores release 2', async () => {
    assert.equal((await owner('deploy', 'off', 'sites/demo')).json.outcome, 'done')
    assert.match(await served(url), /^404/)
    assert.equal((await detail()).app.status, 'removed')
    assert.equal((await owner('deploy', 'on', 'sites/demo')).json.outcome, 'done')
    assert.equal(await served(url), '200 <h1>two</h1>')
    assert.equal((await detail()).app.current, 2)
  })

  it('a publish cut after the upload is pending until deploy sync', async () => {
    front.cutNextRelease = true
    const put = await agent('put', await site(sb, 'v3', 'three'), '--to', 'sites/demo', '--made')
    assert.equal(put.json.outcome, 'accepted', put.stdout)
    assert.ok(put.json.problems.some((p: { message: string }) => p.message.includes('deploy sync')), put.stdout)
    assert.equal(await served(url), '200 <h1>two</h1>')
    assert.match((await agent('inspect', 'sites/demo')).stdout, /待发布/)
    const sync = await owner('deploy', 'sync')
    assert.equal(sync.json.outcome, 'done', sync.stdout)
    assert.equal(await served(url), '200 <h1>three</h1>')
    assert.equal((await detail()).app.current, 3)
  })

  it('an app removed behind the plugin’s back comes back with deploy sync', async () => {
    await api('POST', `/api/apps/${app}/remove`)
    assert.match(await served(url), /^404/)
    assert.match((await agent('inspect', 'sites/demo')).stdout, /待发布/)
    assert.equal((await agent('deploy', 'sync')).json.outcome, 'done')
    assert.equal(await served(url), '200 <h1>three</h1>')
    assert.equal((await detail()).app.current, 3)
    const again = await owner('deploy', 'sync')
    assert.equal(again.json.data.changed, 0, again.stdout)
  })

  it('archive takes it down and keeps its releases', async () => {
    assert.equal((await agent('archive', 'sites/demo')).json.outcome, 'accepted')
    assert.match(await served(url), /^404/)
    const d = await detail()
    assert.equal(d.app.status, 'removed')
    assert.equal(d.releases.length, 3)
  })

  it('a name another library owns is refused, online or removed', async () => {
    const taken = `${prefix}-sites-shared`
    for (const [box, text] of [[other, 'theirs'], [sb, 'mine']] as const) {
      assert.equal((await box.agent('claude-code', 's1', ['put', await site(box, 'shared', text), '--to', 'sites/shared', '--made'])).code, 0)
      await box.agent('claude-code', 's1', ['say', 'deployable', 'sites/shared'])
      await box.owner(['deploy', 'target', 'set', '--kind', 'machine', '--admin', ADMIN, '--prefix', prefix])
    }
    assert.equal((await other.owner(['deploy', 'on', 'sites/shared', '--json'])).json.outcome, 'done')
    const theirs = (await api('GET', `/api/apps/${taken}`)).body.app
    const mine = await owner('deploy', 'on', 'sites/shared')
    assert.match(JSON.stringify(mine.json), /属于 service:pneuma-base\./, mine.stdout)
    assert.deepEqual((await api('GET', `/api/apps/${taken}`)).body.app, theirs)
    assert.equal((await other.owner(['deploy', 'off', 'sites/shared', '--json'])).json.outcome, 'done')
    await owner('deploy', 'sync')
    const after = (await api('GET', `/api/apps/${taken}`)).body.app
    assert.equal(after.status, 'removed')
    assert.equal(after.owner, theirs.owner)
  })
})
