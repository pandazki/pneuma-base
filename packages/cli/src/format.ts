import {
  CONTENT_LIMIT,
  elsewhereWords,
  endText,
  quote,
  TEXT_ROWS,
  type ArchiveResult,
  type Ask,
  type AskResult,
  type CheckResult,
  type Content,
  type FindResult,
  type Hit,
  type InspectResult,
  type Level,
  type PlaceFacts,
  type OwnerCommandInfo,
  type OwnerRequest,
  type OwnerResult,
  type PluginProblem,
  type PutRequest,
  type PutResult,
  type SayResult,
  type Section,
} from '@pneuma-base/kernel'
import { commandOf, minute } from './page.js'

const REFUSAL: Record<string, (subject: string) => string> = {
  'outside-library': (s) => `${s} 不在库的内容里。库内路径相对库的根目录写，不能是 .pneuma-base/ 或 PNEUMA-BASE.md；_archive/ 只经 archive 和 unarchive 进出。`,
  'outside-grant': (s) => `${s} 不在你的授权范围内。`,
  'no-such-file': (s) => `没有这个文件：${s}`,
  'would-overwrite': (s) => `${s} 已有内容不同的东西，没有动它。换一个名字。`,
  'original-path-taken': (s) => `原路径 ${s} 已有文件，什么都没动。`,
  'agent-session': (s) => `${s}：--observed 只给主人用，记的是主人这边自动看到的东西。你知道它从哪来，就直接写 --brought 或 --made，不加 --observed。`,
  'inside-bundle': (s) => `${s} 是一样东西（带 .pneuma-item 标记的目录），它里面的文件不单独放、挪或归档。要改它，把整个目录重新放进来。`,
}

function tail(notes: { plugin: string; text: string }[], problems: PluginProblem[]): string[] {
  return [...notes.map((n) => `  ${n.plugin}：${n.text}`), ...problems.map((p) => `  插件 ${p.plugin} 出错：${p.message}`)]
}

function refusal(reason: string, subject: string): string {
  return `拒绝（${reason}）：${REFUSAL[reason]?.(subject) ?? subject}`
}

export function putText(req: PutRequest, r: PutResult): string[] {
  if (r.outcome === 'refused') {
    // Plugins that could have held the replaced content say why they did not, and what would let them.
    const head = r.notes.length > 0 ? `拒绝（${r.reason}）：${r.subject} 已有内容不同的东西，没有插件替它留住旧内容，所以没有动它。` : refusal(r.reason, r.subject)
    return [head, ...tail(r.notes, r.problems)]
  }
  const head =
    req.kind === 'register' ? `已登记 ${r.path}` : req.kind === 'move' ? `已挪到 ${r.path}` : r.copied ? `已放入 ${r.path}` : `${r.path} 已有相同的内容，没有复制`
  return [head, ...tail(r.notes, r.problems)]
}

type Entry = { key: string; path: string | null; marks: string[]; details: string[]; group: string | null }

/**
 * Hits in rank order. The hits on one path (or title) make one entry: the kernel's mark beside it,
 * each plugin's detail after it. Entries that share a group print under it at the place of the
 * first, one indented line each; an entry without a path describes the group, so it comes first.
 */
function findText(r: FindResult, none = '没有找到。'): string[] {
  const entries = new Map<string, Entry>()
  for (const h of r.hits) {
    const key = h.path ?? h.title
    const entry = entries.get(key) ?? { key, path: h.path, marks: [], details: [], group: null }
    entries.set(key, entry)
    entry.group ??= h.group
    if (h.detail === null) continue
    if (h.by === 'kernel') entry.marks.push(h.detail)
    else entry.details.push(h.detail)
  }
  const all = [...entries.values()]
  const named = (e: Entry) => `${e.key}${e.marks.map((m) => `（${m}）`).join('')}`
  const printed = new Set<string>()
  const lines = all.flatMap((e) => {
    if (e.group === null) return [named(e), ...e.details.map((d) => `  ${d}`)]
    if (printed.has(e.group)) return []
    printed.add(e.group)
    const members = all.filter((m) => m.group === e.group)
    const own = members.filter((m) => m.path === null && m.details.length > 0).map((m) => `  ${m.details.join(' · ')}`)
    return [e.group, ...own, ...members.filter((m) => m.path !== null).map((m) => `  ${[named(m), ...m.details].join('  ')}`)]
  })
  return [...(lines.length === 0 ? [none] : lines), ...tail([], r.problems)]
}

