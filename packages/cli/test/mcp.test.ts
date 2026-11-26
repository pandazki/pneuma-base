// The API face: `pneuma-base @<grant> mcp` serves a library to an MCP client over standard input and
// output, with tools generated from the command table. On a library with the five built-in plugins:
// - every business verb and command is a tool and no management command is; one called by name is
//   refused as the command line refuses it;
// - a tool answers what the command line answers with the same arguments, the text and the result object;
// - a real MCP client of either protocol era works through a whole task, and the ledger puts it all
//   on the grant's agent in one scene;
// - a plugin added while connected is told as a changed tool list and resources.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { ownerFace } from '@pneuma-base/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builtinPlugins } from '../dist/plugins.js'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const VERBS = ['start', 'find', 'inspect', 'put', 'say', 'check', 'archive', 'unarchive', 'ask', 'show']
type Era = 'legacy' | 'modern'
type CallResult = { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }

/** A real MCP client on `pneuma-base @<grant> mcp`, in the era asked for: legacy opens with initialize, modern pins 2026-07-28. */
async function connect(sb: Sandbox, grant: string, era: Era, session?: string): Promise<Client> {
  const env = { PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') }
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, `@${grant}`, 'mcp', ...(session === undefined ? [] : ['--session', session])], env, cwd: sb.home, stderr: 'pipe' })
  const client = new Client({ name: 'pneuma-base-test', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {})
  await client.connect(transport)
  return client
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallResult
const textOf = (r: CallResult) => r.content.map((c) => c.text ?? '').join('\n')

function ok(r: Run): Run {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}

/** A library with the five built-in plugins, something in it, a read-write grant `g` for claude and a read-only `ro` for reader. */
function library(sb: Sandbox): string {
  const lib = join(tempDir(), 'lib')
  ok(sb.run(['init', lib]))
  for (const p of ['version', 'sync', 'deploy', 'search']) ok(sb.run(['--library', lib, 'plugin', 'add', p]))
  ok(sb.run(['--library', lib, 'grant', 'issue', 'g', '--agent', 'claude']))
  ok(sb.run(['--library', lib, 'grant', 'issue', 'ro', '--agent', 'reader', '--read-only']))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'notes/a.md', '--brought', '--source', 'https://example.com/a'], { input: '# 甲\n下单流程\n' }))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'notes/b.md', '--made', '--from', 'notes/a.md'], { input: '# 乙\n' }))
  ok(sb.run(['--library', lib, 'say', 'versioned', 'notes/b.md', '第一版']))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'old.md', '--made'], { input: '旧的\n' }))
  ok(sb.run(['--library', lib, 'archive', 'old.md']))
  return lib
}

describe('the tool list', () => {
  let sb: Sandbox
  let client: Client
  beforeAll(async () => {
    sb = sandbox()
    library(sb)
    client = await connect(sb, 'g', 'legacy')
  })
  afterAll(() => client?.close())

  it('is every verb and every business command of the library, and no management command', async () => {
    const commands = ownerFace.commands([...builtinPlugins.values()])
    const business = commands.filter((c) => !c.destructive && !c.ownerOnly).map((c) => c.name.replaceAll(' ', '_'))
    const management = commands.filter((c) => c.destructive || c.ownerOnly).map((c) => c.name.replaceAll(' ', '_'))
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual([...VERBS, ...business])
    expect(management.filter((m) => tools.some((t) => t.name === m))).toEqual([])
    for (const t of tools.slice(VERBS.length)) expect(t.description).toBe(commands.find((c) => c.name.replaceAll(' ', '_') === t.name)?.summary)
  })

  it('refuses each management command called by name with the reason and words of the command line', async () => {
    const management = ownerFace.commands([...builtinPlugins.values()]).filter((c) => c.destructive || c.ownerOnly)
    expect(management.length).toBeGreaterThan(10)
    for (const c of management) {
      const r = await call(client, c.name.replaceAll(' ', '_'))
      const cli = sb.run(['@g', ...c.name.split(' '), '--json'])
      expect(cli.code, c.name).toBe(2)
      expect(r.isError, c.name).toBe(true)
      expect(r.structuredContent, c.name).toEqual(cli.json())
      expect(textOf(r), c.name).toBe(sb.run(['@g', ...c.name.split(' ')]).stdout.trimEnd())
    }
  })

  it('makes a command’s input schema from its params: names, kinds, required, pattern and hints', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'version_export')
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内路径' },
        version: { type: 'string', description: '第几版', pattern: '^(?:[1-9][0-9]*)$' },
        to: { type: 'string', description: '库外的目录或文件' },
      },
      required: ['path', 'version', 'to'],
      additionalProperties: false,
    })
    const put = (await client.listTools()).tools.find((t) => t.name === 'put')
    expect(put?.inputSchema.required).toBeUndefined()
    expect(Object.keys(put?.inputSchema.properties ?? {})).toEqual(['what', 'to', 'brought', 'made', 'source', 'by', 'from', 'from-outside', 'note', 'observed', 'text', 'base64'])
    const inspect = (await client.listTools()).tools.find((t) => t.name === 'inspect')
    expect(inspect?.inputSchema).toMatchObject({ properties: { target: { type: 'string' }, file: { type: 'string' }, content: { type: 'boolean' } }, required: ['target'] })
    const ask = (await client.listTools()).tools.find((t) => t.name === 'ask')
    expect(ask?.inputSchema).toMatchObject({ properties: { why: { type: 'string' }, command: { type: 'array', items: { type: 'string' } }, withdraw: { type: 'string' } } })
  })
})

