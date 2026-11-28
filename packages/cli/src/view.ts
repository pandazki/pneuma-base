import { ensureLauncher, sentenceFor, type PluginTable } from '@pneuma-base/kernel'
import { startServer } from '@pneuma-base/viewer'
import type { Io } from './main.js'
import { mcpOverHttp } from './mcp/http.js'

/**
 * Serves the management UI for `dir`, and the local endpoint agents connect through, on this machine
 * until the person stops it. The server joins `builtins` with this machine's own plugins on every
 * request. `port` absent: the preferred port, so the sentence to say to an agent stays the same.
 */
export async function view(opts: { dir: string; builtins: PluginTable; home: string; io: Io; port: number | undefined; open: boolean }): Promise<{ url: string }> {
  const { io } = opts
  // The guide the endpoint serves names this machine's command: it runs only once it is there.
  await ensureLauncher(opts.home, io.env)
  const mcp = mcpOverHttp({ home: opts.home, builtins: opts.builtins, env: io.env, cwd: io.cwd })
  const server = await startServer({ dir: opts.dir, builtins: opts.builtins, home: opts.home, env: io.env, port: opts.port, mcp })
  io.out(`Pneuma Base 管理界面：${server.url}`)
  io.out(`发给 Agent 的指令：${sentenceFor(server.endpoint)}`)
  io.out('仅限本机访问，地址中包含 token。按 Ctrl+C 关闭。')
  if (opts.open) io.openBrowser(server.url)
  await io.untilStopped()
  await server.close()
  return { url: server.url }
}
