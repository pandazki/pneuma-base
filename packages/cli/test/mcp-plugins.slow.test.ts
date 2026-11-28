// The plugins under plugins/, written outside this repository against the contract alone, gain their
// MCP tools with no change to them: each is built from a copy against freshly packed package files,
// installed on a temporary machine and added to a library, and a real MCP client sees each of its
// business commands as a tool and none of its management ones.
// Slow and needs the registry for the plugins' own dev dependencies, so it runs with `pnpm test:slow`.
import { spawnSync } from 'node:child_process'
import { cpSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { loadPlugins } from '@pneuma-base/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { tempDir } from './helpers.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BIN = join(REPO, 'packages/cli/dist/bin.js')
const PLUGINS = readdirSync(join(REPO, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)

describe('the plugins under plugins/ as MCP tools', () => {
  // The copies keep the plugins' relative dependencies on ../../dist-packages/ unchanged.
  const root = tempDir('pb-example-plugins-')
  const home = tempDir('pb-home-')
  const lib = join(tempDir(), 'lib')
  const env = { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') }
  const npmEnv = { ...env, npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'), npm_config_update_notifier: 'false' }
  const run = (cwd: string, command: string, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(command, args, { cwd, env: { ...env, ...extra }, input: '', encoding: 'utf8', timeout: 240_000 })
    expect(r.status, `${command} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
    return r.stdout
  }
  let client: Client

  beforeAll(async () => {
    run(REPO, process.execPath, [join(REPO, 'scripts/pack-dist.mjs'), '--out', join(root, 'dist-packages')])
    run(home, process.execPath, [BIN, 'init', lib])
    for (const name of PLUGINS) {
      const dir = join(root, 'plugins', name)
      cpSync(join(REPO, 'plugins', name), dir, { recursive: true, filter: (src) => !/[/\\](node_modules|dist|package-lock\.json)$/.test(src) })
      run(dir, 'npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-package-lock'], npmEnv)
      run(dir, 'npm', ['run', 'build'], npmEnv)
      run(home, process.execPath, [BIN, 'plugin', 'install', join(dir, 'dist')])
      run(home, process.execPath, [BIN, '--library', lib, 'plugin', 'enable', name])
    }
    run(home, process.execPath, [BIN, '--library', lib, 'grant', 'create', 'g', '--agent', 'claude'])
    client = new Client({ name: 'pneuma-base-test', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, '@g', 'mcp'], env, cwd: home, stderr: 'pipe' }))
  }, 900_000)
  afterAll(() => client?.close())

  it('lists each plugin’s business commands as tools, and none of its management ones', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name)
    const table = await loadPlugins(env.PNEUMA_BASE_HOME, builtinPlugins)
    for (const name of PLUGINS) {
      const commands = table.get(name)?.ownerCommands ?? []
      expect(commands.length, name).toBeGreaterThan(0)
      for (const c of commands) expect(tools.includes(c.name.replaceAll(' ', '_')), c.name).toBe(!c.destructive && !c.ownerOnly)
    }
    expect(tools).toEqual(expect.arrayContaining(['space_list', 'space_sync']))
    expect(tools).not.toContain('space_on')
  })

  it('runs a plugin’s command as the command line does', async () => {
    const r = (await client.callTool({ name: 'space_list', arguments: {} })) as { content: { text: string }[]; structuredContent: unknown }
    const cli = spawnSync(process.execPath, [BIN, '@g', 'space', 'list', '--json'], { cwd: home, env, encoding: 'utf8' })
    expect(r.structuredContent).toEqual(JSON.parse(cli.stdout))
    expect(r.content[0]?.text).toBe(spawnSync(process.execPath, [BIN, '@g', 'space', 'list'], { cwd: home, env, encoding: 'utf8' }).stdout.trimEnd())
  })
})