/** Moments differ between two calls made one after the other; everything else must be the same. */
const steady = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<at>').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/g, '<at>')

describe('a tool and the command line with the same arguments', () => {
  let sb: Sandbox
  let client: Client
  let reader: Client
  beforeAll(async () => {
    sb = sandbox()
    library(sb)
    // The same session on both faces: what a verb answers depends on the session it is in.
    client = await connect(sb, 'g', 'legacy', 'both-faces')
    reader = await connect(sb, 'ro', 'modern')
    await call(client, 'find', { text: '甲' })
    ok(sb.run(['@g', '--session', 'both-faces', 'find', '甲']))
    // Asked once before, so each face's ask below finds the same pending request.
    ok(sb.run(['@g', '--session', 'both-faces', 'ask', '帮手要一份授权', 'grant', 'issue', 'helper', '--agent', 'helper']))
  })
  afterAll(async () => {
    await client?.close()
    await reader?.close()
  })

  const cases: [string, Record<string, unknown>, string[], string?][] = [
    ['start', { sentence: '改一下 下单流程' }, ['start', '改一下', '下单流程']],
    ['find', { text: 'notes', 'include-archived': true }, ['find', 'notes', '--include-archived']],
    ['find', { text: '乙', origin: 'made' }, ['find', '乙', '--origin', 'made']],
    ['inspect', { target: 'notes/b.md' }, ['inspect', 'notes/b.md']],
    // An agent that cannot read files reads a thing through inspect: the tool gains it from the verbs table.
    ['inspect', { target: 'notes/a.md', content: true }, ['inspect', 'notes/a.md', '--content']],
    ['put', { text: '# 甲\n下单流程\n', to: 'notes/a.md', brought: true }, ['put', '-', '--to', 'notes/a.md', '--brought'], '# 甲\n下单流程\n'],
    ['put', { what: 'notes/b.md', to: 'notes/a.md' }, ['put', 'notes/b.md', '--to', 'notes/a.md']],
    // An agent declares; what the owner's side saw is the owner's to record.
    ['put', { what: 'notes/a.md', brought: true, by: 'owner', observed: true }, ['put', 'notes/a.md', '--brought', '--by', 'owner', '--observed']],
    ['say', { kind: 'note', about: 'notes/a.md', text: '要再核对一遍' }, ['say', 'note', 'notes/a.md', '要再核对一遍']],
    ['say', { kind: 'from', text: 'notes/b.md', args: { from: ['notes/a.md'] } }, ['say', 'from', 'notes/b.md', '--from', 'notes/a.md']],
    ['say', { kind: 'nobody-hears' }, ['say', 'nobody-hears']],
    ['check', { since: '2020-01-01T00:00:00Z' }, ['check', '--since', '2020-01-01T00:00:00Z']],
    ['archive', { path: 'old.md' }, ['archive', 'old.md']],
    ['unarchive', { path: 'notes/a.md' }, ['unarchive', 'notes/a.md']],
    ['archive', { path: 'notes/missing.md' }, ['archive', 'notes/missing.md']],
    ['ask', { why: '帮手要一份授权', command: ['grant', 'issue', 'helper', '--agent', 'helper'] }, ['ask', '帮手要一份授权', 'grant', 'issue', 'helper', '--agent', 'helper']],
    ['ask', { why: '想清空', command: ['archive', 'purge'] }, ['ask', '想清空', 'archive', 'purge']],
    ['show', {}, ['show']],
    ['show', { view: 'files', params: { dir: 'notes' } }, ['show', 'files', '--dir', 'notes']],
    ['show', { view: 'item', params: { path: 'notes/b.md' } }, ['show', 'item', '--path', 'notes/b.md']],
    ['show', { view: 'config' }, ['show', 'config']],
    ['version_list', { path: 'notes/b.md' }, ['version', 'list', 'notes/b.md']],
    ['ledger_held_list', {}, ['ledger', 'held', 'list']],
    ['sync_status', {}, ['sync', 'status']],
    ['deploy_list', {}, ['deploy', 'list']],
    ['search_status', {}, ['search', 'status']],
    ['plugin_list', {}, ['plugin', 'list']],
  ]

  for (const [tool, args, argv, input] of cases) {
    it(`${tool} ${JSON.stringify(args)} is ${argv.join(' ')}`, async () => {
      // start records that the agent looked; one look first, so the three starts all see what is newer than it.
      if (tool === 'start') expect(sb.run(['@g', '--session', 'both-faces', 'check']).code).toBe(0)
      const text = sb.run(['@g', '--session', 'both-faces', ...argv], { input })
      const json = sb.run(['@g', '--session', 'both-faces', ...argv, '--json'], { input })
      const r = await call(client, tool, args)
      expect(r.isError).toBe(json.code === 2)
      expect(steady(JSON.stringify(r.structuredContent))).toBe(steady(JSON.stringify(json.json())))
      expect(steady(textOf(r))).toBe(steady(text.stdout.trimEnd()))
    })
  }

  it('a usage error is the command line’s, as a refusal', async () => {
    for (const [tool, args, argv] of [
      ['version_list', {}, ['version', 'list']],
      ['put', { text: 'x' }, ['put', '-', '--made']],
      ['show', { view: 'no-such-page' }, ['show', 'no-such-page']],
    ] as const) {
      const cli = sb.run(['@g', ...argv], { input: 'x' })
      expect(cli.code).toBe(1)
      const r = await call(client, tool, args)
      expect(r.isError).toBe(true)
      expect(r.structuredContent).toMatchObject({ outcome: 'refused', reason: 'usage' })
      expect(cli.stderr.startsWith(`${textOf(r)}\n`), `${cli.stderr}\n${textOf(r)}`).toBe(true)
    }
  })

  it('a read-only grant is refused a put as on the command line', async () => {
    const cli = sb.run(['@ro', 'put', '-', '--to', 'r.md', '--made', '--json'], { input: 'r' })
    const r = await call(reader, 'put', { text: 'r', to: 'r.md', made: true })
    expect(cli.json()).toMatchObject({ outcome: 'refused', reason: 'outside-grant' })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual(cli.json())
  })
})

