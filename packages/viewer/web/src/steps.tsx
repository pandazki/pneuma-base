// The steps of getting started, and the place files are brought in. A step left to do shows what to
// do right there; a done one is one line, its title and what came of it, and opens again on a click.
// The first step left is the current one. The drop area is the app's: files dropped anywhere on the
// window, or chosen here, go into the library; a browser cannot hand over a file, so it shows the command.
import type { Block, Step } from '@pneuma-base/kernel'
import { Check, ChevronRight, Upload } from 'lucide-react'
import { useState } from 'react'
import { Blocks } from './blocks'
import { CellView } from './cells'
import { IN_SHELL, tellShell } from './shell'

type State = 'done' | 'current' | 'todo'

function Mark({ state, n }: { state: State; n: number }) {
  return (
    <span className="step-mark" data-state={state} aria-hidden>
      {state === 'done' ? <Check strokeWidth={2.5} /> : n}
    </span>
  )
}

function StepRow({ step, n, state }: { step: Step; n: number; state: State }) {
  const [open, setOpen] = useState(false)
  const shown = state !== 'done' || open
  const label = `第 ${n} 步，${step.title}，${state === 'done' ? '做完了' : state === 'current' ? '在做' : '还没做'}`
  return (
    <li className="step" data-state={state} aria-label={label}>
      {state === 'done' ? (
        <button type="button" className="step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Mark state={state} n={n} />
          <span className="step-title">{step.title}</span>
          {step.summary ? <span className="step-summary">{step.summary}</span> : null}
          <ChevronRight className={`step-chev ${open ? 'rotate-90' : ''}`} strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <div className="step-head">
          <Mark state={state} n={n} />
          <span className="step-title">{step.title}</span>
        </div>
      )}
      {shown && step.blocks.length > 0 ? (
        <div className="step-body">
          <Blocks blocks={step.blocks} />
        </div>
      ) : null}
    </li>
  )
}

export function StepsView({ block }: { block: Extract<Block, { kind: 'steps' }> }) {
  const current = block.steps.findIndex((s) => !s.done)
  const done = block.steps.filter((s) => s.done).length
  return (
    <div className="steps">
      <span className="steps-bar" aria-hidden>
        <span style={{ width: `${(done / Math.max(1, block.steps.length)) * 100}%` }} />
      </span>
      <ol className="steps-list">
        {block.steps.map((s, i) => (
          <StepRow key={s.key} step={s} n={i + 1} state={s.done ? 'done' : i === current ? 'current' : 'todo'} />
        ))}
      </ol>
    </div>
  )
}

export function DropView({ block }: { block: Extract<Block, { kind: 'drop' }> }) {
  if (!IN_SHELL) {
    return (
      <div className="drop" data-browser>
        <p className="drop-title">在终端里运行这一行，把文件或文件夹放进 {block.to}/</p>
        <div className="drop-command">
          <CellView cell={{ text: block.command, mono: true, copy: true }} />
        </div>
        <p className="drop-hint">在 Mac 应用里，直接把文件拖到窗口上就行。</p>
      </div>
    )
  }
  return (
    <button type="button" className="drop" onClick={() => tellShell({ type: 'choose', to: block.to })}>
      <span className="drop-icon" aria-hidden>
        <Upload strokeWidth={1.75} />
      </span>
      <span className="drop-title">
        把文件或文件夹拖到这里，或 <span className="drop-choose">选择…</span>
      </span>
      <span className="drop-hint">放进 {block.to}/，记成你带进来的；拖到窗口的任何地方都一样</span>
    </button>
  )
}
