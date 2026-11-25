// Runs the real built `pneuma-base` without blocking, so a server the test starts in this process
// can answer it.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

export function tempDir(prefix = 'pb-s-'): string {
  return realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
}

export type Run = { code: number; stdout: string; stderr: string; json: () => any }
export type RunOptions = { cwd?: string; env?: Record<string, string>; input?: string }

export type Sandbox = { home: string; run(args: string[], opts?: RunOptions): Promise<Run> }

/** A home of its own; the environment holds no agent session variable unless `env` adds one. */
export function sandbox(): Sandbox {
  const home = tempDir('pb-s-home-')
  return {
    home,
    run: (args, opts = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], {
          cwd: opts.cwd ?? home,
          env: { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...opts.env },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
        child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, json: () => JSON.parse(stdout) }))
        child.stdin.end(opts.input ?? '')
      }),
  }
}

export function ok(r: Run): Run {
  if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`)
  return r
}

export function libraryId(lib: string): string {
  return (JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')) as { id: string }).id
}

/** The words each dimension of the fake model stands for; a text's vector counts them. */
export const CONCEPTS = [
  ['咖啡', '拿铁', '烘焙', '提神', '饮料'],
  ['宠物', '猫', '狗', '疫苗', '兽医'],
  ['小说', '旧书', '阅读', '图书'],
] as const

function conceptVector(text: string): number[] {
  return [...CONCEPTS.map((words) => words.filter((w) => text.includes(w)).length), 0.01]
}

export type FakeEmbedder = {
  url: string
  requests: { authorization: string | undefined; model: unknown; input: string[] }[]
  close(): Promise<void>
}

/** An OpenAI-compatible /v1/embeddings on 127.0.0.1 with deterministic vectors, answering in reverse index order. */
export async function fakeEmbedder(): Promise<FakeEmbedder> {
  const requests: FakeEmbedder['requests'] = []
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = ''
      req.setEncoding('utf8').on('data', (d: string) => (text += d))
      req.on('end', () => resolve(text))
    })
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.writeHead(404).end()
      return
    }
    const parsed = JSON.parse(await body(req)) as { model: unknown; input: string[] }
    requests.push({ authorization: req.headers.authorization, model: parsed.model, input: parsed.input })
    const data = parsed.input.map((text, index) => ({ object: 'embedding', index, embedding: conceptVector(text) })).reverse()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data, model: parsed.model }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
