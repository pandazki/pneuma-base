// A library the deploy plugin wrote before it was built on the kit still loads: these records and
// this configuration are what that version wrote (two sites switched on, one moved), with only the
// target's directory replaced. They read as before, and deploy sync finds nothing to change.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFace, initLibrary, makeContext, openLibrary, ownerFace, type Actor, type Instant, type Session } from '@pneuma-base/kernel'
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

it('loads the records and the target an earlier version wrote', async () => {
  const dir = realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-old-')))
  const [root, home, www] = [join(dir, 'lib'), join(dir, 'home'), join(dir, 'www')]
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
  writeFileSync(join(own, 'config.json'), CONFIG.replaceAll(WWW, www))

  const call = { ctx, table, env: {}, viaGrant: false, confirm: async () => false }
  const list = await ownerFace.dispatch(call, 'deploy list', { positional: [], flags: {} })
  expect(list).toMatchObject({
    outcome: 'done',
    text: `目标：${www}\nshop/b  在线  file://${www}/shop-b/\nsites/a  在线  file://${www}/sites-a/`,
    data: [
      { path: 'shop/b', status: 'online', on: true, site: 'shop-b' },
      { path: 'sites/a', status: 'online', on: true, site: 'sites-a' },
    ],
  })
  expect(await ownerFace.dispatch(call, 'deploy sync', { positional: [], flags: {} })).toMatchObject({ outcome: 'done', data: { changed: 0 } })
  expect((await agentFace.check({ since: null, includeArchived: false }, ctx)).sections.filter((s) => s.plugin === 'deploy')).toEqual([])
})
