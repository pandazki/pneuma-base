// The item panel: one thing of the library, or a directory that is no thing (open, nobody looked into,
// or noise), as storage says it is now, with what each plugin knows about it.
import { posix } from 'node:path'
import { fileFacts, noiseRule } from './agent.js'
import { callableIn, checkBlocks, type Callable } from './blocks.js'
import { closedAnswers, levelPage, thingName } from './files-page.js'
import { originalPath, parseLibraryPath, regionOf } from './paths.js'
import { messageOf, pluginContext } from './pipeline.js'
import { keepsRecords, openDirectories, probeWords } from './places.js'
import { answered, shown, type Shown } from './plugin-views.js'
import { storageOf } from './storage.js'
import { enclosingBundle, whatIsOne } from './things.js'
import { elsewhereText, field, folderLink, IMAGE, isObject, itemLink, kernelAction, modified, nameOf, placeholderOf, sizeText, when } from './view-parts.js'
import type { ViewerCall } from './viewer.js'
import { isDescribed, isFailure, type Action, type Block, type Cell, type Context, type FileFacts, type LibraryPath, type PluginName, type PluginProblem, type TableRow } from '@pneuma-base/sdk'

const archiveAction = (kind: 'archive' | 'unarchive', path: LibraryPath): Action => ({
  label: kind === 'archive' ? '归档' : '取回',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'archive', request: { kind, path } },
})

/** Fetching a placeholder's content to this machine: inspect asked for the content with fetch. */
const fetchAction = (path: LibraryPath): Action => ({
  label: '取回内容',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'inspect', request: { target: path, content: { file: null, fetch: true } } },
})

/** Moving a thing within the library: put with --to, the whole of a bundle with it. */
const moveAction = (path: LibraryPath): Action => ({
  label: '挪到',
  tone: 'default',
  confirm: null,
  inputs: [field('to', '新的库内路径', { value: path })],
  call: { face: 'agent', verb: 'put', request: { kind: 'move', from: path, to: '{to}' } },
})

/** For an `_archive/…` path with no file: the file taken back to its original path, if there is one. */
async function takenBack(root: string, target: string) {
  const path = parseLibraryPath(root, target)
  const original = path !== null && regionOf(path) === 'archive' ? originalPath(path) : null
  return original === null ? null : fileFacts(root, original)
}

/** A section of the item panel; a plugin's part is stamped with the plugin's name. */
const section = (title: string, blocks: Block[], plugin?: PluginName, count: number | null = null): Block => ({ kind: 'section', title, note: null, count, blocks, actions: [], ...(plugin === undefined ? {} : { plugin }) })

type Parts = { blocks: Block[]; actions: Action[]; problems: PluginProblem[] }

/**
 * Each installed plugin's section about `path`, in configuration order, and the actions each gives
 * for the panel's bottom row. A plugin that fails gets a section that says so (K8).
 */