/**
 * What plugins know comes first, the file's own facts after, its content last when asked. A target
 * with no file may still be something a plugin knows, such as a scene.
 */
export function inspectText(target: string, r: InspectResult, inner: string | null = null): string[] {
  const f = r.file
  const what = f === null ? '' : f.kind === 'bundle' ? '一样东西（带标记的目录）' : `${f.size ?? 0} 字节`
  const print = f?.fingerprint ? ` · 指纹 ${f.fingerprint.slice(0, 12)}…` : ''
  const file = f
    ? [`${f.path}${f.archived ? '（已归档）' : ''} · ${what}，改于 ${minute(f.modifiedAt)}${print}`, ...(f.level && r.content?.kind !== 'level' ? levelText(f.path, f.level) : [])]
    : r.place
      ? placeText(r.place)
      : r.sections.length > 0 || r.request
        ? []
        : [`库里没有这个文件：${target}`]
  const request = r.request ? requestText(r.request) : []
  return [...request, ...sectionsText(r.sections), ...file, ...(r.content && r.file ? contentText(target, r.content, inner) : []), ...tail([], r.problems)]
}

/** How many entries of a level the command line names before it gives the total and the command for the rest. */
const LISTED = 20

/** One level of a directory: its first entries, how many there are, and where to see the rest. */
function levelText(dir: string, level: Level): string[] {
  const total = level.entries.length + level.more
  const named = level.entries.slice(0, LISTED).map((e) => `  ${e.kind === 'dir' ? `${e.name}/` : e.name}${e.kind === 'file' && e.size !== null ? `  ${e.size} 字节` : ''}`)
  const count = level.more > 0 ? `至少 ${total} 项` : `${total} 项`
  const rest = total > LISTED ? [`  ……共${count}，看全部：show files --dir ${quote(dir)}`] : []
  return [`第一层，${count}：`, ...named, ...rest]
}

/** A directory that is no thing, or noise. */
function placeText(p: PlaceFacts): string[] {
  switch (p.kind) {
    case 'open':
      return [`${p.path}/ · 目录，里面有登记过的东西`, ...levelText(p.path, p.level)]
    case 'closed': {
      const files = p.exceeded ? `至少 ${p.files} 个文件` : `${p.files} 个文件`
      const marks = p.markers.length === 0 ? '' : `，顶上有 ${p.markers.join('、')}`
      return [`${p.path}/ · 目录，没有登记，${files}${marks}`]
    }
    case 'noise':
      return [`${p.path} 是噪音，${'name' in p.by ? `按名字 ${p.by.name}` : `按路径 ${p.by.path}`}；找、查和登记都不涉及它。`]
  }
}

/** One request in full: who asked and when, why, the command, and where it stands. */
function requestText(q: OwnerRequest): string[] {
  return [`请求 ${q.id}`, `  谁提的：${q.by.name} · ${minute(q.at)}`, `  为什么：${q.why}`, `  命令：${q.line}`, `  现在：${endText(q)}`]
}

export function askText(r: AskResult): string[] {
  if (r.outcome === 'refused') return [`拒绝（${r.reason}）：${r.text}`, ...tail([], r.problems)]
  const q = r.request
  if (r.outcome === 'withdrawn') return [`已撤回请求 ${q.id}：${q.line}`, ...tail([], r.problems)]
  const head = r.again ? `这个请求已经在等主人决定：${q.line}（请求 ${q.id}，${minute(q.at)} 提的），不用再提。` : `已请主人做：${q.line}（请求 ${q.id}）`
  const next = `主人会在管理界面的首页和 request list 里看到它，批准就以主人的身份照原样运行。结果在你下次 check 的「你提的请求」里；不需要了，用 ask --withdraw ${q.id} 撤回。`
  return [head, ...(r.again ? [] : [next]), ...tail([], r.problems)]
}