describe.each(['legacy', 'modern'] as const)('a whole task through a real MCP client (%s)', (era) => {
  let sb: Sandbox
  let lib: string
  let client: Client
  beforeAll(async () => {
    sb = sandbox()
    lib = library(sb)
    client = await connect(sb, 'g', era)
  })
  afterAll(() => client?.close())

  it('reads the instructions, works the library, is refused management, and is one scene of the grant’s agent', async () => {
    const instructions = client.getInstructions() ?? ''
    expect(instructions.startsWith('你经 MCP 连着一个 Pneuma Base 库')).toBe(true)
    expect(instructions.endsWith(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8'))).toBe(true)
    expect(client.getProtocolEra()).toBe(era)

    expect(textOf(await call(client, 'start', { sentence: '写一份下单流程的说明' }))).toContain('【记下】')
    const put = await call(client, 'put', { text: '# 下单流程说明\n', to: 'docs/flow.md', made: true, from: ['notes/a.md'] })
    expect(put.structuredContent).toMatchObject({ outcome: 'accepted', path: 'docs/flow.md', copied: true })
    expect(readFileSync(join(lib, 'docs/flow.md'), 'utf8')).toBe('# 下单流程说明\n')
    const bytes = await call(client, 'put', { base64: Buffer.from([0, 1, 2, 255]).toString('base64'), to: 'docs/blob.bin', made: true })
    expect(bytes.isError).toBe(false)
    expect([...readFileSync(join(lib, 'docs/blob.bin'))]).toEqual([0, 1, 2, 255])
    expect(textOf(await call(client, 'find', { text: 'flow' }))).toContain('docs/flow.md')
    expect(textOf(await call(client, 'inspect', { target: 'docs/flow.md' }))).toContain('做出来的 · claude')
    expect(await call(client, 'say', { kind: 'note', about: 'docs/flow.md', text: '初稿' })).toMatchObject({ isError: false, structuredContent: { outcome: 'heard' } })
    expect((await call(client, 'check')).isError).toBe(false)
    expect(textOf(await call(client, 'show', { view: 'files', params: { dir: 'docs' } }))).toContain('flow.md')
    expect(await call(client, 'search_status')).toMatchObject({ isError: false, structuredContent: { outcome: 'done' } })
    expect(await call(client, 'grant_issue', { name: 'x', agent: 'y' })).toMatchObject({ isError: true, structuredContent: { reason: 'agent-session' } })

    const scenes = (sb.run(['--library', lib, 'show', 'ledger.scenes', '--json']).json().blocks as any[]).find((b) => b.kind === 'feed').groups.flatMap((g: any) => g.rows) as any[]
    const claude = scenes.filter((row) => row.actor.name === 'claude')
    expect(claude).toHaveLength(1)
    expect(claude[0].text).toBe('写一份下单流程的说明')
    expect(claude[0].meta[0].text).toBe('放入 2 样')
  })

  it('a second connection on the same day is a scene of its own', async () => {
    const other = await connect(sb, 'g', era)
    try {
      expect(textOf(await call(other, 'start', { sentence: '另一件事' }))).toContain('【记下】')
    } finally {
      await other.close()
    }
    const scenes = (sb.run(['--library', lib, 'show', 'ledger.scenes', '--json']).json().blocks as any[]).find((b) => b.kind === 'feed').groups.flatMap((g: any) => g.rows) as any[]
    expect(scenes.filter((row) => row.actor.name === 'claude').map((row) => row.text).sort()).toEqual(['另一件事', '写一份下单流程的说明'].sort())
  })

  it('serves the description and the pages as resources', async () => {
    const resources = (await client.listResources()).resources
    expect(resources.map((r) => r.uri)).toContain('pneuma-base://library/description')
    expect(resources.map((r) => r.uri)).toContain('pneuma-base://library/show/files')
    expect(resources.map((r) => r.uri)).not.toContain('pneuma-base://library/show/config')
    const description = await client.readResource({ uri: 'pneuma-base://library/description' })
    expect(description.contents[0]).toMatchObject({ text: client.getInstructions() })
    const files = await client.readResource({ uri: 'pneuma-base://library/show/files' })
    expect(files.contents[0]).toMatchObject({ text: sb.run(['@g', 'show', 'files']).stdout.trimEnd() })
  })
})

describe.each(['legacy', 'modern'] as const)('a plugin added while connected (%s)', (era) => {
  let sb: Sandbox
  let lib: string
  let client: Client
  beforeAll(async () => {
    sb = sandbox()
    lib = join(tempDir(), 'lib')
    ok(sb.run(['init', lib]))
    ok(sb.run(['--library', lib, 'grant', 'issue', 'g', '--agent', 'claude']))
    client = await connect(sb, 'g', era)
  })
  afterAll(() => client?.close())

  it('is told as a changed tool list, a changed resource list and an updated description', async () => {
    const heard: string[] = []
    const hear = (what: string) => () => void heard.push(what)
    client.setNotificationHandler('notifications/tools/list_changed', hear('tools'))
    client.setNotificationHandler('notifications/resources/list_changed', hear('resources'))
    client.setNotificationHandler('notifications/resources/updated', hear('description'))
    if (era === 'modern') await client.listen({ toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['pneuma-base://library/description'] })
    else await client.subscribeResource({ uri: 'pneuma-base://library/description' })
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('version_list')

    ok(sb.run(['--library', lib, 'plugin', 'add', 'version']))
    await expect.poll(() => [...new Set(heard)].sort(), { timeout: 15_000, interval: 200 }).toEqual(['description', 'resources', 'tools'])
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('version_list')
    const description = await client.readResource({ uri: 'pneuma-base://library/description' })
    expect((description.contents[0] as { text: string }).text).toContain('这个库装了**版本**插件')
  })
})
