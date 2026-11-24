// The commands the ledger's cognition section shows agents work as written, with a grant name in
// place of {{授权的名字}}. The shell blocks are read from the section itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

const SECTION = readFileSync(fileURLToPath(new URL('../../plugin-ledger/cognition/2-ledger-section.md', import.meta.url)), 'utf8')

/** The commands in the section's sh blocks, one per line once continuations are joined, comments dropped. */
function shellCommands(markdown: string): string[] {
  return [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((m) => (m[1] as string).replace(/\\\n\s*/g, ' ').split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** Splits a command line into words the way a shell does for plain and quoted words. */
function words(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let quote: string | null = null
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
    } else if (/\s/.test(ch)) {
      if (current !== '' || quoted) out.push(current)
      current = ''
      quoted = false
    } else current += ch
  }
  if (current !== '' || quoted) out.push(current)
  return out
}

describe('the ledger cognition section', () => {
  it('its commands run as written, in order, and leave what they promise', () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    const cwd = tempDir('pb-agent-')
    expect(sb.run(['init', lib]).code).toBe(0)
    expect(sb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code']).code).toBe(0)
    const run = (args: string[], input?: string) => sb.run(args.map((w) => w.replaceAll('{{授权的名字}}', 'claude')), { cwd, ...(input === undefined ? {} : { input }) })
    // The example builds on a pricing page brought in earlier, and on a comparison written next to the agent.
    expect(run(['@claude', 'put', '-', '--to', 'payments/sources/paddle-pricing.html', '--brought', '--source', 'https://www.paddle.com/pricing'], '<html>paddle</html>').code).toBe(0)
    writeFileSync(join(cwd, 'comparison.md'), '# 支付服务对比\n')

    const commands = shellCommands(SECTION)
    expect(commands.length).toBeGreaterThanOrEqual(6)
    for (const command of commands) {
      const [fetch, pipeTo] = command.includes(' | ') ? command.split(' | ') : [null, command]
      const argv = words(pipeTo as string)
      expect(argv[0], command).toBe('pneuma-base')
      const input = fetch === null ? undefined : `<html>${words(fetch).at(-1)}</html>`
      const r = run(argv.slice(1), input)
      expect(r.code, `${command}\n${r.stdout}\n${r.stderr}`).toBe(0)
    }

    const comparison = run(['@claude', 'inspect', 'payments/comparison.md', '--json']).json().sections[0].data
    expect(comparison.basis.map((b: any) => b.path)).toEqual(['payments/sources/stripe-pricing.html', 'payments/sources/paddle-pricing.html'])
    expect(comparison.outside).toEqual(['主人在对话里说：客户主要在欧洲'])
    expect(comparison.said.map((s: any) => s.text)).toContain('主人决定用 Paddle，因为它替他处理欧洲的税')
    expect(run(['@claude', 'inspect', 'payments/sources/stripe-pricing.html', '--json']).json().sections[0].data.origin).toEqual({
      kind: 'brought',
      source: 'https://stripe.com/pricing',
      by: null,
    })
  })

  it('the usages in its table are heard', () => {
    for (const template of ['`say note "<一句话>"`', '`say note <库内路径> "<备注>"`', '`say from <库内路径> --from <库内路径…>`', '`put <库内路径> --brought …`', '`say revised <库内路径>`']) {
      expect(SECTION).toContain(template)
    }
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    const run = (args: string[], input?: string) => sb.run(['--library', lib, '--as', 'claude-code', '--session', 's', ...args], { ...(input === undefined ? {} : { input }) })
    expect(run(['put', '-', '--to', 'notes/a.md', '--made'], 'a').code).toBe(0)
    expect(run(['put', '-', '--to', 'notes/b.md', '--brought'], 'b').code).toBe(0)
    mkdirSync(join(lib, 'inbox'))
    writeFileSync(join(lib, 'inbox/dropped.md'), 'dropped')
    for (const args of [
      ['say', 'note', '一句备注'],
      ['say', 'note', 'notes/a.md', '给 a 的备注'],
      ['say', 'from', 'notes/a.md', '--from', 'notes/b.md'],
      ['put', 'inbox/dropped.md', '--brought', '--by', 'owner'],
    ]) {
      const r = run([...args, '--json'])
      expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.json().outcome, args.join(' ')).toMatch(/heard|accepted/)
    }
    writeFileSync(join(lib, 'notes/a.md'), 'a, edited by hand')
    expect(run(['say', 'revised', 'notes/a.md', '--json']).json()).toMatchObject({ outcome: 'heard', by: 'ledger' })
  })
})