/** The caller's own requests in check: those the owner decided since it last looked, each with how it ended, and how many still wait. */
function requestsText({ ended, pending, more = 0 }: CheckResult['requests']): string[] {
  if (ended.length === 0 && pending === 0 && more === 0) return []
  const later = more === 0 ? [] : [`另有 ${more} 个也有了结果，下次 check 接着说。`]
  const waiting = pending === 0 ? [] : [`${ended.length > 0 ? '还有' : '有'} ${pending} 个在等主人决定。`]
  return ['## 你提的请求', ...ended.map((q) => `- ${q.id} ${q.line}：${endText(q)}`), ...later, ...waiting]
}

function contentText(target: string, c: Content, inner: string | null): string[] {
  switch (c.kind) {
    case 'text':
      return [`内容（UTF-8 文字，${c.size} 字节）：`, c.text.endsWith('\n') ? c.text.slice(0, -1) : c.text]
    case 'other':
      return [`内容：${c.why === 'not-utf8' ? '不是 UTF-8 文字' : `超过 ${CONTENT_LIMIT / 1024} KB 的上限`}${c.type === null ? '' : `，${c.type}`}，${c.size} 字节，没有给出。`]
    case 'level':
      return [...levelText(c.path, c.level), `看其中一个：inspect ${target} --content <文件>`]
    case 'elsewhere':
      return [`${elsewhereWords(c.provider, c.size)}。取回来：inspect ${target} --content${inner === null ? '' : ` ${inner}`} --fetch`]
    case 'unavailable':
      if (c.reason === 'outside-grant') return [`内容：${c.path} 不在你的授权范围内，不给内容。`]
      if (c.reason === 'not-a-bundle') return [`内容：${c.path} 是一个文件，不是带标记的目录，里面没有别的文件；看它自己：inspect ${target} --content`]
      return [`内容：${c.path} 里没有 ${inner}。`]
  }
}

export function sayText(r: SayResult): string[] {
  const head = r.outcome === 'heard' ? `已记下（${r.by}）：${r.note}` : `没有记下（${r.reason}）：${r.note}`
  return [head, ...tail([], r.problems)]
}

/**
 * What only the owner can settle, for an agent to pass on: each sentence and who raises it, then for
 * each answer the command the owner runs, the suggested one marked.
 */
function asksText(asks: readonly Ask[], commands: readonly OwnerCommandInfo[], root: string): string[] {
  if (asks.length === 0) return []
  const library = `--library ${quote(root)}`
  return [
    '## 要主人来做的',
    ...asks.flatMap((a) => [
      `- ${a.text}（${typeof a.by === 'string' ? a.by : a.by.name}）`,
      ...a.actions.map((x, i) => `  pneuma-base ${commandOf(x, commands)} ${library}  # ${x.label}${i === a.suggested ? '（推荐）' : ''}`),
    ]),
    '这些只有主人能定：告诉主人，主人在自己的终端里运行上面的命令，或在管理界面的首页上点。',
  ]
}

/** The most an agent's start or check prints, in bytes: the answer fits its context however much the library holds. */
export const AGENT_TEXT_LIMIT = 8 * 1024
/**
 * The most an agent's start or check answers as JSON (`--json`, MCP's structured content), in bytes as
 * `--json` prints it: four times the text, which names in one line what the JSON gives as fields, an
 * ask with the forms of its answers.
 */
export const AGENT_JSON_LIMIT = 32 * 1024

/** What a bounded answer left out, by kind, and where all of it is. */
export type Cut = { sections?: number; requests?: number; asks?: number; hits?: number; where: string }
type PartKind = Exclude<keyof Cut, 'where'>
type Part<T> = { kind: PartKind; value: T }
type Shaped<J> = { json: J; lines: string[] }

