// A thing's content, which inspect gives when asked, for an agent that cannot read files itself (an
// MCP client). ARCHITECTURE "找、看、说、查、归档".
import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { mayRead } from './access.js'
import { abs } from './paths.js'
import { bundleFiles } from './things.js'
import type { Content, Context, FileFacts, LibraryPath } from '@pneuma-base/sdk'

/** The most text inspect gives: a long document or a page of a site fits; a dump or a data file does not. */
export const CONTENT_LIMIT = 256 * 1024

/** The media types a file's name says, for content that is not given as text. */
const TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * The content of the thing `file` names: a file's, or for a bundle its files, or the one at `inner`
 * in it. Nothing outside the caller's grant.
 */
export async function contentOf(ctx: Context, file: FileFacts, inner: string | null): Promise<Content> {
  const { root } = ctx.library
  const unavailable = (reason: Extract<Content, { kind: 'unavailable' }>['reason']): Content => ({ kind: 'unavailable', path: file.path, reason })
  if (!mayRead(ctx, file.path)) return unavailable('outside-grant')
  if (file.kind === 'file') return inner === null ? fileContent(root, file.path) : unavailable('not-a-bundle')
  const files = await bundleFiles(abs(root, file.path))
  if (inner === null) return { kind: 'files', path: file.path, files }
  // Only a file the bundle counts: a path that climbs out of it, or names its marker, is none.
  const found = files.find((f) => f.path === posix.normalize(inner))
  return found ? fileContent(root, `${file.path}/${found.path}` as LibraryPath) : unavailable('no-such-file')
}

async function fileContent(root: string, path: LibraryPath): Promise<Content> {
  const { size } = await stat(abs(root, path))
  const other = (why: 'not-utf8' | 'too-large'): Content => ({ kind: 'other', path, size, type: TYPES[extname(path).toLowerCase()] ?? null, why })
  if (size > CONTENT_LIMIT) return other('too-large')
  const bytes = await readFile(abs(root, path))
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\u0000') ? other('not-utf8') : { kind: 'text', path, size, text }
  } catch {
    return other('not-utf8')
  }
}
