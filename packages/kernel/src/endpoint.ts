// The local endpoint: the part of the management UI's server that agents talk to (the guide, pairing,
// MCP over HTTP). It prefers one fixed port, so the sentence the owner says to an agent stays the
// same from day to day, and writes the address it got to machine state, one file per running server:
// `$PNEUMA_BASE_HOME/endpoints/<port>.json`. ARCHITECTURE.md「端口和地址的记录」.
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './machine-files.js'
import type { Instant } from '@pneuma-base/sdk'

/** The port the server tries first; when it is taken, the next free one after it. */
export const PREFERRED_PORT = 7638

/** A running endpoint. `url` is its origin, `http://127.0.0.1:<port>`; `library` the directory its server serves. No secret is in it. */
export type EndpointRecord = { format: 1; url: string; port: number; pid: number; library: string; at: Instant }

const endpointsDir = (home: string) => join(home, 'endpoints')
const recordPath = (home: string, port: number) => join(endpointsDir(home), `${port}.json`)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function recordEndpoint(home: string, record: Omit<EndpointRecord, 'format'>): Promise<void> {
  await writeAtomic(recordPath(home, record.port), `${JSON.stringify({ format: 1, ...record }, null, 2)}\n`, endpointsDir(home))
}

/** Takes the record of the server on `port` away, if it is still that process's. */
export async function dropEndpoint(home: string, port: number, pid: number): Promise<void> {
  const current = await readRecord(home, `${port}.json`)
  if (current?.pid === pid) await unlink(recordPath(home, port)).catch(() => undefined)
}

async function readRecord(home: string, name: string): Promise<EndpointRecord | null> {
  try {
    const raw = JSON.parse(await readFile(join(endpointsDir(home), name), 'utf8')) as Partial<EndpointRecord>
    const ok = raw.format === 1 && typeof raw.url === 'string' && typeof raw.port === 'number' && typeof raw.pid === 'number' && typeof raw.library === 'string'
    return ok ? (raw as EndpointRecord) : null
  } catch {
    return null
  }
}

/** The endpoints running on this machine now, lowest port first; a record whose process is gone is left out. */
export async function liveEndpoints(home: string): Promise<EndpointRecord[]> {
  const names = (await readdir(endpointsDir(home)).catch(() => [] as string[])).filter((n) => /^\d+\.json$/.test(n))
  const records = await Promise.all(names.map((n) => readRecord(home, n)))
  return records.filter((r): r is EndpointRecord => r !== null && alive(r.pid)).sort((a, b) => a.port - b.port)
}

/** The running endpoint that serves `library`, or, with no library named, the one on the lowest port; null when none runs. */
export async function endpointOf(home: string, library: string | null): Promise<EndpointRecord | null> {
  const live = await liveEndpoints(home)
  return (library === null ? live[0] : live.find((r) => r.library === library)) ?? null
}

export const guideUrl = (origin: string, product: string | null = null): string => `${origin}/guide${product === null ? '' : `/${product}`}`
export const mcpUrl = (origin: string, grant: string): string => `${origin}/mcp/${grant}`

/** The one sentence the owner says to any agent. */
export const sentenceFor = (origin: string): string => `读取 ${guideUrl(origin)}，连接我的 Pneuma Base 资料库。`
