// One line for the page to show after a call: what happened, and how it went.
import type { ArchiveResult, OwnerResult, PluginProblem, PutResult, SayResult } from '@pneuma-base/kernel'

export type Summary = { tone: 'good' | 'warn' | 'bad'; text: string }

const REFUSAL: Record<string, (subject: string) => string> = {
  'outside-library': (s) => `${s} 不在库的内容里。`,
  'outside-grant': (s) => `${s} 不在授权范围内。`,
  'no-such-file': (s) => `没有这个文件：${s}`,
  'would-overwrite': (s) => `${s} 已有内容不同的文件，没有动它。`,
  'original-path-taken': (s) => `原路径 ${s} 已有文件，什么都没动。`,
}

const refusal = (reason: string, subject: string) => REFUSAL[reason]?.(subject) ?? `没有做（${reason}）：${subject}`

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
    kind === 'archive' ? (r.moved ? `已归档：${r.from} → ${r.to}` : `${r.from} 已经在归档区`) : r.moved ? `已取回：${r.from} → ${r.to}` : `${r.to} 本来就在原处`
  return withProblems({ tone: 'good', text }, r.problems)
}

export function putSummary(r: PutResult): Summary {
  if (r.outcome === 'refused') return withProblems({ tone: 'bad', text: refusal(r.reason, r.subject) }, r.problems)
  return withProblems({ tone: 'good', text: [`已放好 ${r.path}`, ...r.notes.map((n) => n.text)].join('\n') }, r.problems)
}

export function saySummary(r: SayResult): Summary {
  return withProblems({ tone: r.outcome === 'heard' ? 'good' : 'bad', text: r.note }, r.problems)
}

/** For a verb that only reads: nothing to say unless a plugin failed. */
export function readSummary(problems: PluginProblem[]): Summary {
  return withProblems({ tone: 'good', text: '好了。' }, problems)
}
