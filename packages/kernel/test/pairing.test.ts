// Pairing as the local endpoint calls it: `requestPairing` and `pairingAnswer`, with the clock in the
// caller's hand. The command line's side is in packages/cli/test/pairing.test.ts.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { instant, pairingAnswer, recordEndpoint, requestPairing, type PairRequest } from '../src/index.js'
import { fixture, tempDir } from './support.js'

const at = (minutes: number) => instant(Date.UTC(2026, 10, 26, 12, minutes))

async function setup(): Promise<{ home: string; root: string; req: (product: string, minutes?: number) => PairRequest }> {
  const f = await fixture()
  const home = tempDir('pb-k-pair-')
  return { home, root: f.root, req: (product, minutes = 0) => ({ home, library: f.root, product, why: '想接上', via: 'http', now: at(minutes) }) }
}

describe('requestPairing over HTTP', () => {
  it('tells the agent to poll the endpoint’s address when one runs for the library', async () => {
    const { home, root, req } = await setup()
    await recordEndpoint(home, { url: 'http://127.0.0.1:7639', port: 7639, pid: process.pid, library: root, at: at(0) })
    const r = await requestPairing(req('claude-code'))
    if (r.outcome !== 'requested') throw new Error(r.text)
    expect(r.pairing.via).toBe('http')
    expect(r.text).toContain(`http://127.0.0.1:7639/pair/${r.pairing.id}`)
    expect(r.text).toContain(r.pairing.code)
  })

  it('lets five wait at once on this machine and no more, and one product once per library, when requests come together', async () => {
    const many = await setup()
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => requestPairing(many.req(p))))
    expect(results.filter((r) => r.outcome === 'requested').length).toBe(5)
    expect(results.filter((r) => r.outcome === 'refused' && r.reason === 'too-many').length).toBe(2)
    const one = await setup()
    const same = await Promise.all([1, 2, 3].map(() => requestPairing(one.req('h'))))
    expect(new Set(same.map((r) => (r.outcome === 'requested' ? r.pairing.id : r.reason))).size).toBe(1)
    expect(same.filter((r) => r.outcome === 'requested' && !r.again).length).toBe(1)
  })
})

describe('pairingAnswer', () => {
  it('is waiting for ten minutes, then expired; another product may ask once one expired', async () => {
    const { home, req } = await setup()
    const r = await requestPairing(req('codex'))
    if (r.outcome !== 'requested') throw new Error(r.text)
    expect((await pairingAnswer(home, r.pairing.id, at(9)))?.state).toBe('waiting')
    const expired = await pairingAnswer(home, r.pairing.id, at(10))
    expect(expired).toMatchObject({ state: 'expired', connected: null, declined: null })
    expect(expired?.text).toContain('过期')
    const again = await requestPairing(req('codex', 11))
    expect(again.outcome === 'requested' && again.pairing.id).not.toBe(r.pairing.id)
  })

  it('is null for an id it does not have, or one that is no pairing id', async () => {
    const { home, req } = await setup()
    const r = await requestPairing(req('codex'))
    if (r.outcome !== 'requested') throw new Error(r.text)
    expect(await pairingAnswer(home, r.pairing.id, at(0))).not.toBeNull()
    expect(await pairingAnswer(home, 'p-00000000', at(0))).toBeNull()
    expect(await pairingAnswer(home, join('..', 'grants', 'x'), at(0))).toBeNull()
  })
})
