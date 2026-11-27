// The files page and the archive page: storage's overview of one level of a folder, a page at a time.
// A directory nobody looked into is one row: what a budgeted look into it found, and its three answers.
import { asksOf } from './asks.js'
import { callableIn } from './blocks.js'
import { ARCHIVE_DIR, DESCRIPTION_FILE, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { keepsRecords, openDirectories, placeIn, probeWords } from './places.js'
import type { Shown } from './plugin-views.js'
import { shown } from './plugin-views.js'
import { storageOf } from './storage.js'
import { BUNDLE_MARKER, enclosingBundle, whatIsOne } from './things.js'
import { asOneThing, elsewhereText, field, folderLink, IMAGE, itemLink, kernelAction, leaveAlone, modified, nameOf, placeActions, placeholderOf, sizeText } from './view-parts.js'
import type { ViewerCall } from './viewer.js'
import { isDescribed, isFailure, pageAt, pageOfList, pagingOf, type Action, type Block, type Cell, type Context, type Crumb, type Description, type LibraryPath, type Link, type Paging, type RowPlace, type SortKey, type TableRow } from '@pneuma-base/sdk'

/** An entry's name cell: a bundle with its own icon and how many entries its first level has, when storage said; an image or a file with theirs. */
export function thingName(text: string, kind: 'file' | 'bundle', entries: number | null = null): Cell {
  if (kind === 'bundle') return { text, mono: true, icon: 'package', ...(entries === null ? {} : { tag: { text: `${entries} 项`, tone: 'neutral' as const } }) }
  return { text, mono: true, icon: IMAGE.test(text) ? 'image' : 'file' }
}

/** How many entries a bundle's first level has, its marker not counted, from what storage said of the directory. */
const entriesOf = (entry: Description) => (entry.size === undefined || entry.size === null ? null : Math.max(0, entry.size - 1))

export type Listed = { entry: Description; kind: 'file' | 'bundle' | 'folder' | 'other' }
export type Level = { listed: Listed[]; paging: Paging }
export type Sorting = { by: SortKey; desc: boolean }

const SORT_KEYS: readonly string[] = ['name', 'modified', 'kind', 'size'] satisfies SortKey[]
/** By name, as storage lists a level. */
export const BY_NAME: Sorting = { by: 'name', desc: false }

/** The view's parameter `sort`: a key, with a leading `-` for the reverse; anything else is by name. */
export function sortingOf(value: string | undefined): Sorting {
  const desc = value?.startsWith('-') ?? false
  const key = desc ? value?.slice(1) : value
  return key !== undefined && SORT_KEYS.includes(key) ? { by: key as SortKey, desc } : BY_NAME
}

/**
 * How many entries of a level a sort other than storage's own looks at: the first of the level by
 * name, in one look. A level with more is sorted within them, so a sort stays bounded.
 */
export const SORT_WINDOW = 1000

const extensionOf = (place: string) => {
  const name = nameOf(place)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const byName = (a: Description, b: Description) => (a.place < b.place ? -1 : a.place > b.place ? 1 : 0)
const isDir = (e: Description) => e.kind === 'dir'
/** Each key's order, ties by name: when it changed; directories first, then by extension; directories smallest, then files by bytes. */
const ORDER: Record<SortKey, (a: Description, b: Description) => number> = {
  name: () => 0,
  modified: (a, b) => Date.parse(a.modified ?? '') - Date.parse(b.modified ?? '') || 0,
  kind: (a, b) => Number(isDir(b)) - Number(isDir(a)) || (extensionOf(a.place) < extensionOf(b.place) ? -1 : extensionOf(a.place) > extensionOf(b.place) ? 1 : 0),
  size: (a, b) => (isDir(a) ? -1 : (a.size ?? 0)) - (isDir(b) ? -1 : (b.size ?? 0)),
}

/**
 * One page of one level of a directory, through storage: its entries by name, folders and things mixed,
 * a directory a bundle when its marker is there, and where the page stands among them. `hide` names
 * entries that are no content here; they are neither shown nor counted. Sorted by another key, the
 * page is cut from the first `SORT_WINDOW` entries, sorted.
 */
export async function levelPage(root: string, dir: string, params: Record<string, string>, rows: number, view: string, hide: ReadonlySet<string>, target: Link['target'] = 'main', sorting: Sorting = BY_NAME): Promise<Level | null> {
  const store = storageOf(root)
  const { after, back } = pageAt(params)
  const hidden = new Set([...hide, BUNDLE_MARKER])
  const shows = (e: Description) => !hidden.has(nameOf(e.place))
  const byStorage = sorting.by === 'name' && !sorting.desc
  const page = await store.overview(dir, byStorage ? { limit: rows, ...(after === undefined ? {} : { after }) } : { limit: SORT_WINDOW })
  if (isFailure(page)) return null
  let shownEntries: Description[]
  let more = page.more
  let next: string | null
  if (byStorage) {
    // A page holds `rows` entries shown; what was hidden from it is made up from the entries that follow, so places count true.
    shownEntries = page.entries.filter(shows)
    while (shownEntries.length < rows && more !== null) {
      const extra = await store.overview(dir, { limit: rows - shownEntries.length, after: more.after })
      if (isFailure(extra)) break
      shownEntries.push(...extra.entries.filter(shows))
      more = extra.more
    }
    next = more?.after ?? null
  } else {
    const order = ORDER[sorting.by]
    const sorted = page.entries.filter(shows).sort((a, b) => (sorting.desc ? -1 : 1) * (order(a, b) || byName(a, b)))
    const cut = pageOfList(sorted, params, rows)
    shownEntries = cut.rows
    next = cut.next
  }
  const dirs = shownEntries.filter((e) => e.kind === 'dir')
  const [markers, present] = await Promise.all([store.glance(dirs.map((d) => `${d.place}/${BUNDLE_MARKER}`)), store.glance([...hidden].map((name) => placeIn(dir, name)))])
  const bundles = new Set(dirs.filter((_, i) => { const m = markers[i]; return m !== undefined && isDescribed(m) && m.kind === 'file' }).map((d) => d.place))
  const kindOf = (e: Description): Listed['kind'] => (e.kind === 'file' ? 'file' : e.kind === 'dir' ? (bundles.has(e.place) ? 'bundle' : 'folder') : 'other')
  const first = (back.length + (after === undefined ? 0 : 1)) * rows + 1
  // A total from storage counts the hidden entries of the whole level; without one, the count stops where the listing does.
  const total = page.total !== null ? Math.max(0, page.total - present.filter((g) => isDescribed(g) && g.kind !== 'none').length) : first - 1 + shownEntries.length + (more?.at_least ?? 0)
  const paging = pagingOf({ view, params, rows, shown: shownEntries.length, next, total, atLeast: page.total === null && more !== null, target })
  return { listed: shownEntries.map((entry) => ({ entry, kind: kindOf(entry) })), paging }
}

/** A listed entry as the place a row stands for; null for what is no file or directory. */
export function rowPlace({ entry, kind }: Listed, open: boolean): RowPlace | null {
  if (kind === 'other') return null
  const placeKind = kind === 'folder' ? (open ? 'open' : 'closed') : kind
  return { path: entry.place as LibraryPath, kind: placeKind, token: entry.token ?? null, ...(placeholderOf(entry) === null ? {} : { elsewhere: true as const }) }
}

/** The folders from the root of a view's listing to `dir`, each with the link that shows it; `root` names the first. */
export function trailOf(root: string, dir: string | null, link: (dir: string) => Link, from = ''): Crumb[] {
  const parts = dir === null || dir === from ? [] : (from === '' ? dir : dir.slice(from.length + 1)).split('/')
  return [{ label: root, link: link(from) }, ...parts.map((label, i) => ({ label, link: link([...(from === '' ? [] : [from]), ...parts.slice(0, i + 1)].join('/')) }))]
}

/**
 * The answers to directories nobody looked into: what a plugin asks the owner about each, such as the
 * ledger's three; else the kernel's own two, as one thing or left alone.
 */
export async function closedAnswers(ctx: Context, dirs: readonly LibraryPath[]): Promise<Map<string, Action[]>> {
  const asked = dirs.length === 0 ? [] : (await asksOf(ctx, callableIn(ctx.library))).asks
  return new Map(dirs.map((dir) => [dir, asked.find((a) => a.about === dir && a.actions.length > 0)?.actions ?? [asOneThing(dir), leaveAlone(dir)]]))
}

/** Bringing a file of this machine into the library, as put of a file outside does; the page cannot hand over standard input. */
const placeAction = (dir: string | null): Action => ({
  label: '从这台机器放进来',
  tone: 'default',
  confirm: null,
  inputs: [
    field('from', '这台机器上的文件', { placeholder: '绝对路径，比如 /Users/me/Downloads/a.pdf' }),
    field('to', '库内路径', { placeholder: '比如 sources/a.pdf', value: dir === null ? '' : `${dir}/` }),
    field('source', '出处', { placeholder: '网址、书名或别的出处；不知道就留空' }),
  ],
  call: { face: 'agent', verb: 'put', request: { kind: 'place', from: { kind: 'file', path: '{from}' }, to: '{to}', origin: { kind: 'brought', source: '{source}', by: null } } },
  as: 'icon',
  icon: 'plus',
  key: 'n',
})

// Where a row carries answers the name keeps its room: the size, or what a look found, gives way first.
const FILE_COLUMNS = [
  { key: 'name', label: '名字' },
  { key: 'size', label: '大小', optional: true },
  { key: 'modified', label: '改于', optional: true },
]

/**
 * One page of one folder of the library's content: its folders and its things by name. A folder opens
 * on this page, a bundle and a file the item panel; a directory with nothing registered in it is one
 * row that says what a budgeted look into it found, with its answers. The kernel's files and the
 * archive are left out.
 */
export async function filesPage(params: Record<string, string>, { ctx }: ViewerCall, rows: number): Promise<Shown> {
  const { root } = ctx.library
  const input = params.dir ?? ''
  const dir = input === '' ? null : parseLibraryPath(root, input)
  if (input !== '' && (dir === null || regionOf(dir) !== 'content')) {
    return shown('文件', input, [{ kind: 'empty', title: '这个文件夹不在库的内容里', hint: null }])
  }
  const sorting = sortingOf(params.sort)
  const level = await levelPage(root, dir ?? '', params, rows, 'files', new Set(dir === null ? [DESCRIPTION_FILE, ARCHIVE_DIR] : []), 'main', sorting)
  if (level === null) return shown('文件', input, [{ kind: 'empty', title: '没有这个文件夹', hint: input }])
  const store = storageOf(root)
  const folders = level.listed.filter((l) => l.kind === 'folder').map((l) => l.entry.place)
  // Inside a thing every folder is part of it, and with no plugin keeping records a folder is only a folder; elsewhere one with nothing registered in it is closed.
  const plain = folders.length > 0 && (!keepsRecords(ctx.library) || (dir !== null && ((await whatIsOne(store, dir)).kind === 'bundle' || (await enclosingBundle(store, dir)) !== null)))
  const open = new Set(folders.length === 0 ? [] : plain ? folders : await openDirectories(ctx))
  const closed = folders.filter((place) => !open.has(place)) as LibraryPath[]
  const [probes, answers] = await Promise.all([Promise.all(closed.map((place) => store.probe(place))), closedAnswers(ctx, closed)])
  const looked = new Map(closed.map((place, i) => [place, probes[i]]))
  const tableRows: TableRow[] = []
  for (const listed of level.listed) {
    const { entry, kind } = listed
    const name = nameOf(entry.place)
    const path = entry.place as LibraryPath
    const place = rowPlace(listed, open.has(path))
    const at = place === null ? {} : { place }
    if (kind === 'folder' && open.has(path)) {
      tableRows.push({ key: path, cells: { name: { text: `${name}/`, mono: true, icon: 'folder', link: folderLink(path) }, size: { text: '' }, modified: modified(entry.modified) }, link: folderLink(path), actions: [], ...at })
    } else if (kind === 'folder') {
      const probe = looked.get(path)
      const found = probe === undefined || isFailure(probe) ? '读不了这个目录' : probeWords(probe)
      tableRows.push({
        key: path,
        cells: { name: { text: `${name}/`, mono: true, icon: 'folder-dot', tag: { text: '没登记', tone: 'warn' } }, size: { text: found, muted: true }, modified: modified(entry.modified) },
        link: folderLink(path),
        actions: answers.get(path) ?? [],
        ...at,
      })
    } else if (kind === 'other') {
      tableRows.push({ key: path, cells: { name: { text: name, mono: true, muted: true }, size: { text: '链接或特殊文件，不算库里的东西', muted: true }, modified: modified(entry.modified) }, link: null, actions: [] })
    } else {
      const placeholder = placeholderOf(entry)
      const named = thingName(name, kind, kind === 'bundle' ? entriesOf(entry) : null)
      const cells = placeholder === null
        ? { name: named, size: { text: kind === 'file' ? sizeText(entry.size ?? 0) : '', muted: true }, modified: modified(entry.modified) }
        : { name: { ...named, tag: { text: '只有占位', tone: 'warn' as const } }, size: { text: elsewhereText(placeholder), muted: true }, modified: modified(entry.modified) }
      tableRows.push({ key: path, cells, link: itemLink(path), actions: [], ...at })
    }
  }
  const table: Block = { kind: 'table', columns: FILE_COLUMNS, rows: tableRows, empty: '这个文件夹是空的。把文件放进这个文件夹，或者让 agent 用 put 放进来。', page: level.paging, sorted: sorting, each: placeActions() }
  return { ...shown('文件', dir, [{ kind: 'actions', head: true, actions: [placeAction(dir)] }, table]), trail: trailOf('文件', dir, folderLink) }
}

/** One page of one folder of `_archive/`, each thing with the path it came from; to take back one, or to purge them all. */
export async function archivePage(params: Record<string, string>, { ctx }: ViewerCall, rows: number): Promise<Shown> {
  const { root } = ctx.library
  const input = params.dir ?? ''
  const inner = input === '' ? null : parseLibraryPath(root, input)
  let dir = inner === null ? ARCHIVE_DIR : regionOf(inner) === 'archive' ? inner : `${ARCHIVE_DIR}/${inner}`
  const sorting = sortingOf(params.sort)
  let level = await levelPage(root, dir, params, rows, 'archive', new Set(), 'main', sorting)
  if (level === null && dir !== ARCHIVE_DIR) {
    // A folder of the archive is gone once its last thing is taken back: the archive's root is shown instead.
    dir = ARCHIVE_DIR
    level = await levelPage(root, dir, {}, rows, 'archive', new Set(), 'main', sorting)
  }
  const listed = level?.listed ?? []
  const tableRows: TableRow[] = []
  const archiveLink = (at: string): Link => ({ view: 'archive', params: at === ARCHIVE_DIR ? {} : { dir: at }, target: 'main' })
  for (const one of listed) {
    const { entry, kind } = one
    const path = entry.place as LibraryPath
    if (kind === 'folder' || kind === 'other') {
      const link = archiveLink(path)
      tableRows.push({ key: path, cells: { name: { text: `${originalPath(path) ?? path}/`, mono: true, icon: 'folder', link }, size: { text: '' }, modified: { text: '' } }, link, actions: [], ...(kind === 'folder' ? { place: { path, kind: 'open' as const, token: entry.token ?? null } } : {}) })
      continue
    }
    tableRows.push({
      key: path,
      cells: {
        name: thingName(originalPath(path) ?? path, kind, kind === 'bundle' ? entriesOf(entry) : null),
        size: { text: kind === 'file' ? sizeText(entry.size ?? 0) : '', muted: true },
        modified: modified(entry.modified),
      },
      link: itemLink(path),
      actions: [{ label: '取回', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path } }, as: 'icon', icon: 'archive-restore' }],
      ...(rowPlace(one, false) === null ? {} : { place: rowPlace(one, false) as RowPlace }),
    })
  }
  const any = listed.length > 0 || dir !== ARCHIVE_DIR
  const purge = { ...kernelAction('archive purge', '清空归档区', { tone: 'danger', confirm: '归档区里的东西会全部被删掉，不能撤回。' }), icon: 'trash-2' as const }
  // Where each lies in the archive is its old path under _archive/, so the old path alone is said.
  const columns = [
    { key: 'name', label: '原来的路径' },
    { key: 'size', label: '大小', optional: true },
    { key: 'modified', label: '改于', optional: true },
  ]
  const table: Block = { kind: 'table', columns, rows: tableRows, empty: '归档区是空的。归档的东西挪到这里，不会被删掉；默认的找和查不带它们。', ...(level ? { page: level.paging } : {}), sorted: sorting }
  const trail = trailOf('归档区', dir, archiveLink, ARCHIVE_DIR)
  return { ...shown('归档区', dir === ARCHIVE_DIR ? null : dir, [...(any ? [{ kind: 'actions' as const, head: true as const, actions: [purge] }] : []), table]), trail }
}
