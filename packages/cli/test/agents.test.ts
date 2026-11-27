// Connecting an agent product in one command, and undoing it in one. Every run has a temporary HOME
// with configuration files the test makes itself, and a PATH of its own.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { instant, recordEndpoint } from '@pneuma-base/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

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
const launcher = () => join(pbHome(), 'bin', 'pneuma-base')

type Case = { product: string; via?: 'mcp'; setup: Record<string, string>; skill?: string; file?: string; format?: 'json' | 'toml' }

/** One case per kind of configuration a product needs: a skill, MCP in JSON, MCP in TOML, and Claude Desktop's JSON. */
const CASES: Case[] = [
  { product: 'claude-code', setup: { '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\n' }, skill: '.claude/skills/pneuma-base-claude-code/SKILL.md' },
  {
    product: 'claude-code',
    via: 'mcp',
    setup: { '.claude.json': '{"numStartups": 3,\n\t"mcpServers" : { "other": {"command":"x"} },\n  "big": 12345678901234567890, "1": "a", "z": [1, 2.50, 1e3]}', '.claude/settings.json': '{}' },
    file: '.claude.json',
    format: 'json',
  },
  {
    product: 'codex',
    via: 'mcp',
    setup: { '.codex/config.toml': '# mine\nmodel = "o3"   # the model\n\n[mcp_servers.other]\ncommand = "x"\nargs = [ "a" ]' },
    file: '.codex/config.toml',
    format: 'toml',
  },
  { product: 'claude-desktop', setup: { 'Library/Application Support/Claude/claude_desktop_config.json': '{\n    "globalShortcut": "",\n    "preferences": {"menuBarEnabled": false}\n}' }, file: 'Library/Application Support/Claude/claude_desktop_config.json', format: 'json' },
]

type Entry = { type?: string; command: string; args: string[]; env?: Record<string, string> }

/** The command an MCP entry runs, as each format writes it. */
function entryOf(c: Case): Entry | string {
  const text = readFileSync(join(sb.home, c.file as string), 'utf8')
  if (c.format === 'toml') return text
  return (JSON.parse(text) as { mcpServers: Record<string, Entry> }).mcpServers[`pneuma-base-${c.product}`] as Entry
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
        expect(skill).toContain(`${launcher()} @${c.product} start`)
        expect(skill).toContain(lib)
        expect(connected.stdout).toContain(`~/${c.skill}`)
      } else {
        const entry = entryOf(c)
        if (typeof entry === 'string') expect(entry).toContain(`[mcp_servers.pneuma-base-${c.product}]\ncommand = ${JSON.stringify(launcher())}\nargs = ["@${c.product}", "mcp"]\n`)
        else expect(entry).toEqual({ ...(c.product === 'claude-desktop' ? {} : { type: 'stdio' }), command: launcher(), args: [`@${c.product}`, 'mcp'] })
        expect(connected.stdout).toContain(`~/${c.file}`)
        // A product that loads skills, connected by MCP, gets the MCP server and no skill.
        for (const skills of ['.claude/skills', '.agents/skills']) expect(existsSync(join(sb.home, skills, `pneuma-base-${c.product}`))).toBe(false)
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

  it('refuses connecting and disconnecting in an agent session or through a grant, and the page too', () => {
    put('.cursor/x', '')
    ok(run(['agent', 'connect', 'cursor', '--library', lib]))
    const before = tree(sb.home)
    for (const args of [['agent', 'connect', 'cursor', '--library', lib, '--name', 'c2'], ['agent', 'disconnect', 'cursor'], ['show', 'agents', '--library', lib]]) {
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
    expect(byName['claude-code']).toMatchObject({ found: true, signs: ['有 ~/.claude'], ways: [{ way: 'skill' }, { way: 'mcp' }, { way: 'mcp-http' }] })
    expect(byName.codex).toMatchObject({ found: true, signs: ['PATH 上有 codex'] })
    expect(byName['claude-desktop']).toMatchObject({ found: false, ways: [{ way: 'mcp' }] })
    expect(byName.cursor).toMatchObject({ found: true })
    expect(Object.keys(byName)).not.toContain('antigravity')
    const text = ok(run(['agent', 'detect', '--library', lib])).stdout
    expect(text).toContain(`agent connect cursor --library ${lib}`)
  })
})

