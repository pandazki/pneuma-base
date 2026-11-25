// view: the command starts the server for a directory, prints the address with its token, and
// stops on Ctrl+C. `pneuma-base <directory>` is the same command.
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
    const child = sb.start(['view', lib, '--no-open'])
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
    const child = sb.start([dir, '--no-open'])
    const url = await address(child)
    expect(await stateOf(url)).toMatchObject({ dir, library: null, available: expect.arrayContaining([expect.objectContaining({ name: 'ledger' })]) })
    const done = exited(child)
    child.kill('SIGINT')
    expect(await done).toBe(0)
  })

  it('refuses a port that is not a number', () => {
    const sb = sandbox()
    expect(sb.run(['view', tempDir(), '--port', 'eighty', '--no-open']).code).toBe(1)
  })
})
