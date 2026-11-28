// A temporary home and library to test a plugin against, through the real command line and the
// real viewer's server.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import type { Action, ActionInput, Call, ViewResult } from '../types.js'
import { DEFAULT_TIMEOUT, cleanEnv, findCli, runCli, tempDir, type CallOptions, type Result } from './run.js'

export type SandboxOptions = {
  /** Built plugin directories (each with its `index.js`) to install into the temporary home and add to the library. */
  plugins?: readonly string[]
  /** Built-in plugins to add to the library besides those `init` adds. */
  builtins?: readonly string[]
  /**
   * Start from `init --bare`: no plugin but those given here. With no plugin that has `revise`, a put
   * onto a path that holds different content is refused (`would-overwrite`); with no plugin for a
   * kind, `say` is not heard; find lists by name only, and inspect and check give no sections.
   */
  bare?: boolean
  /** Added to the environment of every call, such as the address of a test server. */
  env?: Record<string, string>
  /** Milliseconds each call may take. 60 000 when not given. */
  timeout?: number
  /** The command line's `bin.js`; found as `findCli` finds it when not given. */
  cli?: string
}

/** The viewer's server for the sandbox's library, as the management UI talks to it. */
export interface Viewer {
  /** The address it printed, with its token. */
  readonly url: string
  /** `GET /api/state`: the library, its views and problems. */
  state(): Promise<{ views: { id: string; title: string }[]; problems: { plugin: string; message: string }[]; library: { root: string; id: string } | null }>
  /** `GET /api/view`: one view with its parameters. */
  view(id: string, params?: Record<string, string>): Promise<ViewResult>
  /**
   * The item panel of one library path. With `plugin`, only that plugin's section of it: the
   * section's title and blocks, and that plugin's problems; no blocks when it gave no section.
   */
  item(path: string, options?: { plugin?: string }): Promise<ViewResult>
  /**
   * Runs an action of a block as a person who fills its inputs with `values` and confirms: its call,
   * with every `{input}` replaced as the page replaces it, sent to `POST /api/call`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the call's result is the face's answer, whose shape the test knows
  act(action: Action, values?: Record<string, string>): Promise<{ tone: 'good' | 'warn' | 'bad'; text: string; result: any }>
  /** `GET` of any path on the server, such as `/plugin-ui/<name>/<entry>`, with the token added. */
  get(path: string): Promise<Response>
  stop(): Promise<void>
}

export interface Sandbox {
  /** `$PNEUMA_BASE_HOME` of every call: plugins, grants, secrets and caches of this sandbox live here. */
  readonly home: string
  /** The library's root. */
  readonly library: string
  /** The working directory calls run in unless they say otherwise: put files here to bring them in. */
  readonly work: string
  /** The environment calls run with: the owner's, with no agent session in it. */
  readonly env: Readonly<Record<string, string>>
  /** The command line's `bin.js`. */
  readonly cli: string
  /**
   * The file the kernel writes a JSON line to for each listing, read and probe a plugin asks of storage,
   * in every call and in the viewer (`PNEUMA_BASE_TOOL_LOG`): `plugin`, `area` (`content`, `own`, or a
   * record place it named), `tool`, `place`, and `entries`, how many it answered (or `reason`, why not).
   */
  readonly toolLog: string
  /** `pneuma-base ...args`, with no library given. */
  run(args: readonly string[], opts?: CallOptions): Promise<Result>
  /** `pneuma-base --library <library> ...args`, as the owner. */
  owner(args: readonly string[], opts?: CallOptions): Promise<Result>
  /** `pneuma-base --library <library> --as <name> --session <session> ...args`, as the agent `name` in that session. */
  agent(name: string, session: string, args: readonly string[], opts?: CallOptions): Promise<Result>
  /** Starts `pneuma-base view <library> --no-open`; `cleanup` stops it if the test did not. */
  viewer(): Promise<Viewer>
  /**
   * Starts a stand-in for an outside HTTP service, such as the one a deploy target publishes to, and
   * answers its address, `http://127.0.0.1:<port>`. Each request reaches `handler` whole (method, URL,
   * headers, body), and what it answers goes back; a handler that throws answers 500. `cleanup` stops it.
   */
  serve(handler: Handler): Promise<string>
  /** Stops every viewer and stand-in it started and removes its temporary directories. */
  cleanup(): Promise<void>
}

/** What a stand-in answers to one request, as a `fetch` handler does. */
export type Handler = (request: Request) => Response | Promise<Response>

const failed = (what: string, r: Result) => new Error(`${what}没有做成（退出码 ${r.code}）：\n${r.stdout}${r.stderr}`)

