import { fromMarkdown } from 'mdast-util-from-markdown'
import { parse, parseFragment } from 'parse5'

const htmlPath = /\.html?$/i
const markdownPath = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn)$/i

export function isDocumentPath(path) {
  return htmlPath.test(path) || markdownPath.test(path)
}

function* descendants(root) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    yield node
    const children = node.children ?? node.childNodes ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
}

// URLs in srcset extend up to whitespace. An internal comma can belong to
// the URL (notably a data URL); trailing commas end the candidate.
function* srcsetUrls(input) {
  let i = 0
  while (i < input.length) {
    while (i < input.length && /[\t\n\f\r ,]/.test(input[i])) i++
    const start = i
    while (i < input.length && !/[\t\n\f\r ]/.test(input[i])) i++
    const url = input.slice(start, i)
    if (!url) break
    yield url.replace(/,+$/, '')
    if (url.endsWith(',')) continue
    let parentheses = 0
    while (i < input.length) {
      const ch = input[i++]
      if (ch === '(') parentheses++
      if (ch === ')' && parentheses) parentheses--
      if (ch === ',' && !parentheses) break
    }
  }
}

const urlAttrs = {
  __proto__: null,
  href: new Set(['a', 'area', 'link']),
  src: new Set(['audio', 'embed', 'frame', 'iframe', 'img', 'input', 'script', 'source', 'track', 'video']),
  srcset: new Set(['img', 'source']),
  imagesrcset: new Set(['link']),
  poster: new Set(['video']),
  data: new Set(['object']),
  action: new Set(['form']),
  formaction: new Set(['button', 'input']),
  cite: new Set(['blockquote', 'del', 'ins', 'q']),
}

function refreshUrl(content) {
  const match = /^\s*\d+(?:\.\d*)?(?:\s*[;,]\s*|\s+)(?:url\s*=\s*)?(.*)$/is.exec(content)
  if (!match) return null
  const value = match[1].trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") return value.slice(1).split(quote, 1)[0] || null
  return value || null
}

function htmlLinks(tree, position, result) {
  const fragments = [tree]
  const seen = new Set()
  while (fragments.length) {
    const fragment = fragments.pop()
    for (const node of descendants(fragment)) {
      if (node.content) fragments.push(node.content)
      for (const attr of node.attrs ?? []) {
        const key = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name
        const loc = node.sourceCodeLocation?.attrs?.[key]
        if (!loc || seen.has(loc.startOffset)) continue
        // The HTML parser can create several elements from one source tag.
        seen.add(loc.startOffset)
        const start = position(loc.startLine, loc.startCol)
        if (node.tagName === 'base' && attr.name === 'href') {
          if (fragment === tree) result.bases.push({ ...start, href: attr.value })
          continue
        }
        if (node.tagName === 'meta' && attr.name === 'content') {
          const refresh = node.attrs.some(a => a.name === 'http-equiv' && a.value.toLowerCase() === 'refresh')
          const href = refresh && refreshUrl(attr.value)
          if (href) result.links.push({ ...start, href })
          continue
        }
        const svgHref = node.namespaceURI === 'http://www.w3.org/2000/svg' && attr.name === 'href'
        if (!svgHref && !urlAttrs[attr.name]?.has(node.tagName)) continue
        const values = attr.name.endsWith('srcset') ? srcsetUrls(attr.value) : [attr.value]
        for (const href of values) result.links.push({ ...start, href })
      }
    }
  }
}

const htmlOptions = { sourceCodeLocationInfo: true, scriptingEnabled: false }

function markdownLinks(contents, result) {
  const root = fromMarkdown(contents)
  const definitions = new Map()
  for (const node of descendants(root)) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
  }
  const sourceLines = contents.split(/\r\n|[\r\n]/)
  for (const node of descendants(root)) {
    const { line, column } = node.position.start
    if (node.type === 'link' || node.type === 'image') {
      result.links.push({ line, column, href: node.url })
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      const href = definitions.get(node.identifier)
      if (href !== undefined) result.links.push({ line, column, href })
    } else if (node.type === 'html') {
      const lines = node.value.split(/\r\n|[\r\n]/)
      const fragment = parseFragment(node.value, htmlOptions)
      htmlLinks(fragment, (n, col) => {
        const offset = n === 1 ? column - 1 : sourceLines[line + n - 2].indexOf(lines[n - 1])
        return { line: line + n - 1, column: col + Math.max(0, offset) }
      }, result)
    }
  }
}

// Resolve logical paths only. Keep track of '..' explicitly so that climbing
// past the library root cannot be mistaken for a missing file inside it.
function relativePath(base, href) {
  const path = href.trim().replace(/[\t\r\n]/g, '').split(/[?#]/, 1)[0].replaceAll('\\', '/')
  if (!path) return base
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  const parts = base.directory ? [...base.parts] : base.parts.slice(0, -1)
  let last
  for (const raw of path.split('/')) {
    try {
      // A bare '%' is common in a filename and means a literal percent sign.
      last = decodeURIComponent(raw.replace(/%(?![0-9a-f]{2})/gi, '%25'))
    } catch {
      return null
    }
    if (/[\/\\\0]/.test(last)) return null
    if (last === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (last && last !== '.') {
      parts.push(last)
    }
  }
  return { parts, directory: !last || last === '.' || last === '..' }
}

const inSourceOrder = (a, b) => a.line - b.line || a.column - b.column

/** Extract references to other library files, with one-based source positions. */
export function extractFileLinks(sourcePath, contents) {
  const result = { bases: [], links: [] }
  if (htmlPath.test(sourcePath)) {
    const tree = parse(contents, htmlOptions)
    htmlLinks(tree, (line, column) => ({ line, column }), result)
  } else if (markdownPath.test(sourcePath)) {
    markdownLinks(contents, result)
  } else {
    return []
  }
  let base = { parts: sourcePath.split('/'), directory: false }
  const firstBase = result.bases.sort(inSourceOrder)[0]
  if (firstBase) {
    base = relativePath(base, firstBase.href)
    if (!base) return []
  }
  const links = []
  for (const link of result.links.sort(inSourceOrder)) {
    const resolved = relativePath(base, link.href)
    if (!resolved || resolved.directory) continue
    const target = resolved.parts.join('/')
    if (target !== sourcePath) links.push({ ...link, target })
  }
  return links
}
