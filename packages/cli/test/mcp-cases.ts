// What the MCP tests over standard input and output and over HTTP share: a real client, a library to
// work, and the calls whose answers must be the command line's.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect } from 'vitest'
import { tempDir, type Run, type Sandbox } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
export const VERBS = ['start', 'find', 'inspect', 'put', 'say', 'check', 'archive', 'unarchive', 'ask', 'show']
export type Era = 'legacy' | 'modern'
export type CallResult = { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }

/** Client options for an era: legacy opens with initialize, modern pins 2026-07-28. */
export const eraOptions = (era: Era) => (era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } } : {})

/** A real MCP client on `pneuma-base @<grant> mcp`, in the era asked for. */
export async function connect(sb: Sandbox, grant: string, era: Era, session?: string): Promise<Client> {
  const env = { PATH: process.env.PATH ?? '', HOME: sb.home, PNEUMA_BASE_HOME: join(sb.home, '.pneuma-base') }
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, `@${grant}`, 'mcp', ...(session === undefined ? [] : ['--session', session])], env, cwd: sb.home, stderr: 'pipe' })
  const client = new Client({ name: 'pneuma-base-test', version: '0' }, eraOptions(era))
  await client.connect(transport)
  return client
}

export const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallResult
export const textOf = (r: CallResult) => r.content.map((c) => c.text ?? '').join('\n')

export function ok(r: Run): Run {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}

/** A library with the five built-in plugins, something in it, a read-write grant `g` for claude and a read-only `ro` for reader. */
export function library(sb: Sandbox): string {
  const lib = join(tempDir(), 'lib')
  ok(sb.run(['init', lib]))
  for (const p of ['version', 'sync', 'deploy', 'search']) ok(sb.run(['--library', lib, 'plugin', 'enable', p]))
  ok(sb.run(['--library', lib, 'grant', 'create', 'g', '--agent', 'claude']))
  ok(sb.run(['--library', lib, 'grant', 'create', 'ro', '--agent', 'reader', '--read-only']))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'notes/a.md', '--imported', '--source', 'https://example.com/a'], { input: '# 甲\n下单流程\n' }))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'notes/b.md', '--generated', '--from', 'notes/a.md'], { input: '# 乙\n' }))
  ok(sb.run(['--library', lib, 'say', 'versioned', 'notes/b.md', '第一版']))
  ok(sb.run(['--library', lib, 'put', '-', '--to', 'old.md', '--generated'], { input: '旧的\n' }))
  ok(sb.run(['--library', lib, 'archive', 'old.md']))
  return lib
}

/** The rows of the ledger's scenes page, as the owner's command line shows them. */
export const sceneRows = (sb: Sandbox, lib: string): any[] =>
  (sb.run(['--library', lib, 'show', 'ledger.scenes', '--json']).json().blocks as any[]).find((b) => b.kind === 'feed').groups.flatMap((g: any) => g.rows)

/** Moments differ between two calls made one after the other; everything else must be the same. */
export const steady = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<at>').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/g, '<at>')

/** The session both faces work in: what a verb answers depends on the session it is in. */
export const BOTH_FACES = 'both-faces'

/** On a fresh `library`: the steps that put both faces in the same state before the parity cases. */
export async function sameStart(sb: Sandbox, client: Client): Promise<void> {
  await call(client, 'find', { text: '甲' })
  ok(sb.run(['@g', '--session', BOTH_FACES, 'find', '甲']))
  // Asked once before, so each face's ask below finds the same pending request.
  ok(sb.run(['@g', '--session', BOTH_FACES, 'ask', '帮手要一份授权', 'grant', 'create', 'helper', '--agent', 'helper']))
}

