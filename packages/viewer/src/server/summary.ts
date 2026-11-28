// One line for the page to show after a call: what happened, and how it went.
import { elsewhereWords, type ArchiveResult, type AskResult, type InspectResult, type OwnerResult, type PluginProblem, type PutResult, type SayResult } from '@pneuma-base/kernel'

export type Summary = { tone: 'good' | 'warn' | 'bad'; text: string }

const REFUSAL: Record<string, (subject: string) => string> = {
  'outside-library': (s) => `${s} 不在资料库中。`,
  'outside-grant': (s) => `${s} 不在授权范围内。`,
  'no-such-file': (s) => `文件不存在：${s}`,
  'would-overwrite': (s) => `${s} 已存在内容不同的文件，未修改。`,
  'original-path-taken': (s) => `原路径 ${s} 已存在文件，未做任何修改。`,
}

const refusal = (reason: string, subject: string) => REFUSAL[reason]?.(subject) ?? `未执行（${reason}）：${subject}`

/** A plugin that failed turns a good summary into a warning and says which plugin and why. */
function withProblems(summary: Summary, problems: PluginProblem[]): Summary {
  if (problems.length === 0) return summary
  const lines = problems.map((p) => `插件 ${p.plugin} 出错：${p.message}`)
  return { tone: summary.tone === 'bad' ? 'bad' : 'warn', text: [summary.text, ...lines].join('\n') }
}

export function ownerSummary(r: OwnerResult): Summary {
  return withProblems({ tone: r.outcome === 'done' ? 'good' : 'bad', text: r.text }, r.problems)
}

export function archiveSummary(kind: 'archive' | 'unarchive', r: ArchiveResult): Summary {
  if (r.outcome === 'refused') return withProblems({ tone: 'bad', text: refusal(r.reason, r.subject) }, r.problems)
  const text =
    kind === 'archive' ? (r.moved ? `已归档：${r.from} → ${r.to}` : `${r.from} 已归档，未移动`) : r.moved ? `已取消归档：${r.from} → ${r.to}` : `${r.to} 未归档，未移动`
  return withProblems({ tone: 'good', text }, r.problems)
}

export function putSummary(r: PutResult): Summary {
  if (r.outcome === 'refused') return withProblems({ tone: 'bad', text: [refusal(r.reason, r.subject), ...r.notes.map((n) => n.text)].join('\n') }, r.problems)
  return withProblems({ tone: 'good', text: [`已添加 ${r.path}`, ...r.notes.map((n) => n.text)].join('\n') }, r.problems)
}

export function saySummary(r: SayResult): Summary {
  return withProblems({ tone: r.outcome === 'heard' ? 'good' : 'bad', text: r.note }, r.problems)
}

export function askSummary(r: AskResult): Summary {
  if (r.outcome === 'refused') return withProblems({ tone: 'bad', text: r.text }, r.problems)
  return withProblems({ tone: 'good', text: `${r.outcome === 'withdrawn' ? '已撤销' : '已提交请求'}：${r.request.line}` }, r.problems)
}

/** For a verb that only reads: nothing to say unless a plugin failed. */
export function readSummary(problems: PluginProblem[]): Summary {
  return withProblems({ tone: 'good', text: '完成。' }, problems)
}

/** For inspect asked for content: a fetch that left it elsewhere says where it is still. */
export function inspectSummary(r: InspectResult): Summary {
  return r.content?.kind === 'elsewhere' ? withProblems({ tone: 'warn', text: `${elsewhereWords(r.content.provider, r.content.size)}。` }, r.problems) : readSummary(r.problems)
}

/** For a named whole pass: what it found, as its plugin wrote it. */
export function passSummary(body: string | null, problems: PluginProblem[]): Summary {
  return withProblems({ tone: 'good', text: body ?? '完成。' }, problems)
}
