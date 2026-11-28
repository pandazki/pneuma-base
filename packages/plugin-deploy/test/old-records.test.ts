// A library the deploy plugin wrote before it was built on the kit, and before its commands and kinds
// were renamed, still loads: these records and this configuration are what that version wrote (two
// sites switched on, one moved), with only the target's directory replaced. They read as before, a
// target stored as `dir` or `machine` opens as `folder` or `self-hosted`, deploy sync finds nothing to
// change, and requests asked as `deploy on`, `deploy off` or with the old kinds run under the new names.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, type Actor, type Instant, type OwnerArgs, type Session } from '@pneuma-base/kernel'
import { expect, it } from 'vitest'
import { deploy } from '../src/index.js'

const WWW = '/OLD/www'
const RECORDS = {
  '20261125192056734-e48d2ccd.jsonl': [
    '{"id":"f_20261125192056734_8d1604_0000","at":"2026-11-25T19:20:56.734Z","actor":{"kind":"agent","name":"claude-code"},"session":"e1dedce1-47e1-46b4-8dbb-6ffac384e269","kind":"declare","thing":"d_71de9535ef","path":"sites/a","note":null}',
  ],
  '20261125192056814-8a50d121.jsonl': [
    '{"id":"f_20261125192056814_fb591b_0000","at":"2026-11-25T19:20:56.814Z","actor":{"kind":"agent","name":"claude-code"},"session":"6a49cdf3-bc02-4d6d-ab8c-6b7e1b8ec222","kind":"declare","thing":"d_d3aabd0ecc","path":"sites/b","note":null}',
  ],
  '20261125192056977-358ad3b2.jsonl': [
    '{"id":"f_20261125192056977_846fdb_0000","at":"2026-11-25T19:20:56.977Z","actor":{"kind":"owner","name":"owner"},"session":"0379593e-40b0-4afa-8caa-8dd93591223a","kind":"switch","thing":"d_71de9535ef","on":true}',
    '{"id":"f_20261125192056977_846fdb_0001","at":"2026-11-25T19:20:56.977Z","actor":{"kind":"owner","name":"owner"},"session":"0379593e-40b0-4afa-8caa-8dd93591223a","kind":"publish","thing":"d_71de9535ef","target":"dir:/OLD/www","site":"sites-a","fingerprint":"a51945fb25fc13ff20fad144a5bc01dc83441d17b58ff72bd2fbfe6f18e650bf","url":"file:///OLD/www/sites-a/"}',
  ],
  '20261125192057068-1d5282e2.jsonl': [
    '{"id":"f_20261125192057068_28d294_0000","at":"2026-11-25T19:20:57.068Z","actor":{"kind":"owner","name":"owner"},"session":"a1af893d-b1d2-4d80-82f1-70a259413a8d","kind":"switch","thing":"d_d3aabd0ecc","on":true}',
    '{"id":"f_20261125192057068_28d294_0001","at":"2026-11-25T19:20:57.068Z","actor":{"kind":"owner","name":"owner"},"session":"a1af893d-b1d2-4d80-82f1-70a259413a8d","kind":"publish","thing":"d_d3aabd0ecc","target":"dir:/OLD/www","site":"sites-b","fingerprint":"b690f32c131fb7b150ea7af69df8294e63b43a674a1c6fae5fb75ae68ddf92d3","url":"file:///OLD/www/sites-b/"}',
  ],
  '20261125192057158-7479328f.jsonl': [
    '{"id":"f_20261125192057158_227117_0000","at":"2026-11-25T19:20:57.158Z","actor":{"kind":"agent","name":"claude-code"},"session":"9a29e82f-f2d0-4af2-a85f-cc3d1a3accb1","kind":"move","thing":"d_d3aabd0ecc","from":"sites/b","to":"shop/b"}',
    '{"id":"f_20261125192057158_227117_0001","at":"2026-11-25T19:20:57.158Z","actor":{"kind":"agent","name":"claude-code"},"session":"9a29e82f-f2d0-4af2-a85f-cc3d1a3accb1","kind":"publish","thing":"d_d3aabd0ecc","target":"dir:/OLD/www","site":"shop-b","fingerprint":"b690f32c131fb7b150ea7af69df8294e63b43a674a1c6fae5fb75ae68ddf92d3","url":"file:///OLD/www/shop-b/"}',
    '{"id":"f_20261125192057158_227117_0002","at":"2026-11-25T19:20:57.158Z","actor":{"kind":"agent","name":"claude-code"},"session":"9a29e82f-f2d0-4af2-a85f-cc3d1a3accb1","kind":"unpublish","thing":"d_d3aabd0ecc","target":"dir:/OLD/www","site":"sites-b"}',
  ],
}
const CONFIG = `{\n  "format": 1,\n  "target": {\n    "kind": "dir",\n    "to": "/OLD/www"\n  }\n}\n`
/** A self-hosted PneumaSpace as the version before the rename stored it; nothing answers at its address. */
const MACHINE_CONFIG = `{\n  "format": 1,\n  "target": {\n    "kind": "machine",\n    "admin": "http://127.0.0.1:9",\n    "prefix": "old",\n    "public": null\n  }\n}\n`