/** A tool, its arguments, the command line with the same arguments, and its standard input. In order: later cases see what earlier ones did. */
export const PARITY_CASES: [string, Record<string, unknown>, string[], string?][] = [
  ['start', { sentence: '改一下 下单流程' }, ['start', '改一下', '下单流程']],
  ['find', { text: 'notes', 'include-archived': true }, ['find', 'notes', '--include-archived']],
  ['find', { text: '乙', origin: 'generated' }, ['find', '乙', '--origin', 'generated']],
  ['inspect', { target: 'notes/b.md' }, ['inspect', 'notes/b.md']],
  // An agent that cannot read files reads a thing through inspect: the tool gains it from the verbs table.
  ['inspect', { target: 'notes/a.md', content: true }, ['inspect', 'notes/a.md', '--content']],
  ['put', { text: '# 甲\n下单流程\n', to: 'notes/a.md', imported: true }, ['put', '-', '--to', 'notes/a.md', '--imported'], '# 甲\n下单流程\n'],
  ['put', { what: 'notes/b.md', to: 'notes/a.md' }, ['put', 'notes/b.md', '--to', 'notes/a.md']],
  // An agent declares; what the owner's side saw is the owner's to record.
  ['put', { what: 'notes/a.md', imported: true, by: 'owner', observed: true }, ['put', 'notes/a.md', '--imported', '--by', 'owner', '--observed']],
  ['say', { kind: 'note', about: 'notes/a.md', text: '要再核对一遍' }, ['say', 'note', 'notes/a.md', '要再核对一遍']],
  ['say', { kind: 'basis', text: 'notes/b.md', args: { from: ['notes/a.md'] } }, ['say', 'basis', 'notes/b.md', '--from', 'notes/a.md']],
  ['say', { kind: 'nobody-hears' }, ['say', 'nobody-hears']],
  ['check', { since: '2020-01-01T00:00:00Z' }, ['check', '--since', '2020-01-01T00:00:00Z']],
  ['archive', { path: 'old.md' }, ['archive', 'old.md']],
  ['unarchive', { path: 'notes/a.md' }, ['unarchive', 'notes/a.md']],
  ['archive', { path: 'notes/missing.md' }, ['archive', 'notes/missing.md']],
  ['ask', { why: '帮手要一份授权', command: ['grant', 'create', 'helper', '--agent', 'helper'] }, ['ask', '帮手要一份授权', 'grant', 'create', 'helper', '--agent', 'helper']],
  ['ask', { why: '想清空', command: ['archive', 'purge'] }, ['ask', '想清空', 'archive', 'purge']],
  ['show', {}, ['show']],
  ['show', { view: 'files', params: { dir: 'notes' } }, ['show', 'files', '--dir', 'notes']],
  ['show', { view: 'item', params: { path: 'notes/b.md' } }, ['show', 'item', '--path', 'notes/b.md']],
  ['show', { view: 'settings' }, ['show', 'settings']],
  ['version_list', { path: 'notes/b.md' }, ['version', 'list', 'notes/b.md']],
  ['ledger_copies_list', {}, ['ledger', 'copies', 'list']],
  ['sync_status', {}, ['sync', 'status']],
  ['deploy_list', {}, ['deploy', 'list']],
  ['search_status', {}, ['search', 'status']],
  ['plugin_list', {}, ['plugin', 'list']],
]

/** The case's tool answers what the command line answers in the same session: the same refusal flag, result object and text. */
export async function expectParity(sb: Sandbox, client: Client, [tool, args, argv, input]: (typeof PARITY_CASES)[number]): Promise<void> {
  // start records that the agent looked; one look first, so the three starts all see what is newer than it.
  if (tool === 'start') expect(sb.run(['@g', '--session', BOTH_FACES, 'check']).code).toBe(0)
  const text = sb.run(['@g', '--session', BOTH_FACES, ...argv], { input })
  const json = sb.run(['@g', '--session', BOTH_FACES, ...argv, '--json'], { input })
  const r = await call(client, tool, args)
  expect(r.isError).toBe(json.code === 2)
  expect(steady(JSON.stringify(r.structuredContent))).toBe(steady(JSON.stringify(json.json())))
  expect(steady(textOf(r))).toBe(steady(text.stdout.trimEnd()))
}
