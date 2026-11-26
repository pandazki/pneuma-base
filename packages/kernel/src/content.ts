// A thing's content, which inspect gives when asked, for an agent that cannot read files itself (an
// MCP client). ARCHITECTURE "找、看、说、查、归档". Read through storage, only because asked.
import { extname, posix } from 'node:path'
import { mayRead } from './access.js'
import type { Storage } from './storage.js'
import { BUNDLE_MARKER, levelOf, whatIsOne } from './things.js'
import { isFailure, type Content, type Context, type FileFacts, type LibraryPath } from '@pneuma-base/sdk'

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
 * The content of the thing `file` names: a file's, or for a bundle one level of it (its first, or the
 * directory at `inner`), or the file at `inner` in it. Nothing outside the caller's grant; nothing that
 * climbs out of the bundle or is its marker.
 */
export async function contentOf(ctx: Context, store: Storage, file: FileFacts, inner: string | null): Promise<Content> {
  const unavailable = (reason: Extract<Content, { kind: 'unavailable' }>['reason']): Content => ({ kind: 'unavailable', path: file.path, reason })
  if (!mayRead(ctx, file.path)) return unavailable('outside-grant')
  if (file.kind === 'file') return inner === null ? fileContent(store, file.path) : unavailable('not-a-bundle')
  const rel = inner === null ? '' : posix.normalize(inner).replace(/\/+$/, '')
  if (rel.startsWith('..') || rel.startsWith('/') || rel === BUNDLE_MARKER) return unavailable('no-such-file')
  const path = (rel === '' || rel === '.' ? file.path : `${file.path}/${rel}`) as LibraryPath
  const at = path === file.path ? null : await whatIsOne(store, path)
  if (at === null || at.kind === 'folder' || at.kind === 'bundle') {
    const level = await levelOf(store, path)
    return level === null ? unavailable('no-such-file') : { kind: 'level', path, level }
  }
  return at.kind === 'file' ? fileContent(store, path) : unavailable('no-such-file')
}

async function fileContent(store: Storage, path: LibraryPath): Promise<Content> {
  const [at] = await store.glance([path])
  const size = at !== undefined && 'size' in at ? (at.size ?? 0) : 0
  const other = (why: 'not-utf8' | 'too-large', n = size): Content => ({ kind: 'other', path, size: n, type: TYPES[extname(path).toLowerCase()] ?? null, why })
  if (size > CONTENT_LIMIT) return other('too-large')
  const read = await store.read(path, { length: CONTENT_LIMIT + 1 })
  if (isFailure(read)) return read.reason === 'elsewhere' ? other('too-large', read.size ?? size) : { kind: 'unavailable', path, reason: 'no-such-file' }
  if (read.size > CONTENT_LIMIT || read.data === null) return other('too-large', read.size)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(read.data)
    return text.includes('\u0000') ? other('not-utf8', read.size) : { kind: 'text', path, size: read.size, text }
  } catch {
    return other('not-utf8', read.size)
  }
}