/** A library with the two sites and the old records and configuration, and how to call its owner commands. */
async function oldLibrary(config = CONFIG) {
  const dir = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-old-')))
  const [root, home, www] = [join(dir, 'lib'), join(dir, 'home'), join(dir, 'www')]
  mkdirSync(www)
  const table = new Map([[deploy.name as string, deploy]])
  const owner: Actor = { kind: 'owner' }
  const session: Session = { id: 'old-records', source: 'flag', cwd: dir, machine: 'test', transcript: null }
  await initLibrary(root, { plugins: ['deploy'], table, actor: owner, session, home })
  const lib = await openLibrary(root, table)
  if (!lib) throw new Error('no library')
  const ctx = makeContext(lib, owner, session, home, new Date().toISOString() as Instant)
  for (const [path, text] of [['sites/a', '<h1>a</h1>\n'], ['shop/b', '<h1>b</h1>\n']] as const) {
    const src = join(dir, 'src', path)
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'index.html'), text)
    expect(await agentFace.put({ kind: 'place', from: { kind: 'directory', path: src }, to: path, origin: { kind: 'made', from: [], outside: [] } }, ctx)).toMatchObject({ outcome: 'accepted' })
  }
  const own = join(root, '.pneuma-base', 'deploy')
  mkdirSync(join(own, 'facts'), { recursive: true })
  for (const [name, lines] of Object.entries(RECORDS)) writeFileSync(join(own, 'facts', name), `${lines.join('\n').replaceAll(WWW, www)}\n`)
  writeFileSync(join(own, 'config.json'), config.replaceAll(WWW, www))
  const call = { ctx, table, env: {}, viaGrant: false, confirm: async () => false }
  const cmd = (name: string, positional: string[] = [], flags: OwnerArgs['flags'] = {}) => ownerFace.dispatch(call, name, { positional, flags })
  let asked = 0
  /** Approves a request an agent asked, arriving by sync, under the command's name and arguments then. */
  const approve = async (command: string, args: OwnerArgs) => {
    const request = `r-0ed0ed0${++asked}`
    const at = new Date().toISOString()
    const day = join(root, '.pneuma-base/requests/facts', at.slice(0, 10))
    mkdirSync(day, { recursive: true })
    const line = { request, kind: 'asked', at, by: { name: 'claude-code', grant: null }, session: 's1', why: '旧版本时的请求', command, args }
    writeFileSync(join(day, `${at.replace(/[^0-9]/g, '').slice(0, 17)}-othermachine-00000${asked}.jsonl`), `${JSON.stringify(line)}\n`)
    return cmd('request approve', [request])
  }
  return { dir, www, cmd, approve, ctx }
}

it('loads the records and the target an earlier version wrote, the target stored as dir opening as folder', async () => {
  const { www, cmd, ctx } = await oldLibrary()
  expect(await cmd('deploy list')).toMatchObject({
    outcome: 'done',
    data: [
      { path: 'shop/b', status: 'published', on: true, site: 'shop-b', url: `file://${www}/shop-b/` },
      { path: 'sites/a', status: 'published', on: true, site: 'sites-a', url: `file://${www}/sites-a/` },
    ],
  })
  expect(await cmd('deploy target list')).toMatchObject({ outcome: 'done', data: { connected: { kind: 'folder', label: www } } })
  expect(await cmd('deploy sync')).toMatchObject({ outcome: 'done', data: { changed: 0 } })
  expect((await agentFace.check({ since: null, includeArchived: false }, ctx)).sections.filter((s) => s.plugin === 'deploy')).toEqual([])
})

it('opens a self-hosted PneumaSpace stored as machine', async () => {
  const { cmd } = await oldLibrary(MACHINE_CONFIG)
  expect(await cmd('deploy target list')).toMatchObject({ outcome: 'done', data: { connected: { kind: 'self-hosted', label: '127.0.0.1:9' } } })
})

it('runs requests asked as deploy off and deploy on, and with the kinds dir and machine, under the names they have now', async () => {
  const { dir, cmd, approve } = await oldLibrary()
  const statusOf = async (path: string) => ((await cmd('deploy list')) as { data: { path: string; status: string }[] }).data.find((t) => t.path === path)?.status
  expect(await approve('deploy off', { positional: ['sites/a'], flags: {} })).toMatchObject({ outcome: 'done' })
  expect(await statusOf('sites/a')).toBe('unpublished')
  expect(await approve('deploy on', { positional: ['sites/a'], flags: {} })).toMatchObject({ outcome: 'done' })
  expect(await statusOf('sites/a')).toBe('published')
  const www2 = join(dir, 'www2')
  expect(await approve('deploy target set', { positional: [], flags: { kind: ['dir'], to: [www2] } })).toMatchObject({ outcome: 'done' })
  expect(await cmd('deploy target list')).toMatchObject({ data: { connected: { kind: 'folder', label: www2 } } })
  // Run as self-hosted, it asks the address, where nothing answers; under an unknown kind it would no longer fit.
  expect(await approve('deploy target set', { positional: [], flags: { kind: ['machine'], admin: ['http://127.0.0.1:9'] } })).toMatchObject({ outcome: 'refused', reason: 'unreachable' })
})