const PART_WORDS: Record<PartKind, (n: number) => string> = {
  sections: (n) => `${n} 节状况`,
  requests: (n) => `${n} 个你提的请求的结果`,
  asks: (n) => `${n} 件要主人做的`,
  hits: (n) => `${n} 样可能相关的`,
}

const decidedIn = (r: CheckResult['requests']) => r.ended.length + (r.more ?? 0)

function cutOf(left: readonly Part<unknown>[], where: string): Cut | null {
  if (left.length === 0) return null
  const cut: Cut = { where }
  for (const p of left) {
    const n = p.kind === 'requests' ? decidedIn(p.value as CheckResult['requests']) : 1
    if (n > 0) cut[p.kind] = (cut[p.kind] ?? 0) + n
  }
  return cut
}

const cutLine = (cut: Cut) =>
  `……还有 ${(Object.keys(PART_WORDS) as PartKind[]).flatMap((k) => (cut[k] === undefined ? [] : [PART_WORDS[k](cut[k])])).join('、')}没有给出。${cut.where}`

/**
 * The answer with as many of its parts as fit, in the order the text prints them: the first part that
 * would take the text past AGENT_TEXT_LIMIT or the JSON past AGENT_JSON_LIMIT, and every part after it,
 * are left out of both forms, so the two name the same things, and `cut` says what is missing and where.
 */
function fitted<J>(parts: number, shape: (kept: number) => Shaped<J>): Shaped<J> {
  const fits = (a: Shaped<J>) => Buffer.byteLength(a.lines.join('\n')) <= AGENT_TEXT_LIMIT && Buffer.byteLength(JSON.stringify(a.json, null, 2)) <= AGENT_JSON_LIMIT
  const whole = shape(parts)
  if (fits(whole)) return whole
  let best = shape(0)
  for (let kept = 1; kept < parts; kept++) {
    const next = shape(kept)
    if (!fits(next)) break
    best = next
  }
  return best
}

const STANDING_REST = '状况的全部：show ledger.standing；要主人做的：首页上的「等你决定」。'

/** check's parts in the order its text prints them: each section, the caller's requests, each ask. */
function checkParts(r: CheckResult): Part<unknown>[] {
  const { ended, pending, more = 0 } = r.requests
  return [
    ...r.sections.map((value) => ({ kind: 'sections' as const, value })),
    ...(ended.length > 0 || pending > 0 || more > 0 ? [{ kind: 'requests' as const, value: r.requests }] : []),
    ...r.asks.map((value) => ({ kind: 'asks' as const, value })),
  ]
}

/** The check answer holding only the kept parts. */
function keptCheck(r: CheckResult, kept: readonly Part<unknown>[]): CheckResult {
  const of = <T>(kind: PartKind) => kept.filter((p) => p.kind === kind).map((p) => p.value as T)
  return { ...r, sections: of<Section>('sections'), asks: of<Ask>('asks'), requests: of<CheckResult['requests']>('requests')[0] ?? { ended: [], pending: r.requests.pending } }
}

const checkLines = (r: CheckResult, commands: readonly OwnerCommandInfo[], root: string) => [...sectionsText(r.sections), ...requestsText(r.requests), ...asksText(r.asks, commands, root)]

/** check as both forms, bounded together. */
export function checkAnswer(r: CheckResult, commands: readonly OwnerCommandInfo[], root: string): Shaped<CheckResult & { cut?: Cut }> {
  const parts = checkParts(r)
  return fitted(parts.length, (n) => {
    const kept = keptCheck(r, parts.slice(0, n))
    const cut = cutOf(parts.slice(n), STANDING_REST)
    const own = checkLines(kept, commands, root)
    const lines = [...(own.length === 0 && cut === null ? ['没有可报告的。'] : own), ...tail([], r.problems), ...(cut === null ? [] : [cutLine(cut)])]
    return { json: { ...kept, ...(cut === null ? {} : { cut }) }, lines }
  })
}

