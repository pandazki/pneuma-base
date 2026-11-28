// C3, the relay. Session A (claude-code, directory X) puts four brought-in files and two made
// ones, says what it is doing and records a decision. Session B (codex, directory Y, told nothing)
// learns all of it from start, find and inspect, puts back a file made from A's output, and inspect
// leads from B's file step by step back to A's brought-in sources. How start, find and inspect lay
// out their text is agent-text.test.ts's; a find by origin is packages/plugin-ledger/test/find.test.ts's.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let dirA: string
let dirB: string

const A = (args: string[], input?: string) => sb.run(['@claude', ...args, '--session', 'sess-a'], { cwd: dirA, ...(input === undefined ? {} : { input }) })
const B = (args: string[], input?: string) => sb.run(['@codex', ...args], { cwd: dirB, env: { PNEUMA_BASE_SESSION: 'sess-b' }, ...(input === undefined ? {} : { input }) })

// Text answers show a long working directory as its last 45 characters after an ellipsis.
const shown = (dir: string) => (dir.length > 48 ? `…${dir.slice(-45)}` : dir)

const ok = (r: { code: number; stdout: string; stderr: string }) => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

const DOING = '给电子书小店选支付服务'
const DECIDED = '主人决定用 Paddle，因为它替他处理欧洲的税'
const OUTSIDE = '主人在对话里说：客户主要在欧洲'
const SOURCES = {
  'payments/sources/stripe-pricing.html': 'https://stripe.com/pricing',
  'payments/sources/paddle-pricing.html': 'https://www.paddle.com/pricing',
  'payments/sources/lemonsqueezy-pricing.html': 'https://www.lemonsqueezy.com/pricing',
}

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  dirA = tempDir('pb-dir-a-')
  dirB = tempDir('pb-dir-b-')
  ok(sb.run(['init', lib]))
  ok(sb.run(['grant', 'create', 'claude', '--library', lib, '--agent', 'claude-code']))
  ok(sb.run(['grant', 'create', 'codex', '--library', lib, '--agent', 'codex']))

  writeFileSync(join(dirA, 'stripe.html'), '<html>Stripe pricing: 2.9% + 30c</html>')
  writeFileSync(join(dirA, 'paddle.html'), '<html>Paddle pricing: 5% + 50c, merchant of record</html>')
  writeFileSync(join(dirA, 'eu-vat.txt'), 'EU VAT applies to e-books sold to EU customers.')
  writeFileSync(join(dirA, 'comparison.md'), '# 支付服务对比\n\nStripe、Paddle、Lemon Squeezy 的费率和欧洲增值税的处理。\n')
  writeFileSync(join(dirA, 'recommendation.md'), '# 建议\n\n电子书小店的支付用 Paddle。\n')

  ok(A(['start', DOING]))
  ok(A(['put', 'stripe.html', '--to', 'payments/sources/stripe-pricing.html', '--imported', '--source', SOURCES['payments/sources/stripe-pricing.html']]))
  ok(A(['put', 'paddle.html', '--to', 'payments/sources/paddle-pricing.html', '--imported', '--source', SOURCES['payments/sources/paddle-pricing.html']]))
  ok(A(['put', '-', '--to', 'payments/sources/lemonsqueezy-pricing.html', '--imported', '--source', SOURCES['payments/sources/lemonsqueezy-pricing.html']], '<html>Lemon Squeezy: 5% + 50c</html>'))
  ok(A(['put', 'eu-vat.txt', '--to', 'payments/sources/eu-vat-note.txt', '--imported', '--by', 'owner']))
  ok(A(['put', 'comparison.md', '--to', 'payments/comparison.md', '--generated', '--from', ...Object.keys(SOURCES), '--from-external', OUTSIDE]))
  ok(A(['put', 'recommendation.md', '--to', 'payments/recommendation.md', '--generated', '--from', 'payments/comparison.md', 'payments/sources/eu-vat-note.txt']))
  ok(A(['say', 'decision', DECIDED]))
})

