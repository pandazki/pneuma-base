// Run 2 C5 over HTTP: an owner operation the page sends to the server's /api/call that is refused says
// why and leaves no fact in the ledger. That each operation from the page leaves a fact an agent's check
// reports is the browser's (packages/viewer/e2e/owner-operations.spec.ts); that a destructive call runs
// only with the page's confirmation and never in an agent session is packages/viewer/test/server.test.ts's.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from '@pneuma-base/viewer'
import { describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir } from './helpers.js'

describe('the owner’s operations from the page (C5)', () => {
  it('a refused operation says why and leaves no fact', async () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    const server = await startServer({ dir: lib, builtins: builtinPlugins, home: join(sb.home, '.pneuma-base'), env: {}, port: 0 })
    try {
      const call = { face: 'owner', command: 'ledger held restore', args: { positional: ['nothing.md'], flags: { to: ['x.md'] } } }
      const res = await fetch(`http://127.0.0.1:${server.port}/api/call`, { method: 'POST', headers: { 'x-pneuma-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ call, confirmed: false }) })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ tone: 'bad', result: { outcome: 'refused', reason: 'no-such-item' } })
    } finally {
      await server.close()
    }
    const dir = join(lib, '.pneuma-base/ledger/facts')
    const commands = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      .filter((f) => f.kind === 'owner.op')
      .map((f) => f.command)
    expect(commands).not.toContain('ledger held restore')
  })
})
