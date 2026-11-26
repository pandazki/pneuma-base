// Where the server listens: both loopback addresses with one port number, never a wildcard address.
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** How many ports after the preferred one are tried before any free port is taken. */
const FALLBACKS = 19
/** How many times a free port is asked for when the one 127.0.0.1 got is taken on ::1. */
const ANY_TRIES = 8

export type Listening = { port: number; servers: Server[] }

const listenOn = (server: Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code

/**
 * `handler` on 127.0.0.1 and on ::1 with the same port, or the error that says the port is taken on
 * either. A machine without IPv6 loopback is served on 127.0.0.1 alone.
 */
async function bindBoth(handler: RequestListener, port: number): Promise<Listening | NodeJS.ErrnoException> {
  const v4 = createServer(handler)
  try {
    await listenOn(v4, port, '127.0.0.1')
  } catch (error) {
    if (codeOf(error) === 'EADDRINUSE') return error as NodeJS.ErrnoException
    throw error
  }
  const bound = (v4.address() as AddressInfo).port
  const v6 = createServer(handler)
  try {
    await listenOn(v6, bound, '::1')
    return { port: bound, servers: [v4, v6] }
  } catch (error) {
    if (codeOf(error) === 'EADDRNOTAVAIL' || codeOf(error) === 'EAFNOSUPPORT') return { port: bound, servers: [v4] }
    await closed(v4)
    if (codeOf(error) === 'EADDRINUSE') return error as NodeJS.ErrnoException
    throw error
  }
}

/**
 * `port` absent: `preferred`, else the next free one of the 19 after it, else any free port. 0: any
 * free port. A number: exactly that port, and the EADDRINUSE error when it is taken.
 */
export async function listenLoopback(handler: RequestListener, port: number | undefined, preferred: number): Promise<Listening> {
  const any: number[] = Array.from({ length: ANY_TRIES }, () => 0)
  const tries = port === undefined ? [...Array.from({ length: FALLBACKS + 1 }, (_, i) => preferred + i), ...any] : port === 0 ? any : [port]
  let last: NodeJS.ErrnoException | null = null
  for (const candidate of tries) {
    const r = await bindBoth(handler, candidate)
    if (!(r instanceof Error)) return r
    last = r
  }
  throw last
}
