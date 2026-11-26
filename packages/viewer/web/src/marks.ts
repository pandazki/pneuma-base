// The letters of an agent's mark. Colour alone cannot tell two agents apart, so the letters must:
// two from the name, the same on every page, and where two names on screen would still share them,
// each takes the first later letter that sets it apart. ARCHITECTURE.md section 7.
import { useLayoutEffect, useSyncExternalStore } from 'react'

/** The words of a name: runs of letters and digits; a lower-case letter followed by a capital starts a new word. */
const wordsOf = (name: string) =>
  name
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')

/** A character as wide as two letters: one of them fills a mark. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

const upper = (c: string) => c.toLocaleUpperCase()

/**
 * A name's own letters: the first letters of its first two words (claude-code is CC), or a one-word
 * name's first two letters (codex is Co); a wide character stands alone (小助手 is 小).
 */
export function ownLetters(name: string): string {
  const words = wordsOf(name).map((w) => [...w])
  const first = words[0] ?? ['?']
  const head = first[0] as string
  if (WIDE.test(head)) return head
  const second = words[1]?.[0]
  if (second !== undefined) return upper(head) + upper(second)
  return upper(head) + (first[1]?.toLocaleLowerCase() ?? '')
}

/**
 * The letters of each name among `names`. A name's own letters, unless another name has the same:
 * then its first letter and the first later one where it differs from each of those names, by
 * position (codex and copilot are Cd and Cp), or for a wide one that later character alone; its own
 * letters when none differs.
 */
export function lettersFor(names: readonly string[]): Map<string, string> {
  const own = new Map(names.map((n) => [n, ownLetters(n)]))
  const out = new Map<string, string>()
  for (const name of names) {
    const mine = own.get(name) as string
    const rivals = names.filter((n) => n !== name && upper(own.get(n) as string) === upper(mine))
    const chars = (n: string) => [...n.toLocaleLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c))
    const me = chars(name)
    const others = rivals.map(chars)
    const at = rivals.length === 0 ? -1 : me.findIndex((c, i) => i > 0 && others.every((o) => o[i] !== c))
    // A wide character fills the mark alone: the one that sets it apart stands for the name.
    out.set(name, at < 0 ? mine : WIDE.test(mine) ? (me[at] as string) : upper(me[0] as string) + me[at])
  }
  return out
}

// ---- the names whose marks are on screen, so every mark is chosen among the same names ----

const onScreen = new Map<string, number>()
const listeners = new Set<() => void>()
let letters = new Map<string, string>()
let version = 0

function changed(): void {
  letters = lettersFor([...onScreen.keys()].sort())
  version++
  for (const listen of listeners) listen()
}

const subscribe = (listen: () => void) => {
  listeners.add(listen)
  return () => listeners.delete(listen)
}

/** The letters of the mark for `name`, chosen among the names of every mark on screen, the page and its panel alike. */
export function useMarkLetters(name: string): string {
  useSyncExternalStore(subscribe, () => version)
  useLayoutEffect(() => {
    const count = onScreen.get(name) ?? 0
    onScreen.set(name, count + 1)
    if (count === 0) changed()
    return () => {
      const left = (onScreen.get(name) ?? 1) - 1
      if (left > 0) return void onScreen.set(name, left)
      onScreen.delete(name)
      changed()
    }
  }, [name])
  return letters.get(name) ?? ownLetters(name)
}
