// The steps of getting started, and the place files are brought in. The current step, the first left
// to do, shows what to do right there; every other is one line, a done one with what came of it, and
// opens on a click. The drop area is the app's: files dropped anywhere on the
// window, or chosen here, go into the library; a browser cannot hand over a file, so it shows the command.
import type { Block, Step } from '@pneuma-base/kernel'
import { Check, ChevronRight, Upload } from 'lucide-react'
import { useState } from 'react'
import { ActionBar } from './actions'
import { Blocks } from './blocks'
import { IN_SHELL, tellShell } from './shell'

type State = 'done' | 'current' | 'todo'

function Mark({ state }: { state: State }) {
  return (
    <span className="step-mark" data-state={state} aria-hidden>
      {state === 'done' ? <Check strokeWidth={2.25} /> : null}
    </span>
  )
}

function StepRow({ step, n, state }: { step: Step; n: number; state: State }) {
  const [open, setOpen] = useState(false)
  const shown = state === 'current' || open
  const label = `第 ${n} 步，${step.title}，${state === 'done' ? '已完成' : state === 'current' ? '进行中' : '未完成'}`
  return (
    <li className="step" data-state={state} aria-label={label}>
      {state !== 'current' ? (
        <button type="button" className="step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Mark state={state} />
          <span className="step-text">
            <span className="step-title">{step.title}</span>
            {state === 'done' && step.summary ? <span className="step-summary">{step.summary}</span> : null}
          </span>
          <ChevronRight className={`step-chev ${open ? 'rotate-90' : ''}`} strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <div className="step-head">
          <Mark state={state} />
          <span className="step-text">
            <span className="step-title">{step.title}</span>
          </span>
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
        <span className="drop-icon" aria-hidden>
          <Upload strokeWidth={1.75} />
        </span>
        <ActionBar actions={[block.action]} small={false} />
        <span className="drop-hint">添加到 {block.to}/，标记为我导入</span>
      </div>
    )
  }
  return (
    <button type="button" className="drop" onClick={() => tellShell({ type: 'choose', to: block.to })}>
      <span className="drop-icon" aria-hidden>
        <Upload strokeWidth={1.75} />
      </span>
      <span className="drop-title">
        将文件或文件夹拖到此处，或 <span className="drop-choose">选择…</span>
      </span>
      <span className="drop-hint">添加到 {block.to}/，标记为我导入；拖到窗口任意位置均可</span>
    </button>
  )
}
