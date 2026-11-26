// The mark of who did something. An agent is its letters (marks.ts) on a tint of the hue its name
// gives, so the same name looks the same on every page; the owner is a grey circle; a name given as a
// plain string, such as a plugin's, is its letters on grey, since only agents have colour.
import type { ActorMark } from '@pneuma-base/kernel'
import type { CSSProperties } from 'react'
import { useMarkLetters } from '../marks'

type Size = 18 | 24

/** A hue from 0 to 359 for a name: a hash of its characters, the same everywhere. */
export function hueOf(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193)
  return (hash >>> 0) % 360
}

function Mark({ kind, letters, size, style }: { kind: 'agent' | 'owner' | 'named'; letters: string; size: Size; style?: CSSProperties }) {
  return (
    <span className="actor" data-kind={kind} data-size={size} data-one={[...letters].length === 1 || undefined} style={style} aria-hidden>
      {letters}
    </span>
  )
}

function NameMark({ name, kind, size }: { name: string; kind: 'agent' | 'named'; size: Size }) {
  const letters = useMarkLetters(name)
  return <Mark kind={kind} letters={letters} size={size} style={kind === 'agent' ? ({ '--hue': hueOf(name) } as CSSProperties) : undefined} />
}

/** The mark; with `label`, the name after it. The mark is for the eye: the name is in the text around it or after it. */
export function ActorBadge({ actor, size = 18, label = false }: { actor: ActorMark | string; size?: Size; label?: boolean }) {
  const name = typeof actor === 'string' ? actor : actor.name
  const mark =
    typeof actor !== 'string' && actor.kind === 'owner' ? (
      <Mark kind="owner" letters={([...name][0] ?? '').toLocaleUpperCase()} size={size} />
    ) : (
      <NameMark name={name} kind={typeof actor === 'string' ? 'named' : 'agent'} size={size} />
    )
  if (!label) return mark
  return (
    <span className="actor-named">
      {mark}
      <span className="actor-name">{name}</span>
    </span>
  )
}
