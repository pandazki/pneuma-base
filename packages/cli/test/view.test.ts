// view: the command starts the server for a directory, prints the address with its token and the
// sentence to say to an agent, and stops on Ctrl+C. `pneuma-base <directory>` is the same command.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

/** The address the command prints, once it printed it. */
function address(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/.exec(out)
      if (match) resolve(match[0])
    })
    child.once('exit', (code) => reject(new Error(`exited with ${code} before printing an address: ${out}`)))
  })
}

const exited = (child: ChildProcessWithoutNullStreams) => new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))

async function stateOf(url: string): Promise<any> {
  const { origin, searchParams } = new URL(url)
  const res = await fetch(`${origin}/api/state?token=${searchParams.get('token')}`)
  return res.json()
}

describe('view', () => {
  it('serves the library on 127.0.0.1 with a token until stopped', async () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib, '--bare']).code).toBe(0)
    const child = sb.start(['view', lib, '--no-open', '--port', '0'])
    const url = await address(child)
    expect((await stateOf(url)).library.root).toBe(lib)
    expect((await fetch(new URL(url).origin + '/api/state')).status).toBe(401)
    const done = exited(child)
    child.kill('SIGINT')
    expect(await done).toBe(0)
  })

  it('with a directory as its only argument, pneuma-base opens the view of it, even when it is no library', async () => {
    const sb = sandbox()
    const dir = tempDir('pb-plain-')
    const child = sb.start([dir, '--no-open', '--port', '0'])
    const url = await address(child)
    expect(await stateOf(url)).toMatchObject({ dir, library: null, available: expect.arrayContaining([expect.objectContaining({ name: 'ledger' })]) })
    const done = exited(child)
    child.kill('SIGINT')
    expect(await done).toBe(0)
  })

  it('prints the sentence for an agent, whose address serves the guide and MCP over HTTP', async () => {
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib, '--bare']).code).toBe(0)
    const child = sb.start(['view', lib, '--no-open', '--port', '0'])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')))
    const { origin } = new URL(await address(child))
    await expect.poll(() => out).toContain(`读一下 ${origin}/guide，接上我的 Pneuma Base 库。`)
    expect((await fetch(`${origin}/guide`)).status).toBe(200)
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
    const mcp = await fetch(`${origin}/mcp/claude`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(initialize) })
    expect(mcp.status).toBe(200)
    expect(mcp.headers.get('mcp-session-id')).toBeTruthy()
    const done = exited(child)
    child.kill('SIGINT')
    expect(await done).toBe(0)
  })

  it('refuses a port that is not a number', () => {
    const sb = sandbox()
    expect(sb.run(['view', tempDir(), '--port', 'eighty', '--no-open']).code).toBe(1)
  })
})
