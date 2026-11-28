// K6 and C8 over the whole description: with every plugin installed, PNEUMA-BASE.md reads as one
// text, and every command example in it runs as written, in order, for an agent with a grant in
// an agent session. The examples are read from the assembled file, so no section can drift.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const PLUGINS = ['ledger', 'version', 'deploy', 'sync', 'search'] as const
const GRANT = '<授权名称>'

/** The examples: each line of an sh block, continuations joined, comment lines dropped; and each inline command with no placeholder but the grant. */
function examples(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] as string)
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  )
  const prose = markdown.replace(/```sh\n[\s\S]*?```/g, '')
  const inline = [...prose.matchAll(/`(pneuma-base @[^`]+)`/g)].map((m) => m[1] as string).filter((c) => !c.replaceAll(GRANT, '').includes('<'))
  return [...blocks, ...inline]
}

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('the assembled description with every plugin installed', () => {
  const sb = sandbox()
  const lib = join(tempDir(), 'lib')
  const cwd = tempDir('pb-agent-')
  const owner = (args: string[]) => {
    const r = sb.run(['--library', lib, ...args], { cwd })
    expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
    return r
  }
  expect(sb.run(['init', lib]).code).toBe(0)
  for (const name of PLUGINS.slice(1)) owner(['plugin', 'enable', name])
  const text = readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')

  it('stays under 160 lines, and with only the ledger it is no longer than before the plugins came', () => {
    expect(text.split('\n').length - 1).toBeLessThan(160)
    const ledgerOnly = join(tempDir(), 'ledger-only')
    expect(sb.run(['init', ledgerOnly]).code).toBe(0)
    expect(readFileSync(join(ledgerOnly, 'PNEUMA-BASE.md'), 'utf8').split('\n').length - 1).toBeLessThanOrEqual(116)
  })

  it('gives each plugin one section, in configuration order, each opening with the same sentence and a heading that names what it gives; says 版本 only in the version plugin’s section, and each rule once', () => {
    const titles = ['溯源', '版本管理', '部署', '同步', '搜索']
    const opens = titles.map((t) => text.indexOf(`此资料库已启用**${t}**插件。`))
    expect(opens.every((at) => at > 0)).toBe(true)
    expect(opens).toEqual([...opens].sort((a, b) => a - b))
    expect(text.match(/此资料库已启用\*\*/g)).toHaveLength(titles.length)
    for (const at of opens) expect(text.slice(text.lastIndexOf('\n## ', at), at)).toMatch(/^\n## \S+：\S+/)
    expect(text).not.toContain('这个插件还带来')

    const version = text.slice(text.indexOf('\n## 版本管理：'), text.indexOf('\n## ', text.indexOf('\n## 版本管理：') + 1))
    const config = text.slice(text.indexOf('\n## 资料库当前配置'))
    const rest = text.replace(version, '').replace(config, '')
    expect(rest).not.toMatch(/版本|一版/)
    expect(text).not.toContain('不是按意思')
    expect(text.match(/--include-archived/g)).toHaveLength(1)
    expect(text.match(/在外部写好/g)).toHaveLength(1)
  })

  it('runs every command example as written, in order, and leaves what the examples promise', () => {
    const target = { deploy: join(tempDir('pb-www-'), 'www'), sync: tempDir('pb-sync-') }
    owner(['grant', 'create', 'claude', '--agent', 'claude-code'])
    owner(['deploy', 'target', 'set', '--kind', 'folder', '--to', target.deploy])
    owner(['sync', 'target', 'set', '--kind', 'dir', '--to', target.sync])
    owner(['search', 'embedding', 'set', '--kind', 'hash'])

    // What the examples build on: a pricing page brought in earlier, a site and a support note in the
    // library, and a comparison and the site's next version written next to the agent.
    const shim = tempDir('pb-bin-')
    write(join(shim, 'pneuma-base'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
    write(join(shim, 'curl'), '#!/bin/sh\nfor last; do :; done\nprintf "<html>%s</html>" "$last"\n')
    for (const name of ['pneuma-base', 'curl']) chmodSync(join(shim, name), 0o755)
    const agentEnv = { PATH: `${shim}:${process.env.PATH ?? ''}`, CLAUDE_CODE_SESSION_ID: 'session-of-the-examples' }
    const agent = (args: string[], input?: string): Run => sb.run(['@claude', ...args], { cwd, env: agentEnv, ...(input === undefined ? {} : { input }) })
    expect(agent(['put', '-', '--to', 'payments/sources/paddle-pricing.html', '--imported', '--source', 'https://www.paddle.com/pricing'], '<html>paddle</html>').code).toBe(0)
    expect(agent(['put', '-', '--to', 'support/refunds.md', '--generated'], '# 退款流程\n\n客户申请退款后，三天内原路退回。\n').code).toBe(0)
    const V1 = '<h1>小店</h1>'
    write(join(cwd, 'shop-first/index.html'), V1)
    expect(agent(['put', './shop-first', '--to', 'sites/shop', '--generated']).code).toBe(0)
    write(join(cwd, 'shop/index.html'), '<h1>小店，换了配色</h1>')
    write(join(cwd, 'comparison.md'), '# 支付服务对比\n')

    const commands = examples(text)
    expect(commands.length).toBeGreaterThanOrEqual(18)
    const outputs = new Map<string, string>()
    for (const command of commands) {
      expect(command.startsWith('pneuma-base @') || command.includes('| pneuma-base @'), command).toBe(true)
      const r = spawnSync('sh', ['-c', command.replaceAll(GRANT, 'claude')], {
        cwd,
        env: { HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base'), ...agentEnv },
        encoding: 'utf8',
      })
      expect(r.status, `${command}\n${r.stdout}${r.stderr}`).toBe(0)
      outputs.set(command, r.stdout)
    }

    const inspect = (path: string) => agent(['inspect', path, '--json']).json().sections
    const comparison = inspect('payments/comparison.md').find((s: any) => s.plugin === 'ledger').data
    expect(comparison.basis.map((b: any) => b.path)).toEqual(['payments/sources/stripe-pricing.html', 'payments/sources/paddle-pricing.html'])
    expect(comparison.outside).toEqual(['所有者在对话中说明：客户主要在欧洲'])
    expect(comparison.said.map((s: any) => s.text)).toContain('所有者决定使用 Paddle，因为它代为处理欧洲的税务')
    expect(inspect('payments/sources/stripe-pricing.html').find((s: any) => s.plugin === 'ledger').data.origin).toEqual({ kind: 'imported', source: 'https://stripe.com/pricing', by: null })
    const versions = agent(['version', 'list', 'sites/shop', '--json']).json().data.versions
    expect(versions.map((v: any) => [v.n, v.note, v.same])).toEqual([[1, '第一版', null], [2, '更换配色', null], [3, null, 1]])
    expect(readFileSync(join(cwd, 'shop-v1/index.html'), 'utf8')).toBe(V1)
    expect(readFileSync(join(lib, 'sites/shop/index.html'), 'utf8')).toBe(V1)
    expect(inspect('sites/shop').find((s: any) => s.plugin === 'deploy').data).toMatchObject({ status: 'unpublished', on: false })
    expect(outputs.get([...outputs.keys()].find((c) => c.includes(' find 退款 流程')) as string)).toContain('support/refunds.md')
  })
})
