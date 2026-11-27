import { readFileSync } from 'node:fs'
import { CONTRACT, defineCommand, definePlugin, pluginName, type Block } from '@pneuma-base/sdk'
import { heardMove, heardPurge, heardPut, heardRegistered, scanItem, scanLibrary } from './scan.js'

type BrokenLink = {
  source: string
  line: number
  column: number
  href: string
  target: string
}

const title = '坏链接'
const empty = '没有发现坏链接。'

function report(broken: BrokenLink[]) {
  if (broken.length === 0) return empty
  return broken.map(({ source, line, column, href, target }) =>
    `${source}:${line}:${column}  ${href} → ${target}`,
  ).join('\n')
}

function table(broken: BrokenLink[], showSource: boolean): Block {
  return {
    kind: 'table',
    columns: [
      ...(showSource ? [{ key: 'source', label: '来源文件' }] : []),
      { key: 'position', label: '行:列' },
      { key: 'href', label: '链接' },
      { key: 'target', label: '缺少的文件', optional: true },
    ],
    rows: broken.map(({ source, line, column, href, target }, index) => ({
      key: JSON.stringify([source, line, column, index]),
      cells: {
        ...(showSource && { source: { text: source, mono: true } }),
        position: { text: `${line}:${column}`, mono: true },
        href: { text: href, mono: true },
        target: { text: target, mono: true },
      },
      link: showSource ? { view: 'item', params: { path: source }, target: 'panel' } : null,
      actions: [],
    })),
    empty,
  }
}

const list = defineCommand({
  name: 'links list',
  summary: '列出全库的坏链接，含归档文件',
  params: {},
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run(_args, ctx) {
    const broken = await scanLibrary(ctx, { includeArchived: true })
    return { outcome: 'done', text: report(broken), data: { broken } }
  },
})

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('links'),
  version: '0.1.0',
  summary: '检查 Markdown 和 HTML 文件中的库内相对链接',
  cognition: { title: '链接检查', text: readFileSync(new URL('./cognition.md', import.meta.url), 'utf8').trim() },
  statements: [],
  storage: [],
  ownerCommands: [list],
  views: [{ id: 'links.broken', title, icon: 'link', nav: true, filters: [] }],

  // It checks the documents it heard of: put or registered, then moved, archived or purged.
  async onPut(req, ctx) {
    await heardPut(ctx, req)
    return null
  },
  async onArchive(req, ctx) {
    if (req.moved) await heardMove(ctx, req.from, req.to)
    return null
  },
  async onPurged(paths, ctx) {
    await heardPurge(ctx, paths)
  },
  // What was registered before it was added, a page at a time.
  async catchUp(things, ctx) {
    await heardRegistered(ctx, things)
  },

  async onCheck(req, ctx) {
    const broken = await scanLibrary(ctx, { includeArchived: req.includeArchived })
    return broken.length ? [{ title, body: report(broken), data: { broken } }] : []
  },
  async onView(_req, ctx) {
    const broken = await scanLibrary(ctx, { includeArchived: true })
    return { title, subtitle: `全库共 ${broken.length} 处，含归档文件`, blocks: [table(broken, true)] }
  },
  async onItemView(path, ctx) {
    const broken = await scanItem(ctx, path)
    return broken === null ? null : { title, blocks: [table(broken, false)] }
  },
})
