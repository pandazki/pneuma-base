// One stable command on a machine: `$PNEUMA_BASE_HOME/bin/pneuma-base`. Whoever provides the command
// line keeps it current; what agent connect writes names it by absolute path, so an agent product
// that has no shell profile and nothing on its PATH but system tools still runs pneuma-base, with the
// home the command belongs to. Every run has a temporary HOME and PNEUMA_BASE_HOME.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
/** What a program started by an agent product may have: system tools on PATH, a HOME, nothing of Pneuma Base's. */
const BARE_PATH = '/usr/bin:/bin'

let sb: Sandbox
let lib: string
let work: string
let launcher: string
/** A HOME whose default `~/.pneuma-base` is not the sandbox's: only the launcher can say which home it is. */
let elsewhere: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  work = tempDir('pb-work-')
  elsewhere = tempDir('pb-elsewhere-')
  launcher = join(sb.home, '.pneuma-base', 'bin', 'pneuma-base')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
  return r
}
const run = (args: string[]) => ok(sb.run(args, { env: { PATH: tempDir('pb-bin-') }, cwd: work }))

/** The command line through another path to its entry, as a package or an app that moved would be. */
function elsewhereEntry(): string {
  const link = join(tempDir('pb-entry-'), 'bin.js')
  symlinkSync(BIN, link)
  return link
}
const runVia = (entry: string, args: string[]) => {
  const r = spawnSync(process.execPath, [entry, ...args], { env: { PATH: tempDir('pb-bin-'), HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') }, cwd: work, encoding: 'utf8', input: '' })
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  return r.stdout
}

/** A command line as an agent product runs it: through sh, with nothing but system tools and a HOME. */
function bare(line: string, env: Record<string, string> = {}, input = ''): Run {
  const r = spawnSync('/bin/sh', ['-c', line], { env: { PATH: BARE_PATH, HOME: elsewhere, ...env }, cwd: work, encoding: 'utf8', input })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
}

function put(path: string, content: string): void {
  const file = join(sb.home, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

type Entry = { type?: string; command: string; args: string[]; env?: Record<string, string> }
const cursorEntry = (): Entry => (JSON.parse(readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')) as { mcpServers: Record<string, Entry> }).mcpServers['pneuma-base-cursor'] as Entry

/** Starts what an MCP entry says to run, with nothing but system tools on PATH, and lists its tools. */
async function toolsOf(entry: Entry): Promise<string[]> {
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { PATH: BARE_PATH, HOME: elsewhere, ...entry.env }, cwd: work, stderr: 'pipe' })
  const client = new Client({ name: 'pneuma-base-test', version: '0' })
  await client.connect(transport)
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

const listed = () => run(['agent', 'list', '--json']).json().data.connections as { grant: string; inPlace: boolean; problems: string[] }[]

describe('launcher install', () => {
  it('writes one command under the machine home that runs this command line with that home, from anywhere; again, it changes nothing', () => {
    const first = run(['launcher', 'install', '--json']).json()
    expect(first.data).toMatchObject({ changed: true, launcher: { path: launcher, node: process.execPath, entry: BIN, home: join(sb.home, '.pneuma-base') } })
    expect(statSync(launcher).mode & 0o111).not.toBe(0)
    const text = readFileSync(launcher, 'utf8')

    ok(sb.run(['--library', lib, 'grant', 'issue', 'g', '--agent', 'someone']))
    const found = bare(`${launcher} @g find --json`)
    expect(found.code, `${found.stdout}${found.stderr}`).toBe(0)
    expect(found.json()).toMatchObject({ hits: [], problems: [] })

    const again = run(['launcher', 'install', '--json']).json()
    expect(again.data.changed).toBe(false)
    expect(again.text).toContain('没有改')
    expect(readFileSync(launcher, 'utf8')).toBe(text)
  })

  it('is the owner’s: refused in an agent session', () => {
    const r = sb.run(['launcher', 'install'], { env: { CLAUDE_CODE_SESSION_ID: 's1' } })
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('agent-session')
    expect(existsSync(launcher)).toBe(false)
  })
})

describe('what agent connect writes names the launcher', () => {
  it('a skill: connect writes the launcher; the exact command lines the skill names run with nothing else, and the scene is the agent’s', () => {
    put('.claude/x', '')
    expect(run(['agent', 'connect', 'claude-code', '--library', lib]).stdout).toContain('看看我的 Pneuma Base 库里有什么')
    expect(existsSync(launcher)).toBe(true)
    const skill = readFileSync(join(sb.home, '.claude/skills/pneuma-base-claude-code/SKILL.md'), 'utf8')
    const lines = [...skill.matchAll(/^(\S+ @claude-code (?:start|find|put) [^#\n]*?)\s*(?:#.*)?$/gm)].map((m) => m[1] as string)
    expect(lines.map((l) => l.split(' ')[0])).toEqual([launcher, launcher, launcher])
    expect(skill).not.toMatch(/^pneuma-base @/m)

    const agent = { CLAUDE_CODE_SESSION_ID: 'sess-1' }
    writeFileSync(join(work, 'books.md'), '# 书单\n')
    const fill = (line: string) => line.replace('"<一句话：这次在做什么>"', '整理读书笔记').replace('<文字>', '书单').replace('<库外的文件或目录>', 'books.md').replace('<库内路径>', 'notes/books.md').replace(' --from <依据的库内路径…>', '')
    for (const line of lines) {
      const r = bare(fill(line), agent)
      expect(r.code, `${fill(line)}\n${r.stdout}${r.stderr}`).toBe(0)
    }
    const seen = run(['--library', lib, 'inspect', 'notes/books.md']).stdout
    expect(seen).toContain('做出来的 · claude-code')
    expect(seen).toContain('整理读书笔记')
  })

  it('an MCP entry: its command is the launcher, with no environment of its own, and it starts with nothing else', async () => {
    put('.cursor/x', '')
    run(['agent', 'connect', 'cursor', '--via', 'mcp', '--library', lib])
    const entry = cursorEntry()
    expect(entry).toEqual({ type: 'stdio', command: launcher, args: ['@cursor', 'mcp'] })
    expect(await toolsOf(entry)).toEqual(expect.arrayContaining(['start', 'find', 'put']))
  })

  it('a TOML entry names it too', () => {
    put('.codex/config.toml', 'model = "o3"\n')
    run(['agent', 'connect', 'codex', '--via', 'mcp', '--library', lib])
    expect(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8')).toBe(`model = "o3"\n\n[mcp_servers.pneuma-base-codex]\ncommand = ${JSON.stringify(launcher)}\nargs = ["@codex", "mcp"]\n`)
  })
})

describe('a connection survives the command line moving', () => {
  it('installing from elsewhere rewrites only the launcher and the entry still works; when what it runs is gone, agent list says so and connect again repairs it', async () => {
    put('.cursor/x', '')
    const first = elsewhereEntry()
    runVia(first, ['agent', 'connect', 'cursor', '--via', 'mcp', '--library', lib])
    expect(readFileSync(launcher, 'utf8')).toContain(first)
    const config = readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')

    const moved = elsewhereEntry()
    runVia(moved, ['launcher', 'install'])
    rmSync(first)
    expect(readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')).toBe(config)
    expect(await toolsOf(cursorEntry())).toContain('find')
    expect(listed()).toEqual([expect.objectContaining({ grant: 'cursor', inPlace: true })])

    rmSync(moved)
    expect(listed()).toEqual([expect.objectContaining({ inPlace: false, problems: [`命令 ${launcher} 指向的命令行不在了（${moved}）`] })])
    rmSync(launcher)
    expect(listed()).toEqual([expect.objectContaining({ inPlace: false, problems: [`命令 ${launcher} 不在了`] })])

    const repaired = run(['agent', 'connect', 'cursor', '--via', 'mcp', '--library', lib]).stdout
    expect(repaired).toContain(`命令：${launcher}`)
    expect(readFileSync(launcher, 'utf8')).toContain(BIN)
    expect(readFileSync(join(sb.home, '.cursor/mcp.json'), 'utf8')).toBe(config)
    expect(listed()).toEqual([expect.objectContaining({ inPlace: true })])
    expect(await toolsOf(cursorEntry())).toContain('find')
  })

  it('leaves a working launcher alone: connecting from another command line does not take it over', () => {
    put('.cursor/x', '')
    run(['launcher', 'install'])
    const text = readFileSync(launcher, 'utf8')
    runVia(elsewhereEntry(), ['agent', 'connect', 'cursor', '--library', lib])
    expect(readFileSync(launcher, 'utf8')).toBe(text)
  })

  it('still lists a connection recorded before the launcher, by the node and entry its entry runs', () => {
    put('.cursor/x', '')
    run(['agent', 'connect', 'cursor', '--via', 'mcp', '--library', lib])
    const record = join(sb.home, '.pneuma-base', 'connections', 'cursor', 'connection.json')
    const old = { ...JSON.parse(readFileSync(record, 'utf8')), command: { node: process.execPath, entry: join(work, 'gone.js') } }
    writeFileSync(record, JSON.stringify(old))
    expect(listed()).toEqual([expect.objectContaining({ inPlace: false, problems: [`命令行不在了（${join(work, 'gone.js')}）`] })])
  })
})
