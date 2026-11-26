// The package PneumaSpace on Cloudflare takes for a static app (contract pneuma-space.cf/1): JSON with
// the manifest and every file of the site, base64 under public/, with its content type. Its sha256 is
// the content id, and the digest the control API reports for the release online, so equal content has
// an equal id before anything is uploaded. The bytes depend only on the files (the kit hands them sorted
// by path). What the contract refuses is told here, before anything is sent.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { SiteFile } from '@pneuma-base/sdk/kit'

export const MAX_FILES = 256
export const MAX_BYTES = 4 * 1024 * 1024
const MAX_PATH = 300
const DIR = 'public'
/** As the control API normalizes a static manifest, so the one sent is the one stored. */
export const MANIFEST = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: `${DIR}/index.html`, capabilities: { static: { dir: DIR } } } as const

/** sha256 hex of a package's bytes. */
export type Digest = string & { readonly __brand: 'Digest' }
export type Package = { bytes: Buffer; digest: Digest; files: number }

const TEXT = '; charset=utf-8'
const TYPES: Record<string, string> = {
  '.html': `text/html${TEXT}`,
  '.htm': `text/html${TEXT}`,
  '.css': `text/css${TEXT}`,
  '.js': `text/javascript${TEXT}`,
  '.mjs': `text/javascript${TEXT}`,
  '.cjs': `text/javascript${TEXT}`,
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': `text/plain${TEXT}`,
  '.md': `text/markdown${TEXT}`,
  '.csv': `text/csv${TEXT}`,
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
}

/** The content type a file is served with; PneumaSpace serves it with nosniff, so a script or a font typed wrong does not load. */
export const contentType = (path: string): string => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

export async function packageOf(files: readonly SiteFile[]): Promise<Package> {
  const entries = await Promise.all(files.map(async (f) => ({ path: `${DIR}/${f.path}`, body: (await readFile(f.abs)).toString('base64'), contentType: contentType(f.path) })))
  const bytes = Buffer.from(JSON.stringify({ manifest: MANIFEST, files: entries }))
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') as Digest, files: entries.length }
}

const MiB = 1024 * 1024

/** Why a site path is one the contract refuses, or null: at most 300 characters in the package, no control characters, no backslash, no empty, `.` or `..` part. */
function badPath(path: string): string | null {
  if (`${DIR}/${path}`.length > MAX_PATH) return '太长（包里的路径最多 300 个字符）'
  if (/[\u0000-\u001f]/.test(path)) return '带控制字符'
  if (path.includes('\\')) return '带反斜杠'
  if (path.split('/').some((p) => p === '' || p === '.' || p === '..')) return '有空的、. 或 .. 的一段'
  return null
}

/** What PneumaSpace on Cloudflare would refuse in this site, in words for the owner, with the number and the limit; null when it takes it. */
export function refusal(files: readonly SiteFile[], pkg: Package): string | null {
  if (files.length === 0) return '站点里没有文件'
  if (files.length > MAX_FILES) return `站点有 ${files.length} 个文件，Cloudflare 上的 PneumaSpace 一个应用最多收 ${MAX_FILES} 个`
  if (pkg.bytes.length > MAX_BYTES) return `站点打包后 ${(pkg.bytes.length / MiB).toFixed(2)} MiB，Cloudflare 上的 PneumaSpace 一个包最多 4 MiB（文件按 base64 打进包里，比原来大三分之一）`
  for (const f of files) {
    const why = badPath(f.path)
    if (why !== null) return `文件路径 ${JSON.stringify(f.path)} ${why}，Cloudflare 上的 PneumaSpace 不收`
  }
  return null
}
