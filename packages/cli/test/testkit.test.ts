// The test kit's sandbox as a plugin's tests use it: a stand-in for an outside HTTP service that lives
// as long as the sandbox, and the item panel narrowed to one plugin's section.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sandbox } from '@pneuma-base/sdk/testkit'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

describe('the sandbox', () => {
  it('serves a stand-in for an outside HTTP service from a handler, which sees each request whole, until the sandbox is cleaned up', async () => {
    const sb = await sandbox({ cli, bare: true })
    const seen: string[] = []
    const url = await sb.serve(async (request) => {
      const { pathname, search } = new URL(request.url)
      seen.push(`${request.method} ${pathname}${search} ${request.headers.get('authorization')} ${await request.text()}`)
      return Response.json({ ok: true }, { status: 201, headers: { 'x-stand-in': 'yes' } })
    })
    const reply = await fetch(`${url}/api/apps?x=1`, { method: 'POST', headers: { authorization: 'Bearer t0ken' }, body: '你好' })
    expect([reply.status, reply.headers.get('x-stand-in'), await reply.json()]).toEqual([201, 'yes', { ok: true }])
    expect(seen).toEqual(['POST /api/apps?x=1 Bearer t0ken 你好'])
    await sb.cleanup()
    await expect(fetch(url, { signal: AbortSignal.timeout(5000) })).rejects.toThrow()
  })

  it('gives the item panel of a path, or only one plugin’s section of it with that plugin’s problems', async () => {
    const sb = await sandbox({ cli, builtins: ['deploy'] })
    try {
      mkdirSync(join(sb.work, 'shop'))
      writeFileSync(join(sb.work, 'shop', 'index.html'), '<h1>小店</h1>\n')
      expect((await sb.agent('claude-code', 's1', ['put', 'shop', '--to', 'sites/shop', '--made'])).code).toBe(0)
      expect((await sb.agent('claude-code', 's1', ['say', 'deployable', 'sites/shop'])).code).toBe(0)
      const viewer = await sb.viewer()

      const whole = await viewer.item('sites/shop')
      const sections = whole.outcome === 'shown' ? whole.blocks.flatMap((b) => (b.kind === 'section' && b.plugin !== undefined ? [b.plugin] : [])) : []
      expect(sections).toEqual(['ledger', 'deploy'])

      const deploy = await viewer.item('sites/shop', { plugin: 'deploy' })
      expect(deploy).toMatchObject({ outcome: 'shown', title: '部署', problems: [] })
      const fields = deploy.outcome === 'shown' ? deploy.blocks.find((b) => b.kind === 'fields') : undefined
      // Offline is where a thing rests: unsaid on the page, still in the value the text form prints.
      expect(fields?.kind === 'fields' && fields.fields.find((f) => f.label === '状态')?.value).toEqual({ text: '离线', muted: true, normal: true })

      expect(await viewer.item('sites/shop', { plugin: 'search' })).toMatchObject({ outcome: 'shown', blocks: [], problems: [] })
    } finally {
      await sb.cleanup()
    }
  })
})
