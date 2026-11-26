// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Avatar (clean): letters on a soft colour of their own, picked from the name.
import type { ActorMark } from '@pneuma-base/kernel'
import { useMarkLetters } from '../marks'

/** One of eight soft colours, always the same for the same name. */
export const hueOf = (name: string) => {
  let h = 7
  for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0
  return String(h % 8)
}

/** The letters of a mark, chosen among every mark on screen (marks.ts). */
function Letters({ name }: { name: string }) {
  return <>{useMarkLetters(name)}</>
}

/**
 * Who did it, as a small mark: an agent's letters on its own colour, a rounded square; the owner a
 * grey circle. The mark is decoration: the name stands next to it, or in `label` for readers.
 */
export function ActorBadge({ actor, size = 18, label = false }: { actor: ActorMark | string; size?: 18 | 24; label?: boolean }) {
  const mark = typeof actor === 'string' ? null : actor
  const name = typeof actor === 'string' ? actor : actor.name
  const kind = mark?.kind ?? 'other'
  return (
    <span
      className="aui-actor"
      data-kind={kind}
      data-hue={kind === 'agent' ? hueOf(name) : undefined}
      data-size={size}
      role={label ? 'img' : undefined}
      aria-label={label ? name : undefined}
      aria-hidden={label ? undefined : true}
      title={mark?.grant ? `${name} · 授权 ${mark.grant}` : undefined}
    >
      {kind === 'owner' ? '主' : <Letters name={name} />}
    </span>
  )
}
