// A stand-in for GitHub's releases, served on this machine, and test-only storage providers to put in
// them: the local folder's own program under another name, answering another address form. No test
// fetches from the real internet: PNEUMA_BASE_RELEASE_HOST points the command line here.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CORE = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

/** A file the host serves: its bytes, or bytes it starts to send and then drops the connection halfway through. */
export type Served = Buffer | { cut: Buffer }

export type Release = { repository: string; manifest: Record<string, unknown>; assets: Record<string, Served>; latest?: boolean }

export type ReleaseHost = {
  url: string
  /** Every path asked for, in order. */
  asked: string[]
  /** Serves a release: its manifest and assets under `/<repository>/releases/download/<version>/`, and, when `latest`, behind GitHub's redirect from `/releases/latest/download/`. */
  publish(release: Release): void
  close(): Promise<void>
}

export async function releaseHost(): Promise<ReleaseHost> {
  const files = new Map<string, Served>()
  const latest = new Map<string, string>()
  const asked: string[] = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://host').pathname)
    asked.push(path)
    const m = /^\/([^/]+\/[^/]+)\/releases\/latest\/download\/(.+)$/.exec(path)
    const tag = m ? latest.get(m[1] as string) : undefined
    if (m && tag !== undefined) {
      res.writeHead(302, { location: `/${m[1]}/releases/download/${encodeURIComponent(tag)}/${m[2]}` }).end()
      return
    }
    const body = files.get(path)
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
      return
    }
    if (Buffer.isBuffer(body)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body)
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.cut.length })
    res.write(body.cut.subarray(0, Math.floor(body.cut.length / 2)), () => res.socket?.destroy())
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    publish({ repository, manifest, assets, latest: isLatest }) {
      const version = manifest.version as string
      const base = `/${repository}/releases/download/${version}`
      files.set(`${base}/pneuma-base-provider.json`, Buffer.from(JSON.stringify(manifest)))
      for (const [name, body] of Object.entries(assets)) files.set(`${base}/${name}`, body)
      if (isLatest) latest.set(repository, version)
    },
    close: () => new Promise((done) => server.close(() => done())),
  }
}

/**
 * A test-only provider: the local folder's program, under the name `name`, answering addresses of
 * the form `<form>://<folder>` (and plain folders, as the contract suite gives them). Each run is
 * logged to `log`. `contract` makes its describe say another contract version; `breaks: 'probe'`
 * makes it answer every probe with nothing found, a sentence of STORAGE.md unmet; `note` changes
 * its bytes, as a new version would.
 */
export function providerScript(o: { name: string; form: string; log: string; contract?: number; breaks?: 'probe'; note?: string }): Buffer {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  return Buffer.from(
    [
      '#!/bin/sh',
      `# ${o.name}: a test-only storage provider. ${o.note ?? ''}`,
      `core=${q(CORE)}`,
      `log=${q(o.log)}`,
      'op=$1',
      'shift',
      'printf \'%s\\n\' "$op $*" >> "$log"',
      'prev=',
      'for a do',
      '  shift',
      `  if [ "$prev" = --root ]; then case $a in ${o.form}://*) a=\${a#${o.form}://}; mkdir -p "$a" ;; esac; fi`,
      '  set -- "$@" "$a"',
      '  prev=$a',
      'done',
      ...(o.breaks === 'probe' ? ['if [ "$op" = probe ]; then echo \'{"outcome":"done","files":0,"dirs":0,"bytes":0,"exceeded":false,"markers":[]}\'; exit 0; fi'] : []),
      'if [ "$op" = describe ]; then',
      `  "$core" describe "$@" | sed -e 's/"name":"local-folder"/"name":"${o.name}"/' -e 's/"addresses":\\["path"\\]/"addresses":["${o.form}"]/' -e 's/"contract":1/"contract":${o.contract ?? 1}/'`,
      '  exit 0',
      'fi',
      'exec "$core" "$op" "$@"',
      '',
    ].join('\n'),
  )
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** A manifest for one executable built for this machine's platform. */
export function manifestFor(o: { name: string; version: string; form: string; asset: string; bytes: Buffer; contract?: number; sha?: string }): Record<string, unknown> {
  return {
    format: 1,
    name: o.name,
    version: o.version,
    contract: o.contract ?? 1,
    addresses: [o.form],
    summary: `${o.name}，只给测试用`,
    executables: { [`${process.platform}-${process.arch}`]: { asset: o.asset, sha256: o.sha ?? sha256(o.bytes) } },
  }
}

export type Ran = { code: number; stdout: string; stderr: string; json: () => any }

/** Runs the real built `pneuma-base` without blocking this process, which serves the releases meanwhile. */
export function runCli(home: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr, json: () => JSON.parse(stdout) }))
  })
}
