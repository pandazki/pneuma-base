// What every route of the server answers with, and how it reads a body within a limit.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/** The body is larger than the route takes: answered with 413. */
export class TooLarge extends Error {}

export function sendJson(res: ServerResponse, { status, json }: { status: number; json: unknown }, headers: OutgoingHttpHeaders = {}): void {
  const body = JSON.stringify(json)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

/**
 * The body as text, or TooLarge once it passes `limit` bytes. The rest of an oversized body is read
 * and dropped, so the client gets the answer instead of a reset connection.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume()
      return reject(new TooLarge(`body is larger than ${limit} bytes`))
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size <= limit) return void chunks.push(chunk)
      over = true
      chunks.length = 0
      reject(new TooLarge(`body is larger than ${limit} bytes`))
    })
    req.on('end', () => over || resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** The request's media type without its parameters, lower case: `application/json; charset=utf-8` is `application/json`. */
export const mediaType = (req: IncomingMessage): string => (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