describe('agent connect --via mcp-http', () => {
  const origin = 'http://127.0.0.1:7638'
  const serve = () => recordEndpoint(pbHome(), { url: origin, port: 7638, pid: process.pid, library: lib, at: instant(Date.now()) })

  it('writes the endpoint’s MCP address, and disconnect leaves HOME exactly as it was', async () => {
    put('.claude.json', '{"numStartups": 3}\n')
    put('.claude/settings.json', '{}')
    await serve()
    const before = tree(sb.home)
    const connected = ok(run(['agent', 'connect', 'claude-code', '--library', lib, '--via', 'mcp-http']))
    expect(connected.stdout).toContain(`${origin}/mcp/claude-code`)
    const text = readFileSync(join(sb.home, '.claude.json'), 'utf8')
    expect((JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers['pneuma-base-claude-code']).toEqual({ type: 'http', url: `${origin}/mcp/claude-code` })
    expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections).toEqual([expect.objectContaining({ grant: 'claude-code', way: 'mcp-http', inPlace: true })])
    ok(run(['agent', 'disconnect', 'claude-code']))
    expect(tree(sb.home)).toEqual(before)
    expect(grants()).toEqual([])
  })

  it('connects a product the table does not know by MCP alone: a grant under its name, nothing written, and the ways to reach the library', async () => {
    // Without an endpoint, the command and the stdio form only.
    const alone = ok(run(['agent', 'connect', 'antigravity', '--library', lib]))
    expect(alone.stdout).toContain(`${launcher()} @antigravity mcp`)
    expect(alone.stdout).not.toContain('/mcp/antigravity')
    ok(run(['agent', 'disconnect', 'antigravity']))

    await serve()
    const before = tree(sb.home)
    const r = ok(run(['agent', 'connect', 'my-agent', '--library', lib]))
    expect(grants()).toEqual([expect.objectContaining({ name: 'my-agent', agent: 'my-agent' })])
    expect(r.stdout).toContain(`${launcher()} @my-agent`)
    expect(r.stdout).toContain(`${origin}/mcp/my-agent`)
    expect(r.stdout).toContain(`${launcher()} @my-agent mcp`)
    expect(tree(sb.home)).toEqual(before)
    expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections).toEqual([expect.objectContaining({ grant: 'my-agent', product: 'my-agent', way: 'mcp-http', inPlace: true })])
    expect(ok(run(['agent', 'connect', 'my-agent', '--library', lib])).stdout).toContain('已经接上')
    ok(run(['agent', 'disconnect', 'my-agent']))
    expect(grants()).toEqual([])
    expect(ok(run(['agent', 'list', '--library', lib, '--json'])).json().data.connections).toEqual([])
  })

  it('refuses Claude Desktop, whose configuration takes no address, and a product with an address but no endpoint running', () => {
    put('Library/Application Support/Claude/claude_desktop_config.json', '{}\n')
    put('.claude.json', '{}\n')
    put('.claude/settings.json', '{}')
    const before = tree(sb.home)
    const desktop = run(['agent', 'connect', 'claude-desktop', '--library', lib, '--via', 'mcp-http'])
    expect(desktop.code, desktop.stdout).toBe(2)
    expect(desktop.stdout).toContain('no-such-way')
    const none = run(['agent', 'connect', 'claude-code', '--library', lib, '--via', 'mcp-http'])
    expect(none.code, none.stdout).toBe(2)
    expect(none.stdout).toContain('no-endpoint')
    expect(tree(sb.home)).toEqual(before)
    expect(grants()).toEqual([])
  })
})

describe('the agents page', () => {
  type Item = { cell: { text: string; actor?: { name: string; grant?: string }; tag?: { text: string } }; note: string | null; actions: { label: string; call: { command: string } }[] }
  type Page = { blocks: { kind: string; title: string; about?: string; normal?: true; blocks: { kind: string; items?: Item[]; text?: string; title?: string }[] }[]; problems: unknown[] }
  const page = () => {
    const shown = ok(run(['--library', lib, 'show', 'agents', '--json'])).json() as Page
    expect(shown.problems).toEqual([])
    return shown
  }
  const sections = () => Object.fromEntries(page().blocks.map((b) => [b.title, b.blocks]))
  const section = (title: string) => page().blocks.find((b) => b.title === title)

  it('has a row per connected agent: its mark, how it is connected, what the grant reaches, when it was last here, 断开; and the products found here with 接上', () => {
    put('.claude/x', '')
    put('.cursor/x', '')
    // None connected yet: one quiet line, which the page leaves out; the products below say what to do.
    expect(section('接上的 agent')).toMatchObject({ normal: true, blocks: [{ kind: 'text', tone: 'neutral', text: '还没有接上任何 agent。' }] })
    ok(run(['agent', 'connect', 'claude-code', '--library', lib, '--area', 'notes', '--read-only']))
    let shown = sections()
    // What the grant reaches: the area in the note, read-only as the one mark.
    expect(shown['接上的 agent']).toMatchObject([
      { kind: 'list', items: [{ cell: { text: 'Claude Code', actor: { name: 'claude-code', grant: 'claude-code' }, tag: { text: '只读' } }, note: '技能 · 区域 notes/ · 写在 ~/.claude/skills/pneuma-base-claude-code/SKILL.md · 还没在这里做过事', actions: [{ label: '断开', call: { command: 'agent disconnect' } }] }] },
    ])
    expect(section('接上的 agent')?.normal).toBeUndefined()
    expect(shown['这台机器上找到的']).toMatchObject([{ kind: 'list', items: [{ cell: { text: 'Cursor', actor: { name: 'cursor' } }, actions: [{ label: '接上', call: { command: 'agent connect' } }] }] }])
    // What was looked for and not found is there on demand.
    expect(section('这台机器上找到的')?.about).toContain('没找到：Codex')
    expect(Object.keys(shown)).toEqual(['接上的 agent', '这台机器上找到的', '接上的 agent 能做什么'])

    ok(run(['@claude-code', 'start', '整理笔记'], { PNEUMA_BASE_SESSION: 'one' }))
    shown = sections()
    expect(shown['接上的 agent']?.[0]?.items?.[0]?.note).toMatch(/ · 最近来过：\d{4}-\d\d-\d\d \d\d:\d\dZ；1 次会话，放进 0 样东西$/)

    rmSync(join(sb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'))
    expect(sections()['接上的 agent']?.[0]?.items?.[0]?.cell.tag).toEqual({ text: '接上时写的不在了', tone: 'warn' })
  })
})
