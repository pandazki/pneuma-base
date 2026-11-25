import type { PluginTable } from '@pneuma-base/kernel'
import { startServer } from '@pneuma-base/viewer'
import type { Io } from './main.js'

/** Serves the management UI for `dir` on this machine until the person stops it. The server joins `builtins` with this machine's own plugins on every request. */
export async function view(opts: { dir: string; builtins: PluginTable; home: string; io: Io; port: number; open: boolean }): Promise<{ url: string }> {
  const { io } = opts
  const server = await startServer({ dir: opts.dir, builtins: opts.builtins, home: opts.home, env: io.env, port: opts.port })
  io.out(`Pneuma Base 管理界面：${server.url}`)
  io.out('只有本机能打开，地址里带着令牌。按 Ctrl+C 关闭。')
  if (opts.open) io.openBrowser(server.url)
  await io.untilStopped()
  await server.close()
  return { url: server.url }
}
