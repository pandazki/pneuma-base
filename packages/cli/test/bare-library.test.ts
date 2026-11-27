// C1, K2: with no plugin, each of the six verbs gives the answer in ARCHITECTURE "没有任何插件时的答复".
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

describe('a library with no plugin', () => {
  let sb: Sandbox
  let lib: string
  let outside: string

  beforeEach(() => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    outside = tempDir('pb-outside-')
    const init = sb.run(['init', lib, '--bare'])
    expect(init.code, init.stderr).toBe(0)
  })

  const agent = (args: string[], opts?: { input?: string; cwd?: string }) =>
    sb.run(['--library', lib, '--as', 'claude-code', ...args, '--json'], { cwd: opts?.cwd ?? outside, ...opts })

  it('init --bare writes the description and a configuration with no plugin', () => {
    expect(existsSync(join(lib, 'PNEUMA-BASE.md'))).toBe(true)
    const config = JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8'))
    expect(config.plugins).toEqual([])
    expect(config.format).toBe(1)
    expect(typeof config.id).toBe('string')
  })

  it('put copies the file in and accepts with no notes', () => {
    writeFileSync(join(outside, 'stripe.html'), '<html>stripe</html>')
    const r = agent(['put', 'stripe.html', '--to', 'payments/sources/stripe.html', '--brought', '--source', 'https://stripe.com'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', path: 'payments/sources/stripe.html', copied: true, notes: [], problems: [] })
    expect(readFileSync(join(lib, 'payments/sources/stripe.html'), 'utf8')).toBe('<html>stripe</html>')
  })

  it('put takes content from standard input', () => {
    const r = agent(['put', '-', '--to', 'notes/idea.md', '--made'], { input: '# idea\n' })
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(join(lib, 'notes/idea.md'), 'utf8')).toBe('# idea\n')
  })

  it('find finds nothing with no plugin: the kernel walks no folder to match names', () => {
    agent(['put', '-', '--to', 'payments/comparison.md', '--made'], { input: 'a' })
    const r = agent(['find', 'comparison'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toEqual({ hits: [], problems: [] })
  })

  it('inspect gives the facts of the file itself and no sections; the fingerprint only with the content', () => {
    agent(['put', '-', '--to', 'a.md', '--made'], { input: 'hello' })
    const r = agent(['inspect', 'a.md'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({
      file: { path: 'a.md', kind: 'file', size: 5, archived: false, fingerprint: null, token: expect.any(String) },
      sections: [],
      problems: [],
    })
    expect(agent(['inspect', 'a.md', '--content']).json().file.fingerprint).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('say is not heard, with the named reason and the fixed sentence', () => {
    const r = agent(['say', 'decided', '主人决定用 Paddle'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toEqual({ outcome: 'not-heard', reason: 'no-plugin-for-kind', note: '这个库没配能记下这句话的插件', problems: [] })
  })

  it('check reports no sections', () => {
    const r = agent(['check', '--since', 'last'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toEqual({ sections: [], asks: [], requests: { ended: [], pending: 0 }, problems: [] })
  })

  it('archive moves the file into _archive/ under the same relative path', () => {
    agent(['put', '-', '--to', 'drafts/v1.md', '--made'], { input: 'v1' })
    const r = agent(['archive', 'drafts/v1.md'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'accepted', from: 'drafts/v1.md', to: '_archive/drafts/v1.md', notes: [], problems: [] })
    expect(readFileSync(join(lib, '_archive/drafts/v1.md'), 'utf8')).toBe('v1')
    expect(existsSync(join(lib, 'drafts/v1.md'))).toBe(false)
  })

  it('start composes say, check and find and answers without error', () => {
    agent(['put', '-', '--to', 'payments/comparison.md', '--made'], { input: 'a' })
    const r = agent(['start', '对比 payments 方案'])
    expect(r.code, r.stderr).toBe(0)
    const out = r.json()
    expect(out.say).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
    expect(out.check).toEqual({ sections: [], asks: [], requests: { ended: [], pending: 0 }, problems: [] })
    // Finding asks the plugins' records (ARCHITECTURE.md「找、看、说、查、归档」), and a library with no plugin keeps none.
    expect(out.find.hits).toEqual([])
    expect(agent(['find', 'payments']).json().hits).toEqual([])
  })

  it('prints short Chinese text without --json', () => {
    const r = sb.run(['--library', lib, 'say', 'note', 'x'], { cwd: outside })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('这个库没配能记下这句话的插件')
  })
})
