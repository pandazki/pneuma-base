// What waits for the owner. Each ask is its sentence; the command it is about, exactly as it would
// run; who raised it and the library path it is about, which opens in the panel; and its answers as
// buttons, the suggested one dark. Once answered, it folds where it stood into one line: the answer,
// what came of it and when. The line keeps its place while the page is open, after the next answer
// no longer has the ask. An answer that failed leaves the ask open; its notice says why. `compact`,
// for the menu bar panel: no card around them, and who raised each and what it is about only in its tooltip.
import type { Ask, Block } from '@pneuma-base/kernel'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { CellView, Moment } from '../cells'
import { useEnv, type Done } from '../env'
import { ActorBadge } from './actor'

type Asks = Extract<Block, { kind: 'asks' }>
type Folded = { ask: Ask; place: number; answer: string; done: Done; at: string }

/** The asks of this answer, with each folded one it no longer has put back at the place it had. */
function withFolded(asks: readonly Ask[], folded: ReadonlyMap<string, Folded>): Ask[] {
  const rows = [...asks]
  const gone = [...folded.values()].filter((f) => !asks.some((a) => a.key === f.ask.key)).sort((a, b) => a.place - b.place)
  for (const f of gone) rows.splice(Math.min(f.place, rows.length), 0, f.ask)
  return rows
}

function AskRow({ ask, compact, onAnswered }: { ask: Ask; compact: boolean; onAnswered(answer: string, done: Done): void }) {
  const { onAction } = useEnv()
  const [busy, setBusy] = useState<number | null>(null)
  const answer = async (i: number) => {
    const action = ask.actions[i]
    if (!action) return
    setBusy(i)
    const done = await onAction(action)
    setBusy(null)
    if (done && done.tone !== 'bad') onAnswered(action.label, done)
  }
  const about = ask.about
  const by = typeof ask.by === 'string' ? ask.by : ask.by.name
  return (
    <li className="asks-row">
      <p className="asks-text" title={compact ? [by, about].filter(Boolean).join(' · ') : undefined}>
        {ask.text}
      </p>
      {ask.command ? <code className="asks-command">{ask.command}</code> : null}
      {compact ? null : <p className="asks-meta">
        {typeof ask.by === 'string' ? <span>{ask.by}</span> : <ActorBadge actor={ask.by} label />}
        {about ? (
          <span className="asks-about">
            <CellView cell={{ text: about, mono: true, link: { view: 'item', params: { path: about }, target: 'panel' } }} />
          </span>
        ) : null}
      </p>}
      <div className="asks-answers">
        {ask.actions.map((action, i) => (
          <button
            key={`${action.label}-${i}`}
            type="button"
            className={`btn btn-sm ${i === ask.suggested ? 'btn-primary' : ''} ${action.tone === 'danger' ? 'btn-danger' : ''}`}
            aria-busy={busy === i || undefined}
            disabled={busy !== null && busy !== i}
            onClick={() => void answer(i)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </li>
  )
}

function FoldedRow({ folded }: { folded: Folded }) {
  return (
    <li className="asks-row" data-folded>
      <p className="asks-done" role="status" title={folded.ask.text}>
        <Check strokeWidth={2.25} aria-hidden data-tone={folded.done.tone} />
        <span className="asks-done-answer">{folded.answer}</span>
        <span className="asks-done-text">{folded.done.text}</span>
        <span className="asks-done-at">
          <Moment at={folded.at} />
        </span>
      </p>
    </li>
  )
}

export function AsksView({ block, compact = false }: { block: Asks; compact?: boolean }) {
  const [folded, setFolded] = useState<ReadonlyMap<string, Folded>>(() => new Map())
  const rows = withFolded(block.asks, folded)
  if (rows.length === 0) return <p className="asks-empty">{block.empty}</p>
  return (
    <ul className={compact ? 'asks' : 'card asks'} data-compact={compact || undefined}>
      {rows.map((ask, place) => {
        const done = folded.get(ask.key)
        return done ? (
          <FoldedRow key={ask.key} folded={done} />
        ) : (
          <AskRow key={ask.key} ask={ask} compact={compact} onAnswered={(answer, d) => setFolded((m) => new Map(m).set(ask.key, { ask, place, answer, done: d, at: new Date().toISOString() }))} />
        )
      })}
    </ul>
  )
}
