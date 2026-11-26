// Connecting an agent product in one command, and undoing it in one. Every run has a temporary HOME
// with configuration files the test makes itself, and a PATH of its own.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

let sb: Sandbox
let lib: string
let bin: string
let work: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  bin = tempDir('pb-bin-')
  work = tempDir('pb-work-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const run = (args: string[], env: Record<string, string> = {}, input?: string): Run => sb.run(args, { env: { PATH: bin, ...env }, cwd: work, ...(input === undefined ? {} : { input }) })
const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
  return r
}

function put(path: string, content: string): void {
  const file = join(sb.home, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Every file under `root` but the ones in `skip`, by relative path, as bytes; every folder too. */
function tree(root: string, skip: string[] = ['.pneuma-base']): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const rel = relative(root, path)
      if (skip.includes(rel)) continue
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = ''
        walk(path)
      } else out[rel] = readFileSync(path).toString('base64')
    }
  }
  walk(root)
  return out
}

const grants = () => (JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')) as { grants: { name: string; agent: string }[] }).grants
const pbHome = () => join(sb.home, '.pneuma-base')

type Case = { product: string; via?: 'mcp'; setup: Record<string, string>; skill?: string; file?: string; format?: 'json' | 'toml' }

const CASES: Case[] = [
  { product: 'claude-code', setup: { '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\n' }, skill: '.claude/skills/pneuma-base-claude-code/SKILL.md' },
  {
    product: 'claude-code',
    via: 'mcp',
    setup: { '.claude.json': '{"numStartups": 3,\n\t"mcpServers" : { "other": {"command":"x"} },\n  "big": 12345678901234567890, "1": "a", "z": [1, 2.50, 1e3]}', '.claude/settings.json': '{}' },
    file: '.claude.json',
    format: 'json',
  },
  { product: 'codex', setup: { '.codex/config.toml': 'model = "o3"\n' }, skill: '.agents/skills/pneuma-base-codex/SKILL.md' },
  {
    product: 'codex',
    via: 'mcp',
    setup: { '.codex/config.toml': '# mine\nmodel = "o3"   # the model\n\n[mcp_servers.other]\ncommand = "x"\nargs = [ "a" ]' },
    file: '.codex/config.toml',
    format: 'toml',
  },
  { product: 'claude-desktop', setup: { 'Library/Application Support/Claude/claude_desktop_config.json': '{\n    "globalShortcut": "",\n    "preferences": {"menuBarEnabled": false}\n}' }, file: 'Library/Application Support/Claude/claude_desktop_config.json', format: 'json' },
  { product: 'cursor', setup: { '.cursor/mcp.json': '{"mcpServers":{}}' }, skill: '.cursor/skills/pneuma-base-cursor/SKILL.md' },
  { product: 'cursor', via: 'mcp', setup: { '.cursor/argv.json': '{}\n' }, file: '.cursor/mcp.json', format: 'json' },
]

/** The command an MCP entry runs, as each format writes it. */
function entryOf(c: Case): { command: string; args: string[]; env: Record<string, string> } | string {
  const text = readFileSync(join(sb.home, c.file as string), 'utf8')
  if (c.format === 'toml') return text
  const servers = (JSON.parse(text) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers
  return servers[`pneuma-base-${c.product}`] as { command: string; args: string[]; env: Record<string, string> }
}

describe('agent connect, list and disconnect', () => {
  for (const c of CASES) {
    it(`${c.product}${c.via ? ' --via mcp' : ''}: connect, list, disconnect leave HOME exactly as it was`, () => {
      for (const [path, content] of Object.entries(c.setup)) put(path, content)
      const before = tree(sb.home)

      const connected = ok(run(['agent', 'connect', c.product, '--library', lib, ...(c.via ? ['--via', c.via] : [])]))
      expect(grants()).toEqual([expect.objectContaining({ name: c.product, agent: c.product })])
      if (c.skill) {
        const skill = readFileSync(join(sb.home, c.skill), 'utf8')
        expect(skill).toContain(`pneuma-base @${c.product} start`)
        expect(skill).toContain(lib)
        expect(connected.stdout).toContain(`~/${c.skill}`)
      } else {
        const entry = entryOf(c)
        const home = pbHome()
        if (typeof entry === 'string') {
          expect(entry).toContain(`[mcp_servers.pneuma-base-${c.product}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BIN)}, "@${c.product}", "mcp"]\n`)
          expect(entry).toContain(`PNEUMA_BASE_HOME = ${JSON.stringify(home)}`)
        } else expect(entry).toMatchObject({ command: process.execPath, args: [BIN, `@${c.product}`, 'mcp'], env: { PNEUMA_BASE_HOME: home } })
        expect(connected.stdout).toContain(`~/${c.file}`)
      }

      const listed = ok(run(['agent', 'list', '--library', lib, '--json'])).json()
      expect(listed.data.connections).toEqual([expect.objectContaining({ grant: c.product, product: c.product, way: c.skill ? 'skill' : 'mcp', inPlace: true })])
      expect(ok(run(['agent', 'list', '--library', lib])).stdout).toContain('在用')

      ok(run(['agent', 'disconnect', c.product]))
      expect(tree(sb.home)).toEqual(before)
      expect(grants()).toEqual([])
      expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections).toEqual([])
    })
  }

  it('connect twice changes nothing the second time; disconnect twice is quiet', () => {
    put('Library/Application Support/Claude/claude_desktop_config.json', '{}\n')
    ok(run(['agent', 'connect', 'claude-desktop', '--library', lib]))
    const home = tree(sb.home, [])
    const config = readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')
    expect(ok(run(['agent', 'connect', 'claude-desktop', '--library', lib])).stdout).toContain('已经接上')
    expect(tree(sb.home, [])).toEqual(home)
    expect(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')).toBe(config)

    ok(run(['agent', 'disconnect', 'claude-desktop']))
    expect(ok(run(['agent', 'disconnect', 'claude-desktop'])).stdout).toContain('没有叫 claude-desktop 的连接')
  })

  it('--via mcp on a product that loads skills registers the MCP server and writes no skill', () => {
    put('.claude/settings.json', '{}')
    ok(run(['agent', 'connect', 'claude-code', '--library', lib, '--via', 'mcp']))
    expect(existsSync(join(sb.home, '.claude/skills'))).toBe(false)
    expect(entryOf({ product: 'claude-code', setup: {}, file: '.claude.json', format: 'json' })).toMatchObject({ type: 'stdio', command: process.execPath })
  })

  it('refuses a configuration it cannot read, leaves it untouched, issues no grant, and prints what to paste', () => {
    const text = '{\n  // mine\n  "mcpServers": {}\n}\n'
    put('.cursor/mcp.json', text)
    const r = run(['agent', 'connect', 'cursor', '--library', lib, '--via', 'mcp'])
    expect(r.code, r.stdout).toBe(2)
    expect(r.stdout).toContain('"pneuma-base-cursor"')
    expect(r.stdout).toContain(`grant issue cursor --agent cursor --library ${lib}`)
    expect(readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')).toBe(text)
    expect(grants()).toEqual([])
    expect(existsSync(join(pbHome(), 'connections', 'cursor'))).toBe(false)
  })

  it('does not take out an entry the owner changed: JSON, TOML and a skill', () => {
    put('Library/Application Support/Claude/claude_desktop_config.json', '{}\n')
    put('.codex/config.toml', 'model = "o3"\n')
    put('.cursor/x', '')
    ok(run(['agent', 'connect', 'claude-desktop', '--library', lib]))
    ok(run(['agent', 'connect', 'codex', '--library', lib, '--via', 'mcp']))
    ok(run(['agent', 'connect', 'cursor', '--library', lib]))
    const edit = (path: string, from: string, to: string) => {
      const file = join(sb.home, path)
      writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
      return readFileSync(file, 'utf8')
    }
    const desktop = edit('Library/Application Support/Claude/claude_desktop_config.json', '"@claude-desktop"', '"@claude-desktop", "--verbose"')
    const codex = edit('.codex/config.toml', '"@codex"', '"@other"')
    const skill = edit('.cursor/skills/pneuma-base-cursor/SKILL.md', 'Pneuma Base', 'My Base')

    const listed = ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections as { grant: string; inPlace: boolean }[]
    expect(listed.map((c) => [c.grant, c.inPlace])).toEqual([['claude-desktop', false], ['codex', false], ['cursor', false]])
    expect(ok(run(['agent', 'list', '--library', lib])).stdout).toContain('被改过')

    for (const [grant, path, text] of [['claude-desktop', 'Library/Application Support/Claude/claude_desktop_config.json', desktop], ['codex', '.codex/config.toml', codex], ['cursor', '.cursor/skills/pneuma-base-cursor/SKILL.md', skill]] as const) {
      const r = ok(run(['agent', 'disconnect', grant]))
      expect(r.stdout).toContain('改过')
      expect(readFileSync(join(sb.home, path), 'utf8')).toBe(text)
    }
    expect(grants()).toEqual([])
  })

  it('reuses a grant of the same name for the same product, refuses one that clashes, and takes another name', () => {
    put('.cursor/x', '')
    ok(run(['--library', lib, 'grant', 'issue', 'cursor', '--agent', 'cursor']))
    ok(run(['agent', 'connect', 'cursor', '--library', lib]))
    ok(run(['agent', 'disconnect', 'cursor', '--keep-grant']))
    expect(grants().map((g) => g.name)).toEqual(['cursor'])
    ok(run(['--library', lib, 'grant', 'revoke', 'cursor']))

    ok(run(['--library', lib, 'grant', 'issue', 'cursor', '--agent', 'someone-else']))
    const before = tree(sb.home)
    const clash = run(['agent', 'connect', 'cursor', '--library', lib])
    expect(clash.code, clash.stdout).toBe(2)
    expect(clash.stdout).toContain('--name')
    expect(tree(sb.home)).toEqual(before)

    const other = join(tempDir(), 'other')
    ok(run(['init', other]))
    ok(run(['--library', other, 'grant', 'issue', 'cursor-2', '--agent', 'cursor']))
    expect(run(['agent', 'connect', 'cursor', '--library', lib, '--name', 'cursor-2']).code).toBe(2)

    ok(run(['agent', 'connect', 'cursor', '--library', lib, '--name', 'cursor-3']))
    expect(existsSync(join(sb.home, '.cursor/skills/pneuma-base-cursor-3/SKILL.md'))).toBe(true)
  })

  it('refuses each command in an agent session, and the page too', () => {
    put('.cursor/x', '')
    ok(run(['agent', 'connect', 'cursor', '--library', lib]))
    const before = tree(sb.home)
    for (const args of [['agent', 'detect'], ['agent', 'list'], ['agent', 'connect', 'cursor', '--library', lib, '--name', 'c2'], ['agent', 'disconnect', 'cursor'], ['show', 'agents', '--library', lib]]) {
      const r = run(args, { CLAUDE_CODE_SESSION_ID: 'session-1' })
      expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(2)
      expect(r.stdout).toContain('agent-session')
    }
    expect(run(['@cursor', 'agent', 'list']).stdout).toContain('agent-session')
    expect(tree(sb.home)).toEqual(before)
  })

  it('finds the products on this machine by a program on PATH or a folder under HOME', () => {
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n')
    chmodSync(join(bin, 'codex'), 0o755)
    put('.claude/x', '')
    put('.cursor/x', '')
    const found = ok(run(['agent', 'detect', '--json'])).json().data.products as { name: string; found: boolean; signs: string[]; ways: { way: string }[] }[]
    const byName = Object.fromEntries(found.map((p) => [p.name, p]))
    expect(byName['claude-code']).toMatchObject({ found: true, signs: ['有 ~/.claude'], ways: [{ way: 'skill' }, { way: 'mcp' }] })
    expect(byName.codex).toMatchObject({ found: true, signs: ['PATH 上有 codex'] })
    expect(byName['claude-desktop']).toMatchObject({ found: false, ways: [{ way: 'mcp' }] })
    expect(byName.cursor).toMatchObject({ found: true })
    expect(Object.keys(byName)).not.toContain('antigravity')
    const text = ok(run(['agent', 'detect', '--library', lib])).stdout
    expect(text).toContain(`agent connect cursor --library ${lib}`)
  })

  it('a connection whose command line is gone says so in the list; connecting again writes the new one, and disconnect still restores the file', () => {
    put('.cursor/mcp.json', '{\n  "mcpServers": {\n    "other": { "command": "o" }\n  }\n}\n')
    put('.codex/config.toml', 'model = "o3"\n')
    const before = tree(sb.home)
    const link = join(tempDir('pb-entry-'), 'pneuma-base.js')
    symlinkSync(BIN, link)
    const env = { PATH: bin, HOME: sb.home, PNEUMA_BASE_HOME: pbHome() }
    for (const product of ['cursor', 'codex']) {
      const r = spawnSync(process.execPath, [link, 'agent', 'connect', product, '--via', 'mcp', '--library', lib], { env, encoding: 'utf8', cwd: work, input: '' })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    }
    const cursorArgs = () => (JSON.parse(readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers['pneuma-base-cursor']?.args[0]
    expect(cursorArgs()).toBe(link)
    expect(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8')).toContain(JSON.stringify(link))
    rmSync(link)
    expect(ok(run(['agent', 'list', '--library', lib])).stdout).toContain('命令行不在了')

    for (const product of ['cursor', 'codex']) ok(run(['agent', 'connect', product, '--via', 'mcp', '--library', lib]))
    expect(cursorArgs()).toBe(BIN)
    expect(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8')).not.toContain(JSON.stringify(link))
    expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections.map((c: { inPlace: boolean }) => c.inPlace)).toEqual([true, true])

    for (const product of ['cursor', 'codex']) ok(run(['agent', 'disconnect', product]))
    expect(tree(sb.home)).toEqual(before)
  })
})

describe('the whole run', () => {
  it('connects Claude Code by skill, then the agent works with that grant and the scene is its', () => {
    put('.claude/x', '')
    const connected = ok(run(['agent', 'connect', 'claude-code', '--library', lib]))
    expect(connected.stdout).toContain('看看我的 Pneuma Base 库里有什么')
    const skill = readFileSync(join(sb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'), 'utf8')
    const start = /pneuma-base (@claude-code) start/.exec(skill)
    expect(start?.[1]).toBe('@claude-code')

    const agent = { CLAUDE_CODE_SESSION_ID: 'sess-1' }
    ok(run(['@claude-code', 'start', '整理读书笔记'], agent))
    ok(run(['@claude-code', 'put', '-', '--to', 'notes/books.md', '--made'], agent, '# 书单\n'))
    const seen = ok(run(['--library', lib, 'inspect', 'notes/books.md'])).stdout
    expect(seen).toContain('claude-code')
    expect(seen).toContain('整理读书笔记')
  })
})
