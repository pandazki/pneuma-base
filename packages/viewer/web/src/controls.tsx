// The page's own choice controls: a segmented control for a few options, a select otherwise.
import { ChevronDown } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'

export type Option = { value: string; label: string }

/** Up to this many options show side by side; more go in a select. */
const SEGMENTS = 4

type ChoiceProps = { label: string; options: Option[]; value: string; onChange(value: string): void }

function Segmented({ label, options, value, onChange }: ChoiceProps) {
  const group = useRef<HTMLDivElement | null>(null)
  const current = Math.max(0, options.findIndex((o) => o.value === value))
  // Arrow keys move the choice, as in a radio group.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = (current + step + options.length) % options.length
    onChange(options[next]?.value ?? value)
    group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} className="segmented" onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={i === current} tabIndex={i === current ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SelectControl({ label, options, value, onChange }: ChoiceProps) {
  return (
    <span className="select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-ink-3" strokeWidth={2} aria-hidden />
    </span>
  )
}

/** One choice among `options`, side by side when there are few of them. */
export function Choice(props: ChoiceProps) {
  return props.options.length <= SEGMENTS ? <Segmented {...props} /> : <SelectControl {...props} />
}