/** The hits of each entry find's text prints, by the path or the title they share, in rank order. */
function entriesOf(hits: readonly Hit[]): Hit[][] {
  const entries = new Map<string, Hit[]>()
  for (const h of hits) entries.set(h.path ?? h.title, [...(entries.get(h.path ?? h.title) ?? []), h])
  return [...entries.values()]
}

/** start's three parts under their headings, bounded together. A part with nothing prints nothing; the related part says when nothing is related. */
export function startAnswer(
  say: SayResult,
  check: CheckResult,
  find: FindResult,
  sentence: string,
  commands: readonly OwnerCommandInfo[],
  root: string,
): Shaped<{ say: SayResult; check: CheckResult; find: FindResult; cut?: Cut }> {
  const heading = (title: string, lines: string[]) => (lines.length > 0 ? [title, ...lines] : [])
  const entries = entriesOf(find.hits)
  const parts: Part<unknown>[] = [...checkParts(check), ...entries.map((value) => ({ kind: 'hits' as const, value }))]
  const where = `${STANDING_REST}可能相关的全部：find ${quote(sentence)}`
  return fitted(parts.length, (n) => {
    const kept = parts.slice(0, n)
    const c = keptCheck(check, kept)
    const f: FindResult = { ...find, hits: kept.flatMap((p) => (p.kind === 'hits' ? (p.value as Hit[]) : [])) }
    const cut = cutOf(parts.slice(n), where)
    const related = f.hits.length === 0 && entries.length > 0 ? tail([], f.problems) : findText(f, '库里没有和这件事相关的东西。')
    const lines = [
      ...heading('【记下】', sayText(say)),
      ...heading('【库的变化与状况】', [...checkLines(c, commands, root), ...tail([], check.problems)]),
      ...heading('【库里可能相关的】', related),
      ...(cut === null ? [] : [cutLine(cut)]),
    ]
    return { json: { say, check: c, find: f, ...(cut === null ? {} : { cut }) }, lines }
  })
}

/** How many entries one page of find holds. */
export const FIND_ROWS = TEXT_ROWS

/**
 * One page of find, as both forms: the hits of its entries (FIND_ROWS of them, by the path or the
 * title they share), and when there are more entries than one page, how many and the command for the
 * next page.
 */
export function findAnswer(r: FindResult, page: number, next: (page: number) => string): Shaped<FindResult & { more?: { count: number; next: string | null } }> {
  const entries = entriesOf(r.hits)
  const shown: FindResult = { ...r, hits: entries.slice((page - 1) * FIND_ROWS, page * FIND_ROWS).flat() }
  if (entries.length <= FIND_ROWS && page === 1) return { json: shown, lines: findText(shown) }
  const last = page * FIND_ROWS >= entries.length
  const more = { count: entries.length, next: last ? null : next(page + 1) }
  const line = `……共 ${entries.length} 样，这是第 ${page} 页${more.next === null ? '，最后一页。' : `；下一页：${more.next}`}`
  return { json: { ...shown, more }, lines: [...findText(shown, `第 ${page} 页上没有了。`), line] }
}

export function archiveText(kind: 'archive' | 'unarchive', r: ArchiveResult): string[] {
  if (r.outcome === 'refused') return [refusal(r.reason, r.subject), ...tail([], r.problems)]
  const head =
    kind === 'archive'
      ? r.moved ? `已归档：${r.from} → ${r.to}` : `${r.from} 已经在归档区：${r.to}`
      : r.moved ? `已取回：${r.from} → ${r.to}` : `${r.to} 本来就在原处，没有动`
  return [head, ...tail(r.notes, r.problems)]
}

export function ownerText(r: OwnerResult): string[] {
  return [r.outcome === 'refused' ? `拒绝（${r.reason}）：${r.text}` : r.text, ...tail([], r.problems)]
}

function sectionsText(sections: Section[]): string[] {
  return sections.flatMap((s) => [`## ${s.title}（${s.plugin}）`, s.body])
}