async function pluginSections(ctx: Context, path: LibraryPath, callable: Callable, panel: { params: Record<string, string>; size: number }): Promise<Parts> {
  const blocks: Block[] = []
  const actions: Action[] = []
  const problems: PluginProblem[] = []
  for (const plugin of ctx.library.plugins) {
    if (!plugin.onItemView) continue
    try {
      const answer = await plugin.onItemView(path, pluginContext(ctx, plugin.name), panel)
      if (answer === null) continue
      if (!answered(answer)) throw new Error('onItemView answered something that is not a section')
      const checked = checkBlocks(answer.blocks, plugin, callable)
      blocks.push(section(answer.title, checked.blocks, plugin.name))
      problems.push(...checked.problems)
      const own = checkBlocks([{ kind: 'actions', actions: answer.actions ?? [] }], plugin, callable, 'actions')
      const [row] = own.blocks
      if (row?.kind === 'actions') actions.push(...row.actions)
      else blocks.push(...own.blocks)
      problems.push(...own.problems)
    } catch (error) {
      const message = messageOf(error)
      problems.push({ plugin: plugin.name, message })
      blocks.push(section(`插件 ${plugin.name}`, [{ kind: 'empty', title: `插件 ${plugin.name} 出错了，没能给出它知道的`, hint: message }], plugin.name))
    }
  }
  return { blocks, actions, problems }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
const plain = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * The facets storage gave of a place, as fields for people: where it was downloaded from, which
 * program brought it in, its tags, that only a placeholder is here, when it was made unless that is
 * when it last changed; every field of a facet the page does not know, as it is.
 */
export function facetFields(facets: Record<string, unknown> | undefined, modifiedAt: string | null = null): { label: string; value: Cell }[] {
  const out: { label: string; value: Cell }[] = []
  for (const [name, facet] of Object.entries(facets ?? {})) {
    if (!isObject(facet)) continue
    if (name === 'fs') {
      // Made in the same minute it was last changed says nothing more than 改于 does.
      if (typeof facet.created === 'string' && (modifiedAt === null || when(facet.created) !== when(modifiedAt))) out.push({ label: '建于', value: { text: when(facet.created), at: facet.created as FileFacts['modifiedAt'] } })
    } else if (name === 'macos') {
      for (const url of strings(facet.where_from)) out.push({ label: '下载自', value: /^https?:\/\//.test(url) ? { text: url, href: url } : { text: url, mono: true } })
      if (typeof facet.quarantine === 'string') out.push({ label: '带进来的程序', value: { text: facet.quarantine } })
      const tags = strings(facet.tags)
      if (tags.length > 0) out.push({ label: '标签', value: { text: tags.join('、'), icon: 'tag' } })
    } else if (name === 'placeholder') {
      out.push({ label: '这台机器上', value: { text: elsewhereText(facet), icon: 'cloud-off', tag: { text: '只有占位', tone: 'warn' } } })
    } else {
      for (const [key, value] of Object.entries(facet)) out.push({ label: `${name}.${key}`, value: { text: plain(value), mono: true, muted: true } })
    }
  }
  return out
}

/** What a thing is, in one line: a file or a bundle, its size, and whether it is archived or part of a bundle. */
function whatItIs(facts: FileFacts, bundle: LibraryPath | null): Block {
  const kind = facts.kind === 'bundle' ? '一样东西（带标记的目录）' : `文件 · ${sizeText(facts.size ?? 0)}`
  const where = facts.archived ? ' · 已归档' : bundle !== null ? ` · ${bundle} 的一部分` : ''
  return { kind: 'text', tone: 'neutral', text: `${kind}${where}` }
}

/**
 * One page of a directory's first level in the panel: each entry by name, a file with its size; a
 * folder inside a thing opens on the files page, any other entry its own panel. The page is in the
 * panel's parameters.
 */
async function levelSection(ctx: Context, dir: LibraryPath, params: Record<string, string>, rows: number, inThing: boolean): Promise<Block> {
  const level = await levelPage(ctx.library.root, dir, params, rows, 'item', new Set(), 'panel')
  if (level === null) return section('第一层', [{ kind: 'text', tone: 'warn', text: '读不了这个目录的这一层。' }])
  const tableRows: TableRow[] = level.listed.map(({ entry, kind }) => {
    const name = nameOf(entry.place)
    const path = entry.place as LibraryPath
    const isDir = kind === 'folder' || kind === 'bundle'
    const placeholder = placeholderOf(entry)
    return {
      key: path,
      cells: {
        path: kind === 'folder' ? { text: `${name}/`, mono: true, icon: 'folder' } : kind === 'other' ? { text: name, mono: true, muted: true } : thingName(name, kind),
        size: placeholder !== null ? { text: elsewhereText(placeholder), muted: true } : { text: kind === 'file' ? sizeText(entry.size ?? 0) : '', muted: true },
      },
      link: kind === 'other' ? null : isDir && inThing ? folderLink(path) : itemLink(path),
      actions: [],
    }
  })
  const count = level.paging.atLeast ? null : level.paging.total
  return {
    kind: 'section',
    title: '第一层',
    note: null,
    count,
    blocks: [{ kind: 'table', columns: [{ key: 'path', label: '名字' }, { key: 'size', label: '大小' }], rows: tableRows, empty: '这个目录是空的。', page: level.paging }],
    actions: [],
  }
}

/** The thing's own facts and facets, then a file's preview, which folds, or a bundle's first level, a page at a time. */
async function thingSections(ctx: Context, facts: FileFacts, bundle: LibraryPath | null, params: Record<string, string>, rows: number): Promise<Block[]> {
  const [glanced] = await storageOf(ctx.library.root).glance([facts.path], ['macos'])
  const facets = glanced !== undefined && isDescribed(glanced) ? glanced.facets : undefined
  const fields: Block = {
    kind: 'fields',
    fields: [
      { label: '路径', value: { text: facts.path, mono: true, ...(facts.archived ? { tag: { text: '已归档', tone: 'neutral' as const } } : {}) } },
      ...(bundle !== null ? [{ label: '在', value: { text: bundle, mono: true, icon: 'package' as const, link: itemLink(bundle) } }] : []),
      { label: '种类', value: { text: facts.kind === 'bundle' ? '一样东西（带标记的目录）' : '文件' } },
      ...(facts.size !== null ? [{ label: '大小', value: { text: sizeText(facts.size) } }] : []),
      { label: '改于', value: modified(facts.modifiedAt) },
      ...facetFields(facets, facts.modifiedAt),
      ...(facts.fingerprint !== null ? [{ label: '指纹', value: { text: facts.fingerprint.slice(0, 16), mono: true, muted: true } }] : []),
    ],
  }
  const partOf: Block[] = bundle === null ? [] : [{ kind: 'text', tone: 'neutral', text: `它是 ${bundle} 的一部分。${bundle} 是一样东西，只能整个一起放、挪、归档。` }]
  const own = section('文件', [fields, ...partOf])
  if (facts.kind === 'bundle') return [own, await levelSection(ctx, facts.path, params, rows, true)]
  const preview: Block[] = facets?.placeholder !== undefined ? [{ kind: 'actions', actions: [fetchAction(facts.path)] }] : [{ kind: 'preview', path: facts.path }]
  return [own, { kind: 'section', title: '预览', note: null, count: null, blocks: preview, actions: [], collapse: 'open' }]
}

/**
 * A directory that is no thing: one with something registered in it, opening on the files page; one
 * nobody looked into, with what a budgeted look found and its answers; or noise, by which rule.
 */
async function placePanel(ctx: Context, path: LibraryPath, params: Record<string, string>, rows: number, known: Parts): Promise<Shown | null> {
  const store = storageOf(ctx.library.root)
  const at = await whatIsOne(store, path)
  const title = `${posix.basename(path)}/`
  if (at.failed === 'noise') {
    const rule = await noiseRule(store, path)
    const text = 'name' in rule ? `库的噪音：任何一层叫 ${rule.name} 的都不算库里的东西。` : `库的噪音：${rule.path} 和它里面的一切不算库里的东西。`
    const remove = kernelAction('noise remove', '不再当作噪音', 'name' in rule ? { fixed: { name: rule.name, path: false } } : { fixed: { path: rule.path, name: false } })
    return { ...shown(title, path, [{ kind: 'text', tone: 'neutral', text }, { kind: 'actions', actions: [remove] }]), icon: 'folder' }
  }
  if (at.kind !== 'folder') return null
  const recorded = keepsRecords(ctx.library)
  if (!recorded || (await openDirectories(ctx)).includes(path)) {
    const open: Block = { kind: 'list', items: [{ cell: { text: '在文件页打开', icon: 'folder', link: folderLink(path) }, note: null, actions: [] }] }
    const text = recorded ? '文件夹，里面有登记过的东西。' : '文件夹。'
    return { ...shown(title, path, [{ kind: 'text', tone: 'neutral', text }, open, await levelSection(ctx, path, params, rows, false), ...known.blocks], known.problems), icon: 'folder' }
  }
  const probe = await store.probe(path)
  const found = isFailure(probe) ? '读不了这个目录。' : `${probeWords(probe)}。`
  const answers = (await closedAnswers(ctx, [path])).get(path) ?? []
  const blocks: Block[] = [{ kind: 'text', tone: 'warn', text: `没登记。${found}` }, { kind: 'actions', actions: answers }, await levelSection(ctx, path, params, rows, false), ...known.blocks]
  return { ...shown(title, path, blocks, known.problems), icon: 'folder-dot' }
}

/**
 * One thing of the library, in a fixed order: what it is in one line; what each plugin knows about
 * it; its own facts and facets, and a bundle's first level or a file's preview; then what can be done
 * with it, in one row at the bottom: archive or take back and move, then each plugin's actions. A
 * file inside a bundle names the bundle and offers no archive: the bundle changes only as a whole. A
 * directory that is no thing gets its own panel.
 */
export async function itemPage(params: Record<string, string>, { ctx }: ViewerCall, rows: number): Promise<Shown> {
  const { root } = ctx.library
  const target = params.path ?? ''
  const facts = target === '' ? null : ((await fileFacts(root, target)) ?? (await takenBack(root, target)))
  const path = facts?.path ?? parseLibraryPath(root, target)
  const known = path === null || regionOf(path) === 'kernel' ? { blocks: [], actions: [], problems: [] } : await pluginSections(ctx, path, callableIn(ctx.library), { params, size: rows })
  const bottom = (own: Action[]): Block[] => (own.length + known.actions.length > 0 ? [{ kind: 'actions', actions: [...own, ...known.actions] }] : [])
  if (!facts) {
    const place = path === null || regionOf(path) !== 'content' ? null : await placePanel(ctx, path, params, rows, known)
    if (place !== null) return place
    const missing: Block = { kind: 'text', tone: 'warn', text: `${target || '这个路径'} 上没有文件：不在，或已经除掉了。` }
    return shown(posix.basename(target) || '一样东西', target || null, [missing, ...known.blocks, ...bottom([])], known.problems)
  }
  const original = facts.archived ? (originalPath(facts.path) ?? facts.path) : facts.path
  const bundle = facts.kind === 'file' ? await enclosingBundle(storageOf(root), facts.path) : null
  const own = bundle !== null ? [] : facts.archived ? [archiveAction('unarchive', facts.path)] : [archiveAction('archive', original), moveAction(original)]
  const icon = facts.kind === 'bundle' ? 'package' : IMAGE.test(original) ? 'image' : 'file'
  return { ...shown(posix.basename(original), facts.path, [whatItIs(facts, bundle), ...known.blocks, ...(await thingSections(ctx, facts, bundle, params, rows)), ...bottom(own)], known.problems), icon }
}
