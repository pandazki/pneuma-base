// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Decision Inbox (clean): open decisions in one white card, a row under a
// hairline each, the suggested answer as the dark button; answering folds the row into one line
// that says what was decided, which stays where it happened.
import type { Ask, Block } from '@pneuma-base/kernel'
import { useState } from 'react'
import { CellView, Moment } from '../cells'
import { useEnv } from '../env'
import { ActorBadge } from './actor'

type Asks = Extract<Block, { kind: 'asks' }>
/** A decided ask: the ask as it was, its place, the answer's label, what the answer said, and when. */
type Decided = { ask: Ask; at: number; label: string; text: string; when: string }

const DoneIcon = () => (
  <svg className="aui-asks-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="currentColor" />
    <path className="aui-asks-cut" d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function AskRow({ ask, busy, onAnswer }: { ask: Ask; busy: boolean; onAnswer(i: number): void }) {
  return (
    <div className="aui-asks-row" aria-busy={busy || undefined}>
      <p className="aui-asks-title">{ask.text}</p>
      <p className="aui-asks-detail">
        {typeof ask.by === 'string' ? null : <ActorBadge actor={ask.by} />}
        <span>{typeof ask.by === 'string' ? ask.by : ask.by.name}</span>
        {ask.about !== null ? (
          <>
            <span aria-hidden>·</span>
            <CellView cell={{ text: ask.about, mono: true, link: { view: 'item', params: { path: ask.about }, target: 'panel' } }} />
          </>
        ) : null}
      </p>
      <div className="aui-asks-actions">
        {ask.actions.map((a, i) => (
          <button
            key={`${a.label}-${i}`}
            type="button"
            className={`btn btn-sm ${a.tone === 'danger' ? 'btn-danger' : i === ask.suggested ? 'btn-primary' : ''}`}
            disabled={busy}
            onClick={() => onAnswer(i)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Receipt({ d }: { d: Decided }) {
  return (
    <div className="aui-asks-row aui-asks-receipt" role="status">
      <DoneIcon />
      <span className="aui-asks-receipt-text" title={d.text}>
        <span className="aui-asks-receipt-label">{d.label}</span>
        <span aria-hidden> · </span>
        {d.text}
      </span>
      <span className="aui-asks-receipt-when">
        <Moment at={d.when} />
      </span>
    </div>
  )
}

/**
 * What only the owner can settle. Each answer runs as any button does; once it went through, the row
 * folds in place into the line it answered, and stays there while the page is open, also after the
 * page asked again and the ask is gone. Nothing waiting is one grey sentence.
 */
export function AsksView({ block }: { block: Asks }) {
  const { onAction } = useEnv()
  const [decided, setDecided] = useState<Map<string, Decided>>(() => new Map())
  const [busy, setBusy] = useState<string | null>(null)
  // The asks still open, with each decided one at the place it had, gone from the answer or not.
  const rows: ({ kind: 'ask'; ask: Ask } | { kind: 'done'; d: Decided })[] = block.asks.filter((a) => !decided.has(a.key)).map((ask) => ({ kind: 'ask' as const, ask }))
  for (const d of [...decided.values()].sort((a, b) => a.at - b.at)) rows.splice(Math.min(d.at, rows.length), 0, { kind: 'done', d })
  const open = block.asks.filter((a) => !decided.has(a.key)).length
  const answer = async (ask: Ask, i: number) => {
    const action = ask.actions[i]
    if (!action || busy !== null) return
    setBusy(ask.key)
    const done = await onAction(action)
    setBusy(null)
    if (done === null || done.tone === 'bad') return
    const at = Math.max(0, block.asks.findIndex((a) => a.key === ask.key))
    setDecided((all) => new Map(all).set(ask.key, { ask, at, label: action.label, text: done.text.split('\n')[0] ?? done.text, when: new Date().toISOString() }))
  }
  if (rows.length === 0) return <p className="aui-quiet">{block.empty}</p>
  return (
    <div className="aui-asks">
      <p className="sr-only" aria-live="polite">
        {open > 0 ? `还有 ${open} 件等你决定` : '都决定了'}
      </p>
      {rows.map((r) =>
        r.kind === 'ask' ? <AskRow key={r.ask.key} ask={r.ask} busy={busy === r.ask.key} onAnswer={(i) => void answer(r.ask, i)} /> : <Receipt key={r.d.ask.key} d={r.d} />,
      )}
    </div>
  )
}
