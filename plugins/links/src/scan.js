import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { extractFileLinks, isDocumentPath } from './links.js'

function missing(error) {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

// Test each component before following it. A library symlink may point to a
// file inside the library, a missing file, or somewhere outside our scope.
function fileLookup(root) {
  const entries = new Map()
  async function entry(path) {
    if (entries.has(path)) return entries.get(path)
    let value
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) value = { link: await readlink(path) }
      else if (stat.isDirectory()) value = 'directory'
      else if (stat.isFile()) value = 'file'
      else value = 'other'
    } catch (error) {
      if (!missing(error)) throw error
      value = 'missing'
    }
    entries.set(path, value)
    return value
  }

  return async function kind(path, followLinks) {
    const pending = path.split('/').reverse()
    let at = root
    let value = 'directory'
    let hops = 0
    while (pending.length) {
      if (value !== 'directory') return 'missing'
      const part = pending.pop()
      if (!part || part === '.') continue
      if (part === '..') {
        if (at === root) return 'outside'
        at = dirname(at)
        continue
      }
      at = join(at, part)
      value = await entry(at)
      if (value === 'missing') return value
      if (typeof value === 'object') {
        if (!followLinks || ++hops > 40) return 'ignored'
        let link = value.link
        if (isAbsolute(link)) {
          // Keep ".." components for the loop to resolve after any symlinks.
          if (link !== root && !link.startsWith(root.endsWith(sep) ? root : root + sep)) return 'outside'
          link = link.slice(root.length)
          at = root
        } else {
          at = dirname(at)
        }
        for (const component of link.split(sep).reverse()) pending.push(component)
        value = 'directory'
      }
    }
    return value
  }
}

async function scanDocument(ctx, source, kind) {
  if (await kind(source, false) !== 'file') return null
  let file
  let contents
  try {
    const absolute = ctx.tools.abs(source)
    // The source list may predate a directory move or replacement.
    if (await realpath(absolute) !== absolute) return null
    file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await file.stat()).isFile()) return null
    contents = await file.readFile('utf8')
  } catch (error) {
    if (missing(error) || error.code === 'ELOOP') return null
    throw error
  } finally {
    await file?.close()
  }
  const broken = []
  for (const link of extractFileLinks(source, contents)) {
    if (await kind(link.target, true) === 'missing') broken.push({ source, ...link })
  }
  return broken
}

export async function scanLibrary(ctx, { includeArchived = false } = {}) {
  const kind = fileLookup(ctx.library.root)
  const sources = []
  for (const item of await ctx.tools.things()) {
    const region = ctx.tools.regionOf(item)
    if (region === 'kernel' || (region === 'archive' && !includeArchived)) continue
    // tools.files lists only fingerprinted members and uses bundle-relative paths.
    if (await kind(item, false) === 'directory') {
      for (const file of await ctx.tools.files(item) ?? []) {
        if (isDocumentPath(file.path)) sources.push(item + '/' + file.path)
      }
    } else if (isDocumentPath(item)) {
      sources.push(item)
    }
  }
  const broken = []
  for (const source of sources.sort()) {
    const links = await scanDocument(ctx, source, kind)
    for (const link of links ?? []) broken.push(link)
  }
  return broken
}

export async function scanItem(ctx, path) {
  if (!isDocumentPath(path)) return null
  const resolved = await ctx.tools.resolve(path)
  if (!resolved || resolved.region === 'kernel') return null
  const { path: source, bundle } = resolved
  const kind = fileLookup(ctx.library.root)
  if (bundle) {
    if (await kind(source, false) !== 'file') return null
    const member = source.slice(bundle.length + 1)
    const files = await ctx.tools.files(bundle)
    if (!files?.some(file => file.path === member)) return null
  }
  return scanDocument(ctx, source, kind)
}
