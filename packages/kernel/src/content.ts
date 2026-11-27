// A thing's content, which inspect gives when asked, for an agent that cannot read files itself (an
// MCP client). ARCHITECTURE "找、看、说、查、归档". Read through storage, only because asked.
import { extname, posix } from 'node:path'
import { mayRead } from './access.js'
import { parseLibraryPath, regionOf } from './paths.js'
import { storageOf, type Storage } from './storage.js'
import { BUNDLE_MARKER, levelOf, whatIsOne } from './things.js'
import { isDescribed, isFailure, type Content, type Context, type FileFacts, type LibraryPath } from '@pneuma-base/sdk'

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
 * climbs out of the bundle or is its marker. A file whose content is elsewhere is fetched only with `fetch`.
 */
export async function contentOf(ctx: Context, store: Storage, file: FileFacts, inner: string | null, fetch = false): Promise<Content> {
  const unavailable = (reason: Extract<Content, { kind: 'unavailable' }>['reason']): Content => ({ kind: 'unavailable', path: file.path, reason })
  if (!mayRead(ctx, file.path)) return unavailable('outside-grant')
  if (file.kind === 'file') return inner === null ? fileContent(store, file.path, fetch) : unavailable('not-a-bundle')
  const rel = inner === null ? '' : posix.normalize(inner).replace(/\/+$/, '')
  if (rel.startsWith('..') || rel.startsWith('/') || rel === BUNDLE_MARKER) return unavailable('no-such-file')
  const path = (rel === '' || rel === '.' ? file.path : `${file.path}/${rel}`) as LibraryPath
  const at = path === file.path ? null : await whatIsOne(store, path)
  if (at === null || at.kind === 'folder' || at.kind === 'bundle') {
    const level = await levelOf(store, path)
    return level === null ? unavailable('no-such-file') : { kind: 'level', path, level }
  }
  return at.kind === 'file' ? fileContent(store, path, fetch) : unavailable('no-such-file')
}

async function fileContent(store: Storage, path: LibraryPath, fetch: boolean): Promise<Content> {
  const [at] = await store.glance([path])
  const described = at !== undefined && isDescribed(at) ? at : null
  const size = described?.size ?? 0
  const placeholder = described?.facets?.placeholder
  const facet = typeof placeholder === 'object' && placeholder !== null ? (placeholder as Record<string, unknown>) : null
  const elsewhere = (n: number | null): Content => ({ kind: 'elsewhere', path, size: n, provider: typeof facet?.provider === 'string' ? facet.provider : null })
  const other = (why: 'not-utf8' | 'too-large', n = size): Content => ({ kind: 'other', path, size: n, type: TYPES[extname(path).toLowerCase()] ?? null, why })
  if (facet !== null && !fetch) return elsewhere(typeof facet.size_elsewhere === 'number' ? facet.size_elsewhere : null)
  if (size > CONTENT_LIMIT && facet === null) return other('too-large')
  const read = await store.read(path, { length: CONTENT_LIMIT + 1, ...(fetch ? { fetch: true } : {}) })
  if (isFailure(read)) return read.reason === 'elsewhere' ? elsewhere(read.size ?? null) : { kind: 'unavailable', path, reason: 'no-such-file' }
  if (read.size > CONTENT_LIMIT || read.data === null) return other('too-large', read.size)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(read.data)
    return text.includes('\u0000') ? other('not-utf8', read.size) : { kind: 'text', path, size: read.size, text }
  } catch {
    return other('not-utf8', read.size)
  }
}

/** The images the file route serves as images, by the file's name. */
const IMAGES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** How many bytes of a file decide whether it is text. */
const SNIFF = 8192

/** One range of a file's bytes, read through storage with the token of the version they are of. */
export type FileRange = { data: Uint8Array; token: string }

/**
 * A file of the content or the archive as the management UI's file route serves it: its size, its type
 * (an image by its name; otherwise text when its first bytes are UTF-8 without NUL, else bytes; never
 * HTML), and a reader of ranges, each through storage. `elsewhere`: a sync service keeps only a
 * placeholder here, and its content is fetched only when asked with `fetch`.
 */
export type LibraryFile =
  | { kind: 'file'; path: LibraryPath; size: number; type: string; token: string; read(offset: number, length: number): Promise<FileRange | null> }
  | { kind: 'elsewhere'; path: LibraryPath; size: number }

export async function libraryFile(root: string, input: string, opts: { fetch?: boolean } = {}): Promise<LibraryFile | null> {
  const path = parseLibraryPath(root, input)
  if (path === null || regionOf(path) === 'kernel') return null
  const store = storageOf(root)
  const fetch = opts.fetch === true ? { fetch: true } : {}
  const head = await store.read(path, { length: SNIFF, ...fetch })
  if (isFailure(head)) return head.reason === 'elsewhere' ? { kind: 'elsewhere', path, size: head.size ?? 0 } : null
  // A token is storage's to compare: two texts may differ for one state. A range is of the first
  // read's state when storage says that state still holds, and then carries the first read's token.
  const read = async (offset: number, length: number): Promise<FileRange | null> => {
    const r = await store.read(path, { offset, length, ...fetch })
    if (isFailure(r) || r.data === null) return null
    if (r.token === head.token) return { data: r.data, token: head.token }
    const looked = await store.look([{ place: path, token: head.token }])
    return { data: r.data, token: looked.same === 1 ? head.token : r.token }
  }
  return { kind: 'file', path, size: head.size, type: IMAGES[extname(path).toLowerCase()] ?? sniffed(head.data ?? new Uint8Array()), token: head.token, read }
}

function sniffed(head: Uint8Array): string {
  if (head.includes(0)) return 'application/octet-stream'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return 'text/plain; charset=utf-8'
  } catch {
    return 'application/octet-stream'
  }
}
