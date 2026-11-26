import {
  CONTENT_LIMIT,
  endText,
  quote,
  type ArchiveResult,
  type Ask,
  type AskResult,
  type CheckResult,
  type Content,
  type FindResult,
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
export function findText(r: FindResult, none = '没有找到。'): string[] {
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
    ? [`${f.path}${f.archived ? '（已归档）' : ''} · ${what}，改于 ${minute(f.modifiedAt)}${print}`, ...(f.level ? levelText(f.path, f.level) : [])]
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
function requestsText({ ended, pending }: CheckResult['requests']): string[] {
  if (ended.length === 0 && pending === 0) return []
  const waiting = pending === 0 ? [] : [`${ended.length > 0 ? '还有' : '有'} ${pending} 个在等主人决定。`]
  return ['## 你提的请求', ...ended.map((q) => `- ${q.id} ${q.line}：${endText(q)}`), ...waiting]
}

function contentText(target: string, c: Content, inner: string | null): string[] {
  switch (c.kind) {
    case 'text':
      return [`内容（UTF-8 文字，${c.size} 字节）：`, c.text.endsWith('\n') ? c.text.slice(0, -1) : c.text]
    case 'other':
      return [`内容：${c.why === 'not-utf8' ? '不是 UTF-8 文字' : `超过 ${CONTENT_LIMIT / 1024} KB 的上限`}${c.type === null ? '' : `，${c.type}`}，${c.size} 字节，没有给出。`]
    case 'level':
      return [...levelText(c.path, c.level), `看其中一个：inspect ${target} --content <文件>`]
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

/** The lines, one per line of text, up to AGENT_TEXT_LIMIT bytes; past that, one line saying so and where the rest is. */
export function bounded(lines: readonly string[]): string[] {
  const tail = `……到 ${AGENT_TEXT_LIMIT / 1024} KB 为止，后面的没有印出。状况的全部：show ledger.standing；要主人做的：首页上的「等你决定」。`
  const budget = AGENT_TEXT_LIMIT - Buffer.byteLength(tail) - 1
  const out: string[] = []
  let size = 0
  for (const line of lines.flatMap((l) => l.split('\n'))) {
    size += Buffer.byteLength(line) + 1
    if (size > budget) return [...out, tail]
    out.push(line)
  }
  return out
}

export function checkText(r: CheckResult, commands: readonly OwnerCommandInfo[], root: string): string[] {
  const own = [...requestsText(r.requests), ...asksText(r.asks, commands, root)]
  return bounded([...(r.sections.length === 0 && own.length === 0 ? ['没有可报告的。'] : [...sectionsText(r.sections), ...own]), ...tail([], r.problems)])
}

/** start's three parts under their headings. A part with nothing prints nothing; the related part says when nothing is related. */
export function startText(say: SayResult, check: CheckResult, find: FindResult, commands: readonly OwnerCommandInfo[], root: string): string[] {
  const part = (heading: string, lines: string[]) => (lines.length > 0 ? [heading, ...lines] : [])
  return bounded([
    ...part('【记下】', sayText(say)),
    ...part('【库的变化与状况】', [...sectionsText(check.sections), ...requestsText(check.requests), ...asksText(check.asks, commands, root), ...tail([], check.problems)]),
    ...part('【库里可能相关的】', findText(find, '库里没有和这件事相关的东西。')),
  ])
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