export async function sandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const cli = findCli(options.cli)
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const root = await tempDir('pneuma-base-sandbox-')
  const home = join(root, 'home')
  const library = join(root, 'library')
  const work = join(root, 'work')
  const toolLog = join(root, 'tool-log.jsonl')
  await Promise.all([mkdir(home), mkdir(work)])
  const env = cleanEnv(home, { PNEUMA_BASE_TOOL_LOG: toolLog, ...options.env })
  const viewers: Viewer[] = []
  const standIns: (() => Promise<void>)[] = []

  const run = (args: readonly string[], opts: CallOptions = {}) =>
    runCli(cli, args, { cwd: opts.cwd ?? work, env: { ...env, ...opts.env }, timeout, ...(opts.input === undefined ? {} : { input: opts.input }) })
  const owner = (args: readonly string[], opts?: CallOptions) => run(['--library', library, ...args], opts)
  const must = async (what: string, call: Promise<Result>) => {
    const r = await call
    if (r.code !== 0 || r.json?.outcome !== 'done') throw failed(what, r)
    return r
  }

  const sb: Sandbox = {
    home: env.PNEUMA_BASE_HOME as string,
    library,
    work,
    env,
    cli,
    toolLog,
    run,
    owner,
    agent: (name, session, args, opts) => run(['--library', library, '--as', name, '--session', session, ...args], opts),
    async viewer() {
      const v = await startViewer(cli, library, { cwd: work, env, timeout })
      viewers.push(v)
      return v
    },
    async serve(handler) {
      const { url, stop } = await standIn(handler)
      standIns.push(stop)
      return url
    },
    async cleanup() {
      await Promise.all([...viewers.map((v) => v.stop()), ...standIns.map((stop) => stop())])
      await rm(root, { recursive: true, force: true })
    },
  }

  try {
    const installed: string[] = []
    for (const dir of options.plugins ?? []) {
      const r = await must(`装插件 ${dir} `, run(['plugin', 'install', resolve(dir), '--json']))
      installed.push(r.json.data.name)
    }
    await must('建库', run(['init', library, ...(options.bare ? ['--bare'] : []), '--json']))
    for (const name of [...(options.builtins ?? []), ...installed]) await must(`在库里装上插件 ${name} `, owner(['plugin', 'enable', name, '--json']))
  } catch (error) {
    await sb.cleanup()
    throw error
  }
  return sb
}

// ---- a stand-in for an outside service ----

async function standIn(handler: Handler): Promise<{ url: string; stop: () => Promise<void> }> {
  let origin = ''
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) for (const one of [value ?? []].flat()) headers.append(name, one)
      const body = chunks.length === 0 ? null : new Uint8Array(Buffer.concat(chunks))
      const answer = await handler(new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers, body }))
      res.writeHead(answer.status, Object.fromEntries(answer.headers))
      res.end(Buffer.from(await answer.arrayBuffer()))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`替身出错了：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const stop = () =>
    new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
  return { url: origin, stop }
}

// ---- the viewer ----

const ADDRESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/

async function startViewer(cli: string, library: string, opts: { cwd: string; env: Record<string, string>; timeout: number }): Promise<Viewer> {
  const child = spawn(process.execPath, [cli, 'view', library, '--no-open'], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise<URL>((done, fail) => {
    let printed = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`pneuma-base view 过了 ${opts.timeout / 1000} 秒还没给出地址：\n${printed}`))
    }, opts.timeout)
    const read = (chunk: Buffer) => {
      printed += chunk.toString('utf8')
      const match = ADDRESS.exec(printed)
      if (match === null) return
      clearTimeout(timer)
      done(new URL(match[0]))
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`pneuma-base view 退出了（${code}）：\n${printed}`))
    })
  })
  const token = url.searchParams.get('token') as string
  const signal = () => AbortSignal.timeout(opts.timeout)
  const get = (path: string) => fetch(new URL(`${path}${path.includes('?') ? '&' : '?'}token=${token}`, url.origin), { signal: signal() })
  const json = async <T>(path: string, query: Record<string, string>): Promise<T> => {
    const reply = await get(`${path}?${new URLSearchParams(query)}`)
    if (!reply.ok) throw new Error(`${path} 答复 ${reply.status}：${await reply.text()}`)
    return (await reply.json()) as T
  }
  return {
    url: url.href,
    state: () => json('/api/state', {}),
    view: (id, params = {}) => json('/api/view', { ...params, view: id }),
    async item(path, options = {}) {
      const whole = await json<ViewResult>('/api/view', { view: 'item', path })
      const { plugin } = options
      if (plugin === undefined || whole.outcome !== 'shown') return whole
      const section = whole.blocks.find((b) => b.kind === 'section' && b.plugin === plugin)
      const problems = whole.problems.filter((p) => p.plugin === plugin)
      return section?.kind === 'section' ? { ...whole, title: section.title, blocks: section.blocks, problems } : { ...whole, blocks: [], problems }
    },
    async act(action, values = {}) {
      const call = fill(action.call, { ...initial(action.inputs), ...values }, action.inputs)
      const reply = await fetch(new URL('/api/call', url.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pneuma-token': token },
        body: JSON.stringify({ call, confirmed: true }),
        signal: signal(),
      })
      if (!reply.ok) throw new Error(`/api/call 答复 ${reply.status}：${await reply.text()}`)
      return (await reply.json()) as Awaited<ReturnType<Viewer['act']>>
    },
    get,
    stop: () => stopChild(child),
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill('SIGINT')
  })
}

// As the management page fills a call (packages/viewer/web/src/chrome.tsx, `fill` and `initial`).

const initial = (inputs: readonly ActionInput[]) => Object.fromEntries(inputs.map((i) => [i.name, i.value ?? i.options?.[0]?.value ?? '']))

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

function fill(call: Call, values: Record<string, string>, inputs: readonly ActionInput[]): Call {
  const multiple = new Set(inputs.filter((i) => i.multiple).map((i) => i.name))
  const placeholder = (v: unknown) => (typeof v === 'string' ? /^\{([^{}]+)\}$/.exec(v)?.[1] : undefined)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{([^{}]+)\}/g, (whole, name: string) => values[name] ?? whole)
    if (Array.isArray(v)) {
      return v.flatMap((x) => {
        const name = placeholder(x)
        return name !== undefined && multiple.has(name) ? lines(values[name] ?? '') : [walk(x)]
      })
    }
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(call) as Call
}
