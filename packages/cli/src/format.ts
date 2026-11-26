import { CONTENT_LIMIT, type ArchiveResult, type CheckResult, type Content, type FindResult, type InspectResult, type OwnerResult, type PluginProblem, type PutRequest, type PutResult, type SayResult, type Section } from '@pneuma-base/kernel'
import { minute } from './page.js'

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
  const kind = r.file?.kind === 'bundle' ? `目录，${r.file.files} 个文件，` : ''
  const file = r.file
    ? [`${r.file.path}${r.file.archived ? '（已归档）' : ''} · ${kind}${r.file.size} 字节，改于 ${minute(r.file.modifiedAt)} · 指纹 ${r.file.fingerprint.slice(0, 12)}…`]
    : r.sections.length > 0 ? [] : [`库里没有这个文件：${target}`]
  return [...sectionsText(r.sections), ...file, ...(r.content && r.file ? contentText(target, r.content, inner) : []), ...tail([], r.problems)]
}

function contentText(target: string, c: Content, inner: string | null): string[] {
  switch (c.kind) {
    case 'text':
      return [`内容（UTF-8 文字，${c.size} 字节）：`, c.text.endsWith('\n') ? c.text.slice(0, -1) : c.text]
    case 'other':
      return [`内容：${c.why === 'not-utf8' ? '不是 UTF-8 文字' : `超过 ${CONTENT_LIMIT / 1024} KB 的上限`}${c.type === null ? '' : `，${c.type}`}，${c.size} 字节，没有给出。`]
    case 'files':
      return [`目录里的文件（${c.files.length} 个）：`, ...c.files.map((f) => `  ${f.path}  ${f.size} 字节`), `看其中一个：inspect ${target} --content <文件>`]
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

export function checkText(r: CheckResult): string[] {
  return [...(r.sections.length === 0 ? ['没有可报告的。'] : sectionsText(r.sections)), ...tail([], r.problems)]
}

/** start's three parts under their headings. A part with nothing prints nothing; the related part says when nothing is related. */
export function startText(say: SayResult, check: CheckResult, find: FindResult): string[] {
  const part = (heading: string, lines: string[]) => (lines.length > 0 ? [heading, ...lines] : [])
  return [
    ...part('【记下】', sayText(say)),
    ...part('【库的变化与状况】', [...sectionsText(check.sections), ...tail([], check.problems)]),
    ...part('【库里可能相关的】', findText(find, '库里没有和这件事相关的东西。')),
  ]
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
