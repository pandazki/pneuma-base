import type { ArchiveResult, CheckResult, FindResult, InspectResult, OwnerResult, PluginProblem, PutRequest, PutResult, SayResult, Section } from '@pneuma-base/kernel'

const REFUSAL: Record<string, (subject: string) => string> = {
  'outside-library': (s) => `${s} 不在库的内容里。库内路径相对库的根目录写，不能是 .pneuma-base/ 或 PNEUMA-BASE.md；_archive/ 只经 archive 和 unarchive 进出。`,
  'outside-grant': (s) => `${s} 不在你的授权范围内。`,
  'no-such-file': (s) => `没有这个文件：${s}`,
  'would-overwrite': (s) => `${s} 已有内容不同的文件，没有动它。换一个名字。`,
  'original-path-taken': (s) => `原路径 ${s} 已有文件，什么都没动。`,
}

function tail(notes: { plugin: string; text: string }[], problems: PluginProblem[]): string[] {
  return [...notes.map((n) => `  ${n.plugin}：${n.text}`), ...problems.map((p) => `  插件 ${p.plugin} 出错：${p.message}`)]
}

function refusal(reason: string, subject: string): string {
  return `拒绝（${reason}）：${REFUSAL[reason]?.(subject) ?? subject}`
}

export function putText(req: PutRequest, r: PutResult): string[] {
  if (r.outcome === 'refused') return [refusal(r.reason, r.subject), ...tail([], r.problems)]
  const head =
    req.kind === 'register' ? `已登记 ${r.path}` : req.kind === 'move' ? `已挪到 ${r.path}` : r.copied ? `已放入 ${r.path}` : `${r.path} 已有相同的内容，没有复制`
  return [head, ...tail(r.notes, r.problems)]
}

/** One entry per path (or title): the kernel's mark beside it, each plugin's detail on its own line. */
export function findText(r: FindResult): string[] {
  const entries = new Map<string, { marks: string[]; details: string[] }>()
  for (const h of r.hits) {
    const key = h.path ?? h.title
    const entry = entries.get(key) ?? { marks: [], details: [] }
    entries.set(key, entry)
    if (h.detail === null) continue
    if (h.by === 'kernel') entry.marks.push(h.detail)
    else entry.details.push(`  ${h.detail}`)
  }
  const lines = [...entries].flatMap(([key, e]) => [`${key}${e.marks.map((m) => `（${m}）`).join('')}`, ...e.details])
  return [...(lines.length === 0 ? ['没有找到。'] : lines), ...tail([], r.problems)]
}

export function inspectText(target: string, r: InspectResult): string[] {
  // A target with no file may still be something a plugin knows, such as a scene.
  const file = r.file
    ? [`${r.file.path}${r.file.archived ? '（已归档）' : ''}`, `  ${r.file.size} 字节，改于 ${r.file.modifiedAt}`, `  指纹 ${r.file.fingerprint}`]
    : r.sections.length > 0 ? [] : [`库里没有这个文件：${target}`]
  return [...file, ...sectionsText(r.sections), ...tail([], r.problems)]
}

export function sayText(r: SayResult): string[] {
  const head = r.outcome === 'heard' ? `已记下（${r.by}）：${r.note}` : `没有记下（${r.reason}）：${r.note}`
  return [head, ...tail([], r.problems)]
}

export function checkText(r: CheckResult): string[] {
  return [...(r.sections.length === 0 ? ['没有可报告的。'] : sectionsText(r.sections)), ...tail([], r.problems)]
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
