// Which documents the plugin checks, and their broken links. It follows the puts it hears: a record
// store of the Markdown and HTML documents put or registered, moved, archived and purged. A check reads
// only those documents, each up to READ_BYTES, and asks storage what is at their link targets.
import { isFailure } from '@pneuma-base/sdk'
import { recordStore } from '@pneuma-base/sdk/kit'
import { extractFileLinks, isDocumentPath } from './links.js'

const READ_BYTES = 1 << 20
const MANIFEST_PAGE = 10_000

// A record says either that the documents at or under `under` are now `paths`, or that what was at
// `from` moved to `to`.
function parse(raw) {
  const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string')
  if (typeof raw.under === 'string' && strings(raw.paths)) return { under: raw.under, paths: raw.paths }
  if (typeof raw.from === 'string' && typeof raw.to === 'string') return { from: raw.from, to: raw.to }
  return '不是一条文档记录'
}

const store = ctx => recordStore(ctx, 'documents', parse)
const within = (path, dir) => path === dir || path.startsWith(`${dir}/`)

async function append(ctx, bodies) {
  const s = store(ctx)
  await s.append(bodies.map(body => s.stamp(ctx, body)))
}

/** The documents the records name now, sorted. */
async function documents(ctx) {
  const docs = new Set()
  for (const r of (await store(ctx).read()).records) {
    const there = [...docs].filter(p => within(p, r.from ?? r.under))
    for (const p of there) docs.delete(p)
    if (r.from !== undefined) for (const p of there) docs.add(r.to + p.slice(r.from.length))
    else for (const p of r.paths) docs.add(p)
  }
  return [...docs].sort()
}

/** The documents of a directory thing: the Markdown and HTML files of storage's manifest of it. */
async function documentsIn(ctx, dir) {
  const out = []
  let after
  do {
    const answer = await ctx.tools.storage.content(dir, { manifest: { limit: MANIFEST_PAGE, ...(after === undefined ? {} : { after }) } })
    if (isFailure(answer) || answer.manifest === undefined) return out
    for (const e of answer.manifest.entries) if (isDocumentPath(e.path)) out.push(`${dir}/${e.path}`)
    after = answer.manifest.more?.after
  } while (after !== undefined)
  return out
}

/** Records what a put changed among the documents. */
export async function heardPut(ctx, req) {
  if (req.kind === 'register-files') {
    return append(ctx, req.files.filter(f => isDocumentPath(f.path)).map(f => ({ under: f.path, paths: [f.path] })))
  }
  const bundle = req.now.kind === 'bundle'
  if (!bundle && !isDocumentPath(req.path)) return
  if (req.kind === 'move') return append(ctx, [{ from: req.from, to: req.path }])
  return append(ctx, [{ under: req.path, paths: bundle ? await documentsIn(ctx, req.path) : [req.path] }])
}

export const heardMove = (ctx, from, to) => append(ctx, [{ from, to }])
export const heardPurge = (ctx, paths) => append(ctx, paths.map(under => ({ under, paths: [] })))

/** The broken links of these documents: each read up to READ_BYTES, every target looked at in one glance. */
async function brokenIn(ctx, sources) {
  const links = []
  for (const source of sources) {
    const read = await ctx.tools.storage.read(source, { length: READ_BYTES })
    if (isFailure(read) || read.data === null) continue
    for (const link of extractFileLinks(source, new TextDecoder().decode(read.data))) links.push({ source, ...link })
  }
  const at = await ctx.tools.what([...new Set(links.map(l => l.target))])
  const missing = new Set(at.filter(t => t.kind === 'none').map(t => t.path))
  return links.filter(l => missing.has(l.target))
}

export async function scanLibrary(ctx, { includeArchived = false } = {}) {
  const sources = (await documents(ctx)).filter(p => includeArchived || ctx.tools.regionOf(p) !== 'archive')
  return brokenIn(ctx, sources)
}

export async function scanItem(ctx, path) {
  return (await documents(ctx)).includes(path) ? brokenIn(ctx, [path]) : null
}