describe('session B, told nothing', () => {
  it('start tells it what session A did, where, why, and what it decided, and finds the related things', () => {
    const json = B(['start', '把支付服务接进电子书小店', '--json']).json()
    // That start was a look; the text asks from the same moment the look did, as a start would.
    const text = ok(B(['check', '--since', '2000-01-01T00:00:00Z'])).stdout + ok(B(['find', '把支付服务接进电子书小店'])).stdout
    for (const readable of ['sess-a', 'claude-code', shown(dirA), DOING, DECIDED, 'payments/comparison.md', 'payments/sources/stripe-pricing.html']) expect(text).toContain(readable)

    const since = json.check.sections.find((s: any) => s.title === '自上次以来')
    const sceneA = since.data.scenes.find((s: any) => s.scene === 'sess-a')
    expect(sceneA).toMatchObject({ actors: ['claude-code'], cwds: [dirA] })
    expect(sceneA.facts.filter((f: any) => f.kind === 'item.enter')).toHaveLength(6)
    const related = json.find.hits.filter((h: any) => h.by === 'ledger')
    expect(related.map((h: any) => h.title)).toContain('场景 sess-a')
    expect(related.map((h: any) => h.path)).toEqual(expect.arrayContaining(['payments/recommendation.md', 'payments/comparison.md']))
    expect(related.map((h: any) => h.title)).not.toContain('场景 sess-b')
  })

  it('inspect gives who, when, where, what for, the basis and its state, what built on it, and the decision; of a scene, its card', () => {
    const text = ok(B(['inspect', 'payments/comparison.md'])).stdout
    for (const readable of ['做出来的', 'claude-code', shown(dirA), '场景 sess-a', `当时在做：${DOING}`, `库外：${OUTSIDE}`, '被依据：payments/recommendation.md', `决定：${DECIDED}`]) {
      expect(text).toContain(readable)
    }
    for (const source of Object.keys(SOURCES)) expect(text).toMatch(new RegExp(`${source}\\s+一致`))

    const data = B(['inspect', 'payments/comparison.md', '--json']).json().sections[0].data
    expect(data).toMatchObject({
      kind: 'item',
      path: 'payments/comparison.md',
      origin: { kind: 'generated' },
      entered: { scene: 'sess-a', actor: { kind: 'agent', name: 'claude-code' }, where: { cwd: dirA, sessionSource: 'flag' } },
      doing: DOING,
      outside: [OUTSIDE],
      dependents: [{ path: 'payments/recommendation.md' }],
    })
    expect(data.basis.map((b: any) => [b.path, b.state])).toEqual(Object.keys(SOURCES).map((p) => [p, 'consistent']))

    const card = ok(B(['inspect', 'sess-a'])).stdout
    for (const readable of ['claude-code', shown(dirA), DOING, DECIDED, 'payments/recommendation.md']) expect(card).toContain(readable)
  })

  it('puts back a file made from A’s output; inspect leads step by step back to A’s brought-in sources; A, coming back later, sees in start what B did', () => {
    writeFileSync(join(dirB, 'integration.md'), '# 接入 Paddle\n')
    ok(B(['put', 'integration.md', '--to', 'payments/integration-notes.md', '--generated', '--from', 'payments/recommendation.md']))

    const text = ok(B(['inspect', 'payments/integration-notes.md'])).stdout
    for (const readable of ['做出来的', 'codex', shown(dirB), '场景 sess-b']) expect(text).toContain(readable)
    expect(text).toMatch(/payments\/recommendation\.md\s+一致/)

    const own = B(['inspect', 'payments/integration-notes.md', '--json']).json().sections[0].data
    expect(own.entered).toMatchObject({ scene: 'sess-b', actor: { name: 'codex' }, where: { cwd: dirB, sessionSource: 'env' } })

    // Follow the basis, one inspect per step, until only brought-in things remain.
    const brought = new Map<string, string | null>()
    const seen = new Set<string>()
    const walk = (path: string): void => {
      if (seen.has(path)) return
      seen.add(path)
      const data = B(['inspect', path, '--json']).json().sections[0].data
      if (data.origin.kind === 'imported') brought.set(path, data.origin.source)
      for (const b of data.basis) walk(b.path)
    }
    walk('payments/integration-notes.md')
    expect(Object.fromEntries(brought)).toEqual({ ...SOURCES, 'payments/sources/eu-vat-note.txt': null })
    expect(seen).toEqual(new Set(['payments/integration-notes.md', 'payments/recommendation.md', 'payments/comparison.md', ...Object.keys(SOURCES), 'payments/sources/eu-vat-note.txt']))

    const later = ok(sb.run(['@claude', 'start', '看看支付接入的进展', '--session', 'sess-a2'], { cwd: dirA })).stdout
    for (const readable of ['sess-b', 'codex', shown(dirB), 'payments/integration-notes.md']) expect(later).toContain(readable)
  })
})
